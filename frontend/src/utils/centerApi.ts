import type { MergeItem, Receipt } from '@/types'

/** 回执发送结果 */
export interface SendResult {
  ok: boolean
  /** 中心受理状态：全部接受 / 发送失败 / 部分拒收 */
  status: 'accepted' | 'failed' | 'partial_rejected'
  /** 失败或拒收理由（回执级） */
  reason: string
  /** 被拒收的条目 id 列表（部分拒收时） */
  rejectedItemIds: string[]
  /** 每条被拒收目的理由 */
  rejectedReasons: Record<string, string>
}

/** 模拟发送选项：用于演示失败 / 拒收流程 */
export interface SendOptions {
  /** 强制结果：fail 模拟网络波动，reject 模拟中心校验不通过 */
  force?: 'fail' | 'reject'
}

const REJECT_REASONS = [
  '接受名与名录库当前记录不一致',
  '该异名已被其他接受名合并，请核对',
  '接受名拼写有误',
  '证据不足，暂不接受该合并'
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 模拟图谱库把回执送回中心。
 * 纯前端应用无真实后端，这里用异步 + 可强制结果的 mock 演示：
 * - 默认全部接受；
 * - force: 'fail' 模拟网络波动导致整回执发送失败（可重试）；
 * - force: 'reject' 模拟中心校验不通过，第一条被拒收、其余接受。
 */
export async function sendReceiptToCenter(
  _receipt: Receipt,
  items: MergeItem[],
  options: SendOptions = {}
): Promise<SendResult> {
  await delay(350 + Math.random() * 450)

  if (options.force === 'fail') {
    return {
      ok: false,
      status: 'failed',
      reason: '网络波动，回执发送失败',
      rejectedItemIds: [],
      rejectedReasons: {}
    }
  }

  if (options.force === 'reject') {
    const rejectedReasons: Record<string, string> = {}
    const rejectedItemIds: string[] = []
    // 模拟中心逐条校验：第一条被拒收，其余接受
    items.forEach((item, index) => {
      if (index === 0) {
        rejectedItemIds.push(item.id)
        rejectedReasons[item.id] = REJECT_REASONS[Math.floor(Math.random() * REJECT_REASONS.length)]
      }
    })
    return {
      ok: rejectedItemIds.length === 0,
      status: 'partial_rejected',
      reason: '',
      rejectedItemIds,
      rejectedReasons
    }
  }

  return {
    ok: true,
    status: 'accepted',
    reason: '',
    rejectedItemIds: [],
    rejectedReasons: {}
  }
}
