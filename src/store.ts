/**
 * store.ts —— 记忆的读写核心
 *
 * 三个数据源，边界必须清楚：
 *
 * ┌────────────────────────────┬──────────────────────────────┬────────────┐
 * │ 来源                        │ 位置                          │ 可写        │
 * ├────────────────────────────┼──────────────────────────────┼────────────┤
 * │ 公开种子（本包自带）          │ <pkg>/memories/*.json         │ 否（只读）   │
 * │ 本地私有（运行时产生）        │ <dataDir>/memories/L*.json    │ 是          │
 * │ 远程聚合（别人的公开库）       │ GitHub raw dist/...array.json │ 否          │
 * └────────────────────────────┴──────────────────────────────┴────────────┘
 *
 * 硬约束（有运行时保护，不靠自觉）：
 * - 本文件任何写入路径都会先过 `assertNotPackageMemories()`；
 *   目标落在包内 `memories/` 一律抛错。公开种子只能靠 PR 改，不能靠插件写。
 * - `dist/` 只由 `scripts/build_index.py` 从公开种子聚合，本文件不写 dist。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { anonymizeContributor, describeHits, pickPublicFields, redactPii, sanitizeTags, sanitizeUnicode, scanPii } from './privacy.js'
import type { PiiHit } from './privacy.js'
import { fetchRemoteMemories, resolveRemoteUrl } from './remote.js'
import type { RemoteResult } from './remote.js'

// ───────────────────────────── 数据模型 ─────────────────────────────

/** 只允许这两类。真实经历请写 semi-fiction 并做匿名化。 */
export type MemoryType = 'fiction' | 'semi-fiction'

/** 本地私有记忆的来源。公开 JSON 里没有这个字段。 */
export type MemorySource =
  | 'manual'
  | 'speak-up'
  | 'qq'
  | 'qqbot'
  | 'fish-memory'
  | 'pet'
  | 'tts'
  | 'system'

/** 公开记忆。字段与 schema/memory.schema.json 一一对应，多一个都算违约。 */
export interface PublicMemory {
  id: string
  fish_name: string
  contributor: string
  title: string
  content: string
  tags: string[]
  memory_type: MemoryType
  license: 'CC0-1.0'
  created_at: string
}

/**
 * 本地私有记忆 = 公开字段 + 私有字段。
 * 私有字段**永远不进入**公开 JSON，`preparePublic()` 会结构化剥离。
 */
export interface LocalMemory extends PublicMemory {
  visibility: 'private'
  source: MemorySource
  platform?: string
  freshness?: number
  half_life_days?: number
  mood_snapshot?: Record<string, number>
  long_term?: boolean
  created_by?: string
}

/** 合并视图：公开记忆没有 visibility/source，本地记忆有。 */
export interface MemoryView extends PublicMemory {
  visibility?: 'private'
  source?: MemorySource
  freshness?: number
}

/** 新鲜度分档。 */
export interface FreshnessBuckets {
  fresh: number
  warm: number
  cooling: number
  dormant: number
  average: number
}

/** `get_memory_stats` 的返回体，桌宠 / 心情 / TTS 适配器只读消费。 */
export interface MemoryStats {
  total: number
  public_count: number
  private_count: number
  today_added: number
  freshness: FreshnessBuckets
  sources: Record<string, number>
  data_dir: string
  contracts_version?: string
  generated_at: string
}

/** 可朗读条目。只有短句，没有私有字段。 */
export interface SpeakableItem {
  id: string
  text: string
  source: string
  freshness: number
}

/** submit_memory 的入参。 */
export interface SubmitInput {
  fish_name?: string
  title: string
  content: string
  tags?: string[]
  memory_type?: MemoryType
  source?: MemorySource
  platform?: string
  created_by?: string
  created_at?: string
}

/** submit_memory 的出参。 */
export interface SubmitResult {
  id: string
  saved_path: string
  visibility: 'private'
  public_draft?: PublicMemory
  privacy: {
    hits: PiiHit[]
    summary: string
    redacted: boolean
  }
}

/** prepare_public_memory 的出参。 */
export interface PrepareResult {
  path: string
  json: string
  memory: PublicMemory
  privacy: {
    hits: PiiHit[]
    summary: string
    redacted: boolean
  }
  warnings: string[]
}

/** get_memories 的出参。 */
export interface MergedResult {
  items: MemoryView[]
  total: number
  public_count: number
  private_count: number
  remote: { used: boolean; count: number; error?: string }
  warnings: string[]
}

/** 检索过滤条件。 */
export interface MemoryQuery {
  tag?: string
  keyword?: string
  source?: string
  include_private?: boolean
  include_remote?: boolean
  limit?: number
}

/** 构造参数。 */
export interface MemoryStoreOptions {
  /** 包根目录，默认由 import.meta.url 推出来。测试时可覆盖。 */
  packageRoot?: string
  /** 本地私有记忆根目录。留空按 resolveDataDir 的规则推断。 */
  dataDir?: string
  /** 新鲜度半衰期（天），默认 30。 */
  defaultHalfLifeDays?: number
  /** 远程地址覆盖。 */
  remoteUrl?: string
  /** 远程超时（毫秒），默认 3000。 */
  remoteTimeoutMs?: number
  /** 日志。只用来 warn，不抛错。 */
  logger?: StoreLogger
}

/** 最小日志接口，避免 store 依赖 cordis 类型。 */
export interface StoreLogger {
  warn?: (message: string) => void
  info?: (message: string) => void
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 公开记忆正文长度约束（按 Unicode 字符计，中文一个字算一个）。 */
export const CONTENT_MIN = 20
export const CONTENT_MAX = 300
/** 标题长度约束。 */
export const TITLE_MIN = 2
export const TITLE_MAX = 40
/** 默认半衰期。 */
export const DEFAULT_HALF_LIFE_DAYS = 30

const LOCAL_ID_PREFIX = 'L'
const LOCAL_ID_PATTERN = /^L(\d{4})$/
const PUBLIC_ID_PATTERN = /^\d{4}$/

// ───────────────────────────── 工具函数 ─────────────────────────────

/** 按 Unicode 字符计数，避免 emoji / 中文被 UTF-16 长度算错。 */
export function charLength(text: string): number {
  return [...text].length
}

/**
 * 按 Unicode 字符截断。
 *
 * 不能直接用 `String.prototype.slice`：`'🐟'.length` 是 2，
 * `'🐟'.repeat(300).slice(0, 300)` 只会留下 150 条鱼，
 * 而且不报错、不触发长度下限警告 —— 是静默的数据丢失。
 */
export function truncateChars(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免时区把凌晨算成前一天）。 */
export function todayLocal(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 新鲜度：指数衰减。
 * freshness = 2 ^ (-ageDays / halfLifeDays)，0~1，保留三位小数。
 * 刚创建 = 1.000；过一个半衰期 = 0.500；两个半衰期 = 0.250。
 */
export function computeFreshness(
  createdAt: string,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
  now: Date = new Date(),
): number {
  const created = new Date(`${createdAt}T00:00:00`)
  const createdMs = created.getTime()
  if (Number.isNaN(createdMs)) return 0
  const ageDays = (now.getTime() - createdMs) / 86_400_000
  if (ageDays <= 0) return 1
  const halfLife = halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS
  const value = Math.pow(2, -ageDays / halfLife)
  return Math.round(value * 1000) / 1000
}

/** 内容指纹，用于跨来源去重（公开 / 本地 / 远程可能同文）。 */
export function contentFingerprint(content: string): string {
  return createHash('sha1').update(content.replace(/\s+/gu, '')).digest('hex').slice(0, 16)
}

/**
 * 解析数据根目录。优先级：显式配置 > 环境变量 > 宿主探测 > 默认路径。
 * 用户显式设置的值永远排在自动探测前面。
 */
export function resolveDataDir(hints: { explicit?: string; fromDsh?: string; env?: string } = {}): string {
  const explicit = (hints.explicit ?? '').trim()
  if (explicit) return path.resolve(explicit)

  const fromEnv = (hints.env ?? process.env['DAFEIYU_MEMORIES_DIR'] ?? '').trim()
  if (fromEnv) return path.resolve(fromEnv)

  const fromDsh = (hints.fromDsh ?? '').trim()
  if (fromDsh) return path.resolve(fromDsh)

  return path.join(os.homedir(), '.dsh', 'data', 'dafeiyu-memories')
}

/** 包根目录：lib/ 或 src/ 的上一级。 */
export function defaultPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宽松解析一条公开记忆；字段缺失/类型不对返回 null（调用方跳过并 warn）。 */
export function parsePublicMemory(value: unknown, options: { allowLocalId?: boolean } = {}): PublicMemory | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const title = value['title']
  const content = value['content']
  const tags = value['tags']
  if (typeof id !== 'string') return null
  const idOk = options.allowLocalId
    ? PUBLIC_ID_PATTERN.test(id) || LOCAL_ID_PATTERN.test(id)
    : PUBLIC_ID_PATTERN.test(id)
  if (!idOk) return null
  if (typeof title !== 'string' || typeof content !== 'string') return null
  if (!Array.isArray(tags)) return null

  const memoryType = value['memory_type'] === 'semi-fiction' ? 'semi-fiction' : 'fiction'
  return {
    id,
    fish_name: typeof value['fish_name'] === 'string' && value['fish_name'].trim() ? value['fish_name'].trim() : '大肥鱼',
    contributor: typeof value['contributor'] === 'string' && value['contributor'].trim() ? value['contributor'].trim() : '匿名',
    title: title.trim(),
    content: content.trim(),
    tags: tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0),
    memory_type: memoryType,
    license: 'CC0-1.0',
    created_at: typeof value['created_at'] === 'string' ? value['created_at'] : '1970-01-01',
  }
}

/** 解析一条本地私有记忆。比公开记忆多几个可选字段，缺失不补。 */
export function parseLocalMemory(value: unknown): LocalMemory | null {
  const base = parsePublicMemory(value, { allowLocalId: true })
  if (!base) return null
  const record = value as Record<string, unknown>
  const source = record['source']
  const allowed: MemorySource[] = ['manual', 'speak-up', 'qq', 'qqbot', 'fish-memory', 'pet', 'tts', 'system']
  const local: LocalMemory = {
    ...base,
    visibility: 'private',
    source: allowed.includes(source as MemorySource) ? (source as MemorySource) : 'manual',
  }
  if (typeof record['platform'] === 'string') local.platform = record['platform']
  if (typeof record['freshness'] === 'number') local.freshness = record['freshness']
  if (typeof record['half_life_days'] === 'number') local.half_life_days = record['half_life_days']
  if (typeof record['long_term'] === 'boolean') local.long_term = record['long_term']
  if (typeof record['created_by'] === 'string') local.created_by = record['created_by']
  if (isRecord(record['mood_snapshot'])) {
    const snapshot: Record<string, number> = {}
    for (const [key, mood] of Object.entries(record['mood_snapshot'])) {
      if (typeof mood === 'number' && Number.isFinite(mood)) snapshot[key] = mood
    }
    local.mood_snapshot = snapshot
  }
  return local
}

/** 序列化成落盘文本（2 空格缩进 + 结尾换行，和 Python 脚本保持一致）。 */
export function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ───────────────────────────── Store ─────────────────────────────

export class MemoryStore {
  readonly packageRoot: string
  readonly packageMemoriesDir: string
  readonly dataDir: string
  readonly localMemoriesDir: string
  readonly draftsDir: string
  readonly exportsDir: string

  private readonly defaultHalfLifeDays: number
  private readonly remoteUrl: string
  private readonly remoteTimeoutMs: number
  private readonly logger: StoreLogger

  constructor(options: MemoryStoreOptions = {}) {
    this.packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot())
    this.packageMemoriesDir = path.join(this.packageRoot, 'memories')
    this.dataDir = resolveDataDir({ explicit: options.dataDir })
    this.localMemoriesDir = path.join(this.dataDir, 'memories')
    this.draftsDir = path.join(this.dataDir, 'drafts')
    this.exportsDir = path.join(this.dataDir, 'exports')
    this.defaultHalfLifeDays = options.defaultHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
    this.remoteUrl = resolveRemoteUrl(options.remoteUrl)
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? 3000
    this.logger = options.logger ?? {}
  }

  /** 路径一览，工具返回值里会带上，方便用户确认「到底写到哪了」。 */
  getPaths(): { package_memories: string; data_dir: string; local_memories: string; exports: string } {
    return {
      package_memories: this.packageMemoriesDir,
      data_dir: this.dataDir,
      local_memories: this.localMemoriesDir,
      exports: this.exportsDir,
    }
  }

  /**
   * 写路径保护：拒绝写入包内 memories/。
   *
   * 这不是可选项。插件运行时产生的记忆如果写进包目录，
   * 一次 `npm publish` 就可能把私人记忆带上公网 —— 所以这里直接抛错。
   */
  assertNotPackageMemories(target: string): void {
    const resolved = path.resolve(target)
    const publicDir = path.resolve(this.packageMemoriesDir)
    const relative = path.relative(publicDir, resolved)
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    if (inside) {
      throw new Error(
        `[dafeiyu-memories] 拒绝写入包内公开种子目录：${resolved}。` +
          '公开记忆只能通过 PR 修改；运行时记忆请写入 dataDir。',
      )
    }
  }

  // ── 读 ────────────────────────────────────────────────

  /** 读包内公开种子。跳过 template.json；坏文件只 warn。 */
  async readPublicMemories(): Promise<PublicMemory[]> {
    const files = await listJsonFiles(this.packageMemoriesDir)
    const memories: PublicMemory[] = []
    for (const file of files) {
      if (file === 'template.json') continue
      const full = path.join(this.packageMemoriesDir, file)
      const parsed = await readJson(full)
      if (parsed === undefined) {
        this.warn(`公开记忆解析失败，已跳过：${file}`)
        continue
      }
      const memory = parsePublicMemory(parsed)
      if (!memory) {
        this.warn(`公开记忆字段不合法，已跳过：${file}`)
        continue
      }
      memories.push(memory)
    }
    memories.sort((a, b) => a.id.localeCompare(b.id))
    return memories
  }

  /** 读本地私有记忆。目录不存在返回空数组。 */
  async readLocalMemories(): Promise<LocalMemory[]> {
    const files = await listJsonFiles(this.localMemoriesDir)
    const memories: LocalMemory[] = []
    for (const file of files) {
      if (!LOCAL_ID_PATTERN.test(file.replace(/\.json$/u, ''))) continue
      const parsed = await readJson(path.join(this.localMemoriesDir, file))
      if (parsed === undefined) {
        this.warn(`本地记忆解析失败，已跳过：${file}`)
        continue
      }
      const memory = parseLocalMemory(parsed)
      if (!memory) {
        this.warn(`本地记忆字段不合法，已跳过：${file}`)
        continue
      }
      if (memory.freshness === undefined) {
        memory.freshness = computeFreshness(
          memory.created_at,
          memory.half_life_days ?? this.defaultHalfLifeDays,
        )
      }
      memories.push(memory)
    }
    memories.sort((a, b) => a.id.localeCompare(b.id))
    return memories
  }

  /** 读单条本地记忆。找不到返回 null。 */
  async readLocalMemory(localId: string): Promise<LocalMemory | null> {
    if (!LOCAL_ID_PATTERN.test(localId)) return null
    const parsed = await readJson(path.join(this.localMemoriesDir, `${localId}.json`))
    if (parsed === undefined) return null
    return parseLocalMemory(parsed)
  }

  // ── 合并查询 ────────────────────────────────────────────

  /**
   * 合并三源：公开种子 + 本地私有（仅当 include_private）+ 远程。
   * 去重键：公开 id + 内容指纹。远程失败静默降级。
   */
  async list(query: MemoryQuery = {}): Promise<MergedResult> {
    const warnings: string[] = []
    const publicMemories = await this.readPublicMemories()
    const localMemories = query.include_private ? await this.readLocalMemories() : []

    const seenIds = new Set(publicMemories.map((item) => item.id))
    const seenFingerprints = new Set(publicMemories.map((item) => contentFingerprint(item.content)))

    const items: MemoryView[] = publicMemories.map((item) => ({ ...item }))
    for (const local of localMemories) {
      if (seenIds.has(local.id)) continue
      const fingerprint = contentFingerprint(local.content)
      if (seenFingerprints.has(fingerprint)) continue
      seenIds.add(local.id)
      seenFingerprints.add(fingerprint)
      items.push({ ...local })
    }

    let remote: RemoteResult | null = null
    if (query.include_remote !== false) {
      remote = await fetchRemoteMemories(this.remoteUrl, this.remoteTimeoutMs)
      // 占位符属于「还没配置」，是预期状态，不当成错误提示给用户
      if (!remote.ok && !remote.skipped && remote.error) warnings.push(`远程记忆已降级：${remote.error}`)
      for (const item of remote.items) {
        if (seenIds.has(item.id)) continue
        const fingerprint = contentFingerprint(item.content)
        if (seenFingerprints.has(fingerprint)) continue
        seenIds.add(item.id)
        seenFingerprints.add(fingerprint)
        items.push({ ...item })
      }
    }

    const filtered = items.filter((item) => matchesQuery(item, query))
    filtered.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
      return a.id < b.id ? 1 : -1
    })

    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 500) : 200
    const sliced = filtered.slice(0, limit)

    return {
      items: sliced,
      total: filtered.length,
      public_count: publicMemories.length,
      private_count: localMemories.length,
      remote: {
        used: remote?.ok ?? false,
        count: remote?.items.length ?? 0,
        ...(remote?.error && !remote.skipped ? { error: remote.error } : {}),
      },
      warnings,
    }
  }

  // ── 写本地私有 ──────────────────────────────────────────

  /**
   * 写入一条本地私有记忆。
   *
   * 必须注意：
   * - 目标目录是 dataDir，不是包内 memories/（写入前有 assert）。
   * - QQ / QQBot 来源强制 strict 脱敏；其它来源保留原文但把命中项回传，
   *   并在 public_draft 里使用脱敏后的文本。
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const source: MemorySource = input.source ?? 'manual'
    const title = (input.title ?? '').trim()
    const rawContent = (input.content ?? '').trim()

    if (charLength(title) < TITLE_MIN || charLength(title) > TITLE_MAX) {
      throw new Error(`标题长度需在 ${TITLE_MIN}-${TITLE_MAX} 字之间（当前 ${charLength(title)} 字）`)
    }
    if (charLength(rawContent) < CONTENT_MIN || charLength(rawContent) > CONTENT_MAX) {
      throw new Error(`正文长度需在 ${CONTENT_MIN}-${CONTENT_MAX} 字之间（当前 ${charLength(rawContent)} 字）`)
    }

    const forceRedact = source === 'qq' || source === 'qqbot'
    const strictScan = scanPii(rawContent, 'strict')
    const content = forceRedact ? redactPii(rawContent, 'strict').text : rawContent
    const titleText = forceRedact ? redactPii(title, 'strict').text : title

    const record: LocalMemory = {
      id: 'L0000', // 占位，落盘前替换
      fish_name: (input.fish_name ?? '大肥鱼').trim() || '大肥鱼',
      contributor: anonymizeContributor(input.created_by),
      title: titleText,
      content,
      tags: sanitizeTags(input.tags),
      memory_type: input.memory_type === 'semi-fiction' ? 'semi-fiction' : 'fiction',
      license: 'CC0-1.0',
      created_at: input.created_at ?? todayLocal(),
      visibility: 'private',
      source,
      half_life_days: this.defaultHalfLifeDays,
      freshness: computeFreshness(input.created_at ?? todayLocal(), this.defaultHalfLifeDays),
    }
    if (input.platform) record.platform = input.platform
    if (input.created_by) record.created_by = input.created_by

    const saved = await this.writeLocalMemory(record)
    const publicMemories = await this.readPublicMemories()
    const draftId = nextPublicId(publicMemories.map((item) => item.id))

    return {
      id: saved.id,
      saved_path: saved.path,
      visibility: 'private',
      public_draft: this.buildDraft(saved.record, draftId),
      privacy: {
        hits: strictScan,
        summary: describeHits(strictScan),
        redacted: forceRedact && strictScan.length > 0,
      },
    }
  }

  /**
   * 生成公开草稿：严格过滤 + 结构化剥离 + 分配公开 id。
   * **不写任何文件**，只返回建议路径和 JSON 文本，由用户自己提交 PR。
   */
  async preparePublic(localId: string): Promise<PrepareResult> {
    const local = await this.readLocalMemory(localId)
    if (!local) throw new Error(`找不到本地记忆 ${localId}（本地 id 形如 L0001）`)

    const publicMemories = await this.readPublicMemories()
    const publicId = nextPublicId(publicMemories.map((item) => item.id))
    const warnings: string[] = []

    const memory = this.buildDraft(local, publicId)
    const hits = scanPii(local.content, 'strict')

    const length = charLength(memory.content)
    if (length < CONTENT_MIN) {
      warnings.push(`脱敏后正文只剩 ${length} 字，低于 ${CONTENT_MIN} 字下限，请补写虚构细节`)
    }
    if (length > CONTENT_MAX) {
      warnings.push(`脱敏后正文 ${length} 字，超过 ${CONTENT_MAX} 字上限，请删减`)
    }
    if (memory.tags.length === 0) {
      warnings.push('脱敏后没有可用标签，请至少补一个')
    }

    return {
      path: `memories/${publicId}.json`,
      json: toJsonFile(memory),
      memory,
      privacy: {
        hits,
        summary: describeHits(hits),
        redacted: hits.length > 0,
      },
      warnings,
    }
  }

  /** 按公开字段 + 脱敏规则构造草稿对象（内部使用）。 */
  private buildDraft(local: LocalMemory, publicId: string): PublicMemory {
    const title = truncateChars(redactPii(sanitizeUnicode(local.title), 'strict').text, TITLE_MAX)
    const content = truncateChars(redactPii(sanitizeUnicode(local.content), 'strict').text, CONTENT_MAX)
    const draft: PublicMemory = {
      id: publicId,
      fish_name: local.fish_name,
      contributor: '匿名',
      title,
      content,
      tags: sanitizeTags(local.tags),
      memory_type: local.memory_type,
      license: 'CC0-1.0',
      created_at: local.created_at,
    }
    // 兜底：结构化剥离。即使 buildDraft 以后被改动，也不会把私有字段带出去。
    const onlyPublic = pickPublicFields(draft as unknown as Record<string, unknown>)
    return onlyPublic as unknown as PublicMemory
  }

  /** 写一条本地记忆，自动分配 id 并处理并发撞号。 */
  private async writeLocalMemory(record: LocalMemory): Promise<{ id: string; path: string; record: LocalMemory }> {
    await mkdir(this.localMemoriesDir, { recursive: true })

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = await this.nextLocalId()
      const target = path.join(this.localMemoriesDir, `${id}.json`)
      this.assertNotPackageMemories(target)

      // 落盘前统一清理孤立代理：JSON 能转义存进去，但下游 Python 写盘会崩
      const payload: LocalMemory = {
        ...record,
        id,
        title: sanitizeUnicode(record.title),
        content: sanitizeUnicode(record.content),
        tags: record.tags.map((tag) => sanitizeUnicode(tag)),
      }
      const text = toJsonFile(payload)
      try {
        await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
        return { id, path: target, record: payload }
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue
        throw error
      }
    }
    throw new Error('本地记忆 id 分配失败：连续 20 次撞号，请检查 dataDir 是否被并发写入')
  }

  /** 下一个可用的本地 id：L0001 起，四位数字。 */
  async nextLocalId(): Promise<string> {
    const files = await listJsonFiles(this.localMemoriesDir)
    let max = 0
    for (const file of files) {
      const match = LOCAL_ID_PATTERN.exec(file.replace(/\.json$/u, ''))
      if (!match) continue
      const value = Number.parseInt(match[1] ?? '0', 10)
      if (Number.isFinite(value) && value > max) max = value
    }
    if (max >= 9999) throw new Error('本地记忆 id 已用尽（L9999），请归档 dataDir 后重试')
    return `${LOCAL_ID_PREFIX}${String(max + 1).padStart(4, '0')}`
  }

  // ── 统计 / 朗读 ─────────────────────────────────────────

  /** 聚合统计。桌宠、心情、TTS 适配器只读这里。 */
  async stats(): Promise<MemoryStats> {
    const publicMemories = await this.readPublicMemories()
    const localMemories = await this.readLocalMemories()
    const today = todayLocal()

    const sources: Record<string, number> = { public: publicMemories.length }
    for (const local of localMemories) {
      sources[local.source] = (sources[local.source] ?? 0) + 1
    }

    const buckets: FreshnessBuckets = { fresh: 0, warm: 0, cooling: 0, dormant: 0, average: 0 }
    let freshnessSum = 0
    const all = [...publicMemories.map((item) => ({ created_at: item.created_at })), ...localMemories]
    for (const item of all) {
      const value = computeFreshness(item.created_at, this.defaultHalfLifeDays)
      freshnessSum += value
      if (value >= 0.75) buckets.fresh += 1
      else if (value >= 0.5) buckets.warm += 1
      else if (value >= 0.25) buckets.cooling += 1
      else buckets.dormant += 1
    }
    buckets.average = all.length === 0 ? 0 : Math.round((freshnessSum / all.length) * 1000) / 1000

    const todayAdded =
      publicMemories.filter((item) => item.created_at === today).length +
      localMemories.filter((item) => item.created_at === today).length

    return {
      total: publicMemories.length + localMemories.length,
      public_count: publicMemories.length,
      private_count: localMemories.length,
      today_added: todayAdded,
      freshness: buckets,
      sources,
      data_dir: this.dataDir,
      generated_at: new Date().toISOString(),
    }
  }

  /**
   * 挑 1-2 条适合朗读的短句。
   * 规则：只取公开 + 可选本地；过滤含隐私的；取第一句且 8-60 字；按新鲜度排序。
   */
  async speakable(limit = 2, includePrivate = true): Promise<SpeakableItem[]> {
    const publicMemories = await this.readPublicMemories()
    const localMemories = includePrivate ? await this.readLocalMemories() : []

    const pool: Array<{ id: string; text: string; source: string; created_at: string }> = []
    for (const item of publicMemories) {
      pool.push({ id: item.id, text: item.content, source: 'public', created_at: item.created_at })
    }
    for (const item of localMemories) {
      pool.push({ id: item.id, text: item.content, source: item.source, created_at: item.created_at })
    }

    const candidates: SpeakableItem[] = []
    for (const item of pool) {
      if (scanPii(item.text, 'strict').length > 0) continue
      const sentence = firstSentence(item.text)
      if (charLength(sentence) < 8 || charLength(sentence) > 60) continue
      candidates.push({
        id: item.id,
        text: sentence,
        source: item.source,
        freshness: computeFreshness(item.created_at, this.defaultHalfLifeDays),
      })
    }

    candidates.sort((a, b) => b.freshness - a.freshness)
    const picked = candidates.slice(0, Math.max(1, Math.min(limit, 2)))

    // 只有一条时，补一条不同来源的，避免每次朗读都一样
    if (picked.length === 1) {
      const fallback = candidates.find((item) => item.id !== picked[0]?.id)
      if (fallback) picked.push(fallback)
    }
    return picked
  }

  // ── fish-memory 互操作 ───────────────────────────────────

  /** 导出为 dsh-fish-memory 兼容结构。默认只写 exports/，不碰对方存储。 */
  async exportFishMemory(ids?: string[]): Promise<{ path: string; count: number; content: string }> {
    const localMemories = await this.readLocalMemories()
    const selected = ids && ids.length > 0 ? localMemories.filter((item) => ids.includes(item.id)) : localMemories

    const payload = {
      format: 'dsh-fish-memory/export@1',
      exported_at: new Date().toISOString(),
      source: 'dsh-dafeiyu-memories',
      memories: selected.map((item) => ({
        id: item.id,
        content: item.content,
        freshness: computeFreshness(item.created_at, item.half_life_days ?? this.defaultHalfLifeDays),
        half_life_days: item.half_life_days ?? this.defaultHalfLifeDays,
        long_term: item.long_term ?? false,
        source: item.source,
        created_at: item.created_at,
      })),
    }

    await mkdir(this.exportsDir, { recursive: true })
    const filename = `fish-memory-${Date.now()}.json`
    const target = path.join(this.exportsDir, filename)
    this.assertNotPackageMemories(target)
    const content = toJsonFile(payload)
    await writeFile(target, content, 'utf8')

    return { path: target, count: selected.length, content }
  }

  /** 从 dsh-fish-memory 导出数据导入。按内容指纹去重，全部写成 private。 */
  async importFishMemory(
    payload: unknown,
  ): Promise<{ imported: number; skipped: number; ids: string[] }> {
    const list = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload['memories'])
        ? (payload['memories'] as unknown[])
        : []
    if (list.length === 0) return { imported: 0, skipped: 0, ids: [] }

    const existing = await this.readLocalMemories()
    const fingerprints = new Set(existing.map((item) => contentFingerprint(item.content)))
    const ids: string[] = []
    let skipped = 0

    for (const raw of list) {
      if (!isRecord(raw)) {
        skipped += 1
        continue
      }
      const content = typeof raw['content'] === 'string' ? raw['content'].trim() : ''
      if (charLength(content) < CONTENT_MIN) {
        skipped += 1
        continue
      }
      const fingerprint = contentFingerprint(content)
      if (fingerprints.has(fingerprint)) {
        skipped += 1
        continue
      }
      const halfLife = typeof raw['half_life_days'] === 'number' ? raw['half_life_days'] : this.defaultHalfLifeDays
      const rawTitle =
        typeof raw['title'] === 'string' && raw['title'].trim() ? raw['title'] : truncateChars(content, 16)
      const record: LocalMemory = {
        id: 'L0000',
        fish_name: '大肥鱼',
        contributor: '匿名',
        title: truncateChars(rawTitle, TITLE_MAX),
        content: truncateChars(content, CONTENT_MAX),
        tags: ['导入', 'fish-memory'],
        memory_type: 'semi-fiction',
        license: 'CC0-1.0',
        created_at: typeof raw['created_at'] === 'string' ? raw['created_at'].slice(0, 10) : todayLocal(),
        visibility: 'private',
        source: 'fish-memory',
        half_life_days: halfLife,
        long_term: raw['long_term'] === true,
        freshness: computeFreshness(todayLocal(), halfLife),
      }
      const saved = await this.writeLocalMemory(record)
      fingerprints.add(fingerprint)
      ids.push(saved.id)
    }

    return { imported: ids.length, skipped, ids }
  }

  /** 给本地记忆附加心情快照（只在私有侧，公开时剥离）。 */
  async linkMood(localId: string, snapshot: Record<string, number>): Promise<{ id: string; mood_snapshot: Record<string, number> }> {
    const local = await this.readLocalMemory(localId)
    if (!local) throw new Error(`找不到本地记忆 ${localId}`)
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
    }
    const updated: LocalMemory = { ...local, mood_snapshot: clean }
    const target = path.join(this.localMemoriesDir, `${localId}.json`)
    this.assertNotPackageMemories(target)
    await writeFile(target, toJsonFile(updated), 'utf8')
    return { id: localId, mood_snapshot: clean }
  }

  // ── 内部 ──────────────────────────────────────────────

  private warn(message: string): void {
    this.logger.warn?.(`[dafeiyu-memories] ${message}`)
  }
}

// ───────────────────────────── 内部工具 ─────────────────────────────

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code
}

/** 按 id 与内容过滤。tag 精确匹配（大小写不敏感），keyword 覆盖标题/正文/标签/鱼名。 */
function matchesQuery(item: MemoryView, query: MemoryQuery): boolean {
  if (query.source && item.source !== query.source) return false
  if (query.tag) {
    const wanted = query.tag.toLowerCase()
    if (!item.tags.some((tag) => tag.toLowerCase() === wanted)) return false
  }
  if (query.keyword) {
    const keyword = query.keyword.toLowerCase()
    const haystack = [item.title, item.content, item.fish_name, ...item.tags].join('\n').toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  return true
}

/** 取第一句：按中文/英文句末标点切，兜底整段。 */
function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const match = /^[^。！？!?；;\n]{4,80}[。！？!?]?/u.exec(normalized)
  return (match?.[0] ?? normalized).trim()
}

/** 下一个公开 id：现有最大 +1，四位补零。 */
export function nextPublicId(existingIds: readonly string[]): string {
  let max = 0
  for (const id of existingIds) {
    if (!PUBLIC_ID_PATTERN.test(id)) continue
    const value = Number.parseInt(id, 10)
    if (Number.isFinite(value) && value > max) max = value
  }
  const next = max + 1
  if (next > 9999) throw new Error('公开 id 已用尽（0001-9999）')
  return String(next).padStart(4, '0')
}

/** 清理临时文件（上传失败时用）。 */
export async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch {
    // 忽略
  }
}

/** 供测试/脚本复用的路径常量。 */
export const PATHS = {
  packageMemories: 'memories',
  dist: 'dist',
  localMemories: 'memories',
} as const
