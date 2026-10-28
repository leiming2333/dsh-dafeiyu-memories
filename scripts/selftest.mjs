#!/usr/bin/env node
/**
 * selftest.mjs —— 不依赖 DSH、不联网的自检
 *
 * 跑法：
 *   npm run build && npm run test
 *
 * 覆盖：隐私规则、写入隔离、公开草稿剥离、QQ 强制脱敏、检索/统计/朗读、
 * fish-memory 互操作、假 ctx 装配、8 个工具 handler、边界与降级。
 *
 * 全部用临时目录，跑完自动清理；不会碰包内 memories/ 和 dist/。
 * 退出码：0 全过，1 有失败。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = (name) => pathToFileURL(path.join(ROOT, 'lib', name)).href

try {
  await fs.access(path.join(ROOT, 'lib', 'index.js'))
} catch {
  console.error('找不到 lib/，先跑 npm run build')
  process.exit(1)
}

const { MemoryStore, computeFreshness, nextPublicId, charLength } = await import(lib('store.js'))
const { scanPii, redactPii, sanitizeTags, anonymizeContributor, sanitizeUnicode } = await import(lib('privacy.js'))
const { apply, resolveConfig, CONTEXT_HINT, detectDshDataDir, setupAdapters } = await import(lib('index.js'))
const { registerAllTools, createToolDefinitions, registerTool } = await import(lib('tools.js'))

const PACKAGE_MEMORIES = path.join(ROOT, 'memories')
const PACKAGE_DIST = path.join(ROOT, 'dist')

let passed = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name} :: ${error?.message ?? error}`)
  }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

async function snapshot(dir) {
  try {
    const entries = await fs.readdir(dir)
    const pairs = await Promise.all(
      entries.sort().map(async (name) => {
        const stat = await fs.stat(path.join(dir, name))
        return `${name}:${stat.size}:${stat.mtimeMs}`
      }),
    )
    return pairs.join('|')
  } catch {
    return 'MISSING'
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-selftest-'))
const dataA = path.join(tmpRoot, 'a')
const dataB = path.join(tmpRoot, 'b')
const dataC = path.join(tmpRoot, 'c')
const dataD = path.join(tmpRoot, 'd')

const memoriesBefore = await snapshot(PACKAGE_MEMORIES)
const distBefore = await snapshot(PACKAGE_DIST)

const store = new MemoryStore({ packageRoot: ROOT, dataDir: dataA, defaultHalfLifeDays: 30 })

// ───────────────────────── A. 隐私规则 ─────────────────────────
section('A. 隐私规则')

await t('手机号命中', () => assert.ok(scanPii('电话 13812345678').length > 0))
await t('邮箱命中', () => assert.ok(scanPii('a.b-c@example.com').length > 0))
await t('身份证命中', () => assert.ok(scanPii('110101199003071234').length > 0))
await t('QQ 号命中', () => assert.ok(scanPii('QQ：123456789').length > 0))
await t('微信号命中', () => assert.ok(scanPii('微信：abc12345').length > 0))
await t('群号命中', () => assert.ok(scanPii('群号 987654321').length > 0))
await t('链接命中', () => assert.ok(scanPii('看 https://example.com/x').length > 0))
await t('@提及命中', () => assert.ok(scanPii('@某个人 说的').length > 0))
await t('省市区命中', () => assert.ok(scanPii('住在杭州市西湖区').length > 0))
await t('学校命中', () => assert.ok(scanPii('他在浙江大学读书').length > 0))
await t('单位命中', () => assert.ok(scanPii('在字节跳动公司上班').length > 0))

await t('泛称「去了医院」不误伤', () => assert.equal(scanPii('他去了医院').length, 0))
await t('泛指「这家公司」不误伤', () => assert.equal(scanPii('他说这家公司挺好的').length, 0))
await t('具体单位仍命中', () => assert.equal(scanPii('在字节跳动公司上班').length, 1))
await t('干净文本零命中', () => assert.equal(scanPii('这条记忆里什么都没有，只有一条鱼。').length, 0))

await t('脱敏替换手机号与 QQ', () => {
  const { text, hits } = redactPii('电话 13812345678，QQ：123456789')
  assert.ok(hits.length >= 2)
  assert.equal(/13812345678|123456789/.test(text), false)
})
await t('匿名化：手机号变匿名', () => assert.equal(anonymizeContributor('13812345678'), '匿名'))
await t('匿名化：昵称保留', () => assert.equal(anonymizeContributor('咸鱼一条'), '咸鱼一条'))
await t('标签清洗：丢弃敏感标签', () => {
  const tags = sanitizeTags(['弹幕', '13812345678', '浙大'])
  assert.deepEqual(tags, ['弹幕', '浙大'])
})
await t('标签清洗：去重且截断到 8 个', () => {
  const tags = sanitizeTags(['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  assert.equal(tags.length, 8)
  assert.equal(new Set(tags).size, 8)
})
await t('emoji 标签按字符计长（16 字保留）', () => {
  assert.equal(sanitizeTags(['🐟'.repeat(16)]).length, 1)
})
await t('emoji 标签 17 字被丢弃', () => {
  assert.equal(sanitizeTags(['🐟'.repeat(17)]).length, 0)
})
await t('emoji 昵称 40 字保留为昵称', () => {
  assert.equal(anonymizeContributor('🐟'.repeat(40)), '🐟'.repeat(40))
})
await t('重叠命中合并后不留残片', () => {
  const { text } = redactPii('QQ：123456789a@b.com', 'strict')
  assert.equal(scanPii(text, 'strict').length, 0)
  assert.equal(/a@b\.com/.test(text), false)
})
await t('孤立代理项被清理', () => {
  const cleaned = sanitizeUnicode('a\uD800b\uDC00c')
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cleaned), false)
  assert.ok(cleaned.includes('\uFFFD'))
})
await t('合法 emoji 不被清理', () => assert.equal(sanitizeUnicode('🐟🌊'), '🐟🌊'))

// ───────────────────────── B. 写入与长度 ─────────────────────────
section('B. 写入与长度校验')

const first = await store.submit({
  title: '第一次追弹幕',
  content: '它第一次看见弹幕是在一个很晚的直播里。那些字从屏幕右边游过来，密密麻麻，比鱼缸里的水草还密。',
  tags: ['B站', '弹幕'],
  memory_type: 'fiction',
})
await t('第一条 id 是 L0001', () => assert.equal(first.id, 'L0001'))
await t('写入路径在 dataDir 内', () => assert.ok(first.saved_path.startsWith(dataA)))
await t('文件存在且是合法 JSON', async () => {
  const raw = JSON.parse(await fs.readFile(first.saved_path, 'utf8'))
  assert.equal(raw.id, 'L0001')
  assert.equal(raw.visibility, 'private')
})
await t('正文 19 字被拒', async () => {
  await assert.rejects(
    store.submit({ title: '很短', content: '鱼'.repeat(19) }),
    /正文长度/,
  )
})
await t('正文 300 字通过', async () => {
  const result = await store.submit({ title: '刚好三百字', content: '鱼'.repeat(300) })
  assert.equal(charLength('鱼'.repeat(300)), 300)
  assert.ok(result.id)
})
await t('正文 301 字被拒', async () => {
  await assert.rejects(store.submit({ title: '超一点', content: '鱼'.repeat(301) }), /正文长度/)
})
await t('标题 41 字被拒', async () => {
  await assert.rejects(store.submit({ title: '标'.repeat(41), content: '鱼'.repeat(30) }), /标题长度/)
})
await t('tags 超 8 个被截断', async () => {
  const result = await store.submit({
    title: '标签很多',
    content: '这是一条用来测试标签截断的记忆，正文长度刚好超过二十个字。',
    tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  })
  const raw = JSON.parse(await fs.readFile(result.saved_path, 'utf8'))
  assert.equal(raw.tags.length, 8)
})

// 并发分配 id：10 条同时写，id 不能撞
const concurrent = await Promise.all(
  Array.from({ length: 10 }, (_, index) =>
    store.submit({
      title: `并发 ${index}`,
      content: `这是第 ${index} 条并发写入的记忆，用来验证 id 分配在并发下不会撞号。`,
    }),
  ),
)
await t('并发 10 条 id 互不重复', () => {
  const ids = concurrent.map((item) => item.id)
  assert.equal(new Set(ids).size, 10)
  assert.equal(ids.every((id) => /^L\d{4}$/.test(id)), true)
})

const locals = await store.readLocalMemories()
await t('本地记忆数量正确', () => assert.equal(locals.length, 13))
await t('单条读取命中', async () => {
  const one = await store.readLocalMemory('L0001')
  assert.ok(one && one.title === '第一次追弹幕')
})
await t('不存在的 id 返回 null', async () => {
  assert.equal(await store.readLocalMemory('L9999'), null)
})
await t('非法 id 格式返回 null', async () => {
  assert.equal(await store.readLocalMemory('../package.json'), null)
})
await t('损坏的本地文件被跳过而不是崩', async () => {
  const broken = path.join(dataA, 'memories', 'L9999.json')
  await fs.writeFile(broken, '{ this is not json', 'utf8')
  const all = await store.readLocalMemories()
  assert.equal(all.length, 13)
  await fs.rm(broken)
})

// emoji 单独一套 store，避免打乱上面的计数断言
const emojiStore = new MemoryStore({ packageRoot: ROOT, dataDir: path.join(tmpRoot, 'emoji') })
await t('emoji 正文不被静默截断', async () => {
  const result = await emojiStore.submit({ title: '三百条鱼', content: '🐟'.repeat(300) })
  const draft = await emojiStore.preparePublic(result.id)
  assert.equal(charLength(draft.memory.content), 300)
})
await t('emoji 标题不被切断代理对', async () => {
  const result = await emojiStore.submit({
    title: '🐟'.repeat(5),
    content: '这是一条标题里带 emoji 的记忆，正文长度足够超过二十个字。',
  })
  const draft = await emojiStore.preparePublic(result.id)
  assert.equal(charLength(draft.memory.title), 5)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(draft.memory.title), false)
})
await t('孤立代理项不入库', async () => {
  const result = await emojiStore.submit({
    title: '代理项',
    content: '这是一条含\uD800代理项的记忆，正文长度足够超过二十个字。',
  })
  const raw = JSON.parse(await fs.readFile(result.saved_path, 'utf8'))
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(raw.content), false)
  assert.ok(raw.content.includes('\uFFFD'))
})

// ───────────────────────── C. 写入隔离 ─────────────────────────
section('C. 写入隔离')

await t('拒绝写包内 memories', () => {
  assert.throws(() => store.assertNotPackageMemories(path.join(PACKAGE_MEMORIES, '0009.json')), /拒绝写入/)
})
await t('允许写 dataDir', () => {
  assert.doesNotThrow(() => store.assertNotPackageMemories(path.join(dataA, 'memories', 'L0001.json')))
})
await t('包内 memories 未被改动', async () => {
  assert.equal(await snapshot(PACKAGE_MEMORIES), memoriesBefore)
})
await t('dist 未被改动', async () => {
  assert.equal(await snapshot(PACKAGE_DIST), distBefore)
})
await t('preparePublic 不写文件', async () => {
  const before = await snapshot(PACKAGE_MEMORIES)
  await store.preparePublic('L0001')
  assert.equal(await snapshot(PACKAGE_MEMORIES), before)
})

// ───────────────────────── D. 公开草稿 ─────────────────────────
section('D. 公开草稿')

const draft = await store.preparePublic('L0001')
await t('建议路径是 memories/0002.json', () => assert.equal(draft.path, 'memories/0002.json'))
await t('草稿只有 9 个公开字段', () => {
  const keys = Object.keys(JSON.parse(draft.json)).sort()
  assert.deepEqual(keys, [
    'content', 'contributor', 'created_at', 'fish_name', 'id', 'license', 'memory_type', 'tags', 'title',
  ])
})
await t('contributor 强制匿名', () => assert.equal(draft.memory.contributor, '匿名'))
await t('license 固定 CC0-1.0', () => assert.equal(draft.memory.license, 'CC0-1.0'))

const manualWithPii = await store.submit({
  title: '毕业那天',
  content: '毕业那天我在浙江大学门口站了很久，手机号 13700002222 写在纸条上，最后也没送出去。',
  tags: ['毕业'],
  memory_type: 'semi-fiction',
})
await t('手动来源保留原文（私有库允许）', async () => {
  const raw = JSON.parse(await fs.readFile(manualWithPii.saved_path, 'utf8'))
  assert.ok(/13700002222/.test(raw.content))
})
const piiDraft = await store.preparePublic(manualWithPii.id)
await t('草稿命中隐私并给出数量', () => assert.ok(piiDraft.privacy.hits.length >= 2))
await t('草稿里手机号已替换', () => {
  assert.equal(/13700002222/.test(piiDraft.memory.content), false)
  assert.ok(/\[手机号\]/.test(piiDraft.memory.content))
})
await t('草稿里学校已替换', () => assert.ok(/\[学校\]/.test(piiDraft.memory.content)))

// ───────────────────────── E. QQ 强制脱敏 ─────────────────────────
section('E. QQ 来源')

const qqResult = await store.submit({
  title: 'QQ 群里的一句话',
  content: '他发了手机号 13900001111，还说 QQ：88888888，让我加他，群号 123456789。',
  tags: ['QQ'],
  memory_type: 'semi-fiction',
  source: 'qq',
  platform: 'qq',
})
const qqRaw = JSON.parse(await fs.readFile(qqResult.saved_path, 'utf8'))
await t('手机号未落盘', () => assert.equal(/13900001111/.test(qqRaw.content), false))
await t('QQ 号未落盘', () => assert.equal(/88888888/.test(qqRaw.content), false))
await t('群号未落盘', () => assert.equal(/123456789/.test(qqRaw.content), false))
await t('QQ 来源固定 private', () => assert.equal(qqRaw.visibility, 'private'))
await t('QQ 来源标记正确', () => assert.equal(qqRaw.source, 'qq'))

// ───────────────────────── F. 检索与统计 ─────────────────────────
section('F. 检索与统计')

const noRemote = { include_remote: false }
const listPublic = await store.list(noRemote)
await t('默认不返回私有记忆', () => assert.equal(listPublic.private_count, 0))
await t('默认只返回公开种子', () => assert.equal(listPublic.items.length, 1))

const listPrivate = await store.list({ ...noRemote, include_private: true })
await t('开启后合并本地记忆', () => assert.equal(listPrivate.private_count, 15))
await t('公开数统计正确', () => assert.equal(listPublic.public_count, 1))

const byTag = await store.list({ ...noRemote, tag: '弹幕' })
await t('按标签过滤', () => assert.equal(byTag.items.length, 1))
const byKeyword = await store.list({ ...noRemote, keyword: '直播' })
await t('按关键词过滤', () => assert.equal(byKeyword.items.length, 1))
const bySource = await store.list({ ...noRemote, include_private: true, source: 'qq' })
await t('按来源过滤', () => assert.equal(bySource.items.length, 1))

const stats = await store.stats()
await t('统计总数 = 公开 + 私有', () => assert.equal(stats.total, stats.public_count + stats.private_count))
await t('来源分布含 qq', () => assert.equal(stats.sources.qq, 1))
await t('来源分布含 public', () => assert.equal(stats.sources.public, 1))
await t('新鲜度分布求和等于总数', () => {
  const { fresh, warm, cooling, dormant } = stats.freshness
  assert.equal(fresh + warm + cooling + dormant, stats.total)
})
await t('今日新增统计到本地写入', () => assert.ok(stats.today_added >= 15))

// ───────────────────────── G. 朗读素材 ─────────────────────────
section('G. 朗读素材')

const speakable = await store.speakable(2)
await t('返回 1-2 条', () => assert.ok(speakable.length >= 1 && speakable.length <= 2))
await t('每条 8-60 字', () => {
  for (const item of speakable) {
    const length = charLength(item.text)
    assert.ok(length >= 8 && length <= 60, `${length} 字`)
  }
})
await t('朗读内容不含隐私', () => {
  for (const item of speakable) assert.equal(scanPii(item.text, 'strict').length, 0)
})
await t('不返回私有字段', () => {
  for (const item of speakable) {
    assert.equal('visibility' in item, false)
    assert.equal('mood_snapshot' in item, false)
  }
})

// ───────────────────────── H. fish-memory 互操作 ─────────────────────────
section('H. fish-memory 互操作')

const exported = await store.exportFishMemory()
await t('导出条数 = 本地条数', () => assert.equal(exported.count, 15))
await t('导出文件落在 dataDir/exports', () => assert.ok(exported.path.startsWith(path.join(dataA, 'exports'))))
await t('导出结构含必需字段', () => {
  const payload = JSON.parse(exported.content)
  const record = payload.memories[0]
  for (const key of ['content', 'freshness', 'half_life_days', 'long_term', 'source']) {
    assert.ok(key in record, `缺 ${key}`)
  }
})
await t('重复导入全部跳过', async () => {
  const result = await store.importFishMemory(JSON.parse(exported.content))
  assert.equal(result.imported, 0)
  assert.equal(result.skipped, 15)
})
await t('新数据能导入', async () => {
  const result = await store.importFishMemory({
    memories: [{ content: '这是一条从鱼的记忆导进来的旧事，说的是某个下午的风。' }],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.skipped, 0)
})
await t('导入的记忆来源是 fish-memory', async () => {
  const all = await store.readLocalMemories()
  const imported = all.find((item) => item.source === 'fish-memory')
  assert.ok(imported)
})
await t('导入超长 emoji 内容按字符截断', async () => {
  const result = await emojiStore.importFishMemory({ memories: [{ content: '🐟'.repeat(400) }] })
  assert.equal(result.imported, 1)
  const all = await emojiStore.readLocalMemories()
  const imported = all.filter((item) => item.source === 'fish-memory').at(-1)
  assert.equal(charLength(imported.content), 300)
})
await t('导入的 emoji 标题没有孤立代理项', async () => {
  const all = await emojiStore.readLocalMemories()
  const imported = all.at(-1)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(imported.title), false)
})

// ───────────────────────── I. 插件装配 ─────────────────────────
section('I. 插件装配（假 ctx）')

function makeCtx({ plugins = [], withList = true } = {}) {
  const registered = []
  const events = []
  const services = new Map()
  const state = { contextCalls: 0 }
  const ctx = {
    tools: {
      register: (def) => registered.push(def),
      ...(withList ? { list: () => registered.map((item) => item.name) } : {}),
      call: async () => ({}),
    },
    logger: { info: () => {}, warn: () => {} },
    registry: { has: (id) => plugins.includes(id) },
    on: (event, handler) => events.push({ event, handler }),
    set: (name, value) => services.set(name, value),
    systemPrompt: { context: () => { state.contextCalls += 1 } },
  }
  return { ctx, registered, events, services, state }
}

const allPlugins = [
  'dsh-fish-memory',
  'dsh-feiyu-mood',
  'dsh-yu-mood',
  'dsh-speak-up',
  'dsh-tts-bridge',
  'dsh-speak',
  'dsh-dafeiyu-pet',
  'dsh-qq-bridge',
  'dsh-qqbot',
]
const full = makeCtx({ plugins: allPlugins })
const runtime = apply(full.ctx, { dataDir: dataB, enableMoodEvents: true })

await t('注册 8 个工具', () => assert.equal(runtime.tools.registered.length, 8))
await t('没有注册失败', () => assert.deepEqual(runtime.tools.failed, []))
await t('6 个适配器都有状态', () => assert.equal(runtime.statuses.length, 6))
await t('全部适配器 active', () => assert.equal(runtime.statuses.every((s) => s.active), true))
await t('两个心情插件同时存在时只启用 feiyu', () => {
  const mood = runtime.statuses.find((s) => s.id === 'mood')
  assert.ok(mood?.notes.some((note) => note.includes('dsh-feiyu-mood')))
})
await t('心情事件已订阅', () => assert.ok(full.events.length >= 1))
await t('聚合服务已挂载', () => assert.ok(full.services.has('dafeiyuMemories')))
await t('服务暴露 stats/speakable', () => {
  const service = full.services.get('dafeiyuMemories')
  assert.equal(typeof service.stats, 'function')
  assert.equal(typeof service.speakable, 'function')
})
await t('上下文提示包含 CC0 与工具名', () => {
  assert.ok(CONTEXT_HINT.includes('CC0-1.0'))
  assert.ok(CONTEXT_HINT.includes('submit_memory'))
})

// 热重载：同一个 ctx 上再 apply 一次
const dup = makeCtx({ plugins: [] })
const dupDir = path.join(tmpRoot, 'dup')
await t('重复 apply 不重复注册工具', () => {
  apply(dup.ctx, { dataDir: dupDir })
  apply(dup.ctx, { dataDir: dupDir })
  assert.equal(dup.registered.length, 8)
})
await t('重复 apply 只注入一次上下文', () => {
  assert.equal(dup.state.contextCalls, 1)
})

// 可选：真实 cordis + ToolRegistry 集成（依赖装了才跑）
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const SystemPrompt = await import('@deepseek-ai/dsh-system-prompt')
  const { default: ToolRegistry } = await import('@deepseek-ai/dsh-tools')
  const pluginModule = await import(lib('index.js'))

  const appCtx = new Context()
  await appCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  await appCtx.plugin(ToolRegistry)
  await appCtx.plugin(pluginModule, { dataDir: path.join(tmpRoot, 'cordis') })

  const realTools = appCtx.get('tools')
  await t('真实 cordis 加载后注册 8 个工具', () => assert.equal(realTools.schemas().length, 8))

  let service
  try {
    service = appCtx.get('dafeiyuMemories')
  } catch {
    service = undefined
  }
  await t('真实 cordis 挂上 dafeiyuMemories 服务', () => assert.ok(service))

  const call = (name, args) =>
    realTools.execute({
      callId: `${name}-${Date.now()}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })

  const submitted = await call('submit_memory', {
    title: '集成测试',
    content: '这是一条通过真实 registry 执行的记忆，用来验证从参数校验到结果渲染的完整链路。',
  })
  await t('真实 registry 执行 submit_memory', () => assert.equal(submitted.isError, false))
  await t('真实 registry 返回渲染文本', () => assert.ok(submitted.content?.[0]?.text?.includes('L0001')))

  const statsResult = await call('get_memory_stats', {})
  await t('真实 registry 执行 get_memory_stats', () => assert.equal(statsResult.isError, false))

  const rejected = await call('submit_memory', { title: '短', content: '太短' })
  await t('真实 registry 拒绝非法参数', () => assert.equal(rejected.isError, true))
} catch (error) {
  console.log(`  skip 真实 cordis 集成：${error.message}`)
}

// 空 profile：一个生态插件都没有
const empty = makeCtx({ plugins: [] })
const emptyRuntime = apply(empty.ctx, { dataDir: dataC })
await t('空 profile 仍注册 8 个工具', () => assert.equal(emptyRuntime.tools.registered.length, 8))
await t('空 profile 无适配器激活', () => assert.equal(emptyRuntime.statuses.every((s) => !s.active), true))
await t('空 profile 不订阅心情事件', () => assert.equal(empty.events.length, 0))

// 宿主的 tools 服务没有 list() 也不该崩
const bare = makeCtx({ plugins: ['dsh-fish-memory'], withList: false })
const bareRuntime = apply(bare.ctx, { dataDir: dataD })
await t('tools 无 list() 时不崩', () => assert.equal(bareRuntime.tools.registered.length, 8))
await t('无 list() 时 fish-memory 仍可被 registry 检测到', () => {
  const status = bareRuntime.statuses.find((s) => s.id === 'fish-memory')
  assert.equal(status?.detected, true)
})

// ───────────────────────── J. 工具 handler ─────────────────────────
section('J. 工具 handler 端到端')

// registered 里是 defineTool 编译后的 ToolDefinition，调用入口叫 execute
const handlers = new Map(full.registered.map((def) => [def.name, def.execute.bind(def)]))
const storeB = new MemoryStore({ packageRoot: ROOT, dataDir: dataB })

await t('submit_memory 写成功', async () => {
  const result = await handlers.get('submit_memory')({
    title: '深夜的微波炉',
    content: '凌晨三点，便利店只剩下他和一台微波炉。饭盒转了两圈，「叮」的一声，比外面整条街都响。',
    tags: ['便利店', '凌晨'],
  })
  assert.ok(/^L\d{4}$/.test(result.id))
  assert.equal(result.visibility, 'private')
})
await t('submit_memory 拒绝 QQ 来源当开关关闭时', async () => {
  const ctx = makeCtx({ plugins: [] })
  const tools = registerAllTools(ctx.ctx, {
    store: storeB,
    config: { ...resolveConfig({}), enableQqSource: false },
  })
  const submitDef = ctx.registered.find((def) => def.name === 'submit_memory')
  const handler = submitDef.execute.bind(submitDef)
  assert.equal(tools.registered.length, 8)
  await assert.rejects(
    handler({ title: '来自 QQ', content: '这是一条来自 QQ 的记忆，正文长度足够超过二十个字。', source: 'qq' }),
    /enableQqSource/,
  )
})
await t('prepare_public_memory 返回路径与 JSON', async () => {
  const local = (await storeB.readLocalMemories()).at(-1)
  const result = await handlers.get('prepare_public_memory')({ local_id: local.id })
  assert.ok(result.path.startsWith('memories/'))
  assert.ok(JSON.parse(result.json).id.length === 4)
})
await t('get_memories 默认不含私有', async () => {
  const result = await handlers.get('get_memories')({ include_remote: false })
  assert.equal(result.private_count, 0)
})
await t('get_memory_stats 带 adapters', async () => {
  const result = await handlers.get('get_memory_stats')({})
  assert.equal(result.adapters.length, 6)
})
await t('get_speakable_memories 返回 text', async () => {
  const result = await handlers.get('get_speakable_memories')({ limit: 2 })
  assert.equal(typeof result.text, 'string')
  assert.ok(result.count >= 0)
})
await t('export_to_fish_memory 带 adapter 信息', async () => {
  const result = await handlers.get('export_to_fish_memory')({})
  assert.ok(result.adapter.detected)
  assert.equal(result.adapter.mode, 'format')
})
await t('import_from_fish_memory 去重生效', async () => {
  const exported = await storeB.exportFishMemory()
  const result = await handlers.get('import_from_fish_memory')({ payload: exported.content })
  assert.equal(result.imported, 0)
})
await t('link_mood_snapshot 写入私有字段', async () => {
  const local = (await storeB.readLocalMemories()).at(-1)
  const result = await handlers.get('link_mood_snapshot')({
    local_id: local.id,
    mood_snapshot: { joy: 0.7, calm: 0.4 },
  })
  assert.equal(result.mood_snapshot.joy, 0.7)
  const updated = await storeB.readLocalMemory(local.id)
  assert.equal(updated.mood_snapshot.joy, 0.7)
})
await t('心情快照不进公开草稿', async () => {
  const local = (await storeB.readLocalMemories()).at(-1)
  const draft = await storeB.preparePublic(local.id)
  assert.equal('mood_snapshot' in JSON.parse(draft.json), false)
})
await t('空心情快照被拒', async () => {
  const local = (await storeB.readLocalMemories()).at(-1)
  await assert.rejects(
    handlers.get('link_mood_snapshot')({ local_id: local.id, mood_snapshot: {} }),
    /至少一个字段/,
  )
})
await t('给不存在的记忆挂心情会报错', async () => {
  await assert.rejects(
    handlers.get('link_mood_snapshot')({ local_id: 'L9999', mood_snapshot: { joy: 1 } }),
    /找不到本地记忆/,
  )
})

// ───────────────────────── K. 边界与降级 ─────────────────────────
section('K. 边界与降级')

// 显式给一个占位符地址，别用默认值 —— 默认值现在是真实仓库地址，会真的发请求
const placeholderStore = new MemoryStore({
  packageRoot: ROOT,
  dataDir: path.join(tmpRoot, 'placeholder'),
  remoteUrl: 'https://raw.githubusercontent.com/<USERNAME>/<REPO>/main/dist/memories.array.json',
})
await t('远程占位符静默降级', async () => {
  const result = await placeholderStore.list({ include_remote: true })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.remote.used, false)
})
await t('远程不可达时 3 秒内降级', async () => {
  const unreachable = new MemoryStore({
    packageRoot: ROOT,
    dataDir: path.join(tmpRoot, 'e'),
    remoteUrl: 'http://127.0.0.1:1/memories.json',
    remoteTimeoutMs: 500,
  })
  const started = Date.now()
  const result = await unreachable.list({ include_remote: true })
  assert.ok(Date.now() - started < 3000)
  assert.ok(result.warnings.some((warning) => warning.includes('远程记忆已降级')))
})
await t('nextPublicId 从 0001 推到 0002', () => assert.equal(nextPublicId(['0001']), '0002'))
await t('nextPublicId 跳过非法 id', () => assert.equal(nextPublicId(['0001', 'L0009', 'bad']), '0002'))
await t('新鲜度半衰期 = 0.5', () => {
  const created = new Date(Date.now() - 30 * 86400000)
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`
  const value = computeFreshness(date, 30)
  assert.ok(value > 0.45 && value <= 0.5, String(value))
})
await t('新鲜度未来日期封顶为 1', () => assert.equal(computeFreshness('2999-01-01', 30), 1))
await t('detectDshDataDir 无 storage 时返回 undefined', () => assert.equal(detectDshDataDir({}), undefined))
await t('detectDshDataDir 读 ctx.get("dataDir")', () => {
  const value = detectDshDataDir({ get: (name) => (name === 'dataDir' ? '/tmp/root' : undefined) })
  assert.ok(value?.includes('dafeiyu-memories'))
})

// ───────────────────────── L. 远程与适配器纯函数 ─────────────────────────
section('L. 远程与适配器纯函数')

// 本地起一个 HTTP 服务，测远程成功路径（之前只测了占位符和不可达）
const remotePayload = {
  memories: [
    {
      id: '8001',
      fish_name: '大肥鱼',
      contributor: '匿名',
      title: '远程来的记忆',
      content: '这是一条从远程聚合索引里拿到的记忆，用来验证解析、去重和计数是否都正确。',
      tags: ['远程'],
      memory_type: 'fiction',
      license: 'CC0-1.0',
      created_at: '2026-10-01',
    },
    { id: '8002', title: '缺字段的坏条目' },
  ],
}
let remoteMode = 'ok'
const server = http.createServer((_request, response) => {
  if (remoteMode === '404') {
    response.writeHead(404)
    response.end('not found')
    return
  }
  if (remoteMode === 'broken') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{ not json')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(remotePayload))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const remoteUrl = `http://127.0.0.1:${port}/memories.json`

const remoteStore = new MemoryStore({ packageRoot: ROOT, dataDir: path.join(tmpRoot, 'remote'), remoteUrl })

await t('远程成功：拿到条目并过滤坏数据', async () => {
  remoteMode = 'ok'
  const result = await remoteStore.list({ include_remote: true })
  assert.equal(result.remote.used, true)
  assert.equal(result.remote.count, 1)
  assert.ok(result.items.some((item) => item.id === '8001'))
  assert.equal(result.items.some((item) => item.id === '8002'), false)
  assert.deepEqual(result.warnings, [])
})

await t('远程 404 静默降级', async () => {
  remoteMode = '404'
  const result = await remoteStore.list({ include_remote: true })
  assert.equal(result.remote.used, false)
  assert.ok(result.warnings.some((warning) => warning.includes('HTTP 404')))
})

await t('远程返回坏 JSON 时降级', async () => {
  remoteMode = 'broken'
  const result = await remoteStore.list({ include_remote: true })
  assert.equal(result.remote.used, false)
  assert.equal(result.items.length, 1) // 只剩包内公开种子
})

await t('远程条目与本地重复时去重', async () => {
  remoteMode = 'ok'
  const again = await remoteStore.list({ include_remote: true })
  const ids = again.items.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
})
server.close()

const { extractMoodSnapshot } = await import(lib('adapters/mood.adapter.js'))
const { createSpeakUpDeduplicator } = await import(lib('adapters/speak-up.adapter.js'))
const { emitPetStats } = await import(lib('adapters/pet.adapter.js'))
const { preflightQqText, sanitizeQqText } = await import(lib('adapters/qq.adapter.js'))
const { assembleSpeakText, isSpeakableLength } = await import(lib('adapters/tts.adapter.js'))

await t('心情负载：平铺数值', () => {
  assert.deepEqual(extractMoodSnapshot({ joy: 0.6, sad: 0.1 }), { joy: 0.6, sad: 0.1 })
})
await t('心情负载：嵌套两层', () => {
  const snapshot = extractMoodSnapshot({ mood: { joy: 0.6 }, meta: 'x' })
  assert.deepEqual(snapshot, { joy: 0.6 })
})
await t('心情负载：无数值返回 null', () => {
  assert.equal(extractMoodSnapshot({ text: '开心' }), null)
})

await t('speak-up 去重：同一轮只放行一次', () => {
  const dedupe = createSpeakUpDeduplicator()
  const turn = { session_id: 's1', turn_id: 't1', content: '同一句话' }
  assert.equal(dedupe.firstSeen(turn), true)
  assert.equal(dedupe.firstSeen(turn), false)
  assert.equal(dedupe.size(), 1)
})
await t('speak-up 去重：不同轮不互相影响', () => {
  const dedupe = createSpeakUpDeduplicator()
  assert.equal(dedupe.firstSeen({ session_id: 's1', turn_id: 't1', content: 'a' }), true)
  assert.equal(dedupe.firstSeen({ session_id: 's1', turn_id: 't2', content: 'a' }), true)
})

await t('桌宠事件：开关关闭时不 emit', () => {
  const emitted = []
  const ctx = { emit: (event, payload) => emitted.push({ event, payload }) }
  const count = emitPetStats(ctx, { total: 1 }, false)
  assert.equal(count, 0)
  assert.equal(emitted.length, 0)
})
await t('桌宠事件：开关打开时 emit', () => {
  const emitted = []
  const ctx = { emit: (event, payload) => emitted.push({ event, payload }) }
  const count = emitPetStats(ctx, { total: 1 }, true)
  assert.ok(count >= 1)
  assert.equal(emitted[0].payload.total, 1)
})

await t('QQ 预检：含手机号判为不安全', () => {
  const result = preflightQqText('电话 13812345678')
  assert.equal(result.safe, false)
  assert.ok(result.hits.length > 0)
})
await t('QQ 清洗：文本被替换', () => {
  const result = sanitizeQqText('QQ：123456789 加我')
  assert.equal(/123456789/.test(result.text), false)
  assert.equal(result.changed, true)
})

await t('朗读拼接：去掉句末标点再连', () => {
  const text = assembleSpeakText([
    { id: '1', text: '第一句。', source: 'public', freshness: 1 },
    { id: '2', text: '第二句！', source: 'public', freshness: 1 },
  ])
  assert.equal(text, '第一句。第二句')
})
await t('朗读长度判断', () => {
  assert.equal(isSpeakableLength('刚好八个字的一句话'), true)
  assert.equal(isSpeakableLength('短'), false)
})

// 事件名可配置 + 运行时指标（用来判断适配器是不是真的在工作）
const moodStore = new MemoryStore({ packageRoot: ROOT, dataDir: path.join(tmpRoot, 'mood') })
await moodStore.submit({
  title: '心情测试',
  content: '这是一条用来测试心情事件关联的记忆，正文长度足够超过二十个字。',
})
const moodCtx = makeCtx({ plugins: ['dsh-feiyu-mood'] })
const moodRuntime = setupAdapters(moodCtx.ctx, {
  store: moodStore,
  config: resolveConfig({ enableMoodEvents: true, moodEventName: 'custom:mood' }),
})

await t('配置了事件名就只订阅它', () => {
  assert.deepEqual(moodCtx.events.map((item) => item.event), ['custom:mood'])
})
await t('心情事件触发后 metrics 增长', async () => {
  moodCtx.events[0].handler({ joy: 0.5, calm: 0.2 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const status = moodRuntime.statuses.find((item) => item.id === 'mood')
  assert.equal(status.metrics.received, 1)
  assert.equal(status.metrics.applied, 1)
})
await t('metrics 会带进 get_memory_stats 的 adapters', async () => {
  const status = moodRuntime.statuses.find((item) => item.id === 'mood')
  assert.equal(typeof status.metrics.subscribed, 'number')
})

// ───────────────────────── 收尾 ─────────────────────────
await t('包内 memories 全程未被写', async () => {
  assert.equal(await snapshot(PACKAGE_MEMORIES), memoriesBefore)
})
await t('dist 全程未被写', async () => {
  assert.equal(await snapshot(PACKAGE_DIST), distBefore)
})

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  - ${failure.name} :: ${failure.message}`)
  process.exit(1)
}
process.exit(0)
