<template>
  <section class="page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李装卸管理</h2>
        <p class="page-desc">维护行李作业：按舱位汇总复核、批量提交复核、逐条退回重报，状态按待装载 → 装载中 → 待复核 → 已装机依次推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记行李作业</button>
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
      <h3>按舱位汇总</h3>
      <p class="panel-note">汇总由明细行实时归集，不单独存储；与明细冲突时以明细行的登记件数为准。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>装载舱位</th>
            <th>明细条数</th>
            <th>登记件数</th>
            <th>待装载</th>
            <th>装载中</th>
            <th>待复核</th>
            <th>已装机件数</th>
            <th>舱带不匹配</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in summaries" :key="item.舱位">
            <td>{{ item.舱位 }}</td>
            <td>{{ item.条数 }}</td>
            <td>{{ item.登记件数 }}</td>
            <td>{{ item.待装载件数 }}</td>
            <td>{{ item.装载中件数 }}</td>
            <td>{{ item.待复核件数 }}</td>
            <td>{{ item.已装机件数 }}</td>
            <td :class="{ 'error-text': item.不匹配条数 > 0 }">{{ item.不匹配条数 }}</td>
          </tr>
          <tr v-if="!summaries.length">
            <td colspan="8" class="empty-state">暂无汇总数据</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="createOpen" class="panel">
      <h3>登记行李作业</h3>
      <form class="filter-bar" @submit.prevent="submitCreate">
        <label v-for="field in createFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="createForm[field]" :placeholder="`请输入${field}`" />
        </label>
        <button class="btn primary" type="submit">保存登记</button>
        <button class="btn ghost" type="button" @click="toggleCreate">取消</button>
      </form>
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
      <span>已选 {{ selectedIds.length }} 条（仅「装载中」的明细可提交复核）</span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="submitBatch">
        批量提交复核
      </button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>已装机件数</th>
          <th>舱带核对</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :disabled="row.status !== '装载中'"
              :checked="selectedIds.includes(Number(row.id))"
              @change="toggleSelect(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.已装机件数 }}</td>
          <td :class="row.核对匹配 ? 'match-text' : 'error-text'">{{ row.核对结果 }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button v-if="row.status === '待装载'" class="link" type="button" @click="startLoading(row)">
              开始装载
            </button>
            <button v-if="row.status === '装载中'" class="link" type="button" @click="submitSingle(row)">
              提交复核
            </button>
            <button v-if="row.status === '待复核'" class="link" type="button" @click="confirmLoaded(row)">
              确认装机
            </button>
            <button class="link" type="button" @click="openDetail(row)">
              {{ row.status === '待复核' ? '退回/详情' : '详情' }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无行李装卸数据，可先登记行李作业</td>
        </tr>
      </tbody>
    </table>

    <section v-if="current" class="panel">
      <h3>作业详情：{{ current.作业编号 }}（{{ current.status }}）</h3>
      <dl class="detail-grid">
        <template v-for="field in detailFields" :key="field">
          <dt>{{ field }}</dt>
          <dd>{{ current[field] ?? '—' }}</dd>
        </template>
        <dt>已装机件数</dt>
        <dd>{{ current.已装机件数 }}</dd>
        <dt>舱带核对</dt>
        <dd :class="current.核对匹配 ? 'match-text' : 'error-text'">{{ current.核对结果 }}</dd>
        <dt>退回次数</dt>
        <dd>{{ current.退回次数 }}</dd>
        <dt>退回原因</dt>
        <dd>{{ current.退回原因 || '—' }}</dd>
      </dl>

      <div v-if="current.status === '待复核'" class="return-box">
        <label class="filter-item">
          <span>退回原因</span>
          <input v-model="returnReason" placeholder="例如：舱位与传送带对不上，件数需重报" />
        </label>
        <button class="btn primary" type="button" @click="confirmReturn">确认退回该条</button>
        <p class="panel-note">
          退回只作用于当前这一条：状态退回「装载中」，派生件数同步回落，同批其他明细不受影响；
          重复退回会被拒绝，不会反复扣减。
        </p>
      </div>

      <div v-if="current.status === '待装载' || current.status === '装载中'" class="report-box">
        <h4>重报登记（仅待装载 / 装载中可改）</h4>
        <div class="filter-bar">
          <label class="filter-item">
            <span>行李件数</span>
            <input v-model="reportForm.行李件数" />
          </label>
          <label class="filter-item">
            <span>传送带编号</span>
            <input v-model="reportForm.传送带编号" />
          </label>
          <label class="filter-item">
            <span>装载舱位</span>
            <input v-model="reportForm.装载舱位" />
          </label>
          <button class="btn primary" type="button" @click="saveReport">保存重报</button>
        </div>
      </div>

      <button class="btn ghost" type="button" @click="closeDetail">关闭详情</button>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条行李装卸记录</span>
      <span v-if="message" :class="messageOk ? 'match-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  baggageStats,
  confirmBaggageLoaded,
  createBaggageEntry,
  downloadBaggageCsv,
  listBaggageEntries,
  returnBaggageEntry,
  startBaggageLoading,
  submitBaggageReview,
  summarizeBaggageByCompartment,
  updateBaggageReport,
} from '@/api/baggage-service'
import type { CompartmentSummary } from '@/api/baggage-service'
import type { ActionResult, EntryRow } from '@/data/types'

const columns = ["作业编号", "航班号", "行李件数", "装卸班组", "传送带编号", "装载舱位", "复核人员"]
const statuses = ["待装载", "装载中", "待复核", "已装机"]
const detailFields = [...columns, "作业状态"]
const createFields = ["航班号", "行李件数", "装卸班组", "传送带编号", "装载舱位", "复核人员"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const summaries = ref<CompartmentSummary[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const current = ref<EntryRow | null>(null)
const returnReason = ref('')
const reportForm = ref({ 行李件数: '', 传送带编号: '', 装载舱位: '' })
const createOpen = ref(false)
const createForm = ref<Record<string, string>>({})
const message = ref('')
const messageOk = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function show(result: ActionResult) {
  message.value = result.message
  messageOk.value = result.ok
}

function reload() {
  try {
    const payload = listBaggageEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    summaries.value = summarizeBaggageByCompartment()
    stats.value = baggageStats()
    // 详情面板跟着最新数据走，不拿旧行继续操作
    if (current.value) {
      const fresh = listBaggageEntries({}).items.find(
        (row) => Number(row.id) === Number(current.value?.id),
      )
      current.value = fresh ?? null
    }
  } catch (error) {
    show({ ok: false, message: error instanceof Error ? error.message : '行李装卸列表读取失败' })
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function toggleSelect(row: EntryRow) {
  const id = Number(row.id)
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function submitBatch() {
  const result = submitBaggageReview(selectedIds.value)
  const failed = result.items.filter((item) => !item.ok)
  show({
    ok: result.ok,
    message: failed.length
      ? `${result.message}（${failed.map((item) => `#${item.id} ${item.message}`).join('；')}）`
      : result.message,
  })
  selectedIds.value = []
  reload()
}

function submitSingle(row: EntryRow) {
  const result = submitBaggageReview([Number(row.id)])
  show(result)
  reload()
}

function startLoading(row: EntryRow) {
  show(startBaggageLoading(Number(row.id)))
  reload()
}

function confirmLoaded(row: EntryRow) {
  show(confirmBaggageLoaded(Number(row.id)))
  reload()
}

function openDetail(row: EntryRow) {
  current.value = row
  returnReason.value = ''
  reportForm.value = {
    行李件数: String(row.行李件数 ?? ''),
    传送带编号: String(row.传送带编号 ?? ''),
    装载舱位: String(row.装载舱位 ?? ''),
  }
}

function closeDetail() {
  current.value = null
}

function confirmReturn() {
  if (!current.value) return
  show(returnBaggageEntry(Number(current.value.id), returnReason.value))
  returnReason.value = ''
  reload()
}

function saveReport() {
  if (!current.value) return
  show(
    updateBaggageReport(Number(current.value.id), {
      行李件数: reportForm.value.行李件数,
      传送带编号: reportForm.value.传送带编号,
      装载舱位: reportForm.value.装载舱位,
    }),
  )
  reload()
}

function toggleCreate() {
  createOpen.value = !createOpen.value
  createForm.value = {}
}

function submitCreate() {
  const result = createBaggageEntry({
    航班号: createForm.value.航班号 ?? '',
    行李件数: createForm.value.行李件数 ?? '',
    装卸班组: createForm.value.装卸班组 ?? '',
    传送带编号: createForm.value.传送带编号 ?? '',
    装载舱位: createForm.value.装载舱位 ?? '',
    复核人员: createForm.value.复核人员 ?? '',
  })
  show(result)
  if (result.ok) {
    createOpen.value = false
    createForm.value = {}
  }
  reload()
}

function exportRows() {
  downloadBaggageCsv()
}

onMounted(reload)
</script>
