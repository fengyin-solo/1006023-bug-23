/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// —— 行李装卸复核域 ——

/** 行李作业明细行：件数以这一份为系统记录，汇总永远由它现算。 */
export type BaggageRow = EntryRow & {
  作业编号: string
  航班号: string
  行李件数: number
  已装机件数: number
  /** 上一次「确认装机」时的已装机件数快照，退回时派生件数回落到它。 */
  上次确认件数: number
  装卸班组: string
  传送带编号: string
  装载舱位: string
  复核人员: string
  退回原因: string
  /** 被退回待重报：航班保障待办清单据此派生，重新提交复核后消除。 */
  退回待重报: boolean
}

/** 按装载舱位归集的汇总行：读取时由明细现算，不落地存储。 */
export type BaggageSummaryRow = {
  装载舱位: string
  作业条数: number
  登记件数: number
  已装机件数: number
  待复核条数: number
  异常条数: number
}

/** 复核问题单：核对不通过的明细，附上具体哪里对不上。 */
export type BaggageIssue = {
  id: number
  作业编号: string
  航班号: string
  传送带编号: string
  装载舱位: string
  问题: string[]
}

/** 批量动作结果：逐条独立处理，成功几条、跳过几条、为什么跳过都要说清。 */
export type BatchActionResult = ActionResult & {
  succeeded: number
  skipped: { id: number; reason: string }[]
}

/** 航班保障待办清单条目：由行李退回记录派生，不另存一份。 */
export type FlightTodo = {
  key: string
  来源: string
  作业编号: string
  航班号: string
  装载舱位: string
  传送带编号: string
  退回原因: string
  当前状态: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
