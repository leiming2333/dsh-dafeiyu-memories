# 让智能体找本地记忆

记忆散在好几个地方：插件自己的目录、各个 AI 工具的会话、Markdown 笔记、甚至 SQLite 数据库。想合并之前，得先知道它们在哪。

分两步走：**先盘点，再定点读取**。别一上来就让智能体「全盘搜索」——又慢，又容易翻到不该翻的东西。

> 找完要导出，走 [export-prompt.md](export-prompt.md)；想新写一条，看 [make-memory.md](make-memory.md)。

---

## 常见位置

下面这些是实测过的，路径以 Windows 为例，macOS / Linux 换成 `~` 就行。

| 工具 | 位置 | 形态 |
| --- | --- | --- |
| 本插件（DSH） | `~/.dsh/data/dafeiyu-memories/memories/L*.json` | 单条 JSON |
| DSH 会话 | `~/.dsh/sessions/`、`~/.dsh/storages/` | 会话与项目缓存 |
| WorkBuddy 用户级 | `~/.workbuddy/memory/*.md`、`~/.workbuddy/user-*/MEMORY.md` | Markdown |
| WorkBuddy 工作区级 | `<工作区>/.workbuddy/memory/YYYY-MM-DD.md` | Markdown，按天分文件 |
| Codex | `~/.codex/memories_*.sqlite` | SQLite |
| Codex 会话 | `~/.codex/sessions/` | 会话记录 |
| OpenCode | `~/.config/opencode/` | 视版本而定，可能只有配置 |

`~/.dsh/data/dafeiyu-memories/` 只有装过插件、写过记忆之后才会出现。没装就是空的，不是路径写错了。

---

## 第一步：只盘点，不读内容

```text
帮我盘点本机的 AI 记忆文件。只报告清单，不要读取内容。

扫描这些位置（不存在就跳过，不要全盘搜索）：
- ~/.dsh/data/dafeiyu-memories/memories/
- ~/.dsh/sessions/
- ~/.workbuddy/memory/
- ~/.workbuddy/user-*/MEMORY.md
- 当前工作区/.workbuddy/memory/
- ~/.codex/memories_*.sqlite
- ~/.codex/sessions/
- ~/.config/opencode/

对每个位置报告：路径、文件数、总大小、最后修改时间、文件类型（md / json / sqlite）。
不要打开文件，不要输出任何正文，不要贴文件名以外的内容。
不要扫描 Desktop、Documents、Downloads 和图片目录。
找不到就写「未发现」，不要猜路径。

输出一张表格。
```

为什么要限制「不要打开文件」：记忆文件里全是私人内容，智能体一激动就贴出来了，而这些内容会进对话记录。先看目录结构，够判断了。

拿到表格后再决定读哪个。通常按「最后修改时间」排序，先看最近在用的。

---

## 第二步：定点读取，整理成统一格式

一次只读一个位置，读完立刻整理，不要把整份文件贴进对话。

```text
读取 <上一步表格里的某个路径>，把里面的内容整理成记忆条目。

规则：
1. 只取「发生过的事」：有场景、有动作、有细节。偏好设置、配置、待办清单、技术笔记都不要。
2. 每条 20-300 字。原文太长就压到一个场景，太短就跳过。
3. 删掉真实姓名、学校全名、单位全名、住址、联系方式、具体日期。用「那天」「某个下午」替代。
4. 同一条在多处出现时只保留一份。
5. 整理完不要输出原文，只输出下面这个格式。

输出格式（只输出 JSON 本体，不要解释，也不要用 markdown 代码块包裹）：

{
  "format": "dsh-fish-memory/export@1",
  "memories": [
    { "content": "20-300 字", "title": "可选", "created_at": "YYYY-MM-DD" }
  ]
}
```

拿到 JSON 后走 [`export-prompt.md`](export-prompt.md) 的导入步骤。

**不要一次读所有位置。** 一个位置一个位置来，每轮结束确认一下「这几条要不要」，比一口气导 200 条有用。

---

## 插件自己的库：不用翻文件

如果记忆已经在 `dafeiyu-memories` 里，直接调工具，别去读磁盘：

```json
{ "tool": "get_memory_stats", "arguments": {} }
```

`data_dir` 告诉你库在哪，`total` / `private_count` 告诉你有多少。

检索：

```json
{ "tool": "get_memories", "arguments": { "keyword": "便利店", "include_private": true } }
```

`include_private` 默认是 `false`，不传就只能看到公开种子和远程条目。想看自己写的，必须显式打开。

---

## SQLite 怎么读（Codex 的记忆库）

Codex 把记忆放在 `memories_1.sqlite`，不是文本文件。Node 22 内置了 `node:sqlite`，不用装依赖：

```js
import { createRequire } from 'node:module'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const file = `${os.homedir()}/.codex/memories_1.sqlite`
const db = new DatabaseSync(file, { readOnly: true })   // 只读，别改原库

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log(tables.map((t) => t.name))

db.close()
```

先看有哪些表，再决定查哪张。表结构会随版本变，别把表名写死在提示词里。

`readOnly: true` 不能省。这是别人工具正在用的库，写坏了不只是丢记忆。

---

## 两个提醒

**先看时间，再看内容。** 三个月没动过的记忆目录，多半是废弃的。先读最近在用的那个。

**找不到不等于没有。** 有些工具把记忆存在项目目录里，不在用户目录。表格里那几行只是常见位置，你的环境可能不一样 —— 让智能体在报告里写清「按这些路径没找到」，而不是直接说「没有记忆」。
