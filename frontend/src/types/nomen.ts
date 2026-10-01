/** 称谓表条目：一个接受名及其已并入的老名字（异名） */
export interface NomenEntry {
  /** 接受名 */
  accepted: string
  /** 已并入的老名字 */
  synonyms: string[]
}

/** 名录中心下发的称谓表（整表带称谓版本） */
export interface NomenList {
  id: string
  /** 称谓版本，如 2026.10 */
  version: string
  /** 中心下发日期 */
  issuedAt: string
  note: string
  entries: NomenEntry[]
  /** 站里导入时间 */
  importedAt: string
}

/** 对账运行状态：排队中 / 对账中 / 已完成 */
export const RUN_STATUSES = ['queued', 'running', 'done'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** 一轮对账：导入一张称谓表触发，大批量时排队分批执行 */
export interface ReconcileRun {
  id: string
  /** 目标称谓版本 */
  version: string
  status: RunStatus
  /** 需扫描的鉴定留痕总数 */
  total: number
  /** 已分批处理的条数 */
  processed: number
  /** 受影响（生成待确认条目）数 */
  affected: number
  /** 中心未收录的结论数（仅提示，不生成待确认） */
  unmatched: number
  createdAt: string
}

/** 对账条目类型：并名（老名字并入接受名）/ 版本复核（中心改版需重新确认） */
export const RECONCILE_KINDS = ['merged', 'review'] as const
export type ReconcileKind = (typeof RECONCILE_KINDS)[number]

/** 对账条目状态：待认 / 已认 / 已送出 / 中心已收 / 中心拒收 */
export const RECONCILE_STATUSES = ['pending', 'confirmed', 'sent', 'accepted', 'rejected'] as const
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number]

/** 对账条目：一条需要鉴定人逐条认过的鉴定结论 */
export interface ReconcileItem {
  id: string
  runId: string
  /** 对应的鉴定留痕 */
  identifyId: string
  recordId: string
  /** 冗余采集编号，留痕或条目清理后仍可读 */
  recordCode: string
  kind: ReconcileKind
  /** 原有结论学名 */
  oldName: string
  /** 新表中的接受名（版本复核时与原名相同） */
  newName: string
  /** 结论对齐的旧称谓版本（空串 = 未标注） */
  fromVersion: string
  toVersion: string
  status: ReconcileStatus
  /** 认过的鉴定人 */
  confirmedBy: string
  confirmedAt: string
  /** 已攒入的回执批次 */
  receiptId: string
  /** 中心拒收理由 */
  rejectReason: string
  createdAt: string
}

/** 回执批次状态：待发送 / 已送出 / 发送失败（可从站侧重试） */
export const RECEIPT_STATUSES = ['pending', 'sent', 'failed'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]

/** 回执批次：认过的条目攒批送回中心 */
export interface ReceiptBatch {
  id: string
  itemIds: string[]
  status: ReceiptStatus
  /** 发送尝试次数 */
  attempts: number
  /** 最近一次发送失败原因 */
  lastError: string
  createdAt: string
  sentAt: string
}

/** 中心回执结果（站里导入）：哪些收下、哪些拒收及理由 */
export interface CenterReceiptResult {
  batchId: string
  accepted?: string[]
  rejected?: { itemId: string; reason: string }[]
}
