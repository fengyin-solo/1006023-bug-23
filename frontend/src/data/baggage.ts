import type { BaggageIssue, BaggageRow, BaggageSummaryRow, FlightTodo } from './types'

// 行李装卸复核域：纯函数，不碰存储。页面动作层和本地数据层都只吃这一套逻辑，
// 保证「页面上看到的」和「落库的」是同一份结果。

/** 传送带与装载舱位的对应关系：复核时逐条核对舱位/传送带的依据。 */
export const BELT_COMPARTMENT: Record<string, string> = {
  'BELT-01': '前舱',
  'BELT-02': '前舱',
  'BELT-03': '后舱',
  'BELT-04': '后舱',
  'BELT-05': '散货舱',
}

export const COMPARTMENTS = ['前舱', '后舱', '散货舱']

export const BAGGAGE_STATUSES = ['待装载', '装载中', '待复核', '已装机']

/**
 * 状态机：只许 待装载 → 装载中 → 待复核 → 已装机 顺序推进，
 * 退回只能回到装载中重报，任何动作都不许跳步。
 */
const TRANSITIONS: Record<string, { from: string; to: string }> = {
  开始装载: { from: '待装载', to: '装载中' },
  提交复核: { from: '装载中', to: '待复核' },
  确认装机: { from: '待复核', to: '已装机' },
  退回重报: { from: '待复核', to: '装载中' },
}

export function toCount(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * 逐条核对：传送带与舱位是否对得上、件数是否对得上。
 * 件数核对只在装载量已报上来之后（待复核/已装机）才有意义，装载中还允许继续装。
 */
export function rowIssues(row: BaggageRow): string[] {
  const issues: string[] = []
  const belt = String(row.传送带编号)
  const expected = BELT_COMPARTMENT[belt]
  if (!expected) {
    issues.push(`传送带${belt}未登记对应舱位`)
  } else if (expected !== String(row.装载舱位)) {
    issues.push(`舱带不符：${belt}应对应${expected}，登记为${String(row.装载舱位)}`)
  }
  if (row.status === '待复核' || row.status === '已装机') {
    if (toCount(row.已装机件数) !== toCount(row.行李件数)) {
      issues.push(`件数不符：登记${toCount(row.行李件数)}件，已装机${toCount(row.已装机件数)}件`)
    }
  }
  return issues
}

/** 异常标记的唯一口径：有核对问题，或被退回还没重报。 */
function abnormalOf(row: BaggageRow): boolean {
  return rowIssues(row).length > 0 || row.退回待重报 === true
}

function findRow(rows: BaggageRow[], id: number): BaggageRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function replaceRow(rows: BaggageRow[], updated: BaggageRow): BaggageRow[] {
  return rows.map((row) => (Number(row.id) === Number(updated.id) ? updated : row))
}

type Mutation = { ok: boolean; message: string; rows: BaggageRow[] }

function reject(status: string, action: string, row: BaggageRow, rows: BaggageRow[]): Mutation {
  return {
    ok: false,
    message: `作业${String(row.作业编号)}当前状态「${status}」，不能执行「${action}」`,
    rows,
  }
}

export function startLoading(rows: BaggageRow[], id: number): Mutation {
  const row = findRow(rows, id)
  if (!row) return { ok: false, message: `没有找到编号为 ${id} 的行李作业`, rows }
  const rule = TRANSITIONS.开始装载
  if (String(row.status) !== rule.from) return reject(String(row.status), '开始装载', row, rows)
  const updated: BaggageRow = { ...row, status: rule.to, pending: true }
  updated.abnormal = abnormalOf(updated)
  return { ok: true, message: `作业${String(row.作业编号)}已开始装载`, rows: replaceRow(rows, updated) }
}

/**
 * 批量提交复核：逐条独立处理。一条不符合条件只跳过那一条，
 * 绝不像出纰漏那版一样把整批一起回滚。
 */
export function submitReview(
  rows: BaggageRow[],
  ids: number[],
): { rows: BaggageRow[]; succeeded: number; skipped: { id: number; reason: string }[] } {
  let next = rows
  let succeeded = 0
  const skipped: { id: number; reason: string }[] = []
  for (const id of ids) {
    const row = findRow(next, id)
    if (!row) {
      skipped.push({ id, reason: '记录不存在' })
      continue
    }
    if (String(row.status) !== TRANSITIONS.提交复核.from) {
      skipped.push({ id, reason: `作业${String(row.作业编号)}当前状态「${String(row.status)}」，不能提交复核` })
      continue
    }
    // 重新提交即完成重报：清掉退回标记与退回原因，异常标记按当前核对结果重算
    const updated: BaggageRow = {
      ...row,
      status: TRANSITIONS.提交复核.to,
      pending: true,
      退回待重报: false,
      退回原因: '',
    }
    updated.abnormal = abnormalOf(updated)
    next = replaceRow(next, updated)
    succeeded += 1
  }
  return { rows: next, succeeded, skipped }
}

/**
 * 退回重报：只作用于出问题的那一行。
 * - 同批其他行原样保留，不跟着回滚；
 * - 派生的已装机件数按快照回落到上一次确认的值，不留退回前累加的残数；
 * - 只有「待复核」能退回，已退回的再退会被状态机挡下，配合快照恢复（赋值而非递减），
 *   重复退回只扣一次，不会反复扣减。
 */
export function rejectEntry(rows: BaggageRow[], id: number, reason: string): Mutation {
  const row = findRow(rows, id)
  if (!row) return { ok: false, message: `没有找到编号为 ${id} 的行李作业`, rows }
  if (String(row.status) !== TRANSITIONS.退回重报.from) {
    return reject(String(row.status), '退回重报', row, rows)
  }
  const updated: BaggageRow = {
    ...row,
    status: TRANSITIONS.退回重报.to,
    pending: true,
    已装机件数: toCount(row.上次确认件数),
    退回原因: reason,
    退回待重报: true,
  }
  updated.abnormal = abnormalOf(updated)
  return {
    ok: true,
    message: `作业${String(row.作业编号)}已退回重报，已装机件数回落至${toCount(updated.已装机件数)}件`,
    rows: replaceRow(rows, updated),
  }
}

/** 确认装机：舱带、件数都核对通过才放行，确认时把已装机件数存为新的快照。 */
export function confirmLoaded(rows: BaggageRow[], id: number): Mutation {
  const row = findRow(rows, id)
  if (!row) return { ok: false, message: `没有找到编号为 ${id} 的行李作业`, rows }
  if (String(row.status) !== TRANSITIONS.确认装机.from) {
    return reject(String(row.status), '确认装机', row, rows)
  }
  const issues = rowIssues(row)
  if (issues.length > 0) {
    return {
      ok: false,
      message: `作业${String(row.作业编号)}复核未通过：${issues.join('；')}，请退回重报`,
      rows,
    }
  }
  const updated: BaggageRow = {
    ...row,
    status: TRANSITIONS.确认装机.to,
    pending: false,
    abnormal: false,
    上次确认件数: toCount(row.已装机件数),
    退回待重报: false,
    退回原因: '',
  }
  return {
    ok: true,
    message: `作业${String(row.作业编号)}已确认装机，共${toCount(updated.已装机件数)}件`,
    rows: replaceRow(rows, updated),
  }
}

/** 重报修改：只有回到「装载中」的作业能改舱位、传送带与已装机件数。 */
export function reportEntry(
  rows: BaggageRow[],
  id: number,
  patch: { 装载舱位?: string; 传送带编号?: string; 已装机件数?: number },
): Mutation {
  const row = findRow(rows, id)
  if (!row) return { ok: false, message: `没有找到编号为 ${id} 的行李作业`, rows }
  if (String(row.status) !== '装载中') {
    return reject(String(row.status), '重报修改', row, rows)
  }
  const updated: BaggageRow = { ...row }
  if (patch.装载舱位 !== undefined) updated.装载舱位 = patch.装载舱位
  if (patch.传送带编号 !== undefined) updated.传送带编号 = patch.传送带编号
  if (patch.已装机件数 !== undefined) {
    const count = toCount(patch.已装机件数)
    if (count < 0) return { ok: false, message: '已装机件数不能为负数', rows }
    updated.已装机件数 = count
  }
  updated.abnormal = abnormalOf(updated)
  return { ok: true, message: `作业${String(row.作业编号)}重报内容已保存`, rows: replaceRow(rows, updated) }
}

/**
 * 按装载舱位归集汇总：永远由明细行现算，不落地存储。
 * 明细的行李件数与汇总的登记件数同源，不存在两份会对不上的数。
 */
export function summarizeByCompartment(rows: BaggageRow[]): BaggageSummaryRow[] {
  const buckets = new Map<string, BaggageSummaryRow>()
  for (const row of rows) {
    const key = String(row.装载舱位) || '未登记'
    const bucket =
      buckets.get(key) ?? { 装载舱位: key, 作业条数: 0, 登记件数: 0, 已装机件数: 0, 待复核条数: 0, 异常条数: 0 }
    bucket.作业条数 += 1
    bucket.登记件数 += toCount(row.行李件数)
    bucket.已装机件数 += toCount(row.已装机件数)
    if (String(row.status) === '待复核') bucket.待复核条数 += 1
    if (row.abnormal === true) bucket.异常条数 += 1
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) => a.装载舱位.localeCompare(b.装载舱位, 'zh-Hans-CN'))
}

/** 复核队列里核对不通过的明细：汇总列表挑出「对不上的那几条」就靠它。 */
export function reviewIssues(rows: BaggageRow[]): BaggageIssue[] {
  return rows
    .filter((row) => String(row.status) === '待复核')
    .map((row) => ({
      id: Number(row.id),
      作业编号: String(row.作业编号),
      航班号: String(row.航班号),
      传送带编号: String(row.传送带编号),
      装载舱位: String(row.装载舱位),
      问题: rowIssues(row),
    }))
    .filter((item) => item.问题.length > 0)
}

/** 航班保障待办清单：由退回待重报的行李作业派生，重新提交复核后自动消除。 */
export function flightTodos(rows: BaggageRow[]): FlightTodo[] {
  return rows
    .filter((row) => row.退回待重报 === true)
    .map((row) => ({
      key: `baggage-${Number(row.id)}`,
      来源: '行李装卸',
      作业编号: String(row.作业编号),
      航班号: String(row.航班号),
      装载舱位: String(row.装载舱位),
      传送带编号: String(row.传送带编号),
      退回原因: String(row.退回原因 ?? ''),
      当前状态: String(row.status),
    }))
}
