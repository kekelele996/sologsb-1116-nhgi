/** 称谓版本（中心下发的称谓表版本） */
export interface NomenclatureVersion {
  id: string
  /** 版本号，如 v2026.1 */
  version: string
  /** 下发时间 */
  issuedAt: string
  /** 来源说明 */
  source: string
  /** 备注 */
  note: string
  /** 称谓合并条目数 */
  mergeCount: number
  createdAt: string
}

/** 称谓合并：老名字 → 接受名 */
export interface NameMerge {
  id: string
  versionId: string
  /** 老名字（被合并的异名） */
  oldName: string
  /** 接受名 */
  acceptedName: string
  createdAt: string
}

/** 对账条目：受影响的一条鉴定结论 */
export interface MergeItem {
  id: string
  mergeId: string
  versionId: string
  identifyLogId: string
  recordId: string
  /** 采集编号快照 */
  recordCode: string
  /** 原有结论（老名字）快照 */
  originalConclusion: string
  /** 条目状态：待认 / 已认 / 被拒收 */
  status: 'pending' | 'confirmed' | 'rejected'
  /** 认的时间 */
  confirmedAt: string | null
  /** 鉴定人 */
  confirmedBy: string
  /** 回执 id */
  receiptId: string | null
  /** 拒收理由 */
  rejectReason: string
  /** 发送失败理由（回执级失败时记录） */
  failReason: string
  /** 重试次数 */
  retryCount: number
}

/** 回执：攒成一批送回中心 */
export interface Receipt {
  id: string
  versionId: string
  /** 回执内条目数 */
  itemCount: number
  /** 草稿 / 已发送 / 发送失败 / 部分被拒收 */
  status: 'draft' | 'sent' | 'failed' | 'partial_rejected'
  createdAt: string
  sentAt: string | null
  failReason: string
  rejectReason: string
  retryCount: number
}

/** 对账任务（大批量排队分批） */
export interface ReconcileJob {
  id: string
  versionId: string
  /** 总合并条数 */
  total: number
  /** 已处理条数 */
  processed: number
  /** 排队中 / 处理中 / 完成 / 失败 */
  status: 'queued' | 'processing' | 'done' | 'failed'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** 导入的称谓表格式（粘贴 JSON） */
export interface NomenclatureImport {
  version: string
  issuedAt?: string
  source?: string
  note?: string
  merges: { oldName: string; acceptedName: string }[]
}

/** 旧数据的称谓版本占位值 */
export const LEGACY_NOMENCLATURE_VERSION = 'legacy'
