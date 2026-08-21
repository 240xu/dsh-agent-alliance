// src/roundtable.js — 圆桌讨论编排：同一问题并发派发给多个外部 agent，收集结果。
// 综合分析交给调用方模型（DSH）完成——本模块只负责扇出、失败隔离与格式化。

export async function runRoundtable({ registry, prompt, providerIds, cwd, model, timeoutMs = 300000, signal }) {
  const ids = (providerIds && providerIds.length ? providerIds : registry.list().map(p => p.id))
  const tasks = ids.map(async (id) => {
    const t0 = Date.now()
    try {
      const provider = registry.get(id) // 未知 id 会 throw → 记为该家失败
      const out = await provider.dispatch({
        prompt: String(prompt), cwd, model, timeoutMs, signal,
      })
      return {
        provider: id, ok: true, text: out.text,
        externalSessionId: out.externalSessionId ?? null,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      return { provider: id, ok: false, error: String(err?.message || err), durationMs: Date.now() - t0 }
    }
  })
  const rounds = await Promise.all(tasks)
  return { prompt: String(prompt), rounds }
}

export function formatRoundtableText(result) {
  const lines = ['圆桌问题: ' + result.prompt, '']
  for (const r of result.rounds) {
    if (r.ok) {
      const head = '[' + r.provider + ']' + (r.externalSessionId ? ' (会话 ' + r.externalSessionId + ', ' + r.durationMs + 'ms)' : ' (' + r.durationMs + 'ms)')
      lines.push(head)
      const t = String(r.text || '')
      lines.push(t.length > 4000 ? t.slice(0, 4000) + '\n…(截断)' : t)
    } else {
      lines.push('[' + r.provider + '] 失败: ' + r.error)
    }
    lines.push('')
  }
  const okCount = result.rounds.filter(r => r.ok).length
  lines.unshift('参与 ' + result.rounds.length + ' 家 / 成功 ' + okCount + ' 家')
  return lines.join('\n')
}
