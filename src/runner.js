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

export function normalizeEnv(extra) {
  const prefix = termuxPrefix()
  const merged = { ...process.env, ...(extra || {}) }
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
    child.on('close', (code) => settle(code === null ? -1 : code))
  })
}
