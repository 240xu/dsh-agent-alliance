
import zlib from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
function* walk(root) {
  let stack = [root]
  while (stack.length) {
    const d = stack.pop()
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && /session\.jsonl\.zstd$/.test(e.name)) yield p
    }
  }
}
function decode(f) {
  const buf = readFileSync(f)
  const M = [0x28, 0xB5, 0x2F, 0xFD]
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === M[0] && buf[i+1] === M[1] && buf[i+2] === M[2] && buf[i+3] === M[3]) starts.push(i)
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)))
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
}
let td = null, be = null, tr = null, bsTool = null
outer:
for (const f of walk('/data/data/com.termux/files/home/.dsh/sessions')) {
  let lines
  try { lines = decode(f) } catch { continue }
  for (const l of lines) {
    try {
      const o = JSON.parse(l)
      if (!td && o.type === 'assistant/chunk' && o.data?.chunk?.type === 'text-delta') td = l
      if (!be && o.type === 'assistant/chunk' && o.data?.chunk?.type === 'block-end') be = l
      if (!tr && o.type === 'tool/result') tr = l
      if (!bsTool && o.type === 'assistant/chunk' && o.data?.chunk?.type === 'block-start' && o.data?.chunk?.blockType === 'tool-call') bsTool = l
      if (td && be && tr && bsTool) break outer
    } catch {}
  }
}
console.log('--- text-delta:\n' + (td || '(无)').slice(0, 300))
console.log('\n--- block-end:\n' + (be || '(无)').slice(0, 300))
console.log('\n--- block-start(tool-call):\n' + (bsTool || '(无)').slice(0, 300))
console.log('\n--- tool/result:\n' + (tr || '(无)').slice(0, 500))
