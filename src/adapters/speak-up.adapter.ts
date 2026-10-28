/**
 * speak-up.adapter.ts —— 与 dsh-speak-up（主动搭话）互通
 *
 * 主动搭话是「本地掷骰子」触发的，同一轮对话可能被重复捕捉，
 * 所以这里提供一个内容指纹去重器：同一轮只允许写入一条记忆。
 *
 * 来源统一标记为 `speak-up`，可见性固定 private。
 */

import { createHash } from 'node:crypto'

import type { AdapterDeps, DshContext } from './contracts.js'
import { PLUGIN_IDS, SERVICE_NAMES, TOOL_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasAnyTool, hasPlugin } from './index.js'

/** 一轮主动对话的去重键输入。 */
export interface SpeakUpTurn {
  session_id?: string
  turn_id?: string
  content: string
}

/** 去重器接口。进程内有效，插件卸载即丢弃（记忆本身已落盘，不需要持久化）。 */
export interface SpeakUpDeduplicator {
  key(turn: SpeakUpTurn): string
  /** true = 第一次见到，可以写入；false = 重复，跳过。 */
  firstSeen(turn: SpeakUpTurn): boolean
  size(): number
  clear(): void
}

/** 生成去重器。键 = session + turn + 归一化正文 的 sha1 前 16 位。 */
export function createSpeakUpDeduplicator(limit = 500): SpeakUpDeduplicator {
  const seen = new Set<string>()

  const computeKey = (turn: SpeakUpTurn): string => {
    const normalized = turn.content.replace(/\s+/gu, '').slice(0, 400)
    const raw = `${turn.session_id ?? ''}|${turn.turn_id ?? ''}|${normalized}`
    return createHash('sha1').update(raw).digest('hex').slice(0, 16)
  }

  return {
    key: computeKey,
    firstSeen(turn: SpeakUpTurn): boolean {
      const value = computeKey(turn)
      if (seen.has(value)) return false
      seen.add(value)
      if (seen.size > limit) {
        // 简单的 FIFO 淘汰，避免长时间运行内存无限增长
        const oldest = seen.values().next().value
        if (typeof oldest === 'string') seen.delete(oldest)
      }
      return true
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  }
}

export function createSpeakUpAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []
  const dedupe = createSpeakUpDeduplicator()

  return {
    id: 'speak-up',
    notes,

    detect(ctx: DshContext): boolean {
      const detected =
        hasPlugin(ctx, [PLUGIN_IDS.speakUp]) ||
        getService(ctx, SERVICE_NAMES.speakUp) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.speakUp.lastTurn)
      if (detected) notes.push('主动搭话来源将标记 source=speak-up，默认 private')
      return detected
    },

    setup(ctx: DshContext): void {
      notes.push('已启用按轮次去重（session+turn+正文指纹），同一轮不会重复入库')

      // 去重器是内存态，卸载时清掉；ctx.effect 不存在就交给 GC
      try {
        ctx.effect?.(() => dedupe.clear())
      } catch {
        // 忽略
      }

      if (deps.config.enableQqSource === false) {
        notes.push('注意：enableQqSource=false 只影响 QQ 来源，不影响 speak-up')
      }
    },
  }
}
