/**
 * Manifest guard for the browser half: the package may only declare a client
 * entry that the Host can serve, and that entry must use the current
 * `__ModuleLoader__` factory contract instead of injecting its own DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))
const clientPath = root + '/client.js'

/** Load the bundle in a synthetic window and return the captured definition. */
function loadBundle() {
  const source = readFileSync(clientPath, 'utf8')
  let definition
  const context = {
    window: {
      __ModuleLoader__: {
        load(options) { definition = options },
      },
    },
    document: {
      documentElement: { lang: 'en' },
      createElement() {
        return { setAttribute() {}, remove() {}, textContent: '' }
      },
      head: { appendChild() {} },
    },
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  assert.ok(definition !== undefined, '__ModuleLoader__.load was never called')
  return definition
}

/** Materialize the plugin object with a React stub; no component renders. */
function loadPlugin(definition) {
  const React = {
    createElement() { return null },
    useEffect() { return undefined },
    useRef(value) { return { current: value } },
    useState(value) { return [value, () => {}] },
  }
  return definition.factory((request) => {
    assert.equal(request, 'react', 'the bundle may only require react')
    return React
  })
}

/** Run apply against a minimal ctx and report every contribution it made. */
function applyPlugin(plugin) {
  const dictionaries = {}
  const registrations = []
  const ctx = {
    locale: {
      bind() { return (key) => key },
      register(namespace, value) {
        dictionaries[namespace] = value
        return () => {}
      },
    },
    effect(run) {
      const dispose = run()
      assert.equal(typeof dispose, 'function', 'every ctx.effect must return its disposer')
      return dispose
    },
    slots: {
      inject(_name, register) {
        assert.equal(typeof register, 'function')
        return register()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { dictionaries, registrations }
}

test('package declares a loadable client entry', () => {
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.dsh.client, 'dsh.client must be declared')
  assert.ok(pkg.files.includes('client.js'), 'files must ship client.js')
  assert.ok(existsSync(clientPath), './client export points at a missing client.js')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.private, undefined, 'the plugin must stay installable')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    '.', './client', './icon', './locale/*.json', './package.json',
  ])
})

test('client bundle registers the package id through __ModuleLoader__', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /__ModuleLoader__\.load/)
  const definition = loadBundle()
  assert.equal(definition.id, 'dsh-agent-alliance')
  assert.match(source, /id:\s*'dsh-agent-alliance'/)
  assert.match(source, /return\s*\{\s*inject\s*:\s*\[[^\]]*\]\s*,\s*apply\s*\}/)
  const plugin = loadPlugin(definition)
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.inject.join(','), 'slots,locale')
})

test('client bundle avoids the retired DOM-injection path', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.equal(source.includes('react-dom'), false, 'react-dom must not be required')
  assert.equal(source.includes('document.body'), false, 'the panel must not be appended to document.body')
  assert.equal(source.includes('MutationObserver'), false, 'the sidebar must not be observed by the client')
})

test('apply registers both slots and the agentAlliance dictionaries', () => {
  const plugin = loadPlugin(loadBundle())
  const { dictionaries, registrations } = applyPlugin(plugin)

  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main panel slot was not registered')
  assert.equal(main.options.key, 'agent-alliance')
  assert.equal(main.options.locale, 'agentAlliance')
  assert.equal(typeof main.component, 'function')

  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'sidebar.panellist slot was not registered')
  assert.equal(sidebar.options.id, 'agent-alliance')
  assert.equal(sidebar.options.order, 30)
  assert.equal(sidebar.options.locale, 'agentAlliance')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(typeof sidebar.component, 'function')

  const dict = dictionaries.agentAlliance
  assert.ok(dict, 'agentAlliance dictionaries were not registered')
  const zhKeys = Object.keys(dict.zh).sort()
  const enKeys = Object.keys(dict.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must carry identical keys')
  assert.ok(zhKeys.includes('panel'))
  for (const key of zhKeys) {
    assert.equal(typeof dict.zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof dict.en[key], 'string', `en.${key} must be a string`)
    assert.ok(dict.zh[key].trim() !== '', `zh.${key} must not be empty`)
    assert.ok(dict.en[key].trim() !== '', `en.${key} must not be empty`)
  }
})

test('locale files carry localizable package metadata', () => {
  for (const language of ['en', 'zh']) {
    const file = root + '/locale/' + language + '.json'
    assert.ok(existsSync(file), `locale/${language}.json is missing`)
    const value = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof value.meta, 'object', `locale/${language}.json needs meta`)
    assert.equal(typeof value.meta.title, 'string', `locale/${language}.json needs meta.title`)
    assert.equal(typeof value.meta.description, 'string', `locale/${language}.json needs meta.description`)
    assert.ok(value.meta.title.trim() !== '', `locale/${language}.json meta.title must not be empty`)
    assert.ok(value.meta.description.trim() !== '', `locale/${language}.json meta.description must not be empty`)
  }
})

test('icon is a small original SVG mark', () => {
  const file = root + '/icon.svg'
  assert.ok(existsSync(file), 'icon.svg is missing')
  const source = readFileSync(file, 'utf8')
  assert.ok(source.startsWith('<svg'), 'icon.svg must start with <svg')
  assert.ok(source.length < 4096, 'icon.svg must stay small')
})

test('the ACP documentation names both opencode architectures separately', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname
  const readme = readFileSync(join(root, 'README.md'), 'utf8')

  // opencode ships two architectures on different package lines (opencode-ai is
  // 0.x/1.x only; @opencode/* is the 2.x line). A single unqualified "opencode
  // supports ACP" claim let a reader assume v1's capability set applies to v2,
  // which it does not. The docs must name both.
  assert.match(readme, /opencode v1/, 'the docs must name the v1 architecture')
  assert.match(readme, /opencode v2/, 'the docs must name the v2 architecture')
  assert.match(readme, /两套架构/, 'the docs must say the two are separate architectures')
  // And the differences that matter must be stated, not just "both work".
  assert.match(readme, /mcpCapabilities\.sse/, 'the sse capability difference must be stated')
  assert.match(readme, /additionalDirectories/, 'the added session capability must be stated')
})

test('the panel consumes the official-coverage fields the host reports', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname
  const client = readFileSync(join(root, 'client.js'), 'utf8')

  // The host added `official` and `prefer` to /state; a panel that renders only
  // `available` shows an officially-covered agent as a plain replacement for the
  // official tool, which is the duplication this round removed.
  assert.match(client, /provider\.official === true/, 'the panel must render the coverage flag')
  assert.match(client, /provider\.prefer/, 'the panel must render the preference guidance')
  assert.match(client, /'state\.official'/, 'the coverage label must be localized')
})

test('every client locale key exists in both languages', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const zhBlock = client.slice(client.indexOf('zh:'), client.indexOf('en:'))
  // The English block runs to the closing brace of the dictionary object, which
  // is the LAST closing brace before the next top-level statement — slicing at
  // the first '}' cut the block short and reported genuinely present keys as
  // missing. Anchoring on the next declaration is the reliable boundary.
  const enStart = client.indexOf('en:')
  const enEnd = client.indexOf('\n    }', enStart)
  const enBlock = enEnd === -1 ? client.slice(enStart) : client.slice(enStart, enEnd)
  const keys = (block) => new Set([...block.matchAll(/'([a-zA-Z][^']*?)'[:\s]/g)].map((m) => m[1]))
  for (const key of keys(zhBlock)) {
    if (!key.includes('.')) continue
    assert.ok(keys(enBlock).has(key), 'locale key ' + key + ' is missing from the English dictionary')
  }
})
