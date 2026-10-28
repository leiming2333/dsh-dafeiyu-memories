/**
 * qq.adapter.ts —— 与 dsh-qq-bridge（QQ 桥接）/ dsh-qqbot（QQ 官方机器人）互通
 *
 * 这是全仓库隐私要求最严的一条链路，规则写死在代码里、不提供关闭开关：
 *
 * 1. 来自 QQ 的文本在入库前**强制** strict 脱敏（QQ 号、群号、昵称、手机号、邮箱、
 *    身份证、住址、学校、单位一律替换成占位符），不是「建议」，是必走路径。
 * 2. 来源标记只能是 `qq` 或 `qqbot`，可见性固定 `private`。
 * 3. 想公开必须用户显式调 `prepare_public_memory`，再走一遍过滤；
 *    没有任何「自动公开」的旁路。
 *
 * `enableQqSource=false` 时，来自 QQ 的写入会被直接拒绝（而不是降级成不清洗写入）。
 */

import { redactPii, scanPii } from '../privacy.js'
import type { PiiHit } from '../privacy.js'
import type { MemorySource } from '../store.js'
import type { AdapterDeps, DshContext } from './contracts.js'
import { PLUGIN_IDS, SERVICE_NAMES, TOOL_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasAnyTool, hasPlugin } from './index.js'

/** QQ 来源的平台标识 → 记忆来源字段。 */
export type QqSource = Extract<MemorySource, 'qq' | 'qqbot'>

/** 从平台标识推断来源。默认 qq（桥接场景更多）。 */
export function resolveQqSource(platform?: string): QqSource {
  const value = (platform ?? '').toLowerCase()
  if (value.includes('qqbot') || value.includes('official') || value.includes('bot')) return 'qqbot'
  return 'qq'
}

/** 判断一个来源是否属于 QQ 链路（决定是否强制脱敏）。 */
export function isQqSource(source: string | undefined): source is QqSource {
  return source === 'qq' || source === 'qqbot'
}

/**
 * QQ 文本清洗。返回脱敏后的文本与命中项，
 * 调用方必须把 `redacted` 的结果写库，不能写原文。
 */
export function sanitizeQqText(text: string): { text: string; hits: PiiHit[]; changed: boolean } {
  const { text: clean, hits } = redactPii(text, 'strict')
  return { text: clean, hits, changed: hits.length > 0 }
}

/** QQ 来源是否允许写入。 */
export function isQqSourceAllowed(config: { enableQqSource: boolean }): boolean {
  return config.enableQqSource
}

/** 拒绝写入时抛的错误，文案要能让用户知道去哪开开关。 */
export function qqSourceDisabledError(): Error {
  return new Error(
    'QQ 来源写入已被禁用（enableQqSource=false）。如确需接入，请在 cordis.patch.yml 里把 enableQqSource 设为 true；' +
      '开启后来自 QQ 的文本仍会强制脱敏，且只写入本地私有记忆。',
  )
}

/** 敏感信息预检：给桥接层一个「发送前自查」的入口。 */
export function preflightQqText(text: string): { safe: boolean; hits: PiiHit[] } {
  const hits = scanPii(text, 'strict')
  return { safe: hits.length === 0, hits }
}

export function createQqAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []

  return {
    id: 'qq',
    notes,

    detect(ctx: DshContext): boolean {
      const bridge =
        hasPlugin(ctx, [PLUGIN_IDS.qqBridge]) ||
        getService(ctx, SERVICE_NAMES.qqBridge) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.qqBridge.send)
      const bot =
        hasPlugin(ctx, [PLUGIN_IDS.qqbot]) ||
        getService(ctx, SERVICE_NAMES.qqbot) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.qqbot.send)
      return bridge || bot
    },

    setup(_ctx: DshContext): void {
      if (!deps.config.enableQqSource) {
        notes.push('enableQqSource=false：QQ 来源写入将被拒绝（不会以未脱敏形式落库）')
        return
      }
      notes.push('QQ 来源强制 strict 脱敏：QQ 号/群号/昵称/手机号/邮箱/身份证/住址/学校/单位一律不写入')
      notes.push('QQ 来源固定 private；公开必须显式调用 prepare_public_memory')
    },
  }
}
