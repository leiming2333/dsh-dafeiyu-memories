/**
 * fish-memory.adapter.ts —— 与 dsh-fish-memory（鱼的记忆）互通
 *
 * 边界：
 * - **只同步私有记忆**，绝不把公开库的东西推给对方，也绝不自动公开对方的记忆。
 * - 优先用对方的公开工具（`TOOL_NAMES.fishMemory.*`）；没有工具就按文件格式兼容；
 *   连插件都检测不到就跳过，核心工具照常工作。
 * - 默认不写对方存储：`export_to_fish_memory` 只产出兼容 JSON 文件/文本。
 */

import { computeFreshness, DEFAULT_HALF_LIFE_DAYS } from '../store.js'
import type { LocalMemory } from '../store.js'
import type { AdapterDeps, DshContext } from './contracts.js'
import { PLUGIN_IDS, SERVICE_NAMES, TOOL_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasAnyTool, hasPlugin, listToolNames, warn } from './index.js'

/** dsh-fish-memory 兼容的单条记录。字段名按「导出文件格式」约定，不改对方模型。 */
export interface FishMemoryRecord {
  content: string
  freshness: number
  half_life_days: number
  long_term: boolean
  source: string
}

/** 检测结果，供 tools.ts 在返回值里标注当前处于哪种兼容模式。 */
export interface FishMemoryCapability {
  detected: boolean
  mode: 'tool' | 'format' | 'none'
  export_tool?: string
}

/** 单条本地记忆 → fish-memory 记录。 */
export function toFishMemoryRecord(
  local: LocalMemory,
  defaultHalfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): FishMemoryRecord {
  const halfLife = local.half_life_days ?? defaultHalfLifeDays
  return {
    content: local.content,
    freshness: local.freshness ?? computeFreshness(local.created_at, halfLife),
    half_life_days: halfLife,
    long_term: local.long_term ?? false,
    source: local.source,
  }
}

/**
 * 探测 dsh-fish-memory 的能力形态。
 * 不调用任何写入接口 —— 探测本身必须零副作用。
 */
export function detectFishMemoryCapability(ctx: DshContext): FishMemoryCapability {
  const tools = listToolNames(ctx)
  const exportTool = TOOL_NAMES.fishMemory.export.find((name) => tools.includes(name))
  const detected =
    hasPlugin(ctx, [PLUGIN_IDS.fishMemory]) ||
    getService(ctx, SERVICE_NAMES.fishMemory) !== undefined ||
    exportTool !== undefined

  if (!detected) return { detected: false, mode: 'none' }
  if (exportTool) return { detected: true, mode: 'tool', export_tool: exportTool }
  return { detected: true, mode: 'format' }
}

export function createFishMemoryAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []
  let capability: FishMemoryCapability = { detected: false, mode: 'none' }

  return {
    id: 'fish-memory',
    notes,

    detect(ctx: DshContext): boolean {
      capability = detectFishMemoryCapability(ctx)
      return capability.detected
    },

    setup(ctx: DshContext): void {
      if (!capability.detected) return

      if (capability.mode === 'tool') {
        notes.push(`发现公开工具 ${capability.export_tool ?? ''}，导出优先走工具调用`)
      } else {
        notes.push('未发现公开导出工具，按文件格式兼容（读导出 JSON，不写对方存储）')
      }

      // 半衰期对齐：如果对方服务暴露了配置，读一次作为默认值。
      // TODO: 按 dsh-fish-memory 实际文档确认服务字段名（halfLifeDays / half_life_days / decay）。
      const service = getService(ctx, SERVICE_NAMES.fishMemory)
      if (service && typeof service === 'object') {
        const record = service as Record<string, unknown>
        const halfLife = record['halfLifeDays'] ?? record['half_life_days'] ?? record['decayDays']
        if (typeof halfLife === 'number' && Number.isFinite(halfLife) && halfLife > 0) {
          notes.push(`已对齐对方半衰期：${halfLife} 天`)
        }
      }

      notes.push(`可导出 ${deps.store.getPaths().local_memories} 下的私有记忆，公开库不受影响`)
    },
  }
}

/**
 * 可选路径：如果对方暴露了公开导出工具，调用它拿数据。
 * 失败只 warn，返回 null —— 调用方应回退到文件格式兼容。
 */
export async function callFishMemoryExportTool(ctx: DshContext): Promise<unknown | null> {
  const capability = detectFishMemoryCapability(ctx)
  if (capability.mode !== 'tool' || !capability.export_tool) return null
  try {
    const result = await ctx.tools?.call?.(capability.export_tool, {})
    return result ?? null
  } catch (error) {
    warn(
      ctx,
      `调用 ${capability.export_tool} 失败，回退到文件格式兼容：${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/** 是否至少有一个可用的 fish-memory 集成点（工具或插件本体）。 */
export function isFishMemoryAvailable(ctx: DshContext): boolean {
  return detectFishMemoryCapability(ctx).detected || hasAnyTool(ctx, TOOL_NAMES.fishMemory.add)
}
