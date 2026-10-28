# 大肥鱼记忆库（Shoal Atlas）

代号群鱼星图。仓库名和包名统一用 `dsh-dafeiyu-memories`，文档里简称「记忆库」。

一个可安装、可直接复用的鱼记忆库：DSH 插件负责提交与检索，GitHub 公开仓库负责沉淀与分发。

- **DSH 插件**：`dsh plugin add dsh-dafeiyu-memories`，给 agent 一套「记小事」的记忆工具。
- **公开记忆库**：`memories/*.json` 是 CC0-1.0 的公开源数据，`dist/` 自动聚合，任何人可以直接 raw 拉取。

它记的不是待办和会议纪要，是那些没什么用、但扔了可惜的小事。

```
一条鱼第一次看见弹幕，以为那些字是会游泳的。
```



---

## 目录

- [作为 DSH 插件](#作为-dsh-插件)
  - [安装](#安装)
  - [8 个工具](#8-个工具)
  - [调用示例](#调用示例)
  - [换设备与合并多个助手](#换设备与合并多个助手)
  - [让智能体帮你写一条](#让智能体帮你写一条)
  - [数据写入位置](#数据写入位置)
  - [隐私红线](#隐私红线)
- [作为公开记忆库](#作为公开记忆库)
  - [收录什么](#收录什么)
  - [数据格式](#数据格式)
  - [raw 地址](#raw-地址)
  - [投稿方式](#投稿方式)
  - [CC0 与撤回](#cc0-与撤回)
- [生态兼容](#生态兼容)
- [开发](#开发)
- [目录结构](#目录结构)
- [仓库设置](#仓库设置)
- [版本](#版本)

---

## 作为 DSH 插件

### 安装

```bash
dsh plugin add dsh-dafeiyu-memories
```

装完重启 DSH。启动日志里应该能看到：

```
[dafeiyu-memories] 就绪：工具 8 个，适配器 无（核心功能不受影响），数据目录 ~/.dsh/data/dafeiyu-memories
```

「适配器 无」是正常的，表示你没装那些生态插件，核心功能一样跑。

需要自定义时，在 `cordis.patch.yml` 里加 config（全部可选）：

```yaml
- id: dafeiyu-memories
  name: dsh-dafeiyu-memories
  config:
    remoteUrl: 'https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.array.json'
    remoteTimeoutMs: 3000
    defaultHalfLifeDays: 30
    enableAdapters: true
    enableMoodEvents: false      # 事件名未确认，默认关闭
    enablePetStatsEvent: false   # 同上
    enableQqSource: true
```

### 8 个工具

| 工具                        | 作用                                         | 写文件？                    |
| ------------------------- | ------------------------------------------ | ----------------------- |
| `submit_memory`           | 写一条**本地私有**记忆，分配 `L0001` 形式的 id，跑长度校验和隐私扫描 | 写本地数据目录                 |
| `prepare_public_memory`   | 把本地记忆整理成可提 PR 的公开 JSON，强制过滤 + 匿名化 + 剥离私有字段 | **不写**，只返回路径和 JSON      |
| `get_memories`            | 合并检索：内置公开种子 + 本地私有（需显式开启）+ 远程聚合            | 只读                      |
| `get_memory_stats`        | 总数、公开数、私有数、今日新增、新鲜度分布、来源分布、适配器状态           | 只读                      |
| `get_speakable_memories`  | 返回 1-2 条 8-60 字短句，供朗读插件使用                  | 只读                      |
| `export_to_fish_memory`   | 导出 dsh-fish-memory 兼容结构                    | 写 `exports/`，**不写对方存储** |
| `import_from_fish_memory` | 导入对方导出数据，按正文指纹去重，全部落为 private              | 写本地数据目录                 |
| `link_mood_snapshot`      | 给本地记忆附加心情快照                                | 写本地数据目录                 |

### 调用示例

**写一条记忆**

```json
{
  "tool": "submit_memory",
  "arguments": {
    "title": "第一次追弹幕",
    "content": "它第一次看见弹幕是在一个很晚的直播里。那些字从屏幕右边游过来，密密麻麻，比鱼缸里的水草还密。",
    "tags": ["B站", "弹幕", "虚构"],
    "memory_type": "fiction"
  }
}
```

返回：

```json
{
  "id": "L0001",
  "saved_path": "C:\\Users\\leiming2333\\.dsh\\data\\dafeiyu-memories\\memories\\L0001.json",
  "visibility": "private",
  "public_draft": { "id": "0002", "contributor": "匿名", "...": "只含可公开字段" },
  "privacy": { "hits": [], "summary": "未发现敏感信息", "redacted": false }
}
```

`public_draft` 只是草稿，**不会自动提交**。

**准备公开贡献**

```json
{ "tool": "prepare_public_memory", "arguments": { "local_id": "L0001" } }
```

返回 `{ path: "memories/0002.json", json: "...", warnings: [...], notice: "..." }`。

把 `json` 保存成 `path` 指的文件，提 PR 即可。注意：**保存这一步要你自己做**，工具不写包内目录。

**检索**

```json
{ "tool": "get_memories", "arguments": { "tag": "弹幕", "include_private": true, "limit": 20 } }
```

**统计（桌宠 / 心情 / TTS 用这个）**

```json
{
  "total": 12,
  "public_count": 1,
  "private_count": 11,
  "today_added": 3,
  "freshness": { "fresh": 4, "warm": 3, "cooling": 2, "dormant": 3, "average": 0.61 },
  "sources": { "public": 1, "manual": 7, "qq": 3, "speak-up": 1 },
  "data_dir": "~/.dsh/data/dafeiyu-memories"
}
```

**朗读素材**

```json
{ "tool": "get_speakable_memories", "arguments": { "limit": 2 } }
```

返回的 `text` 已经是拼好的短句，直接丢给 TTS 就行。

### 换设备与合并多个助手

`export_to_fish_memory` 把本地私有记忆导成一个 JSON 文件，换机器时带走它就行。

不知道记忆散在哪，先按 [`docs/find-memory.md`](docs/find-memory.md) 盘点一遍 —— 只列路径和大小，不读内容。各工具的实际位置、SQLite 怎么读都在那篇里。

要把别的助手（另一个大肥鱼、另一个 DSH 实例，甚至不是 DSH 的工具）的记忆收进来，用 [`docs/export-prompt.md`](docs/export-prompt.md) 里的提示词让对方按标准格式导出，再：

```json
{ "tool": "import_from_fish_memory", "arguments": { "path": "dafeiyu-export.json" } }
```

文件放在数据目录的 `exports/` 下（具体路径看 `get_memory_stats` 的 `data_dir`）。导入按正文指纹去重，重复的、太短的会跳过，不会中断。

那份文档里还有一段「导成公开投稿」的提示词，隐私要求比迁移严得多，别和迁移用的混着用。

### 让智能体帮你写一条

记忆不一定都是「已经发生过、等着被导出」的。也可以让智能体采访你、把日记改写成场景，或者直接虚构一条。

四种方法和对应提示词在 [`docs/make-memory.md`](docs/make-memory.md)。产出一律先当草稿，走 `submit_memory` 之前自己读一遍。

一条底线：智能体不许替你补细节。它补出来的是想象，不是你的记忆。

三篇提示词文档的分工：

| 想做的事 | 看哪篇 |
| --- | --- |
| 不知道记忆散在哪 | [`docs/find-memory.md`](docs/find-memory.md)：盘点提示词、各工具实际位置、SQLite 读法 |
| 把别处的记忆导进来 | [`docs/export-prompt.md`](docs/export-prompt.md)：迁移版和投稿版提示词、导入步骤 |
| 让 AI 帮你写一条 | [`docs/make-memory.md`](docs/make-memory.md)：采访式、素材改写、日常摘录、纯虚构 |

### 数据写入位置

| 内容     | 位置                                              | 谁能写                                                                |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| 公开种子   | `<包目录>/memories/*.json`                         | **只能靠 PR**，插件运行时禁止写入（有运行时断言）                                       |
| 本地私有记忆 | `~/.dsh/data/dafeiyu-memories/memories/L*.json` | `submit_memory` / `import_from_fish_memory` / `link_mood_snapshot` |
| 导出文件   | `~/.dsh/data/dafeiyu-memories/exports/*.json`   | `export_to_fish_memory`                                            |
| 公开聚合   | `<包目录>/dist/*.json`                             | 只有 `scripts/build_index.py`，**禁止手改**                               |
| 构建产物   | `<包目录>/lib/*.js`                                | `npm run build`                                                    |

两个细节：

- 数据目录按这个顺序取：config 的 `dataDir` → `DAFEIYU_MEMORIES_DIR` 环境变量 → 宿主如果通过 `ctx.get('dataDir')` 暴露了目录就用它 → `~/.dsh/data/dafeiyu-memories`。
- `dist/` 专门留给公开聚合，所以 TypeScript 的构建输出放在 `lib/`。这两个目录不能混。

### 隐私红线

这几条是代码层面的约束，不是文档约定：

1. **运行时记忆永远不进包目录。** `MemoryStore.assertNotPackageMemories()` 在每次写入前检查路径，落在 `memories/` 里直接抛错。
2. **公开草稿必然过 strict 过滤。** `toPublicDraft()` 没有「跳过过滤」的参数，也不提供开关。
3. **私有字段结构化剥离。** 只保留 9 个公开字段的白名单，`source` / `mood_snapshot` / `platform` / `created_by` 带不出去。
4. **QQ 来源强制脱敏。** `source` 为 `qq` / `qqbot` 时，入库前必走 `redactPii(strict)`，不做「可选的脱敏」。`enableQqSource=false` 时直接拒绝写入，而不是降级成不清洗。
5. **不自动公开。** 没有任何代码路径会把本地记忆写进公开库或 `dist/`。

隐私过滤覆盖：手机号、邮箱、身份证、QQ 号、微信号、群号、链接、@提及、住址（省市区 / 路街号 / 小区 / 楼栋单元室）、学校、单位。

> 脚本偏严，可能把「他说这家公司」误伤成「他说[单位]」。公开草稿里遇到误伤，手工改回来即可。脚本的取舍是宁可多挡：漏掉的信息收不回来，误伤的可以手改。

---

## 作为公开记忆库

### 收录什么

- 原创的、**虚构或半虚构**的短记忆，20-300 字。
- 已匿名化：没有真实姓名、学校、单位、住址、联系方式。
- 有画面感的小事：第一次、最后一次、某个凌晨、某句没说出口的话。

不收：

- 真实新闻、他人隐私、聊天记录原文。
- 引流文案、广告、募捐、政治口号。
- 任何可识别未成年人的内容。
- 歌词、书摘、整段引用。

### 数据格式

`memories/0001.json`：

```json
{
  "id": "0001",
  "fish_name": "大肥鱼",
  "contributor": "匿名",
  "title": "第一次追弹幕",
  "content": "它第一次看见弹幕是在一个很晚的直播里。那些字从屏幕右边游过来，密密麻麻，比鱼缸里的水草还密。",
  "tags": ["B站", "弹幕", "虚构"],
  "memory_type": "fiction",
  "license": "CC0-1.0",
  "created_at": "2026-10-27"
}
```

约束（`schema/memory.schema.json`，2020-12，`additionalProperties: false`）：

| 字段            | 约束                         |
| ------------- | -------------------------- |
| `id`          | 四位数字字符串，全库唯一               |
| `fish_name`   | 1-20 字                     |
| `contributor` | 1-40 字，默认「匿名」              |
| `title`       | 2-40 字                     |
| `content`     | 20-300 字                   |
| `tags`        | 1-8 个，每个 ≤16 字，不重复         |
| `memory_type` | `fiction` 或 `semi-fiction` |
| `license`     | 固定 `CC0-1.0`               |
| `created_at`  | `YYYY-MM-DD`               |

### raw 地址

聚合索引（推荐，一次拿全量）：

```
https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.array.json
```

带元信息的版本：

```
https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.json
```

单条记忆：

```
https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/memories/0001.json
```

直接用：

```bash
curl -s https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.array.json | jq '.[0]'
```

```js
const res = await fetch('https://raw.githubusercontent.com/leiming2333/dsh-dafeiyu-memories/main/dist/memories.array.json')
const memories = await res.json()
console.log(memories.length)
```

> `dist/` 由 `build-index` Action 在 `memories/` 变化后自动重建。**不要手改 dist/**，改了也会被覆盖。

### 投稿方式

**PR（推荐）**

```bash
git clone https://github.com/leiming2333/dsh-dafeiyu-memories.git
cd dsh-dafeiyu-memories
cp memories/template.json memories/0002.json
# 编辑 0002.json：改 id、标题、正文、标签
python scripts/check_memory.py
git checkout -b memory/0002
git add memories/0002.json
git commit -m "feat(memories): 新增 0002 <标题>"
git push origin memory/0002
```

然后开 PR，勾选模板里的三个框。

**Issue**

不想碰 git 就开 Issue：`https://github.com/leiming2333/dsh-dafeiyu-memories/issues/new?template=memory.yml`

按表单填，维护者转成 JSON，署名「匿名」。

审核标准见 [docs/review-checklist.md](docs/review-checklist.md)。

### CC0 与撤回

**提交即同意 CC0-1.0**，具体包括：

- 任何人可以复制、修改、商用、不署名地使用这条记忆；
- 你放弃这条文字的著作权（在法律允许的范围内）；
- **不可撤回。**

如果之后想删除：

1. 开 PR 删除对应文件，或开 Issue 说明；
2. 维护者合并后，`dist/` 会在下一次聚合时移除；
3. 但**已经被 fork、下载、镜像、索引的副本无法收回**。这是 CC0 和公开 Git 仓库的固有性质，不是维护者不帮忙。

想保留撤回权，就不要投公开库 —— 用插件写在本地私有记忆里就好，那部分永远不会自动公开。

---

## 生态兼容

全部**可选**：`peerDependencies` 里标记 `optional: true`，代码里零 `import`。检测不到就跳过。

| 插件                               | 集成的部分                                      | 降级行为                      |
| -------------------------------- | ------------------------------------------ | ------------------------- |
| `dsh-fish-memory`                | 导出/导入兼容结构、半衰期对齐                            | 走文件格式兼容                   |
| `dsh-feiyu-mood` / `dsh-yu-mood` | 心情快照附加到私有记忆                                | 只能手动 `link_mood_snapshot` |
| `dsh-speak-up`                   | 来源标记 + 轮次去重                                | 去重不启用                     |
| `dsh-tts-bridge` / `dsh-speak`   | 只读提供 `get_speakable_memories`              | 工具仍可被调用                   |
| `dsh-dafeiyu-pet` / 鲸鱼娘桌宠        | 只读 `get_memory_stats`，可选 `memory:stats` 事件 | 桌宠不受影响                    |
| `dsh-qq-bridge` / `dsh-qqbot`    | 来源标记 + 强制脱敏                                | QQ 记忆不写入（不会以未清洗形式落库）      |

两个心情插件同时存在时，只启用 `dsh-feiyu-mood` 并 warn 一次。

事件名、服务名、工具名全部集中在 [`src/adapters/contracts.ts`](src/adapters/contracts.ts)，带 `TODO: 按目标插件实际文档确认` 标注，默认关闭。完整矩阵、开启方法、事件名确认流程见 [docs/compatibility.md](docs/compatibility.md)。

---

## 开发

```bash
npm install          # @deepseek-ai/dsh-tools + 开发依赖（typescript、@types/node）
npm run build        # tsc → lib/
npm test             # 147 项自检：隐私、隔离、工具、适配器、远程、真实 cordis
npm run check        # 校验公开记忆（需要 Python 3.9+）
npm run aggregate    # 聚合 dist/（内部会先跑一遍 check）
npm run verify       # build + check + aggregate
npm run probe:remote -- <url>   # 在真实网络下探测远程记忆地址
```

可选：`pip install jsonschema`（没装也能跑，会退回内置校验）。

`README` 里的命令都以项目根目录为工作目录。

---

## 目录结构

```
dsh-dafeiyu-memories/
├─ src/
│  ├─ index.ts              # 插件入口：name / inject / apply
│  ├─ tools.ts              # 8 个工具的定义与注册
│  ├─ store.ts              # 读写、id 分配、统计、新鲜度、写入保护
│  ├─ remote.ts             # 远程拉取（3 秒超时，失败返回 []）
│  ├─ privacy.ts            # 隐私正则与脱敏
│  └─ adapters/
│     ├─ index.ts           # 适配器编排 + 检测辅助 + 聚合服务
│     ├─ contracts.ts       # 外部服务名/工具名/事件名（唯一真相源）
│     ├─ fish-memory.adapter.ts
│     ├─ mood.adapter.ts
│     ├─ speak-up.adapter.ts
│     ├─ tts.adapter.ts
│     ├─ pet.adapter.ts
│     └─ qq.adapter.ts
├─ memories/                # 公开种子（只读）
│  ├─ template.json
│  └─ 0001.json
├─ dist/                    # 公开聚合（脚本生成，禁止手改）
├─ lib/                     # 构建产物（npm run build）
├─ schema/memory.schema.json
├─ scripts/
│  ├─ check_memory.py
│  └─ build_index.py
├─ docs/
│  ├─ compatibility.md
│  ├─ review-checklist.md
│  ├─ export-prompt.md
│  ├─ find-memory.md
│  ├─ make-memory.md
│  └─ bilibili-post.md
└─ .github/
   ├─ ISSUE_TEMPLATE/memory.yml
   ├─ PULL_REQUEST_TEMPLATE.md
   └─ workflows/{validate,build}.yml
```

---

## 仓库设置

GitHub Topics：

```
dsh
dsh-plugin
dafeiyu
memory-library
cc0
shoal-atlas
```

仓库名和包名保持 `dsh-dafeiyu-memories`。不要把 `bilibili` 放进名字，平台来源在描述或文档里提一句就够了。

## 版本

v0.1「初潮」：插件骨架 + CC0 记忆库 + 自动聚合。

---

## 许可

- **代码**：[MIT](LICENSE)
- **公开记忆内容**：[CC0-1.0](LICENSE-CONTENT)（放弃著作权，可自由使用）

隐私说明见 [PRIVACY.md](PRIVACY.md)，投稿规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
