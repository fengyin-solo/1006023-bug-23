/**
 * 行李复核域验证：直接打服务层 + 数据层（local-store 在无 window 时走内存，node 可跑）。
 * 跑法：npm test（先 esbuild 打包成 mjs 再用 node 执行）。
 */
import assert from 'node:assert/strict'

import {
  confirmBaggageLoaded,
  getBaggageEntry,
  listFlightTodos,
  loadBaggageBoard,
  rejectBaggageEntry,
  reportBaggageEntry,
  resetModule,
  runAction,
  startBaggageLoading,
  submitBaggageReview,
} from '../src/api/local-service'
import { rejectEntry, summarizeByCompartment } from '../src/data/baggage'
import { listRows } from '../src/data/local-store'
import type { BaggageRow } from '../src/data/types'

function baggage(): BaggageRow[] {
  return listRows('baggage') as BaggageRow[]
}

function row(id: number): BaggageRow {
  const found = getBaggageEntry(id)
  assert.ok(found, `应存在编号 ${id} 的行李作业`)
  return found
}

function summaryOf(compartment: string) {
  const item = loadBaggageBoard().summary.find((entry) => entry.装载舱位 === compartment)
  assert.ok(item, `汇总里应有舱位 ${compartment}`)
  return item
}

let passed = 0
function test(name: string, fn: () => void) {
  resetModule('baggage')
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// 1. 状态机：只许 待装载→装载中→待复核→已装机，不许跳步
test('状态机按序推进，不许跳步', () => {
  assert.equal(confirmBaggageLoaded(1).ok, false, '待装载不能直接确认装机')
  assert.equal(submitBaggageReview([1]).succeeded, 0, '待装载不能提交复核')
  assert.equal(startBaggageLoading(1).ok, true)
  assert.equal(confirmBaggageLoaded(1).ok, false, '装载中不能跳过待复核直接确认装机')
  assert.equal(startBaggageLoading(1).ok, false, '装载中不能重复开始装载')
  assert.equal(submitBaggageReview([1]).succeeded, 1)
  assert.equal(String(row(1).status), '待复核')
})

// 2. 批量提交：逐条独立，不符合条件的只跳过那一条
test('批量提交复核逐条独立处理', () => {
  const result = submitBaggageReview([2, 3, 1, 999])
  assert.equal(result.succeeded, 2, '装载中的 2、3 应提交成功')
  assert.equal(result.skipped.length, 2, '待装载的 1 与不存在的 999 应被跳过')
  assert.equal(String(row(2).status), '待复核')
  assert.equal(String(row(3).status), '待复核')
  assert.equal(String(row(1).status), '待装载', '被跳过的行状态不变')
})

// 3. 确认装机拦截核对不通过的单子
test('舱带不符、件数不符的单子不能确认装机', () => {
  const r5 = confirmBaggageLoaded(5)
  assert.equal(r5.ok, false)
  assert.match(r5.message, /舱带不符/)
  const r6 = confirmBaggageLoaded(6)
  assert.equal(r6.ok, false)
  assert.match(r6.message, /件数不符/)
  assert.equal(String(row(5).status), '待复核', '拦截后状态不变')
})

// 4. 退回只作用于出问题的那一行，同批其他行不被牵连；汇总只扣那一行
test('退回只退那一行，整批不被牵连', () => {
  submitBaggageReview([2, 3])
  assert.equal(summaryOf('后舱').已装机件数, 74 + 95 + 60)
  const result = rejectBaggageEntry(5, '舱带不符：BELT-01 应对应前舱')
  assert.equal(result.ok, true)
  assert.equal(String(row(5).status), '装载中')
  assert.equal(Number(row(5).已装机件数), 0, '派生件数回落到上一次确认的值')
  assert.equal(row(5).退回待重报, true)
  // 同批其他行原样保留
  assert.equal(String(row(4).status), '待复核')
  assert.equal(Number(row(4).已装机件数), 95)
  assert.equal(String(row(6).status), '待复核')
  assert.equal(Number(row(6).已装机件数), 45)
  assert.equal(String(row(2).status), '待复核')
  // 汇总只扣被退回那一行
  assert.equal(summaryOf('后舱').已装机件数, 74 + 95)
  assert.equal(summaryOf('后舱').登记件数, 74 + 95 + 60, '登记件数不受退回影响')
})

// 5. 重复退回只扣一次，不许反复扣减
test('重复退回只扣一次', () => {
  assert.equal(rejectBaggageEntry(5, '舱带不符').ok, true)
  assert.equal(summaryOf('后舱').已装机件数, 74 + 95)
  const again = rejectBaggageEntry(5, '再退一次')
  assert.equal(again.ok, false, '已退回的行再退会被状态机挡下')
  assert.equal(summaryOf('后舱').已装机件数, 74 + 95, '汇总不会被反复扣减')
  assert.equal(Number(row(5).已装机件数), 0)
})

// 6. 退回结果落到航班保障待办清单
test('退回结果落到航班保障待办清单', () => {
  assert.equal(listFlightTodos().length, 0)
  rejectBaggageEntry(5, '舱带不符：BELT-01 应对应前舱')
  const todos = listFlightTodos()
  assert.equal(todos.length, 1)
  assert.equal(todos[0].作业编号, 'BAGG-0005')
  assert.equal(todos[0].航班号, 'CZ3901')
  assert.equal(todos[0].传送带编号, 'BELT-01')
  assert.equal(todos[0].退回原因, '舱带不符：BELT-01 应对应前舱')
})

// 7. 重报 → 重新提交 → 待办消除 → 确认装机，完整闭环
test('退回-重报-重新提交-确认装机闭环', () => {
  rejectBaggageEntry(5, '舱带不符')
  assert.equal(listFlightTodos().length, 1)
  // 待复核状态不许直接改，必须先退回（此时已是装载中）
  const fixed = reportBaggageEntry(5, { 装载舱位: '前舱', 已装机件数: 60 })
  assert.equal(fixed.ok, true)
  assert.equal(submitBaggageReview([5]).succeeded, 1)
  assert.equal(listFlightTodos().length, 0, '重新提交后待办自动消除')
  assert.equal(row(5).退回待重报, false)
  const confirmed = confirmBaggageLoaded(5)
  assert.equal(confirmed.ok, true, '核对通过后放行')
  assert.equal(String(row(5).status), '已装机')
  assert.equal(Number(row(5).上次确认件数), 60, '确认时留下新快照')
})

// 8. 件数不符那条：退回后已装机件数回落，改对再报才放行
test('件数不符的退回与重报', () => {
  rejectBaggageEntry(6, '件数不符：登记48件，装机45件')
  assert.equal(Number(row(6).已装机件数), 0, '累加出来的 45 件同步回落')
  assert.equal(reportBaggageEntry(6, { 已装机件数: 48 }).ok, true)
  assert.equal(submitBaggageReview([6]).succeeded, 1)
  assert.equal(confirmBaggageLoaded(6).ok, true)
  assert.equal(summaryOf('散货舱').已装机件数, 48)
})

// 9. 汇总与明细同源：合计恒等于明细行现算
test('汇总与明细同源', () => {
  confirmBaggageLoaded(4)
  rejectBaggageEntry(5, '舱带不符')
  const rows = baggage()
  const summary = loadBaggageBoard().summary
  const sum = (field: '行李件数' | '已装机件数') =>
    rows.reduce((acc, item) => acc + Number(item[field]), 0)
  assert.equal(
    summary.reduce((acc, item) => acc + item.登记件数, 0),
    sum('行李件数'),
  )
  assert.equal(
    summary.reduce((acc, item) => acc + item.已装机件数, 0),
    sum('已装机件数'),
  )
  assert.equal(
    summary.reduce((acc, item) => acc + item.作业条数, 0),
    rows.length,
  )
})

// 10. 快照回落：上一次确认的值不是 0 时，退回到那个值而不是清零（纯数据层验证）
test('退回落到上一次确认的值，不留累加残数', () => {
  const synthetic: BaggageRow[] = [
    {
      id: 1,
      status: '待复核',
      pending: true,
      abnormal: false,
      作业编号: 'BAGG-9001',
      航班号: 'CA0001',
      行李件数: 80,
      已装机件数: 80,
      上次确认件数: 50,
      装卸班组: '装卸一班',
      传送带编号: 'BELT-01',
      装载舱位: '前舱',
      复核人员: '周正',
      退回原因: '',
      退回待重报: false,
    },
  ]
  const once = rejectEntry(synthetic, 1, '复核退回')
  assert.equal(once.ok, true)
  assert.equal(Number(once.rows[0].已装机件数), 50, '回落到上一次确认的 50，不留退回前累加的 80')
  const twice = rejectEntry(once.rows, 1, '重复退回')
  assert.equal(twice.ok, false)
  assert.equal(Number(twice.rows[0].已装机件数), 50, '重复退回不再变动')
})

// 11. 通用动作入口也走同一套状态机，旁路绕不开
test('通用 runAction 对行李模块同样受状态机约束', () => {
  assert.equal(runAction('baggage', 1, '确认装机').ok, false, '待装载不能确认装机')
  assert.equal(runAction('baggage', 1, '开始装载').ok, true)
  assert.equal(runAction('baggage', 1, '确认装机').ok, false, '装载中不能跳步到已装机')
  assert.equal(runAction('baggage', 1, '提交复核').ok, true)
  // 件数未报（0 ≠ 120），确认装机被拦，退回后件数回落
  assert.equal(runAction('baggage', 1, '确认装机').ok, false)
  assert.equal(runAction('baggage', 1, '退回重报').ok, true)
  assert.equal(Number(row(1).已装机件数), 0)
  assert.equal(String(row(1).status), '装载中')
})

// 12. 汇总由明细派生：明细一改，汇总跟着变，不存在另存的一份
test('汇总随明细现算，不落地另存', () => {
  const before = summarizeByCompartment(baggage())
  const frontBefore = before.find((item) => item.装载舱位 === '前舱')
  assert.ok(frontBefore)
  reportBaggageEntry(2, { 已装机件数: 80 })
  const after = summarizeByCompartment(baggage())
  const frontAfter = after.find((item) => item.装载舱位 === '前舱')
  assert.ok(frontAfter)
  assert.equal(frontAfter.已装机件数, frontBefore.已装机件数 - 6)
})

console.log(`\n${passed} 项行李复核域验证全部通过`)
