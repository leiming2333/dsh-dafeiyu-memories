#!/usr/bin/env node
/**
 * probe-remote.mjs —— 在你自己的网络下验证远程记忆地址
 *
 * 为什么要单独一个脚本：本地开发环境（代理、防火墙）拿到的结果和用户实际网络
 * 经常不一样。raw.githubusercontent.com 尤其容易这样：可能返回 200 但内容是
 * 代理页，也可能 404，也可能直接连不上。
 *
 * 用法：
 *   npm run probe:remote -- https://raw.githubusercontent.com/<USERNAME>/<REPO>/main/dist/memories.array.json
 *   npm run probe:remote                      # 不传就探默认地址（通常是占位符）
 *
 * 输出：HTTP 状态、content-type、耗时、响应前 200 字、以及本插件解析出几条。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = (name) => path.join(ROOT, 'lib', name)

try {
  await fs.access(lib('remote.js'))
} catch {
  console.error('找不到 lib/，先跑 npm run build')
  process.exit(1)
}

const { fetchRemoteMemories, resolveRemoteUrl, isPlaceholderUrl } = await import(
  pathToFileURL(lib('remote.js')).href
)

const argument = process.argv[2]
const url = argument ?? resolveRemoteUrl()

if (isPlaceholderUrl(url)) {
  console.error('地址还是模板占位符：' + url)
  console.error('先把 <USERNAME> / <REPO> 换成真实值，或者直接把完整 URL 传进来。')
  process.exit(2)
}

console.log('探测地址：' + url)
console.log('')

const started = Date.now()
try {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  })
  const text = await response.text()
  console.log('HTTP 状态：' + response.status)
  console.log('content-type：' + (response.headers.get('content-type') ?? '(空)'))
  console.log('响应长度：' + text.length + ' 字符')
  console.log('耗时：' + (Date.now() - started) + ' ms')
  console.log('前 200 字：' + JSON.stringify(text.slice(0, 200)))
  console.log('')

  // 内容明显不是 JSON 时，多半是被代理改写过，先提示清楚
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    console.log('⚠️  响应看起来不是 JSON。可能是代理拦截页、登录页，或者地址指错了。')
    console.log('   先手动在浏览器打开这个地址，确认能看到 memories 数组。')
    console.log('')
  }
} catch (error) {
  console.error('请求失败：' + (error instanceof Error ? error.message : String(error)))
  console.error('检查网络、代理设置，或者把 remoteTimeoutMs 调大后再试。')
  process.exit(1)
}

const parsed = await fetchRemoteMemories(url, 15_000)
console.log('本插件解析结果：')
console.log('  ok：' + parsed.ok)
console.log('  条目数：' + parsed.items.length)
console.log('  耗时：' + parsed.elapsed_ms + ' ms')
if (parsed.error) console.log('  错误：' + parsed.error)
console.log('')

if (parsed.ok && parsed.items.length > 0) {
  const first = parsed.items[0]
  console.log('第一条：' + first.id + ' · ' + first.title)
  console.log('  正文：' + first.content.slice(0, 40) + '…')
  console.log('')
  console.log('✅ 地址可用。')
} else if (parsed.ok) {
  console.log('地址能打开，但没有解析出任何条目。检查：')
  console.log('  1. 文件是不是 dist/memories.array.json（数组）或 dist/memories.json（含 memories 字段）')
  console.log('  2. 每条是否至少有 id / title / content / tags / fish_name')
} else {
  console.log('❌ 解析失败：' + (parsed.error ?? '未知原因'))
  process.exit(1)
}
