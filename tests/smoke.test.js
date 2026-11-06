// Smoke tests for the Host entry: the exported plugin surface, and the rule
// that the Host half loads with no `@deepseek-ai/*` package resolvable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** Repository root, derived from this test file's location. */
const ROOT = path.resolve(import.meta.dirname, '..')

test('the host entry exports name, inject, and apply', async () => {
  const mod = await import('../index.js')
  assert.equal(mod.name, 'agent-alliance')
  assert.ok(Array.isArray(mod.inject))
  assert.deepEqual(mod.inject, ['tools'])
  assert.equal(typeof mod.apply, 'function')
})

test('the package main entry is the host module this test imports', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['.'], './index.js')
  assert.ok(!('peerDependencies' in manifest), 'the plugin must not declare DSH peer dependencies')
})

test('every host module imports without any @deepseek-ai package', async () => {
  for (const relative of ['index.js', 'src/config.js', 'src/tools.js', 'src/http.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.ok(!source.includes('@deepseek-ai/'), relative + ' must not import a DSH package')
    await import(path.join(ROOT, relative))
  }
})

test('the host entry resolves the modules package.json exposes', async () => {
  for (const relative of ['src/config.js', 'src/tools.js', 'src/http.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), relative + ' must exist')
  }
})
