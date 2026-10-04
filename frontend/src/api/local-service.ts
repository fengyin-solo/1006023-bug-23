import {
  confirmLoaded,
  flightTodos,
  rejectEntry,
  reportEntry,
  reviewIssues,
  startLoading,
  submitReview,
  summarizeByCompartment,
} from '@/data/baggage'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BaggageIssue,
  BaggageRow,
  BaggageSummaryRow,
  BatchActionResult,
  EntryRow,
  FlightTodo,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 行李模块统一走行李域状态机：顺序推进、逐条退回、派生件数回落都在那一套里，
  // 任何调用方都绕不开，保证入口到落库全链路一致。
  if (key === 'baggage') {
    return runBaggageAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// —— 行李装卸复核域服务：页面动作层只调这里，写路径统一经领域逻辑落库 ——

function baggageRows(): BaggageRow[] {
  return listRows('baggage') as BaggageRow[]
}

export type BaggageBoard = {
  items: BaggageRow[]
  total: number
  /** 按装载舱位归集的汇总：由全量明细现算，不受筛选条件影响，与明细同源。 */
  summary: BaggageSummaryRow[]
  /** 复核队列里核对不通过、需要逐条退回重报的明细。 */
  issues: BaggageIssue[]
  /** 各状态条数：按全量明细统计，不受筛选条件影响。 */
  statusCounts: Record<string, number>
}

export function loadBaggageBoard(filters: Record<string, string> = {}): BaggageBoard {
  const all = baggageRows()
  const matched = filterRows(all, filters) as BaggageRow[]
  const statusCounts: Record<string, number> = {}
  for (const row of all) {
    const status = String(row.status)
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  return {
    items: matched,
    total: matched.length,
    summary: summarizeByCompartment(all),
    issues: reviewIssues(all),
    statusCounts,
  }
}

export function getBaggageEntry(id: number): BaggageRow | null {
  return baggageRows().find((row) => Number(row.id) === id) ?? null
}

/** 批量提交复核：逐条独立处理，一条被退回不影响同批其他行。 */
export function submitBaggageReview(ids: number[]): BatchActionResult {
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选要提交复核的行李作业', succeeded: 0, skipped: [] }
  }
  const { rows, succeeded, skipped } = submitReview(baggageRows(), ids)
  if (succeeded > 0) {
    saveRows('baggage', rows)
  }
  const parts = [`已提交复核 ${succeeded} 条`]
  if (skipped.length > 0) {
    parts.push(`跳过 ${skipped.length} 条：${skipped.map((item) => item.reason).join('；')}`)
  }
  return { ok: succeeded > 0, message: parts.join('，'), succeeded, skipped }
}

/** 退回重报：只退那一行，派生的已装机件数按快照同步回落；重复退回会被状态机挡下。 */
export function rejectBaggageEntry(id: number, reason: string): ActionResult {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '退回原因不能为空，请说明件数或舱带哪里对不上' }
  }
  const result = rejectEntry(baggageRows(), id, trimmed)
  if (result.ok) {
    saveRows('baggage', result.rows)
  }
  return { ok: result.ok, message: result.message }
}

export function confirmBaggageLoaded(id: number): ActionResult {
  const result = confirmLoaded(baggageRows(), id)
  if (result.ok) {
    saveRows('baggage', result.rows)
  }
  return { ok: result.ok, message: result.message }
}

export function startBaggageLoading(id: number): ActionResult {
  const result = startLoading(baggageRows(), id)
  if (result.ok) {
    saveRows('baggage', result.rows)
  }
  return { ok: result.ok, message: result.message }
}

/** 重报修改：被退回到「装载中」的作业改舱位、传送带或已装机件数。 */
export function reportBaggageEntry(
  id: number,
  patch: { 装载舱位?: string; 传送带编号?: string; 已装机件数?: number },
): ActionResult {
  const result = reportEntry(baggageRows(), id, patch)
  if (result.ok) {
    saveRows('baggage', result.rows)
  }
  return { ok: result.ok, message: result.message }
}

function runBaggageAction(id: number, action: string): ActionResult {
  switch (action) {
    case '开始装载':
      return startBaggageLoading(id)
    case '提交复核':
      return submitBaggageReview([id])
    case '确认装机':
      return confirmBaggageLoaded(id)
    case '退回重报':
      return rejectBaggageEntry(id, '复核退回')
    default:
      return { ok: false, message: `行李作业没有登记「${action}」这个动作` }
  }
}

/** 航班保障待办清单：由行李退回记录派生，与行李明细同源，重报后自动消除。 */
export function listFlightTodos(): FlightTodo[] {
  return flightTodos(baggageRows())
}
