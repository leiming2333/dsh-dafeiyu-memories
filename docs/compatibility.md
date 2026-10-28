# 生态兼容矩阵

本插件与下面 9 个生态插件**没有硬依赖**。`package.json` 里它们只出现在 `peerDependencies`，并且全部标记 `optional: true`；代码里没有任何 `import`。

检测不到就跳过，核心工具（`submit_memory` / `prepare_public_memory` / `get_memories` / `get_memory_stats` / `get_speakable_memories`）照常工作。

---

## 一、总览

| 插件 | 用途 | 检测方式（按优先级） | 集成点 | 检测不到时 | 待确认 |
| --- | --- | --- | --- | --- | --- |
| `dsh-fish-memory` | 长期记忆、半衰期、长期事实 | 插件 id → 服务 `fishMemory` → 工具 `fish_memory_export` | `export_to_fish_memory` / `import_from_fish_memory`；半衰期对齐 | 走文件格式兼容（自己读写 JSON） | 服务字段名、导出工具名 |
| `dsh-feiyu-mood` | 七种情绪、心情涨跌 | 插件 id → 服务 `feiyuMood` | `link_mood_snapshot`；可选事件订阅 | 只能手动关联心情 | 更新事件名 |
| `dsh-yu-mood` | 同上（二选一） | 插件 id → 服务 `yuMood` | 同上 | 同上 | 同上 |
| `dsh-speak-up` | 本地掷骰子主动搭话 | 插件 id → 服务 `speakUp` → 工具 `speak_up_last_turn` | 来源标记 `speak-up` + 轮次去重 | 不启用去重，其它不受影响 | 历史工具名 |
| `dsh-tts-bridge` | 把对话交给网页端朗读 | 插件 id → 服务 `ttsBridge` → 工具 `tts_bridge_speak` | 只读提供 `get_speakable_memories` | 工具仍可用，只是没人来取 | 朗读工具名 |
| `dsh-speak` | 任务完成语音播报 | 插件 id → 服务 `speak` → 工具 `speak_say` | 同上 | 同上 | 播报工具名 |
| `dsh-dafeiyu-pet` / 鲸鱼娘桌宠 | 桌宠挂件、任务状态联动 | 插件 id → 服务 `dafeiyuPet` → 工具 `pet_notify` | 只读 `get_memory_stats`；可选 `memory:stats` 事件 | 统计仍可用，桌宠不受影响 | 事件名 |
| `dsh-qq-bridge` | QQ 消息 ↔ DSH 会话 | 插件 id → 服务 `qqBridge` → 工具 `qq_bridge_send` | 来源标记 `qq` + 强制脱敏 | QQ 记忆不写入（不会以未清洗形式落库） | 发送工具名 |
| `dsh-qqbot` | QQ 官方机器人、表情包 | 插件 id → 服务 `qqbot` → 工具 `qqbot_send` | 来源标记 `qqbot` + 强制脱敏 | 同上 | 发送工具名 |

> 「检测不到时」这一列是**降级行为**，不是报错。所有降级都会在启动日志里留一条 `info`，在 `get_memory_stats` 的 `adapters` 字段里留状态。

---

## 二、检测怎么做的

`src/adapters/index.ts` 里三个探测函数，按顺序尝试，命中即返回：

```ts
hasPlugin(ctx, ['dsh-fish-memory'])          // ctx.registry.has / ctx.plugins.has
getService(ctx, ['fishMemory', 'fish-memory']) // ctx.get(name) / ctx[name]
hasAnyTool(ctx, ['fish_memory_export'])       // ctx.tools.list()
```

三者都不命中 → `detect()` 返回 `false` → 直接跳过，连 `setup()` 都不调用。

这样做的好处：即使某个插件的服务名改了、工具名改了，最多是「检测不到」，不会让本插件加载失败。

---

## 三、事件名：为什么默认关闭

`src/adapters/contracts.ts` 里的 `EVENT_NAMES` 全部带 `TODO: 按目标插件实际文档确认`，对应配置默认 `false`。

原因很实际：**猜错事件名不会报错，只会永远收不到消息**。这种「静默失效」比崩溃更难查，所以宁可默认关闭，让用户按文档显式打开。

### 3.1 确认事件名的流程

1. 在 DSH 里只加载目标插件，跑一段最小监听脚本（放在你自己的临时 profile 里，不要提交）：

   ```ts
   export const name = 'event-probe'
   export function apply(ctx: any) {
     const originalEmit = ctx.emit?.bind(ctx)
     if (!originalEmit) return
     ctx.emit = (event: string, ...args: unknown[]) => {
       ctx.logger?.info?.(`[probe] ${event}`, args)
       return originalEmit(event, ...args)
     }
   }
   ```

2. 触发一次心情变化 / 主动搭话 / 桌宠刷新，记下日志里的事件名。
3. 改 `src/adapters/contracts.ts` 里对应的数组，把确认过的名字放**第一位**。
4. 在 `cordis.patch.yml` 里打开开关：

   ```yaml
   - id: dafeiyu-memories
     name: dsh-dafeiyu-memories
     config:
       enableMoodEvents: true      # 心情事件
       enablePetStatsEvent: true   # 桌宠统计推送
   ```

5. `npm run build`，重启 DSH，看启动日志里适配器的 `notes` 是否显示「已订阅」。

### 3.2 订阅多个候选名的代价

`mood.adapter.ts` 会订阅 `EVENT_NAMES.moodUpdated` 里的**所有**候选名（因为不确定哪个是真的），并在处理器里用「快照 + 3 秒窗口」去重。确认之后请只保留一个，减少无谓的监听。

---

## 四、确认适配器真的在工作

「检测到了」和「真的收到数据」是两件事。检测只说明插件在，不代表事件名对得上。

`get_memory_stats` 返回的 `adapters` 里带 `metrics`，看这个比看日志快：

```json
{
  "id": "mood",
  "detected": true,
  "active": true,
  "metrics": { "received": 3, "applied": 3, "subscribed": 1 }
}
```

| 字段 | 含义 | 一直是 0 说明什么 |
| --- | --- | --- |
| `subscribed` | 实际订阅成功的事件名数量 | 宿主不支持 `ctx.on`，或者所有候选事件名都被拒 |
| `received` | 收到的事件次数 | 事件名不对，或者插件根本没发事件 |
| `applied` | 成功写进记忆的次数 | 负载里没有数值字段，或者本地还没有记忆可关联 |

`received` 涨了但 `applied` 不涨，多半是负载结构不认识 —— 在 `extractMoodSnapshot` 里加一层解析就行，不用动其它地方。

### 事件名不对怎么办

不用改代码，在 `cordis.patch.yml` 里填真实事件名：

```yaml
- id: dafeiyu-memories
  name: 'dsh-dafeiyu-memories'
  config:
    enableMoodEvents: true
    moodEventName: 'feiyu-mood:updated'
```

配置了 `moodEventName` 就只订阅这一个，候选列表不再尝试。改完重启，再调一次 `get_memory_stats`，看 `received` 有没有涨。

## 五、逐个说明

### dsh-fish-memory（鱼的记忆）

- **映射**：`content` → `content`；`created_at + half_life_days` → `freshness`（指数衰减 `2^(-age/halfLife)`）；`long_term` 原样带过；`source` 保留。
- **只同步私有记忆**：导出时只读 `dataDir/memories/L*.json`，公开库不参与。
- **默认不写对方存储**：`export_to_fish_memory` 只写本插件 `exports/` 目录，返回路径和内容。要写入对方存储，需要对方提供工具，且由用户显式发起。
- **降级**：检测不到 → `adapter.detected=false`，导出仍是合法 JSON（对方以后可以手动导入）。
- **TODO**：服务里的半衰期字段名（`halfLifeDays` / `half_life_days` / `decayDays`）、导出工具名。

### dsh-feiyu-mood / dsh-yu-mood（鱼的心情）

- **二选一**：两个都检测到时只启用 `dsh-feiyu-mood`，并 `warn` 一次。请在实际使用中禁用一个，避免心情数据双写。
- **写入位置**：只写本地私有记忆的 `mood_snapshot` 字段。
- **不注入公开 JSON**：`store.buildDraft()` 用 `pickPublicFields()` 做结构化剥离，`mood_snapshot` 不在白名单里，物理上带不出去。
- **降级**：没有事件 → 用 `link_mood_snapshot` 手动关联。
- **TODO**：心情更新事件名。

### dsh-speak-up（主动搭话）

- **来源标记**：`source: "speak-up"`，`visibility: "private"`。
- **去重键**：`sha1(session_id | turn_id | 归一化正文)` 前 16 位，进程内 FIFO 保留最近 500 条。同一轮对话重复触发只写一条。
- **降级**：检测不到 → 去重器不启用（无害）。

### dsh-tts-bridge / dsh-speak（朗读）

- **只读**：本插件不主动调用对方的朗读工具。工具名未确认，贸然调用会在别人机器上刷错误。
- **输出约束**：只返回 8-60 字的短句，且必须通过 strict 隐私扫描；长文、含隐私的条目直接丢弃。
- **降级**：检测不到 → `get_speakable_memories` 仍可被用户或其它插件调用。

### dsh-dafeiyu-pet / 鲸鱼娘桌宠

- **只读统计**：`get_memory_stats` 返回总数、公开数、私有数、今日新增、新鲜度分布、来源分布、适配器状态。
- **可选事件**：`enablePetStatsEvent: true` 时在 `submit_memory` 之后 emit `memory:stats`。
- **不碰 UI**：本适配器没有任何修改桌宠动画或任务状态的代码路径。

### dsh-qq-bridge / dsh-qqbot（QQ）

这是隐私要求最严的一条链路，规则写死在代码里：

1. 来自 QQ 的文本入库前**强制** strict 脱敏（不是可选）。
2. 来源只能是 `qq` / `qqbot`，可见性固定 `private`。
3. `enableQqSource: false` 时直接拒绝写入，不会「降级成不清洗写入」。
4. 想公开必须用户显式调 `prepare_public_memory`，再过滤一遍。

---

## 六、改 contracts.ts 的注意事项

- 只改数组里的**字符串**，不要改结构；适配器代码按「候选列表」遍历。
- 改完把 `CONTRACTS_VERSION` 加一，方便排查「你用的是哪版契约」。
- 新增候选名时，把最确定的名字放第一位 —— 日志和 notes 会优先显示它。
- 不要在这里加任何 `import` 语句。这个文件必须保持「纯数据 + 纯类型」，否则适配器之间会出现循环依赖。

---

## 七、如果某个插件彻底改版

最坏情况：某插件换了包名、服务名、工具名、事件名，三层探测全不命中。

结果：`detect()` 返回 `false`，该适配器整段跳过。核心工具、公开库、本地私有记忆、隐私过滤**全部不受影响**。
