import { createStore } from 'zustand/vanilla'
import type {
  CenterReceiptResult,
  FungusRecord,
  IdentifyLog,
  NomenEntry,
  NomenList,
  ReconcileItem,
  ReconcileRun,
  ReceiptBatch
} from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { identifyStore } from '@/stores/identifyStore'
import { downloadJson } from '@/utils/export'
import { uid } from '@/utils/id'

/** 大批量对账时每批处理的鉴定留痕条数，批间让出主线程避免卡界面 */
const RECONCILE_BATCH_SIZE = 200
/** 中心回执接口地址在 localStorage 的键（留空 = 导出回执文件人工转交） */
export const CENTER_ENDPOINT_KEY = 'gbfungiguide.centerEndpoint'
/** 鉴定人署名在 localStorage 的键 */
export const REVIEWER_KEY = 'gbfungiguide.reviewer'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 解析并校验中心下发的称谓表 JSON */
function parseNomenList(raw: string): { ok: boolean; message: string; list?: NomenList } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'JSON 解析失败，请检查粘贴内容是否完整' }
  }
  const candidate = data as Partial<NomenList> | null
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, message: '称谓表须为 JSON 对象' }
  }
  const version = String(candidate.version ?? '').trim()
  if (!version) {
    return { ok: false, message: '缺少称谓版本 version' }
  }
  if (!Array.isArray(candidate.entries) || candidate.entries.length === 0) {
    return { ok: false, message: '称谓表条目 entries 为空' }
  }
  const entries: NomenEntry[] = []
  for (const [index, entry] of candidate.entries.entries()) {
    const accepted = String(entry?.accepted ?? '').trim()
    if (!accepted) {
      return { ok: false, message: `第 ${index + 1} 条缺少接受名 accepted` }
    }
    const synonyms = Array.isArray(entry?.synonyms)
      ? entry.synonyms.map((name) => String(name).trim()).filter(Boolean)
      : []
    entries.push({ accepted, synonyms })
  }
  return {
    ok: true,
    message: '',
    list: {
      id: uid('nml'),
      version,
      issuedAt: typeof candidate.issuedAt === 'string' && candidate.issuedAt ? candidate.issuedAt : today(),
      note: typeof candidate.note === 'string' ? candidate.note : '',
      entries,
      importedAt: new Date().toISOString()
    }
  }
}

export interface NomenState {
  lists: NomenList[]
  runs: ReconcileRun[]
  items: ReconcileItem[]
  receipts: ReceiptBatch[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 当前对齐的称谓版本（最新导入的一张表），无则空串 */
  currentVersion: () => string
  /** 粘贴中心下发的称谓表 JSON，导入后排队分批对账 */
  importList: (raw: string) => Promise<{ ok: boolean; message: string }>
  /** 鉴定人逐条认过：结论改接受名、对齐称谓版本 */
  confirmItem: (itemId: string, reviewer: string) => Promise<void>
  /** 把已认未入回执的条目攒成一张回执批次，返回条数 */
  buildReceipt: () => Promise<number>
  /** 发送回执（配了中心接口则 POST，否则导出文件）；失败可重试，已认的不退回 */
  sendReceipt: (batchId: string) => Promise<{ ok: boolean; message: string }>
  /** 导入中心回执结果：收下的标记完结，拒收的留本地写清理由 */
  applyCenterResult: (batchId: string, raw: string) => Promise<{ ok: boolean; message: string }>
  /** 拒收条目重新提交：回到已认状态，等待攒入下一张回执 */
  resubmitItem: (itemId: string) => Promise<void>
  /** 条目删除时清理其未认的对账条目 */
  removePendingByRecord: (recordId: string) => Promise<void>
  /** 某条目待认的对账条目数（图谱/详情角标用） */
  pendingCountOf: (recordId: string) => number
}

export const nomenStore = createStore<NomenState>((set, get) => {
  /** 对账队列：先进先出串行执行，一次几千条也分批慢慢对 */
  const runQueue: string[] = []
  let queueWorking = false

  function patchRun(next: ReconcileRun): void {
    set({ runs: get().runs.map((run) => (run.id === next.id ? { ...next } : run)) })
  }

  function patchItems(next: ReconcileItem[]): void {
    const byId = new Map(next.map((item) => [item.id, item]))
    const known = new Set(get().items.map((item) => item.id))
    const merged = get().items.map((item) => byId.get(item.id) ?? item)
    const added = next.filter((item) => !known.has(item.id))
    set({ items: [...merged, ...added] })
  }

  /** 执行一轮对账：分批扫描鉴定留痕，生成待确认条目 */
  async function executeRun(runId: string): Promise<void> {
    const run = get().runs.find((item) => item.id === runId)
    if (!run) return
    const list = get().lists.find((item) => item.version === run.version)
    if (!list) {
      const abandoned = { ...run, status: 'done' as const }
      patchRun(abandoned)
      await db.reconcileRuns.put(abandoned)
      return
    }
    const synonymTo = new Map<string, string>()
    const acceptedNames = new Set<string>()
    for (const entry of list.entries) {
      acceptedNames.add(entry.accepted)
      for (const synonym of entry.synonyms) synonymTo.set(synonym, entry.accepted)
    }
    const logs = await syncAll<IdentifyLog>(db.identifies)
    const records = await syncAll<FungusRecord>(db.records)
    const codeOf = new Map(records.map((record) => [record.id, record.code]))
    // 幂等键：同一留痕在同一称谓版本下只生成一条待确认
    const doneKeys = new Set(
      get()
        .items.filter((item) => item.toVersion === list.version)
        .map((item) => item.identifyId)
    )
    const progress: ReconcileRun = {
      ...run,
      status: 'running',
      total: logs.length,
      processed: 0,
      affected: 0,
      unmatched: 0
    }
    patchRun(progress)
    await db.reconcileRuns.put(progress)
    for (let offset = 0; offset < logs.length; offset += RECONCILE_BATCH_SIZE) {
      const slice = logs.slice(offset, offset + RECONCILE_BATCH_SIZE)
      const born: ReconcileItem[] = []
      for (const log of slice) {
        if (doneKeys.has(log.id)) continue
        const mergedName = synonymTo.get(log.conclusion)
        let kind: ReconcileItem['kind'] | null = null
        let newName = log.conclusion
        if (mergedName && mergedName !== log.conclusion) {
          // 老名字被并进接受名：列出受影响条目，等鉴定人逐条认过
          kind = 'merged'
          newName = mergedName
        } else if (acceptedNames.has(log.conclusion)) {
          // 中心一改动，按老称谓版本存下的结论要重新确认
          if (log.nomenVersion === list.version) continue
          kind = 'review'
        } else {
          // 中心未收录：只计数提示，不替鉴定人下结论
          progress.unmatched += 1
          continue
        }
        born.push({
          id: uid('rci'),
          runId,
          identifyId: log.id,
          recordId: log.recordId,
          recordCode: codeOf.get(log.recordId) ?? '（条目已删除）',
          kind,
          oldName: log.conclusion,
          newName,
          fromVersion: log.nomenVersion,
          toVersion: list.version,
          status: 'pending',
          confirmedBy: '',
          confirmedAt: '',
          receiptId: '',
          rejectReason: '',
          createdAt: today()
        })
        doneKeys.add(log.id)
      }
      if (born.length > 0) {
        await db.reconcileItems.bulkPut(born)
        patchItems(born)
        progress.affected += born.length
      }
      progress.processed = Math.min(offset + RECONCILE_BATCH_SIZE, logs.length)
      patchRun({ ...progress })
      await db.reconcileRuns.put({ ...progress })
      // 分批之间让出主线程
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const finished = { ...progress, status: 'done' as const }
    patchRun(finished)
    await db.reconcileRuns.put(finished)
  }

  async function workQueue(): Promise<void> {
    if (queueWorking) return
    queueWorking = true
    while (runQueue.length > 0) {
      const runId = runQueue[0]
      await executeRun(runId)
      runQueue.shift()
    }
    queueWorking = false
  }

  function enqueue(runId: string): void {
    // 去重：bootstrap 与 App 挂载都会 hydrate，同一任务不重复排队
    if (!runQueue.includes(runId)) {
      runQueue.push(runId)
    }
    void workQueue()
  }

  return {
    lists: [],
    runs: [],
    items: [],
    receipts: [],
    loaded: false,
    hydrate: async () => {
      const [lists, runs, items, receipts] = await Promise.all([
        syncAll<NomenList>(db.nomenLists),
        syncAll<ReconcileRun>(db.reconcileRuns),
        syncAll<ReconcileItem>(db.reconcileItems),
        syncAll<ReceiptBatch>(db.receipts)
      ])
      lists.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      set({ lists, runs, items, receipts, loaded: true })
      // 上次会话排了队没对完的，重新排队分批对
      for (const run of runs) {
        if (run.status === 'queued' || run.status === 'running') {
          if (run.status === 'running') {
            const reset = { ...run, status: 'queued' as const }
            await db.reconcileRuns.put(reset)
            patchRun(reset)
          }
          enqueue(run.id)
        }
      }
    },
    currentVersion: () => get().lists[0]?.version ?? '',
    importList: async (raw) => {
      const parsed = parseNomenList(raw)
      if (!parsed.ok || !parsed.list) return { ok: false, message: parsed.message }
      const list = parsed.list
      if (get().lists.some((item) => item.version === list.version)) {
        return { ok: false, message: `称谓版本 ${list.version} 已导入过，不能重复对账` }
      }
      await db.nomenLists.put(list)
      // 中心一改动，旧版没认完的待确认条目作废，按新表重新对账生成
      const stale = get().items.filter((item) => item.status === 'pending')
      if (stale.length > 0) {
        await db.reconcileItems.bulkDelete(stale.map((item) => item.id))
        set({ items: get().items.filter((item) => item.status !== 'pending') })
      }
      const run: ReconcileRun = {
        id: uid('run'),
        version: list.version,
        status: 'queued',
        total: 0,
        processed: 0,
        affected: 0,
        unmatched: 0,
        createdAt: new Date().toISOString()
      }
      await db.reconcileRuns.put(run)
      set({ lists: [list, ...get().lists], runs: [run, ...get().runs] })
      enqueue(run.id)
      return { ok: true, message: `称谓表 ${list.version} 已导入，对账任务已排队分批执行` }
    },
    confirmItem: async (itemId, reviewer) => {
      const item = get().items.find((entry) => entry.id === itemId)
      if (!item || item.status !== 'pending') return
      const next: ReconcileItem = {
        ...item,
        status: 'confirmed',
        confirmedBy: reviewer,
        confirmedAt: today()
      }
      await db.reconcileItems.put(next)
      patchItems([next])
      // 认过才算数：结论学名改接受名、对齐称谓版本；没认的照旧留着
      const log = await db.identifies.get(item.identifyId)
      if (log) {
        await db.identifies.put({ ...log, conclusion: item.newName, nomenVersion: item.toVersion })
        await identifyStore.getState().hydrate()
      }
    },
    buildReceipt: async () => {
      const ready = get().items.filter((item) => item.status === 'confirmed' && !item.receiptId)
      if (ready.length === 0) return 0
      const batch: ReceiptBatch = {
        id: uid('rcp'),
        itemIds: ready.map((item) => item.id),
        status: 'pending',
        attempts: 0,
        lastError: '',
        createdAt: new Date().toISOString(),
        sentAt: ''
      }
      await db.receipts.put(batch)
      const stamped = ready.map((item) => ({ ...item, receiptId: batch.id }))
      await db.reconcileItems.bulkPut(stamped)
      patchItems(stamped)
      set({ receipts: [batch, ...get().receipts] })
      return ready.length
    },
    sendReceipt: async (batchId) => {
      const batch = get().receipts.find((item) => item.id === batchId)
      if (!batch) return { ok: false, message: '回执批次不存在' }
      const items = get().items.filter((item) => batch.itemIds.includes(item.id))
      const sentAt = new Date().toISOString()
      const payload = {
        batchId: batch.id,
        nomenVersion: get().currentVersion(),
        sentAt,
        items: items.map((item) => ({
          itemId: item.id,
          identifyId: item.identifyId,
          recordCode: item.recordCode,
          oldName: item.oldName,
          acceptedName: item.newName,
          kind: item.kind,
          confirmedBy: item.confirmedBy,
          confirmedAt: item.confirmedAt
        }))
      }
      const endpoint = (localStorage.getItem(CENTER_ENDPOINT_KEY) ?? '').trim()
      const next: ReceiptBatch = { ...batch, attempts: batch.attempts + 1 }
      if (endpoint) {
        try {
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          if (!resp.ok) throw new Error(`中心接口返回 HTTP ${resp.status}`)
          next.status = 'sent'
          next.sentAt = sentAt
          next.lastError = ''
        } catch (error) {
          next.status = 'failed'
          next.lastError = error instanceof Error ? error.message : String(error)
        }
      } else {
        // 未配置中心接口：导出回执文件人工转交，视为已送出
        downloadJson(`receipt-${batch.id}.json`, payload)
        next.status = 'sent'
        next.sentAt = sentAt
        next.lastError = ''
      }
      await db.receipts.put(next)
      set({ receipts: get().receipts.map((item) => (item.id === next.id ? next : item)) })
      if (next.status === 'sent') {
        const delivered = items
          .filter((item) => item.status === 'confirmed')
          .map((item) => ({ ...item, status: 'sent' as const }))
        if (delivered.length > 0) {
          await db.reconcileItems.bulkPut(delivered)
          patchItems(delivered)
        }
        return { ok: true, message: endpoint ? '回执已送达中心' : '未配置中心接口，已导出回执文件，请人工转交中心' }
      }
      // 发送失败：已认的条目保持已认，不跟着退回，从站侧重试即可
      return { ok: false, message: `发送失败：${next.lastError}；已认条目不受影响，可稍后重试` }
    },
    applyCenterResult: async (batchId, raw) => {
      const batch = get().receipts.find((item) => item.id === batchId)
      if (!batch) return { ok: false, message: '回执批次不存在' }
      let result: CenterReceiptResult
      try {
        result = JSON.parse(raw) as CenterReceiptResult
      } catch {
        return { ok: false, message: '中心回执结果 JSON 解析失败' }
      }
      if (result.batchId !== batchId) {
        return { ok: false, message: '回执结果与所选批次不符，请核对 batchId' }
      }
      const batchItemIds = new Set(batch.itemIds)
      const accepted = new Set((result.accepted ?? []).filter((id) => batchItemIds.has(id)))
      const rejected = (result.rejected ?? []).filter((entry) => batchItemIds.has(entry.itemId))
      const items = get().items.filter((item) => batchItemIds.has(item.id))
      const nextItems = items.map((item) => {
        if (accepted.has(item.id)) {
          return { ...item, status: 'accepted' as const, rejectReason: '' }
        }
        const hit = rejected.find((entry) => entry.itemId === item.id)
        if (hit) {
          // 被中心拒收的留在本地，写清理由
          return { ...item, status: 'rejected' as const, rejectReason: hit.reason?.trim() || '中心未说明理由' }
        }
        return item
      })
      await db.reconcileItems.bulkPut(nextItems)
      patchItems(nextItems)
      return { ok: true, message: `中心收下 ${accepted.size} 条，拒收 ${rejected.length} 条` }
    },
    resubmitItem: async (itemId) => {
      const item = get().items.find((entry) => entry.id === itemId)
      if (!item || item.status !== 'rejected') return
      const next: ReconcileItem = { ...item, status: 'confirmed', receiptId: '', rejectReason: '' }
      await db.reconcileItems.put(next)
      patchItems([next])
    },
    removePendingByRecord: async (recordId) => {
      const stale = get().items.filter((item) => item.recordId === recordId && item.status === 'pending')
      if (stale.length === 0) return
      await db.reconcileItems.bulkDelete(stale.map((item) => item.id))
      const gone = new Set(stale.map((item) => item.id))
      set({ items: get().items.filter((item) => !gone.has(item.id)) })
    },
    pendingCountOf: (recordId) =>
      get().items.filter((item) => item.recordId === recordId && item.status === 'pending').length
  }
})
