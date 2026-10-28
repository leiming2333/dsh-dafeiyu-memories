/**
 * mood.adapter.ts —— 与 dsh-feiyu-mood / dsh-yu-mood（鱼的心情）互通
 *
 * 规则：
 * - 两个心情插件只能启用一个：都检测到时用 dsh-feiyu-mood，并 warn 一次。
 * - 心情快照只写进**本地私有记忆**，公开草稿会结构化剥离（见 store.buildDraft）。
 * - 事件订阅默认关闭：事件名未确认前不猜。开启方式见 docs/compatibility.md。
 * - 没有事件也能用：`link_mood_snapshot` 工具允许手动/由对方显式调用关联。
 */

import type { AdapterDeps, DshContext } from './contracts.js'
import { EVENT_NAMES, PLUGIN_IDS, SERVICE_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasPlugin, warn } from './index.js'

/** 心情插件里常见的「泛用服务名」，不能用来区分两家，检测时排除。 */
const GENERIC_MOOD_SERVICES = new Set(['mood', 'moodService'])

/** 从任意事件负载里挖出数值型心情字段（最多两层嵌套）。 */
export function extractMoodSnapshot(payload: unknown): Record<string, number> | null {
  const result: Record<string, number> = {}

  const visit = (value: unknown, depth: number): void => {
    if (depth > 2 || typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'number' && Number.isFinite(child)) {
        result[key] = child
      } else if (typeof child === 'object' && child !== null) {
        visit(child, depth + 1)
      }
    }
  }

  visit(payload, 0)
  return Object.keys(result).length > 0 ? result : null
}

function specificServiceNames(names: readonly string[]): string[] {
  return names.filter((name) => !GENERIC_MOOD_SERVICES.has(name))
}

export function createMoodAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []
  let chosen: 'dsh-feiyu-mood' | 'dsh-yu-mood' | null = null
  let lastSnapshotKey = ''
  let lastSnapshotAt = 0

  /** 运行时指标：received 一直不涨，就说明事件名不对或插件压根没发。 */
  const metrics = { received: 0, applied: 0, subscribed: 0 }

  /** 把快照附到最近一条本地记忆上。没有记忆就静默跳过（不创建空记忆）。 */
  async function applySnapshot(payload: unknown): Promise<void> {
    metrics.received += 1
    const snapshot = extractMoodSnapshot(payload)
    if (!snapshot) {
      notes.push('收到心情事件，但负载里没有数值字段，已忽略')
      return
    }

    const key = JSON.stringify(snapshot)
    const now = Date.now()
    if (key === lastSnapshotKey && now - lastSnapshotAt < 3000) return
    lastSnapshotKey = key
    lastSnapshotAt = now

    const locals = await deps.store.readLocalMemories()
    const latest = locals.at(-1)
    if (!latest) {
      notes.push('收到心情更新，但本地还没有私有记忆可关联')
      return
    }
    await deps.store.linkMood(latest.id, snapshot)
    metrics.applied += 1
  }

  return {
    id: 'mood',
    notes,
    metrics,

    detect(ctx: DshContext): boolean {
      const feiyu =
        hasPlugin(ctx, [PLUGIN_IDS.feiyuMood]) ||
        getService(ctx, specificServiceNames(SERVICE_NAMES.feiyuMood)) !== undefined
      const yu =
        hasPlugin(ctx, [PLUGIN_IDS.yuMood]) ||
        getService(ctx, specificServiceNames(SERVICE_NAMES.yuMood)) !== undefined

      if (feiyu && yu) {
        chosen = 'dsh-feiyu-mood'
        warn(ctx, '同时检测到 dsh-feiyu-mood 与 dsh-yu-mood，只启用 dsh-feiyu-mood；请禁用其中一个')
        notes.push('两个心情插件同时存在，已按优先级只启用 dsh-feiyu-mood')
        return true
      }
      if (feiyu) {
        chosen = 'dsh-feiyu-mood'
        return true
      }
      if (yu) {
        chosen = 'dsh-yu-mood'
        return true
      }
      return false
    },

    setup(ctx: DshContext): void {
      notes.push(`启用 ${chosen ?? '心情插件'}（心情只写入私有记忆，公开时剥离）`)

      if (!deps.config.enableMoodEvents) {
        notes.push('心情事件订阅默认关闭（enableMoodEvents=false）；可用 link_mood_snapshot 手动关联')
        return
      }

      if (typeof ctx.on !== 'function') {
        notes.push('当前宿主没有 ctx.on，心情事件未订阅')
        return
      }

      let subscribed = 0
      const disposers: Array<() => void> = []

      // 显式配置优先：抓到真实事件名后写进 config，不用改代码
      const events = deps.config.moodEventName ? [deps.config.moodEventName] : [...EVENT_NAMES.moodUpdated]

      for (const event of events) {
        const handler = (...args: unknown[]): void => {
          void applySnapshot(args[0]).catch((error: unknown) => {
            warn(ctx, `处理心情事件 ${event} 失败：${error instanceof Error ? error.message : String(error)}`)
          })
        }
        try {
          ctx.on(event, handler)
          subscribed += 1
          disposers.push(() => {
            try {
              ctx.off?.(event, handler)
            } catch {
              // 忽略
            }
          })
        } catch {
          // 某个事件名被宿主拒绝，继续试下一个
        }
      }

      if (subscribed === 0) {
        notes.push('所有候选事件名都订阅失败，心情事件未生效（请按插件文档改 contracts.ts）')
        return
      }

      metrics.subscribed = subscribed
      notes.push(
        deps.config.moodEventName
          ? `已订阅配置指定的事件：${deps.config.moodEventName}`
          : `已订阅 ${subscribed} 个候选事件名（未命中就填 config.moodEventName）`,
      )

      // 挂到 ctx.effect 上，随插件卸载一起释放；没有 effect 就交给宿主回收
      try {
        ctx.effect?.(() => {
          for (const dispose of disposers) dispose()
        })
      } catch {
        // 忽略
      }
    },
  }
}
