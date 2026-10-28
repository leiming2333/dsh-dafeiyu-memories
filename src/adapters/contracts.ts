/**
 * contracts.ts —— 外部契约清单（唯一真相源）
 *
 * 这个仓库刻意**不把任何生态插件写成硬依赖**。所有可能用到的
 * 服务名、工具名、事件名、插件 id 全部集中在本文件，原因有两条：
 *
 * 1. 生态插件的服务名/事件名可能随版本变化。集中在一处，升级时只改这里。
 * 2. 未确认的名字一律标注 `TODO: 按目标插件实际文档确认`，并且**默认关闭**。
 *    臆造事件名会让插件在别人的 profile 里静默失效，这比不兼容更糟。
 *
 * 开启方式见 docs/compatibility.md「如何开启某个适配器」一节。
 */

import type { MemoryStore } from '../store.js'

/** 契约清单版本。改动外部名字时请同步 +1，方便排查兼容问题。 */
export const CONTRACTS_VERSION = '1.0.0'

/**
 * 生态插件的包名 / 插件 id。
 * 用于在 DSH 插件注册表里做存在性检测（detect 的第一优先级）。
 */
export const PLUGIN_IDS = {
  fishMemory: 'dsh-fish-memory',
  feiyuMood: 'dsh-feiyu-mood',
  yuMood: 'dsh-yu-mood',
  speakUp: 'dsh-speak-up',
  ttsBridge: 'dsh-tts-bridge',
  speak: 'dsh-speak',
  pet: 'dsh-dafeiyu-pet',
  qqBridge: 'dsh-qq-bridge',
  qqbot: 'dsh-qqbot',
} as const

/**
 * 服务容器里的服务名候选（detect 的第二优先级）。
 *
 * TODO: 按目标插件实际文档确认 —— 下面的名字是「常见命名」的候选集合，
 * 检测逻辑会逐个尝试 `ctx.get(name)` / `ctx.has(name)`，命中任意一个即视为存在。
 * 如果你的 DSH 版本里服务名不同，只改这里即可，不需要动适配器代码。
 */
export const SERVICE_NAMES = {
  fishMemory: ['fishMemory', 'fish-memory', 'fishMemoryStore', 'fishMemoryService'],
  feiyuMood: ['feiyuMood', 'feiyu-mood', 'mood', 'moodService'],
  yuMood: ['yuMood', 'yu-mood', 'mood', 'moodService'],
  speakUp: ['speakUp', 'speak-up', 'speakUpService'],
  ttsBridge: ['ttsBridge', 'tts-bridge', 'tts'],
  speak: ['speak', 'speakService'],
  pet: ['dafeiyuPet', 'dafeiyu-pet', 'pet', 'petService'],
  qqBridge: ['qqBridge', 'qq-bridge', 'qq'],
  qqbot: ['qqbot', 'qqBot', 'qq-bot'],
} as const

/**
 * 公开工具名候选（detect 的第三优先级，也是「优先调用公开工具」的入口）。
 *
 * TODO: 按目标插件实际文档确认 —— 名字未确认前，适配器只做**数据格式兼容**，
 * 不会盲目 `ctx.tools.call()` 一个不存在的工具（那会在别人机器上刷错误日志）。
 */
export const TOOL_NAMES = {
  fishMemory: {
    export: ['fish_memory_export', 'fish_memory_dump', 'fish_memory_snapshot'],
    import: ['fish_memory_import', 'fish_memory_restore'],
    add: ['fish_memory_add', 'fish_memory_remember', 'fish_memory_write'],
  },
  feiyuMood: {
    snapshot: ['feiyu_mood_snapshot', 'mood_snapshot', 'mood_get'],
  },
  yuMood: {
    snapshot: ['yu_mood_snapshot', 'mood_snapshot', 'mood_get'],
  },
  speakUp: {
    lastTurn: ['speak_up_last_turn', 'speak_up_history'],
  },
  ttsBridge: {
    speak: ['tts_bridge_speak', 'tts_speak'],
  },
  speak: {
    say: ['speak_say', 'speak_text'],
  },
  pet: {
    notify: ['pet_notify', 'dafeiyu_pet_notify'],
  },
  qqBridge: {
    send: ['qq_bridge_send', 'qq_send_message'],
  },
  qqbot: {
    send: ['qqbot_send', 'qq_bot_send'],
  },
} as const

/**
 * 事件名候选。
 *
 * TODO: 按目标插件实际文档确认 —— **默认全部关闭**。
 * 事件总线是「没有公开工具时的最后手段」，事件名猜错不会报错，只会永远收不到消息，
 * 所以必须由用户在 cordis.patch.yml 里显式打开（enableMoodEvents / enablePetStatsEvent）。
 */
export const EVENT_NAMES = {
  /** 心情更新。TODO: 确认 dsh-feiyu-mood / dsh-yu-mood 的真实事件名。 */
  moodUpdated: ['mood:updated', 'mood/updated', 'feiyu-mood:updated', 'yu-mood:updated'],
  /** 桌宠统计推送（由本插件 emit，桌宠侧监听）。TODO: 确认 dsh-dafeiyu-pet 是否接受此事件。 */
  petStats: ['memory:stats', 'dafeiyu-memory:stats'],
  /** 记忆提交后由本插件 emit，供其它插件观察。TODO: 确认是否有插件监听。 */
  memorySubmitted: ['dafeiyu-memory:submitted'],
} as const

/** 事件默认开关。false = 不订阅、不发送、不产生任何副作用。 */
export const EVENT_ENABLED_BY_DEFAULT = {
  moodUpdated: false,
  petStats: false,
  memorySubmitted: false,
} as const

/**
 * 插件配置（对应 cordis.patch.yml 的 config 段）。
 * 全部可选 —— 一个都不填也能跑。
 */
export interface PluginConfig {
  /** 公开库聚合索引 raw 地址。留空用 DEFAULT_REMOTE_URL。 */
  remoteUrl?: string
  /** 远程拉取超时（毫秒），默认 3000。 */
  remoteTimeoutMs?: number
  /** 本地私有记忆根目录。留空走 DSH 数据目录，再退化到 ~/.dsh/data/dafeiyu-memories。 */
  dataDir?: string
  /** 新鲜度半衰期（天），默认 30。 */
  defaultHalfLifeDays?: number
  /** 生态适配器总开关，默认 true。 */
  enableAdapters?: boolean
  /** 订阅心情更新事件，默认 false（事件名待确认）。 */
  enableMoodEvents?: boolean
  /**
   * 显式指定心情更新的事件名，优先于 EVENT_NAMES.moodUpdated 里的候选列表。
   * 抓到真实事件名后填这里，不用改代码。
   */
  moodEventName?: string
  /** 向桌宠 emit memory:stats，默认 false（事件名待确认）。 */
  enablePetStatsEvent?: boolean
  /** 允许 qq / qqbot 来源写入本地私有记忆，默认 true（写入前强制隐私过滤）。 */
  enableQqSource?: boolean
}

/** 配置补全默认值后的形态。 */
export interface ResolvedConfig extends Required<Omit<PluginConfig, 'remoteUrl' | 'dataDir'>> {
  remoteUrl: string
  dataDir: string
}

/** 统一日志接口。DSH 的 ctx.logger 不一定每个方法都有，调用前会做存在性检查。 */
export interface DshLogger {
  debug?: (message: string, ...args: unknown[]) => void
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
  error?: (message: string, ...args: unknown[]) => void
}

/**
 * 工具注册参数。
 *
 * 说明：`parameters` 用 JSON Schema（draft 2020-12 子集）描述，和 DSH 工具层的约定一致。
 * `handler` 收到的第一个参数是已按 schema 校验过的对象。
 */
export interface DshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * tools 服务的最小结构化契约。
 *
 * TODO: 按目标 DSH 版本确认注册方法名 —— 不同版本的 tools 服务可能叫
 * register / define / add / tool。`adapters/index.ts` 里的 `registerTool()`
 * 会按顺序探测，命中哪个用哪个，全都没有就 warn 并跳过，不抛错。
 */
export interface DshToolService {
  /**
   * @deepseek-ai/dsh-tools 0.0.1-rc.1 的真实签名：
   * `register(definition: ToolDefinition): () => void`，definition 需要
   * `output { schema, render }` 和 `execute`，参数是 ParameterSchemaSpec（属性映射，
   * 不是 JSON Schema）。tools.ts 里的 toRealDefinition() 负责转换。
   */
  register?: (definition: unknown) => unknown
  define?: (definition: unknown) => unknown
  add?: (definition: unknown) => unknown
  tool?: (definition: unknown) => unknown
  /** 按名字取已注册的工具，用于幂等判断。 */
  get?: (name: string) => unknown
  /** 工具名列表，用于存在性检测。可能是数组或 Map。 */
  list?: () => unknown
  /** 调用其它插件的公开工具。 */
  call?: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  [key: string]: unknown
}

/**
 * 宿主上下文的最小结构化契约。
 *
 * 这里**不 import `@deepseek-ai/cordis` 的 Context 类型**，是为了让本包在没有
 * 安装 DSH 依赖的环境里也能独立编译 / 单元测试；运行时它仍然就是 cordis 的 Context。
 * 结构化类型的好处：cordis 加字段、改签名，这里不会连带编译失败。
 */
export interface DshContext {
  tools?: DshToolService
  logger?: DshLogger
  /** 取服务。cordis: ctx.get(name) */
  get?: (name: string) => unknown
  /** 服务是否存在。cordis: ctx.has(name) */
  has?: (name: string) => boolean
  /**
   * 注册服务。cordis 4.x 是 `ctx.provide(name, value)`；
   * `ctx.set` 只能改已 provide 的服务，直接用在未声明的名字上会抛错。
   */
  provide?: (name: string, value?: unknown) => unknown
  /** 设置已 provide 的服务值。cordis: ctx.set(name, value) */
  set?: (name: string, value: unknown) => unknown
  /** 订阅事件。cordis: ctx.on(event, listener) */
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  /** 取消订阅。cordis: ctx.off(event, listener) */
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  /** 发送事件。cordis: ctx.emit(event, ...args) */
  emit?: (event: string, ...args: unknown[]) => unknown
  /** 给模型注入上下文（追加段，不碰系统前缀）。 */
  systemPrompt?: {
    context?: (provider: () => string) => unknown
    set?: (key: string, value: string) => unknown
    [key: string]: unknown
  }
  /** 插件注册表（用于按插件 id 检测）。 */
  registry?: {
    has?: (id: string) => boolean
    get?: (id: string) => unknown
    [key: string]: unknown
  }
  /** 已加载插件集合（Map 或带 has 的对象）。 */
  plugins?: { has?: (id: string) => boolean; [key: string]: unknown }
  /** cordis 的 effect/scope 清理钩子，存在时用于释放监听。 */
  effect?: (dispose: () => void) => unknown
  [key: string]: unknown
}

/** 适配器统一接口。detect 返回 false 就直接跳过，setup 内部绝不允许抛错。 */
export interface Adapter {
  id: string
  detect(ctx: DshContext): boolean
  setup(ctx: DshContext): void
}

/** 适配器初始化结果，用于启动日志与 get_memory_stats 的兼容性信息。 */
export interface AdapterStatus {
  id: string
  detected: boolean
  active: boolean
  notes: string[]
  /**
   * 运行时指标。判断适配器是不是「真的在工作」看这里：
   * 比如心情适配器的 received 一直是 0，说明事件名不对或插件没发事件。
   */
  metrics?: Record<string, number>
}

/**
 * 适配器工厂的依赖。
 *
 * 只传 store 和配置，不传 ctx —— ctx 在 detect/setup 时由调用方注入，
 * 这样同一个适配器实例可以被单测用假 ctx 反复驱动。
 */
export interface AdapterDeps {
  store: MemoryStore
  config: ResolvedConfig
}
