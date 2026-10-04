import { beforeEach, describe, expect, it } from 'vitest'

import {
  confirmBaggageLoaded,
  createBaggageEntry,
  listBaggageEntries,
  returnBaggageEntry,
  startBaggageLoading,
  submitBaggageReview,
  summarizeBaggageByCompartment,
  updateBaggageReport,
} from '@/api/baggage-service'
import { listRows, resetRows } from '@/data/local-store'

// 种子：1=已装机(46,1H/BLT-01) 2=待复核(52,2H/BLT-03) 3=待复核(38,1H/BLT-05 不匹配)
//      4=装载中(61,2H/BLT-03) 5=装载中(27,3H/BLT-05) 6=待装载(33,4H/BLT-06)
beforeEach(() => {
  resetRows('baggage')
  resetRows('flight')
})

function rowOf(id: number) {
  const row = listBaggageEntries({}).items.find((item) => Number(item.id) === id)
  if (!row) throw new Error(`行 ${id} 不存在`)
  return row
}

function summaryOf(compartment: string) {
  const summary = summarizeBaggageByCompartment().find((item) => item.舱位 === compartment)
  if (!summary) throw new Error(`舱位 ${compartment} 没有汇总`)
  return summary
}

describe('批量提交复核', () => {
  it('逐行独立流转，一条被退回不牵连同批其他行', () => {
    const batch = submitBaggageReview([4, 5])
    expect(batch.ok).toBe(true)
    expect(rowOf(4).status).toBe('待复核')
    expect(rowOf(5).status).toBe('待复核')
    expect(summaryOf('2H').待复核件数).toBe(52 + 61)
    expect(summaryOf('3H').待复核件数).toBe(27)

    // 退回其中一条：只有这条的件数回落，其余照常留在待复核
    const returned = returnBaggageEntry(4, '件数对不上')
    expect(returned.ok).toBe(true)
    expect(rowOf(4).status).toBe('装载中')
    expect(rowOf(5).status).toBe('待复核')
    expect(rowOf(2).status).toBe('待复核')
    expect(summaryOf('2H').待复核件数).toBe(52)
    expect(summaryOf('2H').装载中件数).toBe(61)
  })

  it('状态不对的行被单独跳过，不影响同批其他行', () => {
    const batch = submitBaggageReview([4, 6])
    expect(batch.items.find((item) => item.id === 4)?.ok).toBe(true)
    expect(batch.items.find((item) => item.id === 6)?.ok).toBe(false)
    expect(rowOf(4).status).toBe('待复核')
    expect(rowOf(6).status).toBe('待装载')
  })
})

describe('退回', () => {
  it('重复退回只扣一次：第二次被拒绝，件数与待办都不再变', () => {
    submitBaggageReview([4])
    expect(returnBaggageEntry(4, '件数对不上').ok).toBe(true)
    const afterFirst = summarizeBaggageByCompartment()
    const again = returnBaggageEntry(4, '再退一次')
    expect(again.ok).toBe(false)
    expect(rowOf(4).退回次数).toBe(1)
    expect(summarizeBaggageByCompartment()).toEqual(afterFirst)
    const todos = listRows('flight').filter((row) => row.保障编号 === 'FLIG-T-BAGG-0004')
    expect(todos).toHaveLength(1)
  })

  it('被退回的行派生件数同步回落，已装机栏不挂旧值', () => {
    submitBaggageReview([4])
    returnBaggageEntry(4, '舱位与传送带对不上')
    const row = rowOf(4)
    expect(row.status).toBe('装载中')
    expect(row.已装机件数).toBe(0)
    expect(summaryOf('2H').已装机件数).toBe(0)
  })

  it('退回结果落到航班保障待办清单，确认装机后自动办结', () => {
    returnBaggageEntry(3, '舱位与传送带对不上')
    let todo = listRows('flight').find((row) => row.保障编号 === 'FLIG-T-BAGG-0003')
    expect(todo?.pending).toBe(true)
    expect(todo?.abnormal).toBe(true)
    expect(String(todo?.保障状态)).toContain('BAGG-0003')

    // 重报修正 → 重新提交复核 → 确认装机，待办关闭
    expect(updateBaggageReport(3, { 传送带编号: 'BLT-01' }).ok).toBe(true)
    expect(submitBaggageReview([3]).ok).toBe(true)
    expect(confirmBaggageLoaded(3).ok).toBe(true)
    todo = listRows('flight').find((row) => row.保障编号 === 'FLIG-T-BAGG-0003')
    expect(todo?.pending).toBe(false)
    expect(todo?.status).toBe('保障完成')
  })
})

describe('状态机', () => {
  it('只能按 待装载→装载中→待复核→已装机 推进，不许跳步', () => {
    expect(submitBaggageReview([6]).ok).toBe(false) // 待装载不能跳装载中直接提复核
    expect(confirmBaggageLoaded(4).ok).toBe(false) // 装载中不能跳待复核直接装机
    expect(startBaggageLoading(2).ok).toBe(false) // 待复核不能倒回开始装载
    expect(startBaggageLoading(6).ok).toBe(true)
    expect(submitBaggageReview([6]).ok).toBe(true)
    expect(confirmBaggageLoaded(6).ok).toBe(true)
    expect(rowOf(6).status).toBe('已装机')
  })

  it('舱带不匹配的行不能确认装机，必须先退回重报', () => {
    const result = confirmBaggageLoaded(3)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('退回重报')
    expect(rowOf(3).核对匹配).toBe(false)
    expect(String(rowOf(3).核对结果)).toContain('BLT-05')
  })
})

describe('件数同源', () => {
  it('汇总与明细同源：各舱位归集合计等于明细登记件数之和', () => {
    const entries = listBaggageEntries({}).items
    const summaries = summarizeBaggageByCompartment()
    const detailTotal = entries.reduce((sum, row) => sum + Number(row.行李件数), 0)
    const summaryTotal = summaries.reduce((sum, item) => sum + item.登记件数, 0)
    expect(summaryTotal).toBe(detailTotal)
    // 已装机件数也是派生：只有已装机的行计入
    expect(rowOf(1).已装机件数).toBe(46)
    expect(rowOf(2).已装机件数).toBe(0)
    expect(summaries.reduce((sum, item) => sum + item.已装机件数, 0)).toBe(46)
  })

  it('确认装机后派生件数按登记件数计入，重报改数后口径一致', () => {
    expect(confirmBaggageLoaded(2).ok).toBe(true)
    expect(rowOf(2).已装机件数).toBe(52)
    expect(summaryOf('2H').已装机件数).toBe(52)
  })
})

describe('登记与重报', () => {
  it('登记新作业进入待装载，件数必须为正整数', () => {
    expect(createBaggageEntry({ 航班号: '', 行李件数: 10, 装卸班组: '装卸一组', 传送带编号: 'BLT-01', 装载舱位: '1H' }).ok).toBe(false)
    expect(createBaggageEntry({ 航班号: 'HO1298', 行李件数: 'abc', 装卸班组: '装卸一组', 传送带编号: 'BLT-01', 装载舱位: '1H' }).ok).toBe(false)
    const created = createBaggageEntry({ 航班号: 'HO1298', 行李件数: '25', 装卸班组: '装卸一组', 传送带编号: 'BLT-02', 装载舱位: '1H' })
    expect(created.ok).toBe(true)
    const row = listBaggageEntries({}).items.find((item) => item.航班号 === 'HO1298')
    expect(row?.status).toBe('待装载')
    expect(row?.行李件数).toBe(25)
  })

  it('重报只能在待装载/装载中改登记，待复核行改不动', () => {
    expect(updateBaggageReport(2, { 行李件数: 99 }).ok).toBe(false)
    expect(updateBaggageReport(4, { 行李件数: 60 }).ok).toBe(true)
    expect(rowOf(4).行李件数).toBe(60)
  })
})
