/**
 * dsh-dafeiyu-memories —— 大肥鱼记忆库（Shoal Atlas）
 *
 * 一个仓库，两种形态：
 * 1. DSH 插件：`dsh plugin add dsh-dafeiyu-memories`，注册 8 个记忆工具；
 * 2. 公开记忆库：`memories/*.json` 是 CC0 的公开源数据，`dist/` 由脚本聚合。
 *
 * 隐私红线（代码里强制，不靠自觉）：
 * - 运行时记忆只写本地数据目录，绝不写包内 `memories/`（store 有运行时保护）；
 * - 公开草稿必须过 strict 隐私过滤，私有字段结构化剥离；
 * - 任何生态插件都只是可选适配器，检测不到就跳过，核心工具照常工作。
 */

import { setupAdapters } from './adapters/index.js'
import type { AdapterRuntime } from './adapters/index.js'
import type { DshContext, PluginConfig, ResolvedConfig } from './adapters/contracts.js'
import { CONTENT_MAX, CONTENT_MIN, DEFAULT_HALF_LIFE_DAYS, MemoryStore, resolveDataDir } from './store.js'
import { registerAllTools } from './tools.js'
import type { ToolRegistrationResult } from './tools.js'

export const name = 'dafeiyu-memories'

/**
 * 只注入 tools 服务。
 * 不 inject 任何生态插件 —— 那样会让它们变成硬依赖，缺一个插件整个记忆库就起不来。
 */
export const inject = ['tools']

/** 插件配置，字段与 cordis.patch.yml 的 config 段一一对应。 */
export type Config = PluginConfig

/** 补全默认值。 */
export function resolveConfig(config: PluginConfig = {}): ResolvedConfig {
  return {
    remoteUrl: config.remoteUrl?.trim() ?? '',
    remoteTimeoutMs: clampNumber(config.remoteTimeoutMs, 300, 30_000, 3000),
    dataDir: config.dataDir?.trim() ?? '',
    defaultHalfLifeDays: clampNumber(config.defaultHalfLifeDays, 1, 3650, DEFAULT_HALF_LIFE_DAYS),
    enableAdapters: config.enableAdapters ?? true,
    enableMoodEvents: config.enableMoodEvents ?? false,
    moodEventName: config.moodEventName?.trim() ?? '',
    enablePetStatsEvent: config.enablePetStatsEvent ?? false,
    enableQqSource: config.enableQqSource ?? true,
  }
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 探测 DSH 的持久化数据目录。
 *
 * TODO: 按 DSH 版本确认持久化 API 的实际形态。这里按常见形态逐个尝试：
 * - `ctx.get('dataDir')` 直接返回字符串
 * - `ctx.storage.dataDir` / `ctx.storage.resolve(name)` / `ctx.storage.path`
 * - `ctx.paths.data` / `ctx.paths.userData`
 * 全都没有就返回 undefined，由 store 退回 `~/.dsh/data/dafeiyu-memories`。
 */
export function detectDshDataDir(ctx: DshContext): string | undefined {
  const readString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

  /**
   * cordis 的 ctx 是代理：访问没有 inject 的服务属性会直接抛
   * 「cannot get property "xxx" without inject」，不是返回 undefined。
   * 所以每一次属性读取都必须独立 try/catch，否则整个 apply 会挂掉。
   */
  const safeProp = (name: string): unknown => {
    try {
      return ctx[name]
    } catch {
      return undefined
    }
  }
  const safeGet = (name: string): unknown => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const direct = readString(safeGet('dataDir'))
  if (direct) return withPluginSubdir(direct)

  const storage = safeProp('storage')
  if (isRecord(storage)) {
    for (const key of ['dataDir', 'path', 'root']) {
      const value = readString(storage[key])
      if (value) return withPluginSubdir(value)
    }
    const resolver = storage['resolve']
    if (typeof resolver === 'function') {
      try {
        const value = readString((resolver as (name: string) => unknown).call(storage, 'dafeiyu-memories'))
        if (value) return withPluginSubdir(value)
      } catch {
        // 忽略
      }
    }
  }

  const paths = safeProp('paths')
  if (isRecord(paths)) {
    for (const key of ['data', 'userData', 'storage']) {
      const value = readString(paths[key])
      if (value) return withPluginSubdir(value)
    }
  }

  return undefined
}

/** DSH 给的可能是通用数据根，补一层插件子目录；已经带了就不重复补。 */
function withPluginSubdir(base: string): string {
  return /dafeiyu/i.test(base) ? base : `${base.replace(/[\\/]+$/u, '')}/dafeiyu-memories`
}

/**
 * 注入给模型的上下文提示。
 *
 * 内容固定、不含时间戳和随机值 —— systemPrompt.context 是追加段，
 * 但仍然要保证同一份配置下逐字节稳定，避免无谓地打断前缀缓存。
 */
export const CONTEXT_HINT = [
  '【大肥鱼记忆库】已启用。',
  `可用工具：submit_memory（写本地私有记忆，正文 ${CONTENT_MIN}-${CONTENT_MAX} 字）、get_memories（检索）、get_memory_stats（统计）、get_speakable_memories（朗读素材）、prepare_public_memory（生成可提 PR 的公开草稿）。`,
  '默认只检索公开库与远程聚合；读取本地私有记忆需要显式传 include_private=true。',
  '公开库许可是 CC0-1.0。任何写入公开库的动作都必须由用户显式确认，不要自动提交。',
].join('\n')

/** 记录已注入过的 ctx，热重载重复 apply 时不重复挂载。 */
const injectedContexts = new WeakSet<object>()

/** 注入上下文；宿主没有 systemPrompt.context 就静默跳过。 */
export function injectContextHint(ctx: DshContext): boolean {
  if (injectedContexts.has(ctx)) return true
  try {
    if (typeof ctx.systemPrompt?.context === 'function') {
      ctx.systemPrompt.context(() => CONTEXT_HINT)
      injectedContexts.add(ctx)
      return true
    }
  } catch {
    // 注入失败不影响工具可用性
  }
  return false
}

/** 插件主体。返回运行态，方便测试时断言。 */
export function apply(ctx: DshContext, config: PluginConfig = {}): AdapterRuntime & { tools: ToolRegistrationResult } {
  const resolved = resolveConfig(config)

  const dataDir = resolveDataDir({
    explicit: resolved.dataDir,
    fromDsh: detectDshDataDir(ctx) ?? '',
  })

  const store = new MemoryStore({
    dataDir,
    defaultHalfLifeDays: resolved.defaultHalfLifeDays,
    remoteUrl: resolved.remoteUrl,
    remoteTimeoutMs: resolved.remoteTimeoutMs,
    logger: {
      warn: (message: string) => {
        try {
          ctx.logger?.warn?.(message)
        } catch {
          // 忽略
        }
      },
    },
  })

  const runtime = setupAdapters(ctx, { store, config: resolved })
  const tools = registerAllTools(ctx, {
    store,
    config: resolved,
    getAdapterStatuses: () => runtime.statuses,
  })
  const contextInjected = injectContextHint(ctx)

  const activeAdapters = runtime.statuses.filter((status) => status.active).map((status) => status.id)

  try {
    ctx.logger?.info?.(
      `[dafeiyu-memories] 就绪：工具 ${tools.registered.length} 个，适配器 ${
        activeAdapters.length > 0 ? activeAdapters.join('/') : '无（核心功能不受影响）'
      }，数据目录 ${store.dataDir}，上下文注入 ${contextInjected ? '已启用' : '未启用'}`,
    )
  } catch {
    // 日志失败不影响功能
  }

  return { ...runtime, tools }
}

export { MemoryStore, resolveDataDir }
export { setupAdapters } from './adapters/index.js'
export type { Adapter, AdapterDeps, AdapterStatus, DshContext, PluginConfig, ResolvedConfig } from './adapters/contracts.js'
export type {
  LocalMemory,
  MemoryQuery,
  MemorySource,
  MemoryStats,
  MemoryType,
  MergedResult,
  PrepareResult,
  PublicMemory,
  SpeakableItem,
  SubmitInput,
  SubmitResult,
} from './store.js'
export { computeFreshness, nextPublicId } from './store.js'
export { scanPii, redactPii, containsPii, sanitizeTags, anonymizeContributor } from './privacy.js'
export { fetchRemoteMemories, resolveRemoteUrl, DEFAULT_REMOTE_URL } from './remote.js'
export { registerAllTools, registerTool } from './tools.js'

export default { name, inject, apply }
