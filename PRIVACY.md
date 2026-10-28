# 隐私说明

这份文档说清楚三件事：**什么会被收集、什么不会被收集、以及你有哪些控制权**。

最后更新：2026-10-27

---

## 一、一句话版本

插件运行时产生的记忆**只存在你自己的电脑上**，不会上传到任何服务器；公开库只收你**手动**提交的、经过过滤的虚构短记忆。

---

## 二、本地私有记忆

### 存了什么

`submit_memory` 写入的每条记忆包含：

| 字段 | 说明 |
| --- | --- |
| 公开字段 9 个 | id、fish_name、contributor、title、content、tags、memory_type、license、created_at |
| `visibility` | 固定 `private` |
| `source` | 来源：`manual` / `speak-up` / `qq` / `qqbot` / `fish-memory` / `pet` / `tts` / `system` |
| `platform` | 平台标识（可选），如 `bilibili`、`qq` |
| `created_by` | 创建者标识（可选），含敏感信息时自动匿名化 |
| `freshness` / `half_life_days` | 新鲜度与半衰期 |
| `mood_snapshot` | 心情快照（可选），键为情绪名、值为数值 |
| `long_term` | 是否长期事实（可选） |

### 存在哪

优先级从高到低：

1. `cordis.patch.yml` 里的 `config.dataDir`
2. 环境变量 `DAFEIYU_MEMORIES_DIR`
3. 宿主通过 `ctx.get('dataDir')` 暴露的目录（如果有）
4. `~/.dsh/data/dafeiyu-memories/`

具体路径会在每次 `submit_memory` 的返回值 `saved_path` 里给出，也在 `get_memory_stats` 的 `data_dir` 里。

### 不会发生的事

- 不会写进插件包的 `memories/` 目录（有运行时断言，写就抛错）。
- 不会自动进入 `dist/`。
- 不会上传到任何服务器。本插件没有任何上报、埋点、遥测代码。
- 不会发给其它插件。适配器只**读**本地记忆来生成统计/朗读素材，不把内容推给别人。

---

## 三、公开记忆库

### 收什么

只收 `memories/*.json` 里那 9 个公开字段。

### 怎么进去的

只有一条路：**你手动提 PR**（或提 Issue 由维护者代转）。

流程是：

```
本地记忆（含私有字段）
   ↓  prepare_public_memory（强制 strict 过滤 + 匿名化 + 结构化剥离）
公开草稿（只有 9 个字段）
   ↓  你自己保存成 memories/0002.json
   ↓  你自己提 PR
   ↓  CI 校验 + 人工复核
公开库
```

中间没有任何「自动」环节。

### 过滤掉什么

文本层（正则）：

- 手机号、邮箱、身份证号
- QQ 号、微信号、群号
- 链接、@提及
- 住址：省市区 / 路街门牌 / 小区 / 楼栋单元室
- 学校全名、单位全名

结构化层（直接丢字段）：

- `source`、`visibility`、`platform`、`created_by`
- `mood_snapshot`、`freshness`、`half_life_days`、`long_term`

`contributor` 强制匿名化为「匿名」，除非你在 PR 里手动改成一个愿意公开的昵称。

### 过滤不掉什么

正则只能挡「格式明显」的信息。挡不住：

- 「我们组只有两个前端，另一个刚休产假」—— 这是隐喻式身份信息。
- 「去年 3 月 12 日，XX 路口」—— 时间 + 地点组合。
- 你自己写嗨了，把朋友的事原样搬上来。

这些靠人眼复核（[docs/review-checklist.md](docs/review-checklist.md)）和投稿人自查。所以**请在提交前自己读一遍**：如果当事人看到会立刻认出自己，就改。

---

## 四、QQ / 社交平台来源

从 `dsh-qq-bridge` / `dsh-qqbot` 进来的内容，是全链路最严的一档：

1. 入库前**强制**走 strict 脱敏，不是可选。
2. 来源固定标记 `qq` / `qqbot`，可见性固定 `private`。
3. `enableQqSource: false` 时直接拒绝写入 —— 不会「降级成不清洗写入」。
4. 想公开必须你显式调 `prepare_public_memory`，再过滤一遍。

即便如此，**仍然建议不要把 QQ 聊天内容往记忆库里灌**。脱敏能去掉格式化的信息，去不掉语境。

---

## 五、远程请求

`get_memories` 默认会拉一次远程聚合索引（GitHub raw 上的 `dist/memories.array.json`）：

- 只发一个 GET，不带任何本地数据、不带 cookie、不带身份标识。
- 3 秒超时，失败静默降级为空数组。
- 地址可配置（`remoteUrl` / `DAFEIYU_MEMORIES_URL`）；不想联网就设 `include_remote: false`，或把地址指向你自己的镜像。

除了这一次 GET，本插件不发起任何网络请求。

---

## 六、你的控制权

| 想做的事 | 怎么做 |
| --- | --- |
| 看本地存了什么 | 打开 `get_memory_stats` 返回的 `data_dir`，`memories/` 下就是全部 |
| 删一条本地记忆 | 直接删 `L0001.json`（插件不做软删除，删了就没了） |
| 全部删掉 | 删整个 `~/.dsh/data/dafeiyu-memories/` 目录 |
| 不联网 | `get_memories` 传 `include_remote: false`，或把 `remoteUrl` 设成空/本地地址 |
| 关掉某个适配器 | `enableAdapters: false` 全关，或单独关 `enableMoodEvents` / `enablePetStatsEvent` |
| 不接收 QQ 来源 | `enableQqSource: false` |
| 撤回已公开的记忆 | 开 PR 删文件。**已 fork / 下载 / 索引的副本无法收回** |

---

## 七、未成年人

- 公开库不收任何可识别未成年人的内容。
- 如果记忆涉及未成年人，必须完全虚构化，且不能通过组合信息定位到具体的人。
- 如果你自己是未成年人，投稿前请确认监护人知情并同意 CC0 授权。

---

## 八、变更

这份文档变更会走 PR，并在提交信息里用 `docs(privacy):` 前缀，方便追溯。

如果哪天本插件引入了任何形式的网络上报（目前没有，也不打算有），会在 README 顶部用醒目位置说明，并给出关闭方法。

---

## 九、联系

- 隐私相关问题：开 Issue，标题加 `[privacy]`。
- 涉及具体记忆的删除请求：开 Issue，附上文件路径，不要贴原文。
