<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  IdentifyLog,
  ReconcileItem,
  ReconcileKind,
  ReconcileStatus,
  ReceiptBatch,
  ReceiptStatus,
  RunStatus
} from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { CENTER_ENDPOINT_KEY, REVIEWER_KEY, nomenStore } from '@/stores/nomenStore'
import { identifyStore } from '@/stores/identifyStore'

const nomenState = useStore(nomenStore)
const identifyState = useStore(identifyStore)

const STATUS_META: Record<ReconcileStatus, { label: string; type: 'warning' | 'primary' | 'info' | 'success' | 'danger' }> = {
  pending: { label: '待认', type: 'warning' },
  confirmed: { label: '已认', type: 'primary' },
  sent: { label: '已送出', type: 'info' },
  accepted: { label: '中心已收', type: 'success' },
  rejected: { label: '中心拒收', type: 'danger' }
}
const KIND_META: Record<ReconcileKind, { label: string; type: 'danger' | 'info' }> = {
  merged: { label: '并名', type: 'danger' },
  review: { label: '版本复核', type: 'info' }
}
const RUN_META: Record<RunStatus, { label: string; type: 'info' | 'warning' | 'success' }> = {
  queued: { label: '排队中', type: 'info' },
  running: { label: '对账中', type: 'warning' },
  done: { label: '已完成', type: 'success' }
}
const RECEIPT_META: Record<ReceiptStatus, { label: string; type: 'warning' | 'success' | 'danger' }> = {
  pending: { label: '待发送', type: 'warning' },
  sent: { label: '已送出', type: 'success' },
  failed: { label: '发送失败', type: 'danger' }
}

/** 示例称谓表：演示并名（Lepista sordida → Lepista nuda）与未收录提示 */
const SAMPLE_LIST = {
  version: '2026.10',
  issuedAt: '2026-10-01',
  note: '示例称谓表：演示并名与版本复核',
  entries: [
    { accepted: 'Lepista nuda', synonyms: ['Lepista sordida', 'Clitocybe nuda'] },
    { accepted: 'Suillus luteus', synonyms: ['Boletus luteus'] },
    { accepted: 'Boletus edulis', synonyms: [] }
  ]
}

/* ---------- 统计 ---------- */
const currentList = computed(() => nomenState.lists[0] ?? null)
const pendingCount = computed(() => nomenState.items.filter((item) => item.status === 'pending').length)
const readyCount = computed(() => nomenState.items.filter((item) => item.status === 'confirmed' && !item.receiptId).length)
const rejectedItems = computed(() => nomenState.items.filter((item) => item.status === 'rejected'))
const endpoint = ref(localStorage.getItem(CENTER_ENDPOINT_KEY) ?? '')

function synonymCount(entries: { synonyms: string[] }[]): number {
  return entries.reduce((sum, entry) => sum + entry.synonyms.length, 0)
}

function fmtTime(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '—'
}

/* ---------- 待确认列表 ---------- */
const reviewer = ref(localStorage.getItem(REVIEWER_KEY) ?? '')
const filterStatus = ref<ReconcileStatus | ''>('pending')
const filterKind = ref<ReconcileKind | ''>('')
const page = ref(1)
const PAGE_SIZE = 20

watch([filterStatus, filterKind], () => {
  page.value = 1
})

const filteredItems = computed(() =>
  nomenState.items.filter((item) => {
    if (filterStatus.value && item.status !== filterStatus.value) return false
    if (filterKind.value && item.kind !== filterKind.value) return false
    return true
  })
)
const pagedItems = computed(() =>
  filteredItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE)
)

/** 原有结论：从鉴定留痕里 join 出依据、置信度与图鉴信息 */
function logOf(item: ReconcileItem): IdentifyLog | null {
  return identifyState.logs.find((log) => log.id === item.identifyId) ?? null
}

async function confirm(item: ReconcileItem): Promise<void> {
  const name = reviewer.value.trim()
  if (!name) {
    ElMessage.warning('请先填写鉴定人署名，再逐条认过')
    return
  }
  localStorage.setItem(REVIEWER_KEY, name)
  await nomenStore.getState().confirmItem(item.id, name)
  ElMessage.success(`${item.recordCode} 已认过：${item.oldName} → ${item.newName}`)
}

/* ---------- 称谓表导入 ---------- */
const importVisible = ref(false)
const importText = ref('')

function fillSample(): void {
  importText.value = JSON.stringify(SAMPLE_LIST, null, 2)
}

async function submitImport(): Promise<void> {
  if (!importText.value.trim()) {
    ElMessage.warning('请先粘贴中心下发的称谓表 JSON')
    return
  }
  const result = await nomenStore.getState().importList(importText.value)
  if (!result.ok) {
    ElMessage.error(result.message)
    return
  }
  ElMessage.success(result.message)
  importVisible.value = false
  importText.value = ''
}

/* ---------- 中心接口配置 ---------- */
const endpointVisible = ref(false)
const endpointDraft = ref('')

function openEndpoint(): void {
  endpointDraft.value = endpoint.value
  endpointVisible.value = true
}

function saveEndpoint(): void {
  endpoint.value = endpointDraft.value.trim()
  localStorage.setItem(CENTER_ENDPOINT_KEY, endpoint.value)
  endpointVisible.value = false
  ElMessage.success(endpoint.value ? '中心接口已配置，回执将直接 POST 送达' : '已清空中心接口，回执将导出文件人工转交')
}

/* ---------- 回执 ---------- */
async function buildReceipt(): Promise<void> {
  const count = await nomenStore.getState().buildReceipt()
  if (count === 0) {
    ElMessage.info('没有已认待入回执的条目，请先在待确认列表逐条认过')
    return
  }
  ElMessage.success(`已把 ${count} 条认过的结论攒成回执，可发送或导出`)
}

async function sendReceipt(batch: ReceiptBatch): Promise<void> {
  const result = await nomenStore.getState().sendReceipt(batch.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.error(result.message)
}

/* ---------- 中心回执结果 ---------- */
const resultVisible = ref(false)
const resultBatch = ref<ReceiptBatch | null>(null)
const resultText = ref('')

function openResult(batch: ReceiptBatch): void {
  resultBatch.value = batch
  resultText.value = ''
  resultVisible.value = true
}

function fillResultTemplate(): void {
  if (!resultBatch.value) return
  resultText.value = JSON.stringify(
    {
      batchId: resultBatch.value.id,
      accepted: resultBatch.value.itemIds.slice(0, 1),
      rejected: [{ itemId: 'rci_条目ID', reason: '中心填写的拒收理由' }]
    },
    null,
    2
  )
}

async function submitResult(): Promise<void> {
  if (!resultBatch.value) return
  if (!resultText.value.trim()) {
    ElMessage.warning('请粘贴中心返回的回执结果 JSON')
    return
  }
  const result = await nomenStore.getState().applyCenterResult(resultBatch.value.id, resultText.value)
  if (!result.ok) {
    ElMessage.error(result.message)
    return
  }
  ElMessage.success(result.message)
  resultVisible.value = false
}

async function resubmit(item: ReconcileItem): Promise<void> {
  await nomenStore.getState().resubmitItem(item.id)
  ElMessage.success(`${item.recordCode} 已重新入队，等待攒入下一张回执`)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">称谓对账</h2>
        <p class="page-sub">
          粘贴名录中心下发的称谓表，与鉴定留痕逐条对账：并名与版本变动由鉴定人逐条认过，认过的攒成回执送回中心，拒收的留本地写清理由。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="openEndpoint">
          <el-icon><Connection /></el-icon>{{ endpoint ? '中心接口已配置' : '配置中心接口' }}
        </el-button>
        <el-button type="primary" @click="importVisible = true">
          <el-icon><Upload /></el-icon>粘贴导入称谓表
        </el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-tag type="info" effect="plain">当前称谓版本：{{ currentList?.version ?? '未导入' }}</el-tag>
      <el-tag type="warning" effect="plain">待认 {{ pendingCount }}</el-tag>
      <el-tag effect="plain">已认待回执 {{ readyCount }}</el-tag>
      <el-tag type="danger" effect="plain">中心拒收 {{ rejectedItems.length }}</el-tag>
      <el-tag :type="endpoint ? 'success' : 'info'" effect="plain">
        {{ endpoint ? '回执走中心接口 POST' : '回执导出文件人工转交' }}
      </el-tag>
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>中心称谓表</span>
          <span v-if="currentList" class="muted">
            接受名 {{ currentList.entries.length }} 个 · 已并入老名字 {{ synonymCount(currentList.entries) }} 个
          </span>
        </div>
      </template>
      <template v-if="currentList">
        <p class="current-line">
          <el-tag type="success" effect="dark">当前版本 {{ currentList.version }}</el-tag>
          <span class="muted">
            下发 {{ currentList.issuedAt }} · 导入 {{ fmtTime(currentList.importedAt) }}
            <template v-if="currentList.note"> · {{ currentList.note }}</template>
          </span>
        </p>
        <el-table v-if="nomenState.lists.length > 1" :data="nomenState.lists" border stripe size="small">
          <el-table-column prop="version" label="称谓版本" width="120" />
          <el-table-column prop="issuedAt" label="下发日期" width="110" />
          <el-table-column label="接受名 / 异名" width="140">
            <template #default="{ row }: { row: (typeof nomenState.lists)[number] }">
              {{ row.entries.length }} / {{ synonymCount(row.entries) }}
            </template>
          </el-table-column>
          <el-table-column label="导入时间" min-width="150">
            <template #default="{ row }: { row: (typeof nomenState.lists)[number] }">
              {{ fmtTime(row.importedAt) }}
            </template>
          </el-table-column>
          <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
      </template>
      <el-empty v-else description="尚未导入称谓表。点右上角「粘贴导入称谓表」，把中心下发的 JSON 粘进来即可开始对账。" />
    </el-card>

    <el-card v-if="nomenState.runs.length > 0" shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>对账运行（大批量排队分批执行）</span>
          <span class="muted">每批 200 条，批间让出主线程，不卡界面</span>
        </div>
      </template>
      <el-table :data="nomenState.runs" border stripe size="small">
        <el-table-column prop="version" label="目标版本" width="110" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }: { row: (typeof nomenState.runs)[number] }">
            <el-tag :type="RUN_META[row.status].type" size="small" effect="dark">
              {{ RUN_META[row.status].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进度" min-width="180">
          <template #default="{ row }: { row: (typeof nomenState.runs)[number] }">
            <el-progress
              :percentage="row.total ? Math.round((row.processed / row.total) * 100) : 0"
              :stroke-width="8"
            />
            <span class="muted">{{ row.processed }} / {{ row.total }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="affected" label="受影响" width="90" />
        <el-table-column label="中心未收录" width="110">
          <template #default="{ row }: { row: (typeof nomenState.runs)[number] }">
            <span :class="{ warn: row.unmatched > 0 }">{{ row.unmatched }}</span>
          </template>
        </el-table-column>
        <el-table-column label="发起时间" min-width="140">
          <template #default="{ row }: { row: (typeof nomenState.runs)[number] }">
            {{ fmtTime(row.createdAt) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>待确认（{{ filteredItems.length }} 条）</span>
          <div class="reviewer-box">
            <span class="muted">鉴定人署名</span>
            <el-input v-model="reviewer" placeholder="认过前必填，如 祁野" style="width: 180px" size="small" />
          </div>
        </div>
      </template>
      <div class="filter-line">
        <el-select v-model="filterStatus" placeholder="全部状态" clearable style="width: 150px" size="small">
          <el-option v-for="(meta, status) in STATUS_META" :key="status" :label="meta.label" :value="status" />
        </el-select>
        <el-select v-model="filterKind" placeholder="全部类型" clearable style="width: 150px" size="small">
          <el-option v-for="(meta, kind) in KIND_META" :key="kind" :label="meta.label" :value="kind" />
        </el-select>
        <span class="muted">没认的照旧留着；中心再改版时，未认完的会按新表重新生成</span>
      </div>
      <el-table :data="pagedItems" border stripe>
        <el-table-column prop="recordCode" label="采集编号" width="130">
          <template #default="{ row }: { row: ReconcileItem }">
            <span class="mono">{{ row.recordCode }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }: { row: ReconcileItem }">
            <el-tag :type="KIND_META[row.kind].type" size="small" effect="plain">
              {{ KIND_META[row.kind].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结论变化" min-width="220">
          <template #default="{ row }: { row: ReconcileItem }">
            <span class="old-name">{{ row.oldName }}</span>
            <el-icon class="arrow"><Right /></el-icon>
            <span class="new-name">{{ row.newName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="原有结论" min-width="200">
          <template #default="{ row }: { row: ReconcileItem }">
            <template v-if="logOf(row)">
              <div class="muted">依据 {{ logOf(row)?.basis }} · 置信度 {{ logOf(row)?.confidence }}</div>
              <div class="muted">
                {{ logOf(row)?.referenceBook || '—' }} {{ logOf(row)?.referencePage }} · {{ logOf(row)?.date }}
              </div>
            </template>
            <span v-else class="muted">留痕已清理</span>
          </template>
        </el-table-column>
        <el-table-column label="原称谓版本" width="110">
          <template #default="{ row }: { row: ReconcileItem }">
            <span class="muted">{{ row.fromVersion || '未标注' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }: { row: ReconcileItem }">
            <el-tag :type="STATUS_META[row.status].type" size="small" effect="dark">
              {{ STATUS_META[row.status].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="170">
          <template #default="{ row }: { row: ReconcileItem }">
            <el-button v-if="row.status === 'pending'" type="primary" size="small" @click="confirm(row)">
              认过
            </el-button>
            <span v-else-if="row.status === 'rejected'" class="muted" :title="row.rejectReason">理由：{{ row.rejectReason }}</span>
            <span v-else class="muted">{{ row.confirmedBy }} · {{ row.confirmedAt }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="filteredItems.length > PAGE_SIZE" class="pager">
        <el-pagination
          v-model:current-page="page"
          :page-size="PAGE_SIZE"
          :total="filteredItems.length"
          layout="total, prev, pager, next"
        />
      </div>
      <el-empty v-if="filteredItems.length === 0" description="没有命中筛选的对账条目" />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>回执（认过的攒批送回中心）</span>
          <el-button type="primary" plain size="small" :disabled="readyCount === 0" @click="buildReceipt">
            把 {{ readyCount }} 条已认攒成回执
          </el-button>
        </div>
      </template>
      <el-table v-if="nomenState.receipts.length > 0" :data="nomenState.receipts" border stripe size="small">
        <el-table-column label="批次号" width="200">
          <template #default="{ row }: { row: ReceiptBatch }">
            <span class="mono">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="条目数" width="80">
          <template #default="{ row }: { row: ReceiptBatch }">
            {{ row.itemIds.length }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }: { row: ReceiptBatch }">
            <el-tag :type="RECEIPT_META[row.status].type" size="small" effect="dark">
              {{ RECEIPT_META[row.status].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="attempts" label="尝试" width="70" />
        <el-table-column label="最近错误" min-width="160">
          <template #default="{ row }: { row: ReceiptBatch }">
            <span class="muted">{{ row.lastError || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="送出时间" min-width="140">
          <template #default="{ row }: { row: ReceiptBatch }">
            {{ row.sentAt ? fmtTime(row.sentAt) : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240">
          <template #default="{ row }: { row: ReceiptBatch }">
            <el-button v-if="row.status !== 'sent'" type="primary" size="small" @click="sendReceipt(row)">
              {{ row.status === 'failed' ? '从站侧重试' : '发送回执' }}
            </el-button>
            <el-button v-else size="small" @click="openResult(row)">导入中心结果</el-button>
            <el-button size="small" plain @click="sendReceipt(row)">
              {{ row.status === 'sent' ? '再次导出' : '导出' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="还没有回执批次。认过的条目会先攒在这里，再统一送回中心。" />
    </el-card>

    <el-card v-if="rejectedItems.length > 0" shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>中心拒收（留在本地，已写清理由）</span>
          <span class="muted">可修改结论后重新提交，随下一张回执再送中心</span>
        </div>
      </template>
      <el-table :data="rejectedItems" border stripe size="small">
        <el-table-column prop="recordCode" label="采集编号" width="130">
          <template #default="{ row }: { row: ReconcileItem }">
            <span class="mono">{{ row.recordCode }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结论变化" min-width="200">
          <template #default="{ row }: { row: ReconcileItem }">
            {{ row.oldName }} → {{ row.newName }}
          </template>
        </el-table-column>
        <el-table-column prop="confirmedBy" label="认过人" width="100" />
        <el-table-column prop="rejectReason" label="中心拒收理由" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="120">
          <template #default="{ row }: { row: ReconcileItem }">
            <el-button type="primary" plain size="small" @click="resubmit(row)">重新提交</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="importVisible" title="粘贴导入称谓表" width="640px">
      <p class="dialog-tip">
        把名录中心下发的称谓表 JSON 原样粘进来。格式：
        <code>{ "version": "2026.10", "issuedAt": "2026-10-01", "entries": [{ "accepted": "接受名", "synonyms": ["老名字"] }] }</code>
      </p>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="12"
        placeholder='{"version":"2026.10","entries":[{"accepted":"Lepista nuda","synonyms":["Lepista sordida"]}]}'
      />
      <template #footer>
        <el-button @click="fillSample">填入示例称谓表</el-button>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" @click="submitImport">导入并排队对账</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="endpointVisible" title="中心接口配置" width="480px">
      <p class="dialog-tip">
        配置后回执直接 POST 送达中心；留空则发送时导出 JSON 文件，人工转交。发送失败可从站侧重试，已认条目不会退回。
      </p>
      <el-input v-model="endpointDraft" placeholder="如 https://center.example.com/api/receipts" />
      <template #footer>
        <el-button @click="endpointVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEndpoint">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resultVisible" title="导入中心回执结果" width="640px">
      <p class="dialog-tip">
        中心处理完回执后，把结果 JSON 粘进来：收下的标记完结，拒收的留在本地并写清理由。格式：
        <code>{ "batchId": "…", "accepted": ["条目ID"], "rejected": [{ "itemId": "条目ID", "reason": "理由" }] }</code>
      </p>
      <el-input v-model="resultText" type="textarea" :rows="10" placeholder='{"batchId":"rcp_…","accepted":[],"rejected":[]}' />
      <template #footer>
        <el-button @click="fillResultTemplate">填入模板</el-button>
        <el-button @click="resultVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResult">应用中心结果</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.block {
  border-radius: 12px;
  margin-bottom: 16px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.current-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
}
.reviewer-box {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.old-name {
  color: #a45b1f;
  text-decoration: line-through;
}
.new-name {
  color: #2f7a4d;
  font-weight: 600;
}
.arrow {
  margin: 0 6px;
  vertical-align: middle;
  color: #7f8d82;
}
.warn {
  color: #a45b1f;
  font-weight: 600;
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.dialog-tip {
  margin: 0 0 10px;
  font-size: 12px;
  color: #6f7d72;
  line-height: 1.8;
}
.dialog-tip code {
  padding: 1px 6px;
  border-radius: 4px;
  background: #f7f5f0;
  font-size: 11px;
}
</style>
