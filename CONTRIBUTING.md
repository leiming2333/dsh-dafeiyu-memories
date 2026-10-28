# 贡献指南

两种贡献：**投稿一条记忆**，或者**改代码**。两条路的规则不一样，别混。

---

## 一、投稿一条公开记忆

### 基本要求

| 项 | 要求 |
| --- | --- |
| 长度 | 正文 20-300 字 |
| 类型 | `fiction`（完全虚构）或 `semi-fiction`（半虚构，细节已改写） |
| 原创 | 自己写的；不是歌词、书摘、聊天记录原文 |
| 匿名 | 不含真实姓名、学校、单位、住址、联系方式 |
| 许可 | CC0-1.0，提交即放弃著作权，不可撤回 |

完整审核标准：[docs/review-checklist.md](docs/review-checklist.md)。

### 走 PR

```bash
git clone https://github.com/leiming2333/dsh-dafeiyu-memories.git
cd dsh-dafeiyu-memories

# 1. 找一个没被占用的编号
ls memories/

# 2. 复制模板
cp memories/template.json memories/0002.json

# 3. 编辑：id 改成 0002，写标题、正文、标签、日期
#    正文 20-300 字，contributor 保持「匿名」或写你愿意公开的昵称

# 4. 本地自查（需要 Python 3.9+）
python scripts/check_memory.py

# 5. 提 PR
git checkout -b memory/0002
git add memories/0002.json
git commit -m "feat(memories): 新增 0002 <标题>"
git push origin memory/0002
```

PR 描述里把模板的三个勾选框都勾上，否则不会被合并。

### 走 Issue

不想碰 git：开 [投稿 Issue](https://github.com/leiming2333/dsh-dafeiyu-memories/issues/new?template=memory.yml)，按表单填。维护者会转成 JSON，署名「匿名」，并在 PR 里 @ 你确认。

### 编号冲突

两个人同时提 `0002` 很常见。处理方式：

- 如果 CI 报「id 重复」，把你的编号往后挪一位（改成当前最大编号 +1），重新跑脚本。
- 不要改别人的文件。
- 维护者合并时也可能帮你重排编号，这种情况下 PR 里会说明。

### 会被拒的稿子

- 写得太具体，能定位到真人（哪怕没写名字）。
- 消费他人创伤：疾病、事故、家庭变故、校园事件的具体细节。
- 涉及可识别的未成年人。
- 引流：联系方式变体、「主页有」「私信我」。
- 纯口号、段子、鸡汤，没有具体场景。
- 机翻感明显、AI 味重的整段文字（可以让 AI 帮你改，但请自己读一遍再投）。

被拒不代表写得不好，很多时候只是「太具体了，改一改就能收」。

---

## 二、改代码

### 环境

```bash
npm install
npm run build      # tsc → lib/
npm run check      # 校验 memories/
npm run aggregate  # 重建 dist/
npm run verify     # 三个一起跑
```

需要 Node 20+、Python 3.9+（只有跑脚本时需要）。可选 `pip install jsonschema`。

### 硬约束（PR 会被直接打回的几条）

1. **不允许把生态插件写进 `dependencies`。** 最多 `peerDependencies` + `optional: true`，或者运行时检测。
2. **不允许在 `src/` 里 `import` 任何 `dsh-*` 生态插件。** 所有外部交互走 `src/adapters/contracts.ts` 里的名字 + 运行时探测。
3. **不允许新增写包内 `memories/` 的代码路径。** 所有写操作必须过 `MemoryStore.assertNotPackageMemories()`。
4. **不允许给隐私过滤加「跳过」开关。** `preparePublic()` 必须无条件走 strict 过滤。
5. **不允许手改 `dist/`。** 它由 `scripts/build_index.py` 生成。
6. **不允许在 `contracts.ts` 里写没有 `TODO` 标注的推测性事件名。** 没确认就标 TODO，并保持默认关闭。

### 代码风格

- TypeScript strict，`noUncheckedIndexedAccess` 开着；不要用 `any`（`unknown` + 类型守卫）。
- 注释写「为什么」，不写「这行在做什么」。
- 中文文案用简体，标点用中文标点；代码标识符用英文。
- 新增工具时：参数用 JSON Schema 描述，返回体保证 JSON 可序列化，字段名 snake_case。

### 加一个适配器

1. 在 `src/adapters/contracts.ts` 里加插件 id、服务名候选、工具名候选、事件名候选（带 TODO）。
2. 新建 `src/adapters/<name>.adapter.ts`，导出 `createXxxAdapter(deps: AdapterDeps): AdapterWithNotes`。
3. `detect()` 里按「插件 id → 服务 → 工具」的顺序探测，命中任意一个返回 `true`。
4. `setup()` 里只做三件事：记 notes、注册只读能力、（可选）订阅事件。**任何异常都不要往外抛**。
5. 在 `src/adapters/index.ts` 的 `createAdapters()` 里注册。
6. 在 `docs/compatibility.md` 的矩阵里补一行。
7. 跑 `npm run build`，确认零错误。

### 提交信息

```
feat(tools): 新增 xxx 工具
fix(privacy): 修正身份证正则误伤生日
docs(compat): 补 dsh-xxx 的检测方式
chore(dist): 聚合公开记忆
```

---

## 三、行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。简单说：对事不对人，不人身攻击，不未经同意把别人的故事写进来。

---

## 四、许可

- 代码贡献按 [MIT](LICENSE) 授权。
- 记忆内容贡献按 [CC0-1.0](LICENSE-CONTENT) 授权。

提交 PR 即表示你同意这两个许可。
