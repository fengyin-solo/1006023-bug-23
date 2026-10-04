import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

// 行李作业的状态机：只允许按 待装载 → 装载中 → 待复核 → 已装机 依次推进，不许跳步；
// 退回是唯一的逆向动作，且只从「待复核」退一格到「装载中」。
const STATUS_WAIT_LOAD = '待装载'
const STATUS_LOADING = '装载中'
const STATUS_REVIEW = '待复核'
const STATUS_LOADED = '已装机'

const BAGGAGE_KEY = 'baggage'
const FLIGHT_KEY = 'flight'

// 舱位与传送带的对应关系：复核时逐条按这张表核。
// 传送带不服务该舱位时，这行件数会被归集到错的舱位，汇总必然跟着错。
const COMPARTMENT_BELTS: Record<string, string[]> = {
  '1H': ['BLT-01', 'BLT-02'],
  '2H': ['BLT-03', 'BLT-04'],
  '3H': ['BLT-05'],
  '4H': ['BLT-06'],
}

// 派生字段只挂在返回给页面的行上，绝不写回存储：存储里只放登记事实，
// 派生件数每次现算，从根上杜绝「退回后旧值残留」。
const DERIVED_FIELDS = ['已装机件数', '核对匹配', '核对结果']

export type BaggageCheck = { matched: boolean; reasons: string[] }

export type BatchItemResult = { id: number; ok: boolean; message: string }

export type BatchActionResult = ActionResult & { items: BatchItemResult[] }

export type CompartmentSummary = {
  舱位: string
  条数: number
  登记件数: number
  待装载件数: number
  装载中件数: number
  待复核件数: number
  已装机件数: number
  不匹配条数: number
}

export type BaggageEntryInput = {
  航班号: string
  行李件数: string | number
  装卸班组: string
  传送带编号: string
  装载舱位: string
  复核人员?: string
}

export type BaggageReportPatch = {
  行李件数?: string | number
  传送带编号?: string
  装载舱位?: string
}

function toCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

// 读存储行并规范件数：历史数据里件数可能是文本，读入口统一成数字，之后全链路同一口径。
function readBaggageRows(): EntryRow[] {
  return listRows(BAGGAGE_KEY).map((row) => ({
    ...row,
    行李件数: toCount(row.行李件数),
    退回次数: toCount(row.退回次数),
  }))
}

function writeBaggageRows(rows: EntryRow[]): void {
  saveRows(
    BAGGAGE_KEY,
    rows.map((row) => {
      const stored = { ...row }
      for (const field of DERIVED_FIELDS) {
        delete stored[field]
      }
      return stored
    }),
  )
}

// 已装机件数是派生值：只有「已装机」的行才计入，且只认该行的登记件数。
// 不存累加器，退回时它随状态自然回落到上一次确认的值（未确认过就是 0），不存在残留。
export function deriveLoadedCount(row: EntryRow): number {
  return String(row.status) === STATUS_LOADED ? toCount(row.行李件数) : 0
}

// 逐条核对：装载舱位与传送带编号是否对得上、件数是否有效。复核列表和详情都按它逐条核。
export function checkBaggageRow(row: EntryRow): BaggageCheck {
  const reasons: string[] = []
  if (toCount(row.行李件数) <= 0) {
    reasons.push(`行李件数「${String(row.行李件数 ?? '空')}」不是正整数`)
  }
  const compartment = String(row.装载舱位 ?? '').trim()
  const belt = String(row.传送带编号 ?? '').trim()
  if (!compartment || !(compartment in COMPARTMENT_BELTS)) {
    reasons.push(`装载舱位「${compartment || '空'}」未登记`)
  }
  if (!belt) {
    reasons.push('传送带编号缺失')
  } else if (compartment in COMPARTMENT_BELTS && !COMPARTMENT_BELTS[compartment].includes(belt)) {
    reasons.push(`传送带「${belt}」不服务舱位「${compartment}」`)
  }
  return { matched: reasons.length === 0, reasons }
}

function withDerived(row: EntryRow): EntryRow {
  const check = checkBaggageRow(row)
  return {
    ...row,
    已装机件数: deriveLoadedCount(row),
    核对匹配: check.matched,
    核对结果: check.matched ? '匹配' : `不匹配：${check.reasons.join('；')}`,
  }
}

export function listBaggageEntries(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(readBaggageRows(), filters).map(withDerived)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 按舱位汇总：只是明细的派生视图，每次从明细行实时归集，不落地存储。
// 因此「原始登记」与「汇总」两处件数必然同源；如有冲突，以明细行的登记件数为准。
export function summarizeBaggageByCompartment(): CompartmentSummary[] {
  const byCompartment = new Map<string, CompartmentSummary>()
  for (const row of readBaggageRows()) {
    const key = String(row.装载舱位 ?? '').trim() || '未登记舱位'
    let bucket = byCompartment.get(key)
    if (!bucket) {
      bucket = {
        舱位: key,
        条数: 0,
        登记件数: 0,
        待装载件数: 0,
        装载中件数: 0,
        待复核件数: 0,
        已装机件数: 0,
        不匹配条数: 0,
      }
      byCompartment.set(key, bucket)
    }
    const count = toCount(row.行李件数)
    bucket.条数 += 1
    bucket.登记件数 += count
    if (row.status === STATUS_WAIT_LOAD) bucket.待装载件数 += count
    if (row.status === STATUS_LOADING) bucket.装载中件数 += count
    if (row.status === STATUS_REVIEW) bucket.待复核件数 += count
    bucket.已装机件数 += deriveLoadedCount(row)
    if (!checkBaggageRow(row).matched) bucket.不匹配条数 += 1
  }
  return [...byCompartment.values()].sort((a, b) => a.舱位.localeCompare(b.舱位))
}

export function baggageStats(): { label: string; value: number }[] {
  const rows = readBaggageRows()
  return [
    { label: '今日行李作业', value: rows.length },
    { label: '装载中作业', value: rows.filter((row) => row.status === STATUS_LOADING).length },
    { label: '待复核作业', value: rows.filter((row) => row.status === STATUS_REVIEW).length },
  ]
}

function findRow(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

function notFound(id: number): ActionResult {
  return { ok: false, message: `没有找到编号为 ${id} 的行李作业` }
}

export function startBaggageLoading(id: number): ActionResult {
  const rows = readBaggageRows()
  const index = findRow(rows, id)
  if (index < 0) return notFound(id)
  const row = rows[index]
  if (row.status !== STATUS_WAIT_LOAD) {
    return { ok: false, message: `行李作业${row.作业编号}当前状态「${String(row.status)}」，不能开始装载` }
  }
  rows[index] = { ...row, status: STATUS_LOADING, 作业状态: STATUS_LOADING, pending: true }
  writeBaggageRows(rows)
  return { ok: true, message: `行李作业${row.作业编号}已开始装载` }
}

// 批量提交复核：逐行独立流转，一行的成败不影响同批其他行——
// 之后任何一条被退回，也只动那一行，其余本该照常通过的不会被牵连。
export function submitBaggageReview(ids: number[]): BatchActionResult {
  const rows = readBaggageRows()
  const items: BatchItemResult[] = []
  let changed = false
  for (const id of ids) {
    const index = findRow(rows, id)
    if (index < 0) {
      items.push({ id, ok: false, message: '记录不存在' })
      continue
    }
    const row = rows[index]
    if (row.status !== STATUS_LOADING) {
      items.push({ id, ok: false, message: `状态「${String(row.status)}」不能提交复核` })
      continue
    }
    rows[index] = { ...row, status: STATUS_REVIEW, 作业状态: STATUS_REVIEW, pending: true }
    changed = true
    items.push({ id, ok: true, message: '已进入待复核' })
  }
  if (changed) {
    writeBaggageRows(rows)
  }
  const okCount = items.filter((item) => item.ok).length
  return {
    ok: okCount > 0,
    message: `批量提交完成：${okCount} 条进入待复核，${items.length - okCount} 条未提交`,
    items,
  }
}

export function confirmBaggageLoaded(id: number): ActionResult {
  const rows = readBaggageRows()
  const index = findRow(rows, id)
  if (index < 0) return notFound(id)
  const row = rows[index]
  if (row.status !== STATUS_REVIEW) {
    return { ok: false, message: `行李作业${row.作业编号}当前状态「${String(row.status)}」，不能确认装机` }
  }
  const check = checkBaggageRow(row)
  if (!check.matched) {
    return { ok: false, message: `舱位与传送带对不上（${check.reasons.join('；')}），请先退回重报` }
  }
  rows[index] = {
    ...row,
    status: STATUS_LOADED,
    作业状态: STATUS_LOADED,
    pending: false,
    abnormal: false,
  }
  writeBaggageRows(rows)
  closeFlightTodo(rows[index])
  return { ok: true, message: `行李作业${row.作业编号}已确认装机，已装机件数 ${toCount(row.行李件数)}` }
}

// 退回重报：只作用于出问题的那一行。
// 状态退回「装载中」后，该行的派生件数（待复核/已装机归集）随状态同步回落；
// 重复退回会被状态守卫拒绝，件数不会被反复扣减。
export function returnBaggageEntry(id: number, reason: string): ActionResult {
  const rows = readBaggageRows()
  const index = findRow(rows, id)
  if (index < 0) return notFound(id)
  const row = rows[index]
  if (row.status !== STATUS_REVIEW) {
    return {
      ok: false,
      message: `行李作业${row.作业编号}当前状态「${String(row.status)}」，不在待复核中，重复退回不会再次扣减件数`,
    }
  }
  const trimmed = reason.trim() || '复核不通过'
  rows[index] = {
    ...row,
    status: STATUS_LOADING,
    作业状态: STATUS_LOADING,
    pending: true,
    abnormal: true,
    退回原因: trimmed,
    退回次数: toCount(row.退回次数) + 1,
  }
  writeBaggageRows(rows)
  upsertFlightTodo(rows[index], trimmed)
  return { ok: true, message: `行李作业${row.作业编号}已退回重报，仅该行件数回落，已写入航班保障待办` }
}

// 退回后的重报：只允许在「待装载 / 装载中」改登记内容，改完重新走 提交复核 → 确认装机。
export function updateBaggageReport(id: number, patch: BaggageReportPatch): ActionResult {
  const rows = readBaggageRows()
  const index = findRow(rows, id)
  if (index < 0) return notFound(id)
  const row = rows[index]
  if (row.status !== STATUS_WAIT_LOAD && row.status !== STATUS_LOADING) {
    return { ok: false, message: `行李作业${row.作业编号}当前状态「${String(row.status)}」，不能重报登记` }
  }
  const next: EntryRow = { ...row }
  if (patch.行李件数 !== undefined) {
    const count = toCount(patch.行李件数)
    if (count <= 0) {
      return { ok: false, message: `行李件数「${String(patch.行李件数)}」不是正整数，重报未保存` }
    }
    next.行李件数 = count
  }
  if (patch.传送带编号 !== undefined) {
    if (!patch.传送带编号.trim()) {
      return { ok: false, message: '传送带编号不能为空，重报未保存' }
    }
    next.传送带编号 = patch.传送带编号.trim()
  }
  if (patch.装载舱位 !== undefined) {
    if (!patch.装载舱位.trim()) {
      return { ok: false, message: '装载舱位不能为空，重报未保存' }
    }
    next.装载舱位 = patch.装载舱位.trim()
  }
  rows[index] = next
  writeBaggageRows(rows)
  return { ok: true, message: `行李作业${row.作业编号}已重报登记，可重新提交复核` }
}

export function createBaggageEntry(input: BaggageEntryInput): ActionResult {
  const count = toCount(input.行李件数)
  if (!input.航班号.trim()) return { ok: false, message: '航班号不能为空' }
  if (count <= 0) return { ok: false, message: `行李件数「${String(input.行李件数)}」不是正整数` }
  if (!input.装卸班组.trim()) return { ok: false, message: '装卸班组不能为空' }
  if (!input.传送带编号.trim()) return { ok: false, message: '传送带编号不能为空' }
  if (!input.装载舱位.trim()) return { ok: false, message: '装载舱位不能为空' }
  const rows = readBaggageRows()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const entry: EntryRow = {
    id,
    status: STATUS_WAIT_LOAD,
    pending: true,
    abnormal: false,
    作业编号: `BAGG-${String(id).padStart(4, '0')}`,
    航班号: input.航班号.trim(),
    行李件数: count,
    装卸班组: input.装卸班组.trim(),
    传送带编号: input.传送带编号.trim(),
    装载舱位: input.装载舱位.trim(),
    复核人员: (input.复核人员 ?? '').trim() || '—',
    作业状态: STATUS_WAIT_LOAD,
    退回次数: 0,
  }
  writeBaggageRows([...rows, entry])
  return { ok: true, message: `行李作业${entry.作业编号}已登记，当前状态「待装载」` }
}

// 航班保障待办：退回结果落到航班保障模块，按作业编号 upsert，
// 同一件作业反复退回只保留一条待办，不会刷出一堆重复项。
function flightTodoCode(row: EntryRow): string {
  return `FLIG-T-${String(row.作业编号)}`
}

function upsertFlightTodo(row: EntryRow, reason: string): void {
  const flights = listRows(FLIGHT_KEY).map((flight) => ({ ...flight }))
  const code = flightTodoCode(row)
  const note =
    `行李作业${String(row.作业编号)}复核退回：${reason}；` +
    `舱位${String(row.装载舱位)}，传送带${String(row.传送带编号)}，待重新装机`
  const index = flights.findIndex((flight) => flight.保障编号 === code)
  if (index >= 0) {
    flights[index] = {
      ...flights[index],
      status: '待接收',
      pending: true,
      abnormal: true,
      航班号: row.航班号,
      保障班组: row.装卸班组,
      保障状态: note,
    }
  } else {
    const id = flights.reduce((max, flight) => Math.max(max, Number(flight.id) || 0), 0) + 1
    flights.push({
      id,
      status: '待接收',
      pending: true,
      abnormal: true,
      保障编号: code,
      航班号: row.航班号,
      机型: '—',
      计划到达: new Date().toISOString().slice(0, 10),
      机位号: '—',
      保障等级: '行李复核退回',
      保障班组: row.装卸班组,
      保障状态: note,
    })
  }
  saveRows(FLIGHT_KEY, flights)
}

function closeFlightTodo(row: EntryRow): void {
  const flights = listRows(FLIGHT_KEY).map((flight) => ({ ...flight }))
  const code = flightTodoCode(row)
  const index = flights.findIndex((flight) => flight.保障编号 === code)
  if (index < 0) return
  flights[index] = {
    ...flights[index],
    status: '保障完成',
    pending: false,
    abnormal: false,
    保障状态: `行李作业${String(row.作业编号)}已重新复核并确认装机，退回办结`,
  }
  saveRows(FLIGHT_KEY, flights)
}

export function exportBaggageCsv(): { filename: string; content: string } {
  const header = [
    '编号', '作业编号', '航班号', '行李件数', '装卸班组', '传送带编号', '装载舱位',
    '复核人员', '已装机件数', '舱带核对', '退回次数', '当前状态',
  ]
  const lines = [header.join(',')]
  for (const row of readBaggageRows().map(withDerived)) {
    lines.push(
      [
        row.id, row.作业编号, row.航班号, row.行李件数, row.装卸班组, row.传送带编号,
        row.装载舱位, row.复核人员, row.已装机件数, row.核对结果, row.退回次数, row.status,
      ].join(','),
    )
  }
  return { filename: '行李装卸-清单.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadBaggageCsv(): void {
  const { filename, content } = exportBaggageCsv()
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
