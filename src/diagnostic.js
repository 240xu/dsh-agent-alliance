// src/diagnostic.js — 官方化的失败诊断。
//
// 官方 SubagentResult.diagnostic 的契约（dsh-subagent/lib/types/types.d.ts:255-260）：
// provider 撰写的失败详情不得包含 tool inputs、文件内容、环境变量值、凭据、
// 原始协议载荷，且限制在 4096 UTF-8 字节内。官方 provider 只从固定字段构造
// 诊断（subagent-codex/src/run.ts:86-105），并把 cause 藏起来。
//
// 本模块把外部 CLI 的失败也收敛到同一形态：模型只看到结构化分类，原始
// stderr/stdout 留在 error.cause 供 Host 日志使用，绝不进入模型上下文。

/** 官方 codex wire 的失败分类（subagent-codex/src/wire.ts:19-30）。 */
export const CLI_FAILURE_CATEGORIES = [
  'limit',
  'access-policy',
  'service',
  'transport',
  'product-error',
  'invalid-result',
  'unknown',
]

/** 官方 SubagentResult.diagnostic 的 UTF-8 字节上限（out-of-process.ts:19）。 */
export const MAX_DIAGNOSTIC_BYTES = 4096

const TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 按官方算法在 UTF-8 边界处截断，避免劈开多字节序列。
 * @param {string} diagnostic 已构造好的结构化诊断文本
 * @returns {string} 原文，或带可见截断标记的受限文本
 */
export function limitDiagnostic(diagnostic) {
  const bytes = encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return diagnostic
  const suffixBytes = encoder.encode(TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] | 0) & 0b1100_0000) === 0b1000_0000) prefixBytes -= 1
  return decoder.decode(bytes.subarray(0, prefixBytes)) + TRUNCATION_SUFFIX
}

/**
 * 从 CLI 退出事实推断官方七分类之一。只读固定字段，不读原始输出内容。
 * @param {{ code?: number|null, signal?: string|null, timedOut?: boolean, aborted?: boolean,
 *           stderr?: string, stdout?: string }} r spawnCli 的结果
 * @returns {string} CLI_FAILURE_CATEGORIES 之一
 */
export function classifyCliFailure(r) {
  if (r.aborted === true) return 'transport'
  if (r.timedOut === true) return 'limit'
  const text = String(r.stderr || r.stdout || '')
  // 只做粗分类的关键词匹配，结果仅作为分类标签，绝不把原文带给模型。
  if (/quota|rate.?limit|429|too many requests|insufficient|billing|credit/i.test(text)) return 'limit'
  if (/unauthoriz|forbidden|401|403|api key|credential|permission denied|eacces/i.test(text)) return 'access-policy'
  if (/econn|enotfound|etimedout|socket|network|dns/i.test(text)) return 'transport'
  if (/invalid|parse|malformed|schema/i.test(text)) return 'invalid-result'
  if (/5\d\d|service unavailable|overload/i.test(text)) return 'service'
  return 'unknown'
}

/**
 * 构造一个官方形态的 CLI 失败错误。
 *
 * 消息只含固定字段（product / stage / category / exit code / signal），
 * 与 codex failureDiagnostic 一致；原始输出挂在 error.cause 上供日志用，
 * 不进入模型可见的 error.message。
 * @param {{ provider: string, stage?: string, r: object, raw?: string }} options 失败事实
 * @returns {Error} 带 code / category / cause 的结构化失败
 */
export function cliFailure({ provider, stage = 'dispatch', r, raw } = {}) {
  const category = classifyCliFailure(r)
  const fields = [
    'product: ' + String(provider),
    'stage: ' + stage,
    'category: ' + category,
  ]
  if (r.code !== undefined && r.code !== null) fields.push('exit code: ' + String(r.code))
  if (typeof r.signal === 'string' && r.signal !== '') fields.push('signal: ' + r.signal)
  if (r.timedOut === true) fields.push('timed out: true')
  if (r.aborted === true) fields.push('aborted: true')

  const message = limitDiagnostic('External CLI failure (' + fields.join('; ') + ')')
  const error = new Error(message)
  error.code = 'cli-failure'
  error.category = category
  // 原始输出只作为 Host 日志的 cause，模型看到的是上面的结构化消息。
  if (raw !== undefined) {
    const cause = new Error('raw CLI output (Host logs only)')
    cause.rawOutput = String(raw).slice(-4096)
    error.cause = cause
  }
  return error
}
