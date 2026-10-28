/**
 * privacy.ts —— 隐私过滤与匿名化
 *
 * 设计原则：
 * 1. **偏严**：公开草稿走 strict 级别，宁可把「他说这家公司」误伤成「他说[单位]」，
 *    也不放过一条真实单位名。误伤可以手工改，泄漏收不回来。
 * 2. **结构化 + 文本双层**：文本层用正则扫，结构化层直接丢弃
 *    platform / created_by / mood_snapshot 等私有字段。
 * 3. **公开草稿强制过滤**：`toPublicDraft()` 内部必定调用 strict 扫描，
 *    没有「跳过过滤」的参数，也不提供这样的开关。
 */

/** 敏感信息类别。 */
export type PiiKind =
  | 'phone'
  | 'email'
  | 'id-card'
  | 'qq'
  | 'wechat'
  | 'group'
  | 'url'
  | 'mention'
  | 'address'
  | 'school'
  | 'organization'

/**
 * 孤立代理项（半个 emoji）。JSON 里可以用 `\ud800` 转义写进文件，
 * 但 Python 侧 `ensure_ascii=False` 写盘时会直接抛 UnicodeEncodeError。
 * 入库前统一换成 U+FFFD，别把非法 Unicode 带进公开库。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu

/** 把孤立代理项替换成 U+FFFD。合法文本原样返回。 */
export function sanitizeUnicode(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD')
}

/** 一条命中记录。start/end 是原文本中的下标，用于精确替换。 */
export interface PiiHit {
  kind: PiiKind
  label: string
  match: string
  start: number
  end: number
}

/** 扫描级别。public 只扫「强标识」，strict 额外扫地址/学校/单位。 */
export type ScanLevel = 'public' | 'strict'

interface PiiRule {
  kind: PiiKind
  label: string
  source: string
  levels: ScanLevel[]
}

/**
 * 规则表。所有正则都用 `new RegExp(source, 'gu')` 独立构造，
 * 避免共享 lastIndex 导致的漏扫。
 */
const RULES: PiiRule[] = [
  {
    kind: 'phone',
    label: '手机号',
    // 中国大陆手机号：1 开头，第二位 3-9，共 11 位，两侧不能紧邻数字
    source: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'email',
    label: '邮箱',
    source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'id-card',
    label: '身份证',
    // 18 位身份证：6 位地区码 + 8 位生日 + 3 位顺序码 + 1 位校验位
    source: String.raw`(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'group',
    label: '群号',
    source: String.raw`(?:群号|群聊号|QQ\s*群|qq\s*群)\s*[:：]?\s*\d{5,12}`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'qq',
    label: 'QQ号',
    source: String.raw`(?:QQ|qq|Qq|qQ|扣扣)\s*(?:号码|号)?\s*[:：]?\s*[1-9]\d{4,10}`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'wechat',
    label: '微信号',
    source: String.raw`(?:微信号|微信|WeChat|wechat|VX|vx|V信)\s*(?:号|ID|id)?\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'url',
    label: '链接',
    source: String.raw`https?:\/\/[^\s，。；、）)】]+`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'mention',
    label: '提及',
    source: String.raw`@[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}`,
    levels: ['public', 'strict'],
  },
  {
    kind: 'address',
    label: '地址',
    // 省 + 市/区/县 连写
    source: String.raw`[\u4e00-\u9fa5]{2,8}(?:省|自治区|市)[\u4e00-\u9fa5]{2,8}(?:市|区|县|旗)`,
    levels: ['strict'],
  },
  {
    kind: 'address',
    label: '地址',
    // 路/街/大道 + 门牌号
    source: String.raw`[\u4e00-\u9fa5]{2,10}(?:路|街|大道)[\u4e00-\u9fa5\d]{0,6}号`,
    levels: ['strict'],
  },
  {
    kind: 'address',
    label: '地址',
    // 小区名
    source: String.raw`[\u4e00-\u9fa5]{2,10}小区(?:[\u4e00-\u9fa5\d]{0,8}(?:栋|号楼|单元|室|号))?`,
    levels: ['strict'],
  },
  {
    kind: 'address',
    label: '地址',
    // 门牌：3 号楼 2 单元 501 室
    source: String.raw`\d{1,4}(?:号楼|栋|单元)\d{0,4}(?:室|号)?`,
    levels: ['strict'],
  },
  {
    kind: 'school',
    label: '学校',
    source: String.raw`[\u4e00-\u9fa5]{2,12}(?:大学|学院|中学|小学|附中|附小|职校|技校)`,
    levels: ['strict'],
  },
  {
    kind: 'organization',
    label: '单位',
    source: String.raw`[\u4e00-\u9fa5]{2,10}(?:有限公司|公司|集团|研究院|研究所|事务所|医院|银行)`,
    levels: ['strict'],
  },
]

/**
 * 句首代词 / 介词。剥掉它们之后再看剩下的部分是不是「纯泛指机构」。
 *
 * 注意：不能一看到「在」就判定误伤 —— 「在字节跳动公司」里的「在」是介词，
 * 后面跟的是真实单位名，必须命中。所以判断依据是**剥离后的剩余部分**。
 */
const LEADING_NOISE = /^(?:他们|她们|我们|你们|他|她|我|你|它|的|了|在|从|到|和|跟|去了|来到|回到|离开|走进)+/u

/**
 * 只剩泛称的机构：医院、公司、学校、银行……
 * 允许前面带「一家 / 这家 / 某所」这类量词。
 */
const GENERIC_ONLY =
  /^(?:[一二两三四五六七八九十这那某每]\s*(?:家|所|个|座|间)?)?(?:医院|公司|学校|银行|集团|大学|学院|中学|小学|超市|商场|单位)$/u

/** 「他说这家公司」这种：结尾是量词 + 泛称，同样属于泛指。 */
const GENERIC_SUFFIX =
  /(?:这|那|一|某|每|两|几)\s*(?:家|所|个|座|间)?\s*(?:医院|公司|学校|银行|集团|大学|学院|中学|小学|超市|商场)$/u

function isFalsePositive(hit: PiiHit): boolean {
  if (hit.kind !== 'address' && hit.kind !== 'school' && hit.kind !== 'organization') {
    return false
  }
  const stripped = hit.match.replace(LEADING_NOISE, '')
  return GENERIC_ONLY.test(stripped) || GENERIC_SUFFIX.test(stripped)
}

/** 扫描文本，返回所有命中（按出现位置排序，已剔除常见误伤）。 */
export function scanPii(text: string, level: ScanLevel = 'strict'): PiiHit[] {
  if (!text) return []
  const hits: PiiHit[] = []

  for (const rule of RULES) {
    if (!rule.levels.includes(level)) continue
    const pattern = new RegExp(rule.source, 'gu')
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      if (!raw || match.index === undefined) continue
      const hit: PiiHit = {
        kind: rule.kind,
        label: rule.label,
        match: raw,
        start: match.index,
        end: match.index + raw.length,
      }
      if (isFalsePositive(hit)) continue
      hits.push(hit)
    }
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  return hits
}

/**
 * 合并重叠区间，用于替换。
 *
 * 不能像以前那样「丢掉重叠的那条」：文本 `QQ：123456789a@b.com` 里，
 * QQ 规则命中前段、邮箱规则命中 `123456789a@b.com`，丢掉邮箱后只替换了 QQ 部分，
 * `a@b.com` 就原样留在公开草稿里。合并成一整段再替换才不漏。
 */
function mergeRanges(hits: PiiHit[]): PiiHit[] {
  const merged: PiiHit[] = []
  for (const hit of hits) {
    const last = merged[merged.length - 1]
    if (last && hit.start < last.end) {
      if (hit.end > last.end) last.end = hit.end
      continue
    }
    merged.push({ ...hit })
  }
  return merged
}

/** 文本是否含敏感信息。 */
export function containsPii(text: string, level: ScanLevel = 'public'): boolean {
  return scanPii(text, level).length > 0
}

/**
 * 脱敏：把命中的片段替换为 `[手机号]`、`[地址]` 这类占位符。
 * 返回替换后的文本和命中列表（命中列表用于向用户解释「改了哪些地方」）。
 */
export function redactPii(text: string, level: ScanLevel = 'strict'): { text: string; hits: PiiHit[] } {
  const found = scanPii(text, level)
  if (found.length === 0) return { text, hits: found }
  const hits = mergeRanges(found)

  let output = ''
  let cursor = 0
  for (const hit of hits) {
    output += text.slice(cursor, hit.start)
    output += `[${hit.label}]`
    cursor = hit.end
  }
  output += text.slice(cursor)
  return { text: output, hits }
}

/** 命中列表 → 中文说明，用于工具返回值和日志。 */
export function describeHits(hits: PiiHit[]): string {
  if (hits.length === 0) return '未发现敏感信息'
  const counter = new Map<string, number>()
  for (const hit of hits) {
    counter.set(hit.label, (counter.get(hit.label) ?? 0) + 1)
  }
  return [...counter.entries()].map(([label, count]) => `${label}×${count}`).join('、')
}

/** 按 Unicode 字符计数。不能用 .length：一个 emoji 在 UTF-16 里占两个单位。 */
function charCount(text: string): number {
  return [...text].length
}

/** 标签清洗：含敏感信息的标签直接丢弃，不做替换（替换后的标签没有检索价值）。 */
export function sanitizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    if (charCount(tag) > 16) continue
    if (containsPii(tag, 'strict')) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= 8) break
  }
  return result
}

/**
 * 署名匿名化：
 * - 空值 / 「匿名」/「anonymous」→ 统一成「匿名」
 * - 含手机号、邮箱、QQ 等 → 「匿名」
 * - 其它短昵称 → 保留（用户自愿署名，不属于隐私泄漏）
 */
export function anonymizeContributor(name: string | undefined): string {
  const value = (name ?? '').trim()
  if (!value) return '匿名'
  if (value === '匿名' || /^anonymous$/i.test(value)) return '匿名'
  if (charCount(value) > 40) return '匿名'
  if (containsPii(value, 'strict')) return '匿名'
  return value
}

/** 公开记忆的固定字段集合。剥离私有字段时以此为准。 */
const PUBLIC_FIELDS = [
  'id',
  'fish_name',
  'contributor',
  'title',
  'content',
  'tags',
  'memory_type',
  'license',
  'created_at',
] as const

/**
 * 只保留公开字段（结构化剥离）。
 * 注意：这个函数不做文本脱敏，只丢字段；文本层必须再走 redactPii。
 */
export function pickPublicFields<T extends Record<string, unknown>>(memory: T): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const field of PUBLIC_FIELDS) {
    if (field in memory) output[field] = memory[field]
  }
  return output
}

/**
 * 正文安全断言。返回 ok=false 时附带命中列表，
 * 调用方（prepare_public_memory）应当把命中项展示给用户，而不是静默替换。
 */
export function assertSafeContent(text: string): { ok: boolean; hits: PiiHit[] } {
  const hits = scanPii(text, 'strict')
  return { ok: hits.length === 0, hits }
}

/** 公开字段列表，供 store / 脚本复用。 */
export const PUBLIC_MEMORY_FIELDS: readonly string[] = PUBLIC_FIELDS
