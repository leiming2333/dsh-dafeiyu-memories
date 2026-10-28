/**
 * tools.ts —— 对 DSH 暴露的全部工具
 *
 * 注册策略：
 * - 核心工具（submit / prepare / get / stats / speakable）**不依赖任何生态插件**；
 * - 互操作工具（export / import / link_mood）总是注册，检测不到对应插件时
 *   走「文件格式兼容」模式，并在返回值里说明，不会报错；
 * - 工具注册入口做多签名探测（register / define / add / tool），
 *   找不到就 warn，不影响插件加载。
 *
 * 所有返回体都是纯 JSON 可序列化对象，字段名用 snake_case，
 * 和 DSH 其它工具保持一致的观感。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describeHits, scanPii } from './privacy.js'
import type { AdapterStatus, DshContext, DshToolDefinition, DshToolService, ResolvedConfig } from './adapters/contracts.js'
import { detectFishMemoryCapability } from './adapters/fish-memory.adapter.js'
import { emitPetStats } from './adapters/pet.adapter.js'
import { isQqSource, qqSourceDisabledError } from './adapters/qq.adapter.js'
import { listToolNames, warn } from './adapters/index.js'
import type { LocalMemory, MemoryStore, MemoryType, MemorySource } from './store.js'
import { CONTENT_MAX, CONTENT_MIN, DEFAULT_HALF_LIFE_DAYS, TITLE_MAX, TITLE_MIN, computeFreshness, charLength } from './store.js'

/** 工具注册所需依赖。 */
export interface ToolDeps {
  store: MemoryStore
  config: ResolvedConfig
  /** 适配器状态读取器，get_memory_stats 会带上兼容性摘要。 */
  getAdapterStatuses?: () => AdapterStatus[]
}

/** 注册结果，index.ts 用它打一条启动日志。 */
export interface ToolRegistrationResult {
  registered: string[]
  failed: string[]
}

const ALLOWED_SOURCES: MemorySource[] = [
  'manual',
  'speak-up',
  'qq',
  'qqbot',
  'fish-memory',
  'pet',
  'tts',
  'system',
]

// ───────────────────────── 参数取值辅助 ─────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asMemoryType(value: unknown): MemoryType | undefined {
  return value === 'fiction' || value === 'semi-fiction' ? value : undefined
}

function asSource(value: unknown): MemorySource | undefined {
  return typeof value === 'string' && (ALLOWED_SOURCES as string[]).includes(value)
    ? (value as MemorySource)
    : undefined
}

function asMoodSnapshot(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const snapshot: Record<string, number> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number' && Number.isFinite(item)) snapshot[key] = item
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

// ───────────────────────── 注册器 ─────────────────────────

/**
 * 把工具挂到 ctx.tools 上。
 *
 * TODO: 按目标 DSH 版本确认注册方法名。目前按 register → define → add → tool
 * 的顺序探测，命中即返回；四个都没有就返回 false，由调用方 warn。
 */
/**
 * defineTool 的宽松签名。
 * 官方泛型签名会推导出极深的条件类型，直接传 Record 会触发 TS2321（栈过深）。
 * 运行时行为不变，只是绕开类型推导。
 */
interface LooseDefineToolOptions {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
  isConcurrencySafe?: (args: unknown) => boolean
}

const defineToolLoose = defineTool as unknown as (options: LooseDefineToolOptions) => unknown

/** 校验词白名单：DSH 的 schema DSL 只认这几个注解。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

function annotations(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ANNOTATION_KEYS) {
    if (key in schema) out[key] = schema[key]
  }
  return out
}

/**
 * 单个值 schema 的转换。
 *
 * DSH 的 DSL 支持 type / enum / const / description / title / default / examples，
 * 不支持 minLength、maxLength、pattern —— 这些仍由 store 在运行时执行，
 * 参数 description 里也写了范围，所以这里丢掉不会让约束失效。
 */
function toValueSpec(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema['type']

  if (type === 'array') {
    const items = asRecord(schema['items'])
    return {
      type: 'array',
      ...(items ? { items: toValueSpec(items) } : {}),
      ...annotations(schema),
    }
  }

  if (type === 'object') {
    // `additionalProperties: { type: 'number' }` 这种映射表达式 DSL 里没有，退化成任意 JSON
    if (asRecord(schema['additionalProperties'])) {
      return { type: 'json', ...annotations(schema) }
    }
    const properties = toParameterSpec(schema)
    return {
      type: 'object',
      additionalProperties: true,
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...annotations(schema),
    }
  }

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    const out: Record<string, unknown> = { type }
    if (Array.isArray(schema['enum'])) out['enum'] = schema['enum']
    if ('const' in schema) out['const'] = schema['const']
    return { ...out, ...annotations(schema) }
  }

  return { type: 'json', ...annotations(schema) }
}

/**
 * JSON Schema 参数 → DSH 的 ParameterSchemaSpec。
 *
 * 后者是一个「属性映射」，根对象隐式开放，必填靠每个属性上的 `required: true`，
 * 而不是 JSON Schema 的 `required: [...]` 数组。
 */
export function toParameterSpec(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = asRecord(schema['properties']) ?? {}
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((name): name is string => typeof name === 'string')
    : []

  const spec: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(properties)) {
    const value = asRecord(raw)
    if (!value) continue
    spec[key] = {
      ...toValueSpec(value),
      ...(required.includes(key) ? { required: true } : {}),
    }
  }
  return spec
}

/**
 * 内部形态 → @deepseek-ai/dsh-tools 的 ToolDefinition。
 *
 * 真实定义要求 `output { schema, render }` 和 `execute`；
 * 我们的 handler 直接当 execute 用，输出统一声明成任意 JSON，render 成文本块。
 */
export function toRealDefinition(definition: DshToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: toParameterSpec(definition.parameters),
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: definition.handler,
    // 这些工具会写文件，不声明并发安全，让注册表按独占调度
    isConcurrencySafe: () => false,
  }
}

/**
 * 把工具挂到 ctx.tools 上。
 *
 * 真实入口是 `ctx.tools.register(ToolDefinition)`（@deepseek-ai/dsh-tools 0.0.1-rc.1）。
 * define / add / tool 是给其它版本留的兜底，签名可能是 (def) 或 (name, def)。
 */
export function registerTool(ctx: DshContext, definition: DshToolDefinition): boolean {
  const service: DshToolService | undefined = ctx.tools
  if (!service) return false

  // 热重载时同一个 ctx 可能被 apply 两次，已经注册过就别再来一遍
  if (typeof service.get === 'function') {
    try {
      if (service.get(definition.name)) return true
    } catch {
      // get 不可用，继续走下面的判断
    }
  }
  if (listToolNames(ctx).includes(definition.name)) return true

  let realDefinition: unknown
  try {
    // registry 只接收编译后的 ToolDefinition：parameters 必须是 JSON Schema、
    // output.schema 必须是已编译 schema。defineTool 负责这一步。
    realDefinition = defineToolLoose(toRealDefinition(definition) as unknown as LooseDefineToolOptions)
  } catch (error) {
    warn(
      ctx,
      `工具 ${definition.name} 的定义被 SDK 拒绝：${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }

  const register = service.register
  if (typeof register === 'function') {
    try {
      register.call(service, realDefinition)
      return true
    } catch (error) {
      warn(ctx, `register 失败（${definition.name}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const methodName of ['define', 'add', 'tool'] as const) {
    const candidate = service[methodName]
    if (typeof candidate !== 'function') continue
    try {
      candidate.call(service, realDefinition)
      return true
    } catch {
      try {
        ;(candidate as (name: string, def: unknown) => unknown).call(service, definition.name, realDefinition)
        return true
      } catch {
        // 试下一个入口
      }
    }
  }
  return false
}

// ───────────────────────── 工具定义 ─────────────────────────

function buildSubmitTool(deps: ToolDeps, ctx: DshContext): DshToolDefinition {
  return {
    name: 'submit_memory',
    description:
      '提交一条原创、虚构或半虚构的「大肥鱼记忆」。只写短故事，不要包含真实姓名、学校、住址、联系方式等隐私。' +
      '提交后保存到本地，并返回可提 PR 的 JSON。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'content'],
      properties: {
        fish_name: { type: 'string', maxLength: 20, description: '这条记忆属于哪条鱼，默认「大肥鱼」' },
        title: { type: 'string', minLength: TITLE_MIN, maxLength: TITLE_MAX, description: '标题，2-40 字' },
        content: {
          type: 'string',
          minLength: CONTENT_MIN,
          maxLength: CONTENT_MAX,
          description: '正文，20-300 字；虚构或半虚构，不要写真实隐私',
        },
        tags: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 16 },
          description: '标签，最多 8 个，每个不超过 16 字',
        },
        memory_type: {
          type: 'string',
          enum: ['fiction', 'semi-fiction'],
          description: 'fiction=完全虚构，semi-fiction=半虚构；默认 fiction',
        },
        source: {
          type: 'string',
          enum: ALLOWED_SOURCES,
          description: '来源标记；默认 manual。qq / qqbot 会强制脱敏',
        },
        platform: { type: 'string', description: '平台标识，如 bilibili / qq；只存本地，不公开' },
        created_by: { type: 'string', description: '创建者标识；含敏感信息时会被匿名化成「匿名」' },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const source = asSource(args['source']) ?? 'manual'
      if (isQqSource(source) && !deps.config.enableQqSource) {
        throw qqSourceDisabledError()
      }

      const result = await deps.store.submit({
        title: asString(args['title']) ?? '',
        content: asString(args['content']) ?? '',
        ...(asString(args['fish_name']) ? { fish_name: asString(args['fish_name']) as string } : {}),
        ...(asStringArray(args['tags']) ? { tags: asStringArray(args['tags']) as string[] } : {}),
        ...(asMemoryType(args['memory_type']) ? { memory_type: asMemoryType(args['memory_type']) as MemoryType } : {}),
        ...(source ? { source } : {}),
        ...(asString(args['platform']) ? { platform: asString(args['platform']) as string } : {}),
        ...(asString(args['created_by']) ? { created_by: asString(args['created_by']) as string } : {}),
      })

      // 桌宠事件是可选的：没开就什么都不做
      if (deps.config.enablePetStatsEvent) {
        const stats = await deps.store.stats()
        emitPetStats(ctx, stats, true)
      }

      return result
    },
  }
}

function buildPrepareTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'prepare_public_memory',
    description:
      '把一条本地私有记忆整理成可提 PR 的公开 JSON：强制隐私过滤、匿名化、剥离全部私有字段，' +
      '分配公开 id 并给出建议路径。不会写文件、不会自动提交。提交即视为同意 CC0-1.0，' +
      '公开后已被 fork / 下载的副本无法收回。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['local_id'],
      properties: {
        local_id: { type: 'string', pattern: '^L[0-9]{4}$', description: '本地记忆 id，形如 L0001' },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const localId = asString(args['local_id']) ?? ''
      const result = await deps.store.preparePublic(localId)
      return {
        ...result,
        notice:
          '请把 json 保存为对应路径后提 PR。提交即同意以 CC0-1.0 公开；公开后已 fork / 下载的副本无法收回。' +
          '提交前请再对照 docs/review-checklist.md 自查一遍（尤其是学校、单位、地址这类半虚构里容易残留的信息）。',
      }
    },
  }
}

function buildGetMemoriesTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'get_memories',
    description:
      '检索大肥鱼记忆库，支持按标签和关键词筛选。合并内置记忆、本地提交和远程公开记忆库，远程失败时自动降级。' +
      '本地提交默认不返回，需要时把 include_private 设为 true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string', description: '按标签精确匹配（大小写不敏感）' },
        keyword: { type: 'string', description: '关键词，匹配标题、正文、标签、鱼名' },
        source: {
          type: 'string',
          enum: ALLOWED_SOURCES,
          description: '按来源过滤；公开种子没有来源字段，不会被命中',
        },
        include_private: { type: 'boolean', description: '是否包含本地私有记忆，默认 false' },
        include_remote: { type: 'boolean', description: '是否拉取远程公开记忆，默认 true' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回条数上限，默认 200' },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      return deps.store.list({
        ...(asString(args['tag']) ? { tag: asString(args['tag']) as string } : {}),
        ...(asString(args['keyword']) ? { keyword: asString(args['keyword']) as string } : {}),
        ...(asString(args['source']) ? { source: asString(args['source']) as string } : {}),
        ...(asBoolean(args['include_private']) !== undefined
          ? { include_private: asBoolean(args['include_private']) as boolean }
          : {}),
        ...(asBoolean(args['include_remote']) !== undefined
          ? { include_remote: asBoolean(args['include_remote']) as boolean }
          : {}),
        ...(asNumber(args['limit']) !== undefined ? { limit: asNumber(args['limit']) as number } : {}),
      })
    },
  }
}

function buildStatsTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'get_memory_stats',
    description:
      '读取记忆库统计：总数、公开数、本地私有数、今日新增、新鲜度分布、来源分布。' +
      '只读，供桌宠 / 心情 / 朗读适配器消费，不修改任何数据。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (): Promise<unknown> => {
      const stats = await deps.store.stats()
      return {
        ...stats,
        adapters: deps.getAdapterStatuses?.() ?? [],
      }
    },
  }
}

function buildSpeakableTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'get_speakable_memories',
    description:
      '取 1-2 条适合朗读的短句，供 dsh-tts-bridge / dsh-speak 使用。' +
      '只返回 8-60 字的短句，过滤含隐私的内容，不返回长文和私有字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 2, description: '返回条数，1-2，默认 2' },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const limit = Math.min(Math.max(asNumber(args['limit']) ?? 2, 1), 2)
      const items = await deps.store.speakable(limit)
      return {
        items,
        text: items.map((item) => item.text).join('。'),
        count: items.length,
      }
    },
  }
}

function buildExportTool(deps: ToolDeps, ctx: DshContext): DshToolDefinition {
  return {
    name: 'export_to_fish_memory',
    description:
      '把本地私有记忆导出成 dsh-fish-memory 兼容结构（content / freshness / half_life_days / long_term / source）。' +
      '默认只写本插件的 exports/ 目录并返回路径，不写对方存储，也不导出公开库内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string', pattern: '^L[0-9]{4}$' },
          maxItems: 200,
          description: '只导出指定本地 id；不传则导出全部本地私有记忆',
        },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const ids = asStringArray(args['ids'])
      const result = await deps.store.exportFishMemory(ids)
      const capability = detectFishMemoryCapability(ctx)
      return {
        path: result.path,
        count: result.count,
        content: result.content,
        adapter: {
          detected: capability.detected,
          mode: capability.mode,
          note: capability.detected
            ? '检测到 dsh-fish-memory；本工具仍只产出文件，不写对方存储'
            : '未检测到 dsh-fish-memory，已按文件格式兼容导出',
        },
      }
    },
  }
}

function buildImportTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'import_from_fish_memory',
    description:
      '导入 dsh-fish-memory 的导出数据，按正文指纹去重后写入本地私有记忆，' +
      '来源标记 fish-memory、可见性 private。可直接传 payload 对象，或传 exports/ 目录下的文件名。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        payload: {
          description: '导出数据本体：可以是 { memories: [...] } 对象，也可以是 JSON 字符串',
        },
        path: {
          type: 'string',
          description: 'exports/ 目录下的文件名（不接受任意路径，避免读到不该读的文件）',
        },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      let payload: unknown = args['payload']

      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload) as unknown
        } catch {
          throw new Error('payload 不是合法 JSON 字符串')
        }
      }

      const filename = asString(args['path'])
      if (payload === undefined && filename) {
        const base = path.basename(filename)
        if (base !== filename) throw new Error('path 只能是 exports/ 目录下的文件名，不能带路径分隔符')
        const target = path.join(deps.store.exportsDir, base)
        payload = JSON.parse(await readFile(target, 'utf8')) as unknown
      }

      if (payload === undefined) throw new Error('需要提供 payload 或 path 其中之一')

      const result = await deps.store.importFishMemory(payload)
      return {
        ...result,
        note: '导入的记忆全部为本地私有（visibility=private），不会自动进入公开库',
      }
    },
  }
}

function buildLinkMoodTool(deps: ToolDeps): DshToolDefinition {
  return {
    name: 'link_mood_snapshot',
    description:
      '给某条本地私有记忆附加心情快照（心情插件调用，或用户手动关联）。' +
      '快照只存本地，生成公开草稿时会自动剥离，不会出现在公开 JSON 里。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['local_id', 'mood_snapshot'],
      properties: {
        local_id: { type: 'string', pattern: '^L[0-9]{4}$', description: '本地记忆 id，形如 L0001' },
        mood_snapshot: {
          type: 'object',
          description: '心情快照，键为情绪名，值为数值',
          additionalProperties: { type: 'number' },
        },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const localId = asString(args['local_id']) ?? ''
      const snapshot = asMoodSnapshot(args['mood_snapshot'])
      if (!snapshot) throw new Error('mood_snapshot 必须是「情绪名 → 数值」的对象，至少一个字段')
      const result = await deps.store.linkMood(localId, snapshot)
      return {
        ...result,
        note: '心情快照仅存本地私有记忆，公开贡献时会被剥离',
      }
    },
  }
}

// ───────────────────────── 入口 ─────────────────────────

/** 注册全部工具。返回成功/失败清单，失败只 warn，绝不抛错。 */
export function registerAllTools(ctx: DshContext, deps: ToolDeps): ToolRegistrationResult {
  const definitions: DshToolDefinition[] = [
    buildSubmitTool(deps, ctx),
    buildPrepareTool(deps),
    buildGetMemoriesTool(deps),
    buildStatsTool(deps),
    buildSpeakableTool(deps),
    buildExportTool(deps, ctx),
    buildImportTool(deps),
    buildLinkMoodTool(deps),
  ]

  const registered: string[] = []
  const failed: string[] = []

  for (const definition of definitions) {
    const ok = registerTool(ctx, definition)
    if (ok) {
      registered.push(definition.name)
    } else {
      failed.push(definition.name)
    }
  }

  if (failed.length > 0) {
    warn(
      ctx,
      `以下工具注册失败（ctx.tools 的注册入口不匹配，请按 DSH 文档调整 registerTool）：${failed.join(', ')}`,
    )
  }

  return { registered, failed }
}

/** 供单测/调试：工具定义不依赖 ctx 也能构造出来。 */
export function createToolDefinitions(ctx: DshContext, deps: ToolDeps): DshToolDefinition[] {
  return [
    buildSubmitTool(deps, ctx),
    buildPrepareTool(deps),
    buildGetMemoriesTool(deps),
    buildStatsTool(deps),
    buildSpeakableTool(deps),
    buildExportTool(deps, ctx),
    buildImportTool(deps),
    buildLinkMoodTool(deps),
  ]
}

/** 把本地记忆换算成带新鲜度的视图（供调试输出）。 */
export function withFreshness(local: LocalMemory): LocalMemory {
  const halfLife = local.half_life_days ?? DEFAULT_HALF_LIFE_DAYS
  return {
    ...local,
    freshness: local.freshness ?? computeFreshness(local.created_at, halfLife),
  }
}

/** 调试用：检查文本会不会被公开过滤命中。 */
export function inspectText(text: string): { hits: number; summary: string; length: number } {
  const hits = scanPii(text, 'strict')
  return { hits: hits.length, summary: describeHits(hits), length: charLength(text) }
}
