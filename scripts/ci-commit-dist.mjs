#!/usr/bin/env node
/**
 * ci-commit-dist.mjs —— dist/ 有变化才提交
 *
 * 抽成脚本的好处：这段逻辑本地也能跑，不用等 Actions 跑完才知道判断对不对。
 *
 * 用法：
 *   node scripts/ci-commit-dist.mjs            # 只报告，不提交（本地默认）
 *   node scripts/ci-commit-dist.mjs --commit   # 真的 add / commit / push（CI 用）
 *
 * 为什么不用 `git diff --quiet -- dist`：diff 只比较已跟踪文件。
 * 首次生成、还没 git add 的 dist/*.json 会被判成「没有变化」，于是被漏掉。
 * `git status --porcelain` 连未跟踪文件一起看。
 */

import { execFileSync } from 'node:child_process'

const commit = process.argv.includes('--commit')

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

let status
try {
  status = git(['status', '--porcelain', '--', 'dist'])
} catch (error) {
  console.log('当前目录不是 git 仓库（或没装 git），跳过。')
  console.log('提示：' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
  process.exit(0)
}

if (!status.trim()) {
  console.log('dist/ 没有变化，跳过提交。')
  process.exit(0)
}

console.log('dist/ 有变化：')
console.log(status.trimEnd())

if (!commit) {
  console.log('')
  console.log('报告模式（没加 --commit），没有写任何东西。')
  process.exit(0)
}

try {
  git(['config', 'user.name', 'github-actions[bot]'])
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  git(['add', 'dist'])
  git(['commit', '-m', 'chore(dist): 聚合公开记忆 [skip ci]'])
  git(['push'])
  console.log('')
  console.log('已提交并推送。')
} catch (error) {
  console.error('提交失败：' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
  console.error('如果 push 被拒绝，多半是分支保护规则：允许 github-actions[bot] 写入，')
  console.error('或者改为由维护者手动跑 python scripts/build_index.py 后提交。')
  process.exit(1)
}
