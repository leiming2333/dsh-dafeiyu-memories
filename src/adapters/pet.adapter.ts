/**
 * pet.adapter.ts —— 与 dsh-dafeiyu-pet（大肥鱼桌宠）互通
 *
 * 桌宠只消费**只读统计**，不参与任何写路径：
 * - 默认：对方主动调 `get_memory_stats` 或读服务 `dafeiyuMemories.stats()`；
 * - 可选：本插件在记忆写入后 emit `memory:stats`（事件名见 contracts.ts，默认关闭）。
 *
 * 硬约束：本适配器**不得**改动桌宠动画、任务状态或任何 UI 状态。
 */

import type { MemoryStats } from '../store.js'
import type { AdapterDeps, DshContext } from './contracts.js'
import { EVENT_NAMES, PLUGIN_IDS, SERVICE_NAMES, TOOL_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasAnyTool, hasPlugin } from './index.js'

/**
 * 推送统计事件。只有 config.enablePetStatsEvent=true 时才真正 emit。
 * 返回实际发出的事件名数量（0 表示没开或宿主不支持）。
 */
export function emitPetStats(ctx: DshContext, stats: MemoryStats, enabled: boolean): number {
  if (!enabled || typeof ctx.emit !== 'function') return 0
  let emitted = 0
  for (const event of EVENT_NAMES.petStats) {
    try {
      ctx.emit(event, stats)
      emitted += 1
    } catch {
      // 某个事件名不被接受就跳过，不影响主流程
    }
  }
  return emitted
}

export function createPetAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []

  return {
    id: 'pet',
    notes,

    detect(ctx: DshContext): boolean {
      return (
        hasPlugin(ctx, [PLUGIN_IDS.pet]) ||
        getService(ctx, SERVICE_NAMES.pet) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.pet.notify)
      )
    },

    setup(_ctx: DshContext): void {
      notes.push('统计已就绪：桌宠可调 get_memory_stats 或读 dafeiyuMemories.stats()')

      if (deps.config.enablePetStatsEvent) {
        notes.push('已开启 memory:stats 事件推送（TODO: 按桌宠文档确认事件名）')
      } else {
        notes.push('memory:stats 事件推送默认关闭（enablePetStatsEvent=false），不影响桌宠')
      }

      notes.push('本适配器为只读，不改动桌宠动画与任务状态')
    },
  }
}
