/**
 * adapters/index.ts —— 适配器编排
 *
 * 职责只有三件：
 * 1. 按固定顺序初始化适配器；
 * 2. 任何 detect / setup 抛错都只记 warning，继续跑下一个；
 * 3. 把适配器的只读能力聚合成一个服务 `dafeiyuMemories`，挂到 ctx 上。
 *
 * 核心工具（submit/get/stats/speakable/export/import）**不依赖**这里的任何东西。
 * 所有适配器都失败时，插件依然完整可用 —— 这是硬要求。
 */

import type { MemoryStore, MemoryStats, SpeakableItem } from '../store.js'
import type { Adapter, AdapterDeps, AdapterStatus, DshContext, ResolvedConfig } from './contracts.js'
import { CONTRACTS_VERSION, PLUGIN_IDS } from './contracts.js'
import { createFishMemoryAdapter } from './fish-memory.adapter.js'
import { createMoodAdapter } from './mood.adapter.js'
import { createPetAdapter } from './pet.adapter.js'
import { createQqAdapter } from './qq.adapter.js'
import { createSpeakUpAdapter } from './speak-up.adapter.js'
import { createTtsAdapter } from './tts.adapter.js'

/** 带 notes 的适配器：setup 期间把「用了什么事件名 / 降级到什么模式」记下来。 */
export interface AdapterWithNotes extends Adapter {
  readonly notes: string[]
  /** 运行时指标，随 statuses 一起暴露给 get_memory_stats。 */
  readonly metrics?: Record<string, number>
}

/** 聚合后暴露给其它插件的服务名。 */
export const SERVICE_NAME = 'dafeiyuMemories'

/** 聚合服务契约。其它插件可以 `ctx.get('dafeiyuMemories')` 拿到只读能力。 */
export interface DafeiyuMemoriesService {
  version: string
  contracts_version: string
  stats(): Promise<MemoryStats>
  speakable(limit?: number): Promise<SpeakableItem[]>
  exportFishMemory(ids?: string[]): Promise<{ path: string; count: number; content: string }>
  importFishMemory(payload: unknown): Promise<{ imported: number; skipped: number; ids: string[] }>
  linkMood(id: string, snapshot: Record<string, number>): Promise<{ id: string; mood_snapshot: Record<string, number> }>
  statuses(): AdapterStatus[]
}

/** 适配器运行态。 */
export interface AdapterRuntime {
  statuses: AdapterStatus[]
  service?: DafeiyuMemoriesService
}

// ───────────────────────── 检测辅助 ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取服务：先 ctx.get(name)，再直接读 ctx[name]。两者都没有返回 undefined。 */
export function getService(ctx: DshContext, names: readonly string[]): unknown {
  for (const name of names) {
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(name)
        if (value !== undefined && value !== null) return value
      }
    } catch {
      // ctx.get 在某些 profile 下会抛「服务未注册」，忽略后继续试下一个名字
    }
    try {
      const direct = ctx[name]
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // cordis 对未 inject 的服务属性会直接抛「cannot get property ... without inject」
    }
  }
  return undefined
}

/** 插件注册表里是否存在某个插件 id。 */
export function hasPlugin(ctx: DshContext, ids: readonly string[]): boolean {
  for (const id of ids) {
    try {
      if (ctx.registry?.has?.(id)) return true
    } catch {
      // 忽略
    }
    try {
      if (ctx.plugins?.has?.(id)) return true
    } catch {
      // 忽略
    }
  }
  return false
}

/** 列出当前已注册的工具名。兼容数组 / Map / 对象三种形态。 */
export function listToolNames(ctx: DshContext): string[] {
  const service = ctx.tools
  if (!service || typeof service.list !== 'function') return []
  try {
    const value = service.list()
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item : isRecord(item) && typeof item['name'] === 'string' ? item['name'] : ''))
        .filter((name) => name.length > 0)
    }
    if (value instanceof Map) {
      return [...value.keys()].filter((key): key is string => typeof key === 'string')
    }
    if (isRecord(value)) return Object.keys(value)
  } catch {
    // list 本身可能未实现，忽略
  }
  return []
}

/** 工具名里是否命中任意一个候选。 */
export function hasAnyTool(ctx: DshContext, candidates: readonly string[]): boolean {
  if (candidates.length === 0) return false
  const names = listToolNames(ctx)
  if (names.length === 0) return false
  return candidates.some((candidate) => names.includes(candidate))
}

/** 统一 warning 出口。宿主没有 logger 就退回 console，别把错误吞掉。 */
export function warn(ctx: DshContext, message: string): void {
  const line = `[dafeiyu-memories] ${message}`
  try {
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn(line)
      return
    }
  } catch {
    // logger 抛错也不能影响主流程
  }
  console.warn(line)
}

/** 统一 info 出口。 */
export function info(ctx: DshContext, message: string): void {
  const line = `[dafeiyu-memories] ${message}`
  try {
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(line)
      return
    }
  } catch {
    // 同上
  }
  console.log(line)
}

/** 安全地挂服务。重复注册或宿主不支持时返回 false，不抛错。 */
export function exposeService(ctx: DshContext, name: string, value: unknown): boolean {
  try {
    if (typeof ctx.get === 'function' && ctx.get(name) !== undefined) {
      warn(ctx, `服务 ${name} 已存在，跳过挂载`)
      return false
    }
  } catch {
    // ctx.get 不可用就跑下面的正常挂载
  }
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide(name, value)
      return true
    } catch (error) {
      warn(ctx, `provide 服务 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 旧版本可能只有 set
  try {
    if (typeof ctx.set === 'function') {
      ctx.set(name, value)
      return true
    }
  } catch (error) {
    warn(ctx, `挂载服务 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return false
}

// ───────────────────────── 编排 ─────────────────────────

/** 按固定顺序创建适配器。顺序有意义：mood 依赖 fish-memory 的半衰期，qq 最后兜底。 */
export function createAdapters(deps: AdapterDeps): AdapterWithNotes[] {
  return [
    createFishMemoryAdapter(deps),
    createMoodAdapter(deps),
    createSpeakUpAdapter(deps),
    createTtsAdapter(deps),
    createPetAdapter(deps),
    createQqAdapter(deps),
  ]
}

/**
 * 初始化全部适配器。
 * 任何一个抛错都只记 warning，并把该适配器标成 active=false，继续下一个。
 */
export function setupAdapters(ctx: DshContext, deps: AdapterDeps): AdapterRuntime {
  const runtime: AdapterRuntime = { statuses: [] }

  if (!deps.config.enableAdapters) {
    info(ctx, '适配器总开关已关闭（enableAdapters=false），只跑核心记忆功能')
    return runtime
  }

  const adapters = createAdapters(deps)

  for (const adapter of adapters) {
    let detected = false
    try {
      detected = adapter.detect(ctx)
    } catch (error) {
      warn(ctx, `适配器 ${adapter.id} 检测失败：${error instanceof Error ? error.message : String(error)}`)
      runtime.statuses.push({ id: adapter.id, detected: false, active: false, notes: ['检测过程抛错，已跳过'] })
      continue
    }

    if (!detected) {
      runtime.statuses.push({ id: adapter.id, detected: false, active: false, notes: ['未检测到对应插件，已跳过'] })
      continue
    }

    try {
      adapter.setup(ctx)
      runtime.statuses.push({
        id: adapter.id,
        detected: true,
        active: true,
        notes: [...adapter.notes],
        ...(adapter.metrics ? { metrics: adapter.metrics } : {}),
      })
      info(ctx, `适配器 ${adapter.id} 已启用`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(ctx, `适配器 ${adapter.id} 初始化失败，已降级：${message}`)
      runtime.statuses.push({ id: adapter.id, detected: true, active: false, notes: [`初始化失败：${message}`] })
    }
  }

  const service: DafeiyuMemoriesService = {
    version: '0.1.0',
    contracts_version: CONTRACTS_VERSION,
    stats: () => deps.store.stats(),
    speakable: (limit?: number) => deps.store.speakable(limit ?? 2),
    exportFishMemory: (ids?: string[]) => deps.store.exportFishMemory(ids),
    importFishMemory: (payload: unknown) => deps.store.importFishMemory(payload),
    linkMood: (id: string, snapshot: Record<string, number>) => deps.store.linkMood(id, snapshot),
    statuses: () => runtime.statuses,
  }
  runtime.service = service
  exposeService(ctx, SERVICE_NAME, service)

  return runtime
}

export type { MemoryStore, ResolvedConfig, AdapterDeps, AdapterStatus }
export { PLUGIN_IDS }
