// src/runner.js — 外部 CLI 子进程启动器。
// 职责：argv 数组直 spawn（不经 shell）、env 归一化、超时 kill、abort kill。
// 返回 {code, stdout, stderr, timedOut, aborted}，永不 reject（失败也是结果）。
//
// 环境归一化：DSH 宿主/worker 进程的环境可能被清空（实测 run_code worker
// process.env 为空对象）。外部 agent CLI 至少需要 PATH/HOME/TMPDIR：
// - PATH 缺失 → Termux 前缀 bin + 系统 bin 兜底；
// - HOME 缺失 → Termux home；
// - TMPDIR 缺失 → $PREFIX/tmp（opencode 会尝试 mkdir /tmp/opencode，Termux 无 /tmp）。

import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

function termuxPrefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

/**
 * Names whose values look like credentials and must not reach an external agent.
 *
 * The DSH subprocess seam scrubs the same names (`KEY|PASSWORD|SECRET|TOKEN`
 * plus every `DSH_*` fact) before spawning an official child. This CLI path is
 * used by the panel and by every non-agent dispatch, so it needs the same
 * treatment: the panel's dispatch would otherwise hand a third-party CLI the
 * host's API keys.
 */
// Matches the host's own `SENSITIVE_ENV_PATTERN` exactly
// (packages/subprocess/subprocess/src/index.ts:47). Do not widen it: a broader
// pattern (PASSWD|CREDENTIAL|SESSION) was tried and silently removed legitimate
// names such as MONKEY, KEYBOARD, TOKENIZER and SESSION_NAME from the child.
// The broad substring match is the host's deliberate tradeoff — a name like
// MONKEY is dropped rather than a credential leaking.
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Build the child environment for one external agent CLI.
 *
 * The ambient environment is scrubbed of credential-shaped names and DSH
 * internals, then `extra` is layered on top as a deliberate caller opt-in.
 * PATH/HOME/TMPDIR are backfilled so a cleared host environment still runs.
 * @param {Record<string, string|undefined>} [extra] explicit caller-supplied entries
 * @returns {NodeJS.ProcessEnv} the child environment
 */
export function normalizeEnv(extra) {
  const prefix = termuxPrefix()
  const merged = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (CREDENTIAL_NAME.test(name)) continue
    // The host matches case-insensitively: Windows environment names are
    // case-insensitive, so a lowercase `dsh_*` entry would otherwise survive
    // and read back as `$env:DSH_*` in the child. Keep this in lockstep with
    // `scrubbedParentEnv()` in dsh-subprocess.
    if (name.toUpperCase().startsWith('DSH_')) continue
    merged[name] = value
  }
  // `extra` is an explicit caller decision, so it survives the scrub.
  Object.assign(merged, extra || {})
  if (!merged.HOME) merged.HOME = homedir() || '/data/data/com.termux/files/home'
  if (!merged.TMPDIR) merged.TMPDIR = tmpdir() && tmpdir() !== '/tmp' ? tmpdir() : prefix + '/tmp'
  if (!merged.PATH || merged.PATH.length === 0) {
    merged.PATH = [prefix + '/bin', prefix + '/bin/applets', '/system/bin', '/system/xbin'].join(':')
  }
  return merged
}

export function spawnCli({ argv, cwd, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let timer

    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd || undefined,
      env: normalizeEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    function settle(code) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, aborted })
    }
    function onAbort() {
      aborted = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already dead */ }
      }, timeoutMs)
    }

    child.on('error', (err) => {
      stderr += String(err && err.message ? err.message : err)
      settle(-1)
    })
    // `close` waits for every inherited stdio pipe to drain, so a surviving
    // grandchild that keeps stdout open leaves this promise pending forever and
    // permanently occupies a concurrency slot. `exit` fires when the direct
    // child ends regardless; settle on whichever arrives first and give the
    // pipes a short grace to flush afterwards.
    let exitCode = null
    child.on('exit', (code, signal) => {
      exitCode = code === null ? -1 : code
      setTimeout(() => settle(exitCode), 250).unref?.()
    })
    child.on('close', (code) => settle(code === null ? (exitCode ?? -1) : code))
  })
}
