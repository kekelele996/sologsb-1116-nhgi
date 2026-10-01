import { createStore } from 'zustand/vanilla'
import type {
  IdentifyLog,
  MergeItem,
  NameMerge,
  NomenclatureImport,
  NomenclatureVersion,
  Receipt,
  ReconcileJob
} from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'
import { sendReceiptToCenter } from '@/utils/centerApi'
import { uid } from '@/utils/id'

/** 大批量阈值：一次来几千条算大批量，走排队分批 */
export const LARGE_BATCH_THRESHOLD = 1000
/** 每批处理的合并条数 */
export const BATCH_SIZE = 200

export interface NomenclatureState {
  versions: NomenclatureVersion[]
  merges: NameMerge[]
  mergeItems: MergeItem[]
  receipts: Receipt[]
  jobs: ReconcileJob[]
  loaded: boolean
  /** 当前鉴定人（认过操作的署名） */
  confirmer: string
  hydrate: () => Promise<void>
  setConfirmer: (name: string) => void
  importNomenclature: (data: NomenclatureImport) => Promise<{ versionId: string; jobId: string }>
  confirmItem: (itemId: string) => Promise<void>
  sendReceipt: (receiptId: string, force?: 'fail' | 'reject') => Promise<void>
  retryReceipt: (receiptId: string) => Promise<void>
  /** 某条目下待认的对账条目数（图谱/详情角标用） */
  pendingCountOfRecord: (recordId: string) => number
  /** 某条鉴定结论对应的对账条目（取最新一条） */
  itemOfLog: (logId: string) => MergeItem | undefined
}

export const nomenclatureStore = createStore<NomenclatureState>((set, get) => ({
  versions: [],
  merges: [],
  mergeItems: [],
  receipts: [],
  jobs: [],
  loaded: false,
  confirmer: '鉴定人',

  hydrate: async () => {
    const [versions, merges, mergeItems, receipts, jobs] = await Promise.all([
      syncAll<NomenclatureVersion>(db.versions),
      syncAll<NameMerge>(db.merges),
      syncAll<MergeItem>(db.mergeItems),
      syncAll<Receipt>(db.receipts),
      syncAll<ReconcileJob>(db.reconcileJobs)
    ])
    versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    merges.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    mergeItems.sort((a, b) => a.recordCode.localeCompare(b.recordCode, 'zh-Hans-CN'))
    receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ versions, merges, mergeItems, receipts, jobs, loaded: true })
  },

  setConfirmer: (name) => set({ confirmer: name.trim() || '鉴定人' }),

  importNomenclature: async (data) => {
    const version = data.version.trim()
    if (!version) throw new Error('版本号不能为空')
    if (!Array.isArray(data.merges) || data.merges.length === 0) throw new Error('称谓合并列表为空')
    if (get().versions.some((item) => item.version === version)) {
      throw new Error(`版本「${version}」已导入，请勿重复导入`)
    }

    const now = new Date().toISOString()
    const versionId = uid('ver')
    const row: NomenclatureVersion = {
      id: versionId,
      version,
      issuedAt: data.issuedAt ?? now.slice(0, 10),
      source: data.source ?? '中心下发',
      note: data.note ?? '',
      mergeCount: data.merges.length,
      createdAt: now
    }
    await syncPut<NomenclatureVersion>(db.versions, row)

    const jobId = uid('job')
    const job: ReconcileJob = {
      id: jobId,
      versionId,
      total: data.merges.length,
      processed: 0,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null
    }
    await syncPut<ReconcileJob>(db.reconcileJobs, job)

    // 把原始合并数据暂存在内存队列里，避免一次性写入几千条阻塞页面
    enqueueJob(jobId, versionId, data.merges)
    await get().hydrate()
    void processQueue()
    return { versionId, jobId }
  },

  confirmItem: async (itemId) => {
    const state = get()
    const item = state.mergeItems.find((entry) => entry.id === itemId)
    if (!item || item.status !== 'pending') return

    const merge = state.merges.find((entry) => entry.id === item.mergeId)
    if (!merge) return

    // 1. 更新鉴定结论：老名字 → 接受名，并记称谓版本
    const log = await db.identifies.get(item.identifyLogId)
    if (log) {
      const updated: IdentifyLog = {
        ...log,
        conclusion: merge.acceptedName,
        nomenclatureVersion: item.versionId
      }
      await syncPut<IdentifyLog>(db.identifies, updated)
    }

    // 2. 找（或建）当前版本的草稿回执，把这条认过的攒进去
    let receipt = state.receipts.find(
      (entry) => entry.versionId === item.versionId && entry.status === 'draft'
    )
    if (!receipt) {
      const receiptId = uid('rcp')
      receipt = {
        id: receiptId,
        versionId: item.versionId,
        itemCount: 0,
        status: 'draft',
        createdAt: new Date().toISOString(),
        sentAt: null,
        failReason: '',
        rejectReason: '',
        retryCount: 0
      }
      await syncPut<Receipt>(db.receipts, receipt)
    }

    // 3. 更新对账条目为已认
    const confirmed: MergeItem = {
      ...item,
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
      confirmedBy: state.confirmer,
      receiptId: receipt.id,
      failReason: ''
    }
    await syncPut<MergeItem>(db.mergeItems, confirmed)

    // 4. 回执条目数 +1
    await syncPut<Receipt>(db.receipts, { ...receipt, itemCount: receipt.itemCount + 1 })

    await get().hydrate()
  },

  sendReceipt: async (receiptId, force) => {
    const state = get()
    const receipt = state.receipts.find((entry) => entry.id === receiptId)
    if (!receipt) return
    const items = state.mergeItems.filter((entry) => entry.receiptId === receiptId)

    const result = await sendReceiptToCenter(receipt, items, { force })

    if (result.status === 'accepted') {
      await syncPut<Receipt>(db.receipts, {
        ...receipt,
        status: 'sent',
        sentAt: new Date().toISOString(),
        failReason: '',
        rejectReason: ''
      })
    } else if (result.status === 'failed') {
      // 发送失败：回执置失败，条目仍是已认（认过的不退回），可重试
      await syncPut<Receipt>(db.receipts, {
        ...receipt,
        status: 'failed',
        failReason: result.reason,
        retryCount: receipt.retryCount + 1
      })
    } else {
      // 部分拒收：被拒条目留在本地写清理由，其余已认不退回
      const rejectedSet = new Set(result.rejectedItemIds)
      for (const item of items) {
        if (rejectedSet.has(item.id)) {
          const rejected: MergeItem = {
            ...item,
            status: 'rejected',
            rejectReason: result.rejectedReasons[item.id] ?? '中心拒收'
          }
          await syncPut<MergeItem>(db.mergeItems, rejected)
          // 被中心拒收：结论退回原有老名字
          const log = await db.identifies.get(item.identifyLogId)
          if (log) {
            await syncPut<IdentifyLog>(db.identifies, {
              ...log,
              conclusion: item.originalConclusion,
              nomenclatureVersion: LEGACY_FALLBACK
            })
          }
        }
      }
      await syncPut<Receipt>(db.receipts, {
        ...receipt,
        status: 'partial_rejected',
        rejectReason: '部分条目被中心拒收',
        sentAt: new Date().toISOString()
      })
    }

    await get().hydrate()
  },

  retryReceipt: async (receiptId) => {
    const state = get()
    const receipt = state.receipts.find((entry) => entry.id === receiptId)
    if (!receipt || receipt.status !== 'failed') return
    // 重试：重新发送（认过的条目不退回，仍在回执里）
    await get().sendReceipt(receiptId)
  },

  pendingCountOfRecord: (recordId) =>
    get().mergeItems.filter((item) => item.recordId === recordId && item.status === 'pending').length,

  itemOfLog: (logId) =>
    get()
      .mergeItems.filter((item) => item.identifyLogId === logId)
      .sort((a, b) => (b.confirmedAt ?? '').localeCompare(a.confirmedAt ?? ''))[0]
}))

/** 拒收后结论退回时的称谓版本占位 */
const LEGACY_FALLBACK = 'legacy'

/* ---------- 队列处理：大批量分批对账 ---------- */

interface QueuedJob {
  jobId: string
  versionId: string
  merges: NomenclatureImport['merges']
}

const jobQueue: QueuedJob[] = []
let processing = false

function enqueueJob(jobId: string, versionId: string, merges: NomenclatureImport['merges']): void {
  jobQueue.push({ jobId, versionId, merges })
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (jobQueue.length > 0) {
      const queued = jobQueue.shift()
      if (!queued) break
      await processJob(queued)
    }
  } finally {
    processing = false
  }
}

async function processJob(queued: QueuedJob): Promise<void> {
  const { jobId, versionId, merges } = queued
  const startedAt = new Date().toISOString()
  await syncPut<ReconcileJob>(db.reconcileJobs, {
    id: jobId,
    versionId,
    total: merges.length,
    processed: 0,
    status: 'processing',
    createdAt: startedAt,
    startedAt,
    finishedAt: null
  })
  nomenclatureStore.setState((state) => ({
    jobs: state.jobs.map((job) =>
      job.id === jobId ? { ...job, status: 'processing', startedAt } : job
    )
  }))

  // 一次性加载全部鉴定结论与条目，避免大批量时逐条查 IndexedDB
  const [allLogs, allRecords, existingItems] = await Promise.all([
    db.identifies.toArray(),
    db.records.toArray(),
    db.mergeItems.where('versionId').equals(versionId).toArray()
  ])
  const recordCodeOf = new Map(allRecords.map((record) => [record.id, record.code]))
  const logsByName = new Map<string, IdentifyLog[]>()
  for (const log of allLogs) {
    const list = logsByName.get(log.conclusion) ?? []
    list.push(log)
    logsByName.set(log.conclusion, list)
  }
  const existingLogIds = new Set(existingItems.map((item) => item.identifyLogId))

  let processed = 0
  for (let start = 0; start < merges.length; start += BATCH_SIZE) {
    const batch = merges.slice(start, start + BATCH_SIZE)
    for (const mergeInput of batch) {
      await reconcileOne(versionId, mergeInput, logsByName, recordCodeOf, existingLogIds)
      processed += 1
    }
    // 每批写完更新一次进度（直接改 store，避免全量 hydrate），并让出主线程
    await syncPut<ReconcileJob>(db.reconcileJobs, {
      id: jobId,
      versionId,
      total: merges.length,
      processed,
      status: 'processing',
      createdAt: startedAt,
      startedAt,
      finishedAt: null
    })
    nomenclatureStore.setState((state) => ({
      jobs: state.jobs.map((job) => (job.id === jobId ? { ...job, processed } : job))
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const finishedAt = new Date().toISOString()
  await syncPut<ReconcileJob>(db.reconcileJobs, {
    id: jobId,
    versionId,
    total: merges.length,
    processed: merges.length,
    status: 'done',
    createdAt: startedAt,
    startedAt,
    finishedAt
  })
  nomenclatureStore.setState((state) => ({
    jobs: state.jobs.map((job) =>
      job.id === jobId ? { ...job, status: 'done', processed: merges.length, finishedAt } : job
    )
  }))
  // 任务完成后全量刷新一次，把新合并与对账条目带进 store
  await nomenclatureStore.getState().hydrate()
}

/** 处理一条合并：建合并记录，从内存中找出所有按老称谓存下的鉴定结论 */
async function reconcileOne(
  versionId: string,
  mergeInput: { oldName: string; acceptedName: string },
  logsByName: Map<string, IdentifyLog[]>,
  recordCodeOf: Map<string, string>,
  existingLogIds: Set<string>
): Promise<void> {
  const oldName = mergeInput.oldName.trim()
  const acceptedName = mergeInput.acceptedName.trim()
  if (!oldName || !acceptedName) return

  const mergeId = uid('mrg')
  const merge: NameMerge = {
    id: mergeId,
    versionId,
    oldName,
    acceptedName,
    createdAt: new Date().toISOString()
  }
  await syncPut<NameMerge>(db.merges, merge)

  // 找出结论学名等于老名字的鉴定结论（先前按老称谓存下的）
  const logs = logsByName.get(oldName) ?? []
  for (const log of logs) {
    // 同一版本下同一结论只建一条对账条目
    if (existingLogIds.has(log.id)) continue
    existingLogIds.add(log.id)

    const item: MergeItem = {
      id: uid('mit'),
      mergeId,
      versionId,
      identifyLogId: log.id,
      recordId: log.recordId,
      recordCode: recordCodeOf.get(log.recordId) ?? '未知编号',
      originalConclusion: log.conclusion,
      status: 'pending',
      confirmedAt: null,
      confirmedBy: '',
      receiptId: null,
      rejectReason: '',
      failReason: '',
      retryCount: 0
    }
    await syncPut<MergeItem>(db.mergeItems, item)
  }
}
