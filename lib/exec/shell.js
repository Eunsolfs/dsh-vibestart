/**
 * lib/exec/shell.js — 通过 DSH 执行缝 `ctx.shell` 跑 CLI（契约 §7）
 *
 * 只按 README 的契约调用 `resolve()` → `execute()` → `result()`，**不 import**
 * `@deepseek-ai/dsh-shell`：宿主运行时才提供这个服务，构建期不应该把类型依赖
 * 带进来。`result()` 只在基础设施失败时 reject，这里把它转成结构化结果，永远
 * 不向工具层抛。
 */

import { MAX_OUTPUT_CHARS, TIMEOUTS } from '../config.js'

// 命令前缀拼装与 plan 共用同一实现，避免 runner/版本两处漂移。
export { buildCliCommand } from '../plan/index.js'

/** 结果字符串超过这个长度就截断（与 config 的 MAX_OUTPUT_CHARS 一致）。 */
const TRUNCATION_MARK = '\n…[输出已截断]'

function truncate(text) {
  const value = String(text ?? '')
  if (value.length <= MAX_OUTPUT_CHARS) return value
  return value.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARK
}

function normalizeTimeout(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name
  return String(error ?? 'unknown error')
}

/** CollectedOutput 可能是 `{text}`，也可能已经被上层折成字符串。 */
function outputText(output) {
  if (typeof output === 'string') return output
  if (output && typeof output.text === 'string') return output.text
  return ''
}

/**
 * 跑一条命令并收集前台结果。
 *
 * `result()` 的 reject 会变成 `{exitCode:null, stdout:'', stderr:message}`
 * ——工具层据此给出可读失败，而不是让整条工具调用炸掉。
 *
 * @param {object} options
 * @param {object} options.shell ctx.shell 服务
 * @param {string} options.command
 * @param {number} [options.timeoutMs]
 * @param {string} [options.workdir]
 * @param {AbortSignal} [options.signal]
 * @param {Record<string,string>} [options.env] 额外环境变量（如 npm_config_cache）
 * @returns {Promise<{exitCode:number|null, timedOut:boolean, aborted:boolean, stdout:string, stderr:string}>}
 */
export async function runCommand({ shell, command, timeoutMs, workdir, signal, env } = {}) {
  const empty = { exitCode: null, timedOut: false, aborted: false, stdout: '', stderr: '' }

  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    return { ...empty, stderr: 'ctx.shell 不可用：无法执行命令。' }
  }

  const request = {
    command: String(command ?? ''),
    timeoutMs: normalizeTimeout(timeoutMs, TIMEOUTS.runPreview),
    onExpiry: 'kill',
    stdoutMaxBytes: MAX_OUTPUT_CHARS,
  }
  if (workdir !== undefined && workdir !== null && String(workdir) !== '') request.workdir = String(workdir)
  if (signal) request.signal = signal
  if (env && typeof env === 'object' && Object.keys(env).length > 0) request.env = { ...env }

  let execution
  try {
    const resolved = shell.resolve(request)
    execution = await shell.execute(resolved)
  } catch (error) {
    return { ...empty, stderr: `启动命令失败：${errorMessage(error)}` }
  }

  if (!execution || typeof execution.result !== 'function') {
    return { ...empty, stderr: 'ctx.shell 返回的句柄没有 result()，无法收集命令结果。' }
  }

  let result
  try {
    result = await execution.result()
  } catch (error) {
    return { ...empty, stderr: `命令执行失败：${errorMessage(error)}` }
  }

  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    timedOut: result?.timedOut === true,
    aborted: result?.aborted === true,
    stdout: truncate(outputText(result?.stdout)),
    stderr: truncate(outputText(result?.stderr)),
  }
}

/**
 * 从 CLI stdout 里取出那一个 JSON 对象。
 *
 * 前面可能有 Node 的 ExperimentalWarning、npm 的横幅；从第一个「以 { 开头的
 * 独立行」起截到末尾再解析。解析失败返回 null，绝不抛。
 *
 * @param {unknown} stdout
 * @returns {object|null}
 */
export function parseCliJson(stdout) {
  const text = String(stdout ?? '')
  if (!text) return null

  // 按 \n 切行，但用 index 计算行首（不能按 split 后的长度累加：
  // CRLF 会在每行多出一个 \r，偏移会漂到上一行中间）。
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if (line.trimStart().startsWith('{')) {
      const candidate = text.slice(lineStart).trim()
      const parsed = tryParse(candidate)
      if (parsed) return parsed
      // 末尾若混入日志行，退一步只解析到最后一个 `}`。
      const lastBrace = candidate.lastIndexOf('}')
      if (lastBrace > 0) {
        const fallback = tryParse(candidate.slice(0, lastBrace + 1))
        if (fallback) return fallback
      }
      return null
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return null
}

function tryParse(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}
