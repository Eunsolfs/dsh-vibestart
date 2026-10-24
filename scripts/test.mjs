#!/usr/bin/env node
/**
 * scripts/test.mjs — 进程内测试入口
 *
 * 为什么不用 `node --test tests/`：Node 的测试运行器给每个测试文件开子进程，
 * 而受限环境（DSH 的 Windows 沙箱、某些 CI 容器）不允许子进程通过管道
 * 交接 stdio，会直接 `spawn EPERM`。这里改成在当前进程里依次 import 各测试
 * 文件——`node:test` 在直接运行时会自注册并执行，行为一致，但没有子进程。
 *
 * 用法：node scripts/test.mjs [过滤词]
 */

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = join(HERE, '..', 'tests')
const filter = process.argv[2] ?? ''

const entries = await readdir(TESTS_DIR, { withFileTypes: true })
const files = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => entry.name)
  .filter(name => (filter ? name.includes(filter) : true))
  .sort()

if (files.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : 'tests/ 下没有任何 *.test.mjs')
  process.exitCode = 1
} else {
  for (const file of files) {
    // 顺序 import：每个文件注册自己的用例，node:test 汇总报告。
    await import(pathToFileURL(join(TESTS_DIR, file)).href)
  }
}
