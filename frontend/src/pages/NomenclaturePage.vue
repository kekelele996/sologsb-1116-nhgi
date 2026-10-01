<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MergeItem, NomenclatureImport, NomenclatureVersion } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import {
  BATCH_SIZE,
  LARGE_BATCH_THRESHOLD,
  nomenclatureStore
} from '@/stores/nomenclatureStore'

const state = useStore(nomenclatureStore)

/* ---------- 导入称谓表 ---------- */
const importVisible = ref(false)
const importText = ref('')
const confirmerDraft = ref(state.confirmer)

const SAMPLE_SMALL: NomenclatureImport = {
  version: 'v2026.1',
  issuedAt: '2026-09-01',
  source: '国家菌物名录中心',
  note: '首批称谓合并试点，先按老称谓对账',
  merges: [
    { oldName: 'Lepista sordida', acceptedName: 'Lepista nuda' },
    { oldName: 'Boletus sp.', acceptedName: 'Boletus edulis' },
    { oldName: 'Agaricus campestris', acceptedName: 'Agaricus bisporus' }
  ]
}

/** 大批量示例：一次来几千条，演示排队分批对账 */
function buildLargeSample(): NomenclatureImport {
  const merges: NomenclatureImport['merges'] = [
    { oldName: 'Lepista sordida', acceptedName: 'Lepista nuda' },
    { oldName: 'Boletus sp.', acceptedName: 'Boletus edulis' }
  ]
  const genera = ['Agaricus', 'Amanita', 'Boletus', 'Cortinarius', 'Entoloma', 'Hygrocybe', 'Inocybe', 'Lactarius', 'Mycena', 'Russula', 'Suillus', 'Tricholoma']
  const epithets = ['albus', 'ruber', 'viridis', 'flavus', 'niger', 'gracilis', 'crassus', 'tenuis', 'majus', 'minus', 'borealis', 'australis']
  let n = 0
  while (merges.length < 3000) {
    const g = genera[n % genera.length]
    const e = epithets[Math.floor(n / genera.length) % epithets.length]
    merges.push({ oldName: `${g} ${e}`, acceptedName: `${g} ${e} subsp. novum` })
    n += 1
  }
  return {
    version: 'v2026.2',
    issuedAt: '2026-09-15',
    source: '国家菌物名录中心',
    note: '大批量称谓合并（3000 条），演示排队分批对账',
    merges
  }
}

function loadSample(kind: 'small' | 'large'): void {
  const sample = kind === 'small' ? SAMPLE_SMALL : buildLargeSample()
  importText.value = JSON.stringify(sample, null, 2)
}

async function submitImport(): Promise<void> {
  let data: NomenclatureImport
  try {
    data = JSON.parse(importText.value) as NomenclatureImport
  } catch {
    ElMessage.error('JSON 解析失败，请检查格式')
    return
  }
  if (!data.version || !Array.isArray(data.merges) || data.merges.length === 0) {
    ElMessage.error('称谓表缺少 version 或 merges 为空')
    return
  }
  try {
    const { jobId } = await nomenclatureStore.getState().importNomenclature(data)
    importVisible.value = false
    importText.value = ''
    if (data.merges.length >= LARGE_BATCH_THRESHOLD) {
      ElMessage.success(`已导入 ${data.merges.length} 条合并，进入排队分批对账（任务 ${jobId}）`)
    } else {
      ElMessage.success(`已导入 ${data.merges.length} 条合并`)
    }
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

/* ---------- 版本与任务 ---------- */
const selectedVersionId = ref('')
const selectedVersion = computed<NomenclatureVersion | null>(
  () => state.versions.find((item) => item.id === selectedVersionId.value) ?? null
)

// 版本异步加载后，默认选中最新版本
watch(
  () => state.versions,
  (versions) => {
    if (!selectedVersionId.value && versions.length > 0) {
      selectedVersionId.value = versions[0].id
    }
  },
  { immediate: true }
)

const versionMerges = computed(() =>
  state.merges.filter((item) => item.versionId === selectedVersionId.value)
)

const activeJobs = computed(() =>
  state.jobs.filter((item) => item.status === 'queued' || item.status === 'processing')
)

/* ---------- 合并条目统计 ---------- */
function statsOfMerge(mergeId: string) {
  const items = state.mergeItems.filter((item) => item.mergeId === mergeId)
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    confirmed: items.filter((item) => item.status === 'confirmed').length,
    rejected: items.filter((item) => item.status === 'rejected').length
  }
}

const versionStats = computed(() => {
  const items = state.mergeItems.filter((item) => item.versionId === selectedVersionId.value)
  return {
    merges: versionMerges.value.length,
    affected: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    confirmed: items.filter((item) => item.status === 'confirmed').length,
    rejected: items.filter((item) => item.status === 'rejected').length
  }
})

/* ---------- 逐条认过 ---------- */
const itemsVisible = ref(false)
const activeMergeId = ref('')
const activeMerge = computed(() => state.merges.find((item) => item.id === activeMergeId.value) ?? null)
const activeItems = computed(() =>
  state.mergeItems.filter((item) => item.mergeId === activeMergeId.value)
)

function openItems(mergeId: string): void {
  activeMergeId.value = mergeId
  itemsVisible.value = true
}

async function confirmItem(item: MergeItem): Promise<void> {
  await nomenclatureStore.getState().confirmItem(item.id)
  ElMessage.success(`已认过：${item.recordCode} ${item.originalConclusion} → ${activeMerge.value?.acceptedName ?? ''}`)
}

async function confirmAll(): Promise<void> {
  const pending = activeItems.value.filter((item) => item.status === 'pending')
  if (pending.length === 0) {
    ElMessage.info('没有待认条目')
    return
  }
  await ElMessageBox.confirm(`确认认过本合并下全部 ${pending.length} 条受影响条目？`, '批量认过', {
    type: 'warning'
  })
  for (const item of pending) {
    await nomenclatureStore.getState().confirmItem(item.id)
  }
  ElMessage.success(`已认过 ${pending.length} 条`)
}

/* ---------- 回执 ---------- */
const versionReceipts = computed(() =>
  state.receipts.filter((item) => item.versionId === selectedVersionId.value)
)

async function sendReceipt(receiptId: string, force?: 'fail' | 'reject'): Promise<void> {
  await nomenclatureStore.getState().sendReceipt(receiptId, force)
  if (force === 'fail') ElMessage.warning('已模拟发送失败，可重试')
  else if (force === 'reject') ElMessage.warning('已模拟中心拒收，被拒条目留在本地写清理由')
  else ElMessage.success('回执已发送')
}

async function retryReceipt(receiptId: string): Promise<void> {
  await nomenclatureStore.getState().retryReceipt(receiptId)
  ElMessage.success('重试成功，回执已送达')
}

/* ---------- 状态标签 ---------- */
function mergeStatusType(mergeId: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const s = statsOfMerge(mergeId)
  if (s.total === 0) return 'info'
  if (s.rejected > 0) return 'danger'
  if (s.pending === 0) return 'success'
  if (s.confirmed > 0) return 'warning'
  return 'info'
}

function mergeStatusText(mergeId: string): string {
  const s = statsOfMerge(mergeId)
  if (s.total === 0) return '无受影响条目'
  if (s.rejected > 0) return `有拒收（${s.rejected}）`
  if (s.pending === 0) return '已认完'
  if (s.confirmed > 0) return `部分已认（${s.confirmed}/${s.total}）`
  return '待认'
}

function itemStatusTag(status: MergeItem['status']) {
  const map = {
    pending: { type: 'warning', text: '待认' },
    confirmed: { type: 'success', text: '已认' },
    rejected: { type: 'danger', text: '被拒收' }
  } as const
  return map[status]
}

function receiptStatusTag(status: string) {
  const map: Record<string, { type: '' | 'success' | 'warning' | 'danger' | 'info'; text: string }> = {
    draft: { type: 'info', text: '草稿' },
    sent: { type: 'success', text: '已发送' },
    failed: { type: 'danger', text: '发送失败' },
    partial_rejected: { type: 'warning', text: '部分拒收' }
  }
  return map[status] ?? { type: 'info', text: status }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">称谓对账</h2>
        <p class="page-sub">
          把中心下发的称谓表粘进来，跟鉴定留痕对账。老名字并入接受名时，逐条认过才算数；认过的攒成回执送回中心，被拒收的留在本地写清理由。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="importVisible = true">
          <el-icon><Upload /></el-icon>粘贴称谓表
        </el-button>
      </div>
    </div>

    <!-- 大批量任务进度 -->
    <el-card v-for="job in activeJobs" :key="job.id" shadow="never" class="job-card">
      <div class="job-head">
        <div>
          <span class="job-title">对账任务 {{ job.id }}</span>
          <el-tag v-if="job.total >= LARGE_BATCH_THRESHOLD" type="danger" size="small" effect="dark">
            大批量 · 分批处理
          </el-tag>
          <el-tag v-else type="info" size="small">分批处理</el-tag>
        </div>
        <span class="muted">
          {{ job.processed }} / {{ job.total }} 条 · 每批 {{ BATCH_SIZE }} 条
        </span>
      </div>
      <el-progress
        :percentage="job.total === 0 ? 0 : Math.round((job.processed / job.total) * 100)"
        :status="job.status === 'processing' ? undefined : 'success'"
        :stroke-width="10"
      />
      <p class="muted">
        正在排队分批对账，已按老称谓找出先前存下的鉴定结论；处理完成后可在下方逐条认过。
      </p>
    </el-card>

    <!-- 版本概览 -->
    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>称谓版本</span>
          <el-select
            v-model="selectedVersionId"
            placeholder="选择版本"
            style="width: 260px"
            @change="() => {}"
          >
            <el-option v-for="ver in state.versions" :key="ver.id" :label="`${ver.version} · ${ver.mergeCount} 条`" :value="ver.id" />
          </el-select>
        </div>
      </template>
      <el-empty v-if="state.versions.length === 0" description="尚未导入称谓表，点击右上角「粘贴称谓表」开始" />
      <template v-else-if="selectedVersion">
        <div class="version-meta">
          <el-descriptions :column="4" size="small" border>
            <el-descriptions-item label="版本号">{{ selectedVersion.version }}</el-descriptions-item>
            <el-descriptions-item label="下发时间">{{ selectedVersion.issuedAt }}</el-descriptions-item>
            <el-descriptions-item label="来源">{{ selectedVersion.source }}</el-descriptions-item>
            <el-descriptions-item label="合并条数">{{ selectedVersion.mergeCount }}</el-descriptions-item>
          </el-descriptions>
          <div class="stat-row">
            <el-tag type="info" effect="plain">受影响结论 {{ versionStats.affected }}</el-tag>
            <el-tag type="warning" effect="plain">待认 {{ versionStats.pending }}</el-tag>
            <el-tag type="success" effect="plain">已认 {{ versionStats.confirmed }}</el-tag>
            <el-tag type="danger" effect="plain">被拒收 {{ versionStats.rejected }}</el-tag>
          </div>
        </div>

        <el-tabs>
          <el-tab-pane label="称谓合并与受影响条目">
            <el-table :data="versionMerges" border stripe max-height="460">
              <el-table-column label="老名字 → 接受名" min-width="280">
                <template #default="{ row }">
                  <span class="mono">{{ row.oldName }}</span>
                  <el-icon class="arrow"><ArrowRight /></el-icon>
                  <span class="accepted">{{ row.acceptedName }}</span>
                </template>
              </el-table-column>
              <el-table-column label="受影响" width="90" align="center">
                <template #default="{ row }">{{ statsOfMerge(row.id).total }}</template>
              </el-table-column>
              <el-table-column label="待认" width="70" align="center">
                <template #default="{ row }">
                  <el-tag v-if="statsOfMerge(row.id).pending > 0" type="warning" size="small">{{ statsOfMerge(row.id).pending }}</el-tag>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="已认" width="70" align="center">
                <template #default="{ row }">
                  <el-tag v-if="statsOfMerge(row.id).confirmed > 0" type="success" size="small">{{ statsOfMerge(row.id).confirmed }}</el-tag>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="130">
                <template #default="{ row }">
                  <el-tag :type="mergeStatusType(row.id)" size="small" effect="plain">{{ mergeStatusText(row.id) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button size="small" type="primary" plain @click="openItems(row.id)">逐条认过</el-button>
                </template>
              </el-table-column>
              <template #empty>该版本下暂无合并记录</template>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="回执中心">
            <el-table :data="versionReceipts" border stripe max-height="460">
              <el-table-column label="回执号" min-width="180">
                <template #default="{ row }">
                  <span class="mono">{{ row.id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="条目数" width="90" align="center">
                <template #default="{ row }">{{ row.itemCount }}</template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="receiptStatusTag(row.status).type" size="small" effect="plain">
                    {{ receiptStatusTag(row.status).text }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="失败 / 拒收理由" min-width="200">
                <template #default="{ row }">
                  <span v-if="row.failReason" class="fail-reason">{{ row.failReason }}</span>
                  <span v-else-if="row.rejectReason" class="reject-reason">{{ row.rejectReason }}</span>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="重试" width="70" align="center">
                <template #default="{ row }">{{ row.retryCount }}</template>
              </el-table-column>
              <el-table-column label="操作" min-width="280">
                <template #default="{ row }">
                  <template v-if="row.status === 'draft'">
                    <el-button size="small" type="primary" @click="sendReceipt(row.id)">发送回执</el-button>
                    <el-button size="small" @click="sendReceipt(row.id, 'fail')">模拟失败</el-button>
                    <el-button size="small" @click="sendReceipt(row.id, 'reject')">模拟拒收</el-button>
                  </template>
                  <template v-else-if="row.status === 'failed'">
                    <el-button size="small" type="primary" @click="retryReceipt(row.id)">重试</el-button>
                    <el-button size="small" @click="sendReceipt(row.id, 'fail')">再模拟失败</el-button>
                  </template>
                  <span v-else class="muted">已处理</span>
                </template>
              </el-table-column>
              <template #empty>暂无回执，认过的条目会攒成回执送到这里</template>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-card>

    <!-- 逐条认过对话框 -->
    <el-dialog v-model="itemsVisible" title="逐条认过" width="820px">
      <div v-if="activeMerge" class="items-head">
        <span class="mono">{{ activeMerge.oldName }}</span>
        <el-icon><ArrowRight /></el-icon>
        <span class="accepted">{{ activeMerge.acceptedName }}</span>
        <el-tag type="info" size="small" effect="plain">共 {{ activeItems.length }} 条</el-tag>
      </div>
      <div class="items-toolbar">
        <el-input v-model="confirmerDraft" placeholder="鉴定人署名" size="small" style="width: 180px" @change="state.setConfirmer(confirmerDraft)" />
        <el-button size="small" type="primary" plain @click="confirmAll">全部认过</el-button>
      </div>
      <el-table :data="activeItems" border stripe max-height="420">
        <el-table-column prop="recordCode" label="采集编号" width="140" />
        <el-table-column label="原有结论" min-width="160">
          <template #default="{ row }">
            <span class="mono original">{{ row.originalConclusion }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="itemStatusTag(row.status).type" size="small" effect="dark">
              {{ itemStatusTag(row.status).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="认过时间" width="170">
          <template #default="{ row }">{{ row.confirmedAt ? row.confirmedAt.slice(0, 16).replace('T', ' ') : '—' }}</template>
        </el-table-column>
        <el-table-column label="拒收理由" min-width="180">
          <template #default="{ row }">
            <span v-if="row.rejectReason" class="reject-reason">{{ row.rejectReason }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="confirmItem(row)">认过</el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <template #empty>该合并下没有受影响的鉴定结论</template>
      </el-table>
      <template #footer>
        <el-button @click="itemsVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 导入对话框 -->
    <el-dialog v-model="importVisible" title="粘贴中心下发的称谓表" width="640px">
      <el-alert type="info" :closable="false" class="import-tip">
        称谓表为 JSON 格式：version 为版本号，merges 为「老名字 → 接受名」合并列表。粘贴后先排队分批对账，找出先前按老称谓存下的鉴定结论。
      </el-alert>
      <div class="sample-row">
        <el-button size="small" @click="loadSample('small')">载入示例（小批量）</el-button>
        <el-button size="small" @click="loadSample('large')">载入示例（大批量 3000 条）</el-button>
      </div>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="14"
        placeholder='{"version":"v2026.1","merges":[{"oldName":"Lepista sordida","acceptedName":"Lepista nuda"}]}'
        class="import-text"
      />
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" @click="submitImport">导入并对账</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.job-card {
  border-radius: 12px;
  margin-bottom: 16px;
  border-left: 4px solid #c96f3a;
}
.job-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.job-title {
  font-weight: 600;
  margin-right: 8px;
}
.block {
  border-radius: 12px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.version-meta {
  margin-bottom: 14px;
}
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.arrow {
  vertical-align: middle;
  color: #b9a591;
}
.accepted {
  font-weight: 600;
  color: #2f7a4d;
}
.original {
  color: #a45b1f;
}
.fail-reason {
  color: #c0392b;
  font-size: 12px;
}
.reject-reason {
  color: #8a5a1f;
  font-size: 12px;
}
.items-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
}
.items-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.import-tip {
  margin-bottom: 10px;
}
.sample-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.import-text :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
