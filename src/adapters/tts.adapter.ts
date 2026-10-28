/**
 * tts.adapter.ts —— 与 dsh-tts-bridge（朗读桥）/ dsh-speak（任务完成播报）互通
 *
 * 只做两件事：
 * 1. 把 `get_speakable_memories` 的结果整理成适合朗读的短句；
 * 2. 通过聚合服务 `dafeiyuMemories.speakable()` 暴露只读数据。
 *
 * 刻意**不主动调用**对方的朗读工具：工具名未确认（见 contracts.ts 的 TODO），
 * 贸然调用只会在别人机器上刷错误日志。朗读由对方决定，我们只提供素材。
 */

import type { SpeakableItem } from '../store.js'
import type { AdapterDeps, DshContext } from './contracts.js'
import { PLUGIN_IDS, SERVICE_NAMES, TOOL_NAMES } from './contracts.js'
import type { AdapterWithNotes } from './index.js'
import { getService, hasAnyTool, hasPlugin } from './index.js'

/** 朗读文本拼接：短句之间用句号分隔，不加标题、不加编号（TTS 读编号很怪）。 */
export function assembleSpeakText(items: readonly SpeakableItem[]): string {
  return items
    .map((item) => item.text.trim().replace(/[。！？!?]+$/u, ''))
    .filter((text) => text.length > 0)
    .join('。')
}

/** 判断一个字符串是否适合朗读（8-60 字，无换行）。 */
export function isSpeakableLength(text: string): boolean {
  const length = [...text].length
  return length >= 8 && length <= 60 && !text.includes('\n')
}

export function createTtsAdapter(deps: AdapterDeps): AdapterWithNotes {
  const notes: string[] = []

  return {
    id: 'tts',
    notes,

    detect(ctx: DshContext): boolean {
      const bridge =
        hasPlugin(ctx, [PLUGIN_IDS.ttsBridge]) ||
        getService(ctx, SERVICE_NAMES.ttsBridge) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.ttsBridge.speak)
      const speak =
        hasPlugin(ctx, [PLUGIN_IDS.speak]) ||
        getService(ctx, SERVICE_NAMES.speak) !== undefined ||
        hasAnyTool(ctx, TOOL_NAMES.speak.say)
      return bridge || speak
    },

    setup(_ctx: DshContext): void {
      notes.push('get_speakable_memories 已就绪；只输出公开/私有短句，不输出长文与隐私字段')
      notes.push('本适配器不主动调用朗读工具（工具名待确认），朗读时机由对方决定')

      // 预热一次，确认取数链路是通的；失败只记 warning，不影响启动
      void deps.store
        .speakable(2)
        .then((items) => {
          notes.push(`朗读素材可用 ${items.length} 条`)
        })
        .catch(() => {
          notes.push('朗读素材预热失败，调用时仍会重试')
        })
    },
  }
}
