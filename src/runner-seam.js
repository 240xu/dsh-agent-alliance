/**
 * Run one external CLI through the OFFICIAL `ctx.subprocess` seam.
 *
 * `ctx.subprocess` is a Cordis service (dsh-base mounts
 * `dsh-subprocess-local`), so a zero-dependency plugin uses it without importing
 * the package. It supplies three guarantees a raw `node:child_process.spawn`
 * does not: managed-range termination that kills the whole process group,
 * `scrubbedParentEnv()` credential scrubbing applied by the implementation, and
 * platform-correct termination semantics. The seam's `SubprocessSpawnSpec`
 * requires cwd/stdio/graceMs explicitly; `env` is the caller's deliberate
 * overlay on top of the scrubbed parent.
 *
 * Returns the same shape as {@link spawnCli} so providers are agnostic to which
 * path ran.
 * @param {object} options dependencies and spawn request
 * @param {object} options.subprocess the official `ctx.subprocess` service
 * @param {{ argv: string[], cwd?: string, env?: object, timeoutMs?: number,
 *           signal?: AbortSignal }} options.request spawn request
 * @returns {Promise<{ code: number, stdout: string, stderr: string,
 *                      timedOut: boolean, aborted: boolean }>} normalized result
 */
export async function spawnCliViaSeam({ subprocess, request }) {
  const { argv, cwd, env, timeoutMs, signal } = request
  const controller = new AbortController()
  let timedOut = false
  let aborted = false

  const onAbort = () => {
    aborted = true
    controller.abort(new Error('cancelled'))
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let timer
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('timed out'))
    }, timeoutMs)
  }

  const collect = { maxBytes: 4 * 1024 * 1024 }
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: cwd || process.cwd(),
      stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
      graceMs: 3000,
      signal: controller.signal,
      // Explicit entries only; the seam applies scrubbedParentEnv itself.
      ...(env !== undefined ? { env } : {}),
    })
    const outcome = await handle.done
    // `collected` readers are cursor-free; readFrom(0) after settlement is the
    // batch result.
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return {
      code: outcome.exitCode === null ? -1 : outcome.exitCode,
      stdout,
      stderr,
      timedOut,
      aborted,
    }
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: String(error?.message || error),
      timedOut,
      aborted,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Bind the official subprocess seam to a `spawnCli`-compatible function.
 * @param {object} ctx plugin context
 * @returns {Function|undefined} spawn function when the seam is mounted
 */
export function seamSpawnCli(ctx) {
  let subprocess
  try { subprocess = ctx?.get?.('subprocess') } catch { subprocess = undefined }
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') return undefined
  return (request) => spawnCliViaSeam({ subprocess, request })
}
