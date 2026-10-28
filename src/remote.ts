/**
 * remote.ts —— 公开库聚合索引的远程拉取
 *
 * 约定：
 * - 远程地址默认指向本仓库的 `dist/memories.array.json`（raw）。
 * - 3 秒超时，任何失败（超时 / 404 / 断网 / JSON 坏了）都返回空数组，
 *   只把原因放进 `error` 字段，**绝不抛错**。记忆检索是锦上添花，
 *   不能因为 GitHub 抽风就让整个工具调用失败。
 * - 可用环境变量 `DAFEIYU_MEMORIES_URL` 或插件配置 `remoteUrl` 覆盖。
 */

import type { PublicMemory } from './store.js'

/** 默认远程地址，指向本仓库的聚合索引。 */
export const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.array.json'

/** 默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 3000

/** 远程拉取结果。ok=false 时 items 一定是空数组。 */
export interface RemoteResult {
  items: PublicMemory[]
  ok: boolean
  url: string
  elapsed_ms: number
  error?: string
  /** true = 没配置远程地址，属于预期状态，调用方不必当成错误提示。 */
  skipped?: boolean
}

/** 判断地址是否还是模板占位符（没配置过）。 */
export function isPlaceholderUrl(url: string): boolean {
  return url.includes('<USERNAME>') || url.includes('<REPO>') || url.trim() === ''
}

/**
 * 解析最终使用的远程地址，优先级：
 * 显式传入 > 环境变量 DAFEIYU_MEMORIES_URL > 默认常量。
 */
export function resolveRemoteUrl(explicit?: string): string {
  const fromConfig = (explicit ?? '').trim()
  if (fromConfig) return fromConfig
  const fromEnv = (process.env['DAFEIYU_MEMORIES_URL'] ?? '').trim()
  if (fromEnv) return fromEnv
  return DEFAULT_REMOTE_URL
}

/**
 * 宽松校验远程条目：只要求公开字段里最关键的几个存在且类型对。
 * 远程数据可能来自旧版本仓库，字段多一点少一点不应该让整批数据作废。
 */
export function isPublicMemoryShape(value: unknown): value is PublicMemory {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['title'] === 'string' &&
    typeof record['content'] === 'string' &&
    Array.isArray(record['tags']) &&
    typeof record['fish_name'] === 'string'
  )
}

/** 把任意 JSON 归一化成 PublicMemory[]：数组直接用，对象取 memories 字段。 */
export function normalizePayload(payload: unknown): PublicMemory[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as Record<string, unknown>)['memories'])
      ? ((payload as Record<string, unknown>)['memories'] as unknown[])
      : []

  const result: PublicMemory[] = []
  for (const item of list) {
    if (!isPublicMemoryShape(item)) continue
    result.push({
      id: item.id,
      fish_name: item.fish_name,
      contributor: typeof item.contributor === 'string' ? item.contributor : '匿名',
      title: item.title,
      content: item.content,
      tags: item.tags.filter((tag): tag is string => typeof tag === 'string'),
      memory_type: item.memory_type === 'semi-fiction' ? 'semi-fiction' : 'fiction',
      license: 'CC0-1.0',
      created_at: typeof item.created_at === 'string' ? item.created_at : '1970-01-01',
    })
  }
  return result
}

/**
 * 拉取远程公开记忆。
 * @param url 已解析好的地址（用 resolveRemoteUrl 得到）
 * @param timeoutMs 超时毫秒数，默认 3000
 */
export async function fetchRemoteMemories(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RemoteResult> {
  const startedAt = Date.now()
  const fail = (error: string): RemoteResult => ({
    items: [],
    ok: false,
    url,
    elapsed_ms: Date.now() - startedAt,
    error,
  })

  if (isPlaceholderUrl(url)) {
    return {
      items: [],
      ok: false,
      url,
      elapsed_ms: Date.now() - startedAt,
      error: '远程地址仍是模板占位符，未配置 leiming2333/dsh-dafeiyu-memories',
      skipped: true,
    }
  }

  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof fetchImpl !== 'function') {
    return fail('当前运行时没有 fetch，跳过远程记忆')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs))

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return fail(`HTTP ${response.status}`)
    }
    const payload: unknown = await response.json()
    return {
      items: normalizePayload(payload),
      ok: true,
      url,
      elapsed_ms: Date.now() - startedAt,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return fail(`超时（${timeoutMs}ms）`)
    }
    const message = error instanceof Error ? error.message : String(error)
    // fetch 的 "fetch failed" 太笼统，带上底层 cause 才能区分 DNS / TLS / 连接重置
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message
    return fail(detail ? `${message} (${detail})` : message)
  } finally {
    clearTimeout(timer)
  }
}
