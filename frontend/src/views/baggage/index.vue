<template>
  <section class="page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李装卸管理</h2>
        <p class="page-desc">维护行李作业，围绕作业编号、航班号、行李件数、装卸班组做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记行李作业</button>
        <button class="btn" type="button" @click="exportRows">导出行李装卸清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="panel">
      <h3 class="panel-title">复核汇总（按装载舱位归集，与明细同源现算）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>装载舱位</th>
            <th>作业条数</th>
            <th>登记件数</th>
            <th>已装机件数</th>
            <th>待复核</th>
            <th>异常</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in summary" :key="item.装载舱位">
            <td>{{ item.装载舱位 }}</td>
            <td>{{ item.作业条数 }}</td>
            <td>{{ item.登记件数 }}</td>
            <td>{{ item.已装机件数 }}</td>
            <td>{{ item.待复核条数 }}</td>
            <td>{{ item.异常条数 }}</td>
          </tr>
          <tr class="total-row">
            <td>合计</td>
            <td>{{ summaryTotal.作业条数 }}</td>
            <td>{{ summaryTotal.登记件数 }}</td>
            <td>{{ summaryTotal.已装机件数 }}</td>
            <td>{{ summaryTotal.待复核条数 }}</td>
            <td>{{ summaryTotal.异常条数 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="issues.length" class="panel">
      <h3 class="panel-title">复核待处理：{{ issues.length }} 条对不上，需逐条退回重报</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>作业编号</th>
            <th>航班号</th>
            <th>传送带编号</th>
            <th>装载舱位</th>
            <th>问题</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in issues" :key="String(item.id)">
            <td>{{ item.作业编号 }}</td>
            <td>{{ item.航班号 }}</td>
            <td>{{ item.传送带编号 }}</td>
            <td>{{ item.装载舱位 }}</td>
            <td>
              <span v-for="issue in item.问题" :key="issue" class="tag warn">{{ issue }}</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(Number(item.id))">进详情退回</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="submitBatch">
        批量提交复核（已选 {{ selectedIds.length }} 条）
      </button>
      <span class="batch-hint">仅「装载中」的明细可勾选；逐条独立提交，一条被退回不牵连同批其他行</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>核对结果</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-warn': issuesOf(row).length > 0 }">
          <td>
            <input
              type="checkbox"
              :disabled="row.status !== '装载中'"
              :checked="selectedIds.includes(Number(row.id))"
              @change="toggleSelect(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <template v-if="issuesOf(row).length">
              <span v-for="issue in issuesOf(row)" :key="issue" class="tag warn">{{ issue }}</span>
            </template>
            <span v-else class="tag ok">相符</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button v-if="row.status === '待装载'" class="link" type="button" @click="startLoading(row)">
              开始装载
            </button>
            <button v-if="row.status === '装载中'" class="link" type="button" @click="submitSingle(Number(row.id))">
              提交复核
            </button>
            <button
              v-if="row.status === '待复核'"
              class="link"
              type="button"
              :disabled="issuesOf(row).length > 0"
              :title="issuesOf(row).length > 0 ? '核对不通过，请退回重报' : ''"
              @click="confirmLoaded(Number(row.id))"
            >
              确认装机
            </button>
            <button v-if="row.status === '待复核'" class="link" type="button" @click="openDetail(Number(row.id))">
              退回重报
            </button>
            <button class="link" type="button" @click="openDetail(Number(row.id))">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无行李装卸数据，可先登记行李作业</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="panel">
      <h3 class="panel-title">作业详情：{{ detail.作业编号 }}（{{ detail.status }}）</h3>
      <dl class="detail-grid">
        <dt>航班号</dt>
        <dd>{{ detail.航班号 }}</dd>
        <dt>装卸班组</dt>
        <dd>{{ detail.装卸班组 }}</dd>
        <dt>传送带编号</dt>
        <dd>{{ detail.传送带编号 }}</dd>
        <dt>装载舱位</dt>
        <dd>{{ detail.装载舱位 }}</dd>
        <dt>登记件数</dt>
        <dd>{{ detail.行李件数 }}</dd>
        <dt>已装机件数</dt>
        <dd>{{ detail.已装机件数 }}</dd>
        <dt>上次确认件数</dt>
        <dd>{{ detail.上次确认件数 }}</dd>
        <dt>复核人员</dt>
        <dd>{{ detail.复核人员 }}</dd>
        <dt>核对结果</dt>
        <dd>
          <template v-if="detailIssues.length">
            <span v-for="issue in detailIssues" :key="issue" class="tag warn">{{ issue }}</span>
          </template>
          <span v-else class="tag ok">相符</span>
        </dd>
        <dt>退回原因</dt>
        <dd>{{ detail.退回原因 || '—' }}</dd>
      </dl>

      <div v-if="detail.status === '待复核'" class="action-box">
        <input v-model="rejectReason" placeholder="退回原因（必填）：件数或舱带哪里对不上" />
        <button class="btn primary" type="button" @click="rejectDetail">退回重报</button>
      </div>

      <div v-if="detail.status === '装载中'" class="action-box">
        <label>
          <span>装载舱位</span>
          <select v-model="reportForm.装载舱位">
            <option v-for="item in compartmentOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label>
          <span>传送带编号</span>
          <select v-model="reportForm.传送带编号">
            <option v-for="item in beltOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label>
          <span>已装机件数</span>
          <input v-model.number="reportForm.已装机件数" type="number" min="0" />
        </label>
        <button class="btn" type="button" @click="saveReport">保存重报</button>
        <button class="btn primary" type="button" @click="submitSingle(Number(detail.id))">提交复核</button>
      </div>

      <button class="btn ghost" type="button" @click="closeDetail">收起详情</button>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条行李装卸记录</span>
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmBaggageLoaded,
  downloadEntries,
  getBaggageEntry,
  loadBaggageBoard,
  rejectBaggageEntry,
  reportBaggageEntry,
  startBaggageLoading,
  submitBaggageReview,
} from '@/api/local-service'
import { BELT_COMPARTMENT, COMPARTMENTS, rowIssues } from '@/data/baggage'
import type { BaggageIssue, BaggageRow, BaggageSummaryRow } from '@/data/types'

const columns = ["作业编号", "航班号", "行李件数", "已装机件数", "装卸班组", "传送带编号", "装载舱位", "复核人员"]
const statuses = ["待装载", "装载中", "待复核", "已装机"]

const rows = ref<BaggageRow[]>([])
const total = ref(0)
const summary = ref<BaggageSummaryRow[]>([])
const issues = ref<BaggageIssue[]>([])
const statusCounts = ref<Record<string, number>>({})
const message = ref('')
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const detailId = ref<number | null>(null)
const rejectReason = ref('')
const reportForm = ref<{ 装载舱位: string; 传送带编号: string; 已装机件数: number }>({
  装载舱位: '',
  传送带编号: '',
  已装机件数: 0,
})

const beltOptions = Object.keys(BELT_COMPARTMENT)
const compartmentOptions = COMPARTMENTS

const stats = computed(() => [
  { label: '今日行李作业', value: summaryTotal.value.作业条数 },
  { label: '装载中作业', value: statusCounts.value['装载中'] ?? 0 },
  { label: '待复核作业', value: statusCounts.value['待复核'] ?? 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: statusCounts.value[status] ?? 0,
  })),
)

const summaryTotal = computed(() =>
  summary.value.reduce(
    (acc, item) => ({
      作业条数: acc.作业条数 + item.作业条数,
      登记件数: acc.登记件数 + item.登记件数,
      已装机件数: acc.已装机件数 + item.已装机件数,
      待复核条数: acc.待复核条数 + item.待复核条数,
      异常条数: acc.异常条数 + item.异常条数,
    }),
    { 作业条数: 0, 登记件数: 0, 已装机件数: 0, 待复核条数: 0, 异常条数: 0 },
  ),
)

const detail = computed(() =>
  detailId.value === null ? null : rows.value.find((row) => Number(row.id) === detailId.value) ?? getBaggageEntry(detailId.value),
)

const detailIssues = computed(() => (detail.value ? rowIssues(detail.value) : []))

function issuesOf(row: BaggageRow): string[] {
  return rowIssues(row)
}

function toggleSelect(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function openCreate() {
  errorMessage.value = '行李作业登记入口尚未接入审批流'
}

function exportRows() {
  downloadEntries('baggage')
}

function openDetail(id: number) {
  detailId.value = id
  rejectReason.value = ''
  const entry = getBaggageEntry(id)
  if (entry) {
    reportForm.value = {
      装载舱位: String(entry.装载舱位),
      传送带编号: String(entry.传送带编号),
      已装机件数: Number(entry.已装机件数) || 0,
    }
  }
}

function closeDetail() {
  detailId.value = null
}

function applyResult(result: { ok: boolean; message: string }) {
  reload()
  if (result.ok) {
    message.value = result.message
  } else {
    errorMessage.value = result.message
  }
}

function submitBatch() {
  applyResult(submitBaggageReview(selectedIds.value))
  selectedIds.value = []
}

function submitSingle(id: number) {
  applyResult(submitBaggageReview([id]))
}

function startLoading(row: BaggageRow) {
  applyResult(startBaggageLoading(Number(row.id)))
}

function confirmLoaded(id: number) {
  applyResult(confirmBaggageLoaded(id))
}

function rejectDetail() {
  if (detailId.value === null) return
  applyResult(rejectBaggageEntry(detailId.value, rejectReason.value))
}

function saveReport() {
  if (detailId.value === null) return
  applyResult(reportBaggageEntry(detailId.value, { ...reportForm.value }))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function reload() {
  message.value = ''
  errorMessage.value = ''
  try {
    const board = loadBaggageBoard(filters.value)
    rows.value = board.items
    total.value = board.total
    summary.value = board.summary
    issues.value = board.issues
    statusCounts.value = board.statusCounts
    // 已提交或状态变化的行不再保留勾选，避免误操作
    selectedIds.value = selectedIds.value.filter((id) =>
      board.items.some((row) => Number(row.id) === id && row.status === '装载中'),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '行李装卸列表读取失败'
  }
}

onMounted(reload)
</script>
