// The part of the render check that turns a record into the tracker's own StatBlock HTML, shared by
// scripts/render.mjs (headings, stage 3) and scripts/sample.mjs (full text, stage 4).
//
// loadStatBlock() bundles the vendored component (vendor/src at the commit in vendor/PIN.md) with
// esbuild, installs a jsdom browser-ish global environment, imports the bundle and returns
//   { SB, dom, host, renderRecord }
// where SB exports StatBlock, parseCreature, parseHazard, useSettingsStore and STATBLOCK_DEFAULT,
// host is a <div> attached to the jsdom body for reading rendered HTML back as a DOM, and
// renderRecord(creature) renders an adapted Creature with the settings store reset to defaults,
// hideHP={false}, hideTraits={false}, no edit.
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Action-glyph font letters (ActionGlyph.tsx) -> the glyphs they draw. */
export const GLYPH_BACK = { A: '◆', D: '◆◆', T: '◆◆◆', F: '◇', R: '↺' }

/** An element's text with whitespace collapsed. */
export const text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

export async function loadStatBlock(root) {
  // ── bundle the vendored component ──
  const VENDOR_SRC = join(root, 'vendor', 'src')
  const STUBS = join(root, 'vendor', 'stubs')
  const BUNDLE = join(root, 'cache', 'render', 'statblock.mjs')
  const stubPlugin = {
    name: 'vendor-stubs',
    setup(b) {
      // Any import that resolves to a module with a file under vendor/stubs/ gets the stub instead.
      b.onResolve({ filter: /^\./ }, args => {
        const target = resolve(args.resolveDir, args.path)
        if (!target.startsWith(VENDOR_SRC)) return
        const rel = target.slice(VENDOR_SRC.length + 1)
        for (const ext of ['.tsx', '.ts']) {
          const stub = join(STUBS, rel + ext)
          if (existsSync(stub)) return { path: stub }
        }
      })
    },
  }
  await build({
    stdin: {
      contents: `
        export { StatBlock } from './components/StatBlock'
        export { parseCreature, parseHazard } from './utils/parseCreature'
        export { useSettingsStore, STATBLOCK_DEFAULT } from './store/settingsStore'
      `,
      resolveDir: VENDOR_SRC, loader: 'ts', sourcefile: 'render-entry.ts',
    },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    outfile: BUNDLE, logLevel: 'warning', plugins: [stubPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
  })

  // ── a browser-ish global environment, then the bundle ──
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const g = globalThis
  for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'getComputedStyle']) {
    Object.defineProperty(g, k, { value: k === 'window' ? dom.window : dom.window[k], configurable: true, writable: true })
  }
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  g.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  g.matchMedia = dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })

  const React = (await import('react')).default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const SB = await import(pathToFileURL(BUNDLE).href + `?t=${Date.now()}`)

  function renderRecord(creature) {
    SB.useSettingsStore.setState({ statBlock: SB.STATBLOCK_DEFAULT, spellLayout: 'grid', spellIndicator: 'diamond' })
    const combatant = {
      id: 'render-check', name: creature.name, creature, isPC: false, isAlly: false, initiative: null,
      currentHP: creature.defenses.hp, maxHP: creature.defenses.hp, tempHP: 0, conditions: [],
      isElite: false, isWeak: false, notes: '', isDefeated: false,
    }
    return renderToStaticMarkup(React.createElement(SB.StatBlock, { combatant, hideHP: false, hideTraits: false }))
  }

  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  return { SB, dom, host, renderRecord }
}

/** Load the records the way the render check does: every bestiary shard in file order, then hazards. */
export function loadRecords(dataDir) {
  const records = []
  const bdir = join(dataDir, 'bestiary')
  for (const f of readdirSync(bdir).filter(f => f.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(bdir, f), 'utf8'))
    for (const rec of j.creature ?? []) records.push({ rec, file: f, hazard: false })
  }
  const hz = JSON.parse(readFileSync(join(dataDir, 'hazards.json'), 'utf8'))
  for (const rec of hz.hazard ?? []) records.push({ rec, file: 'hazards.json', hazard: true })
  return records
}

/** Adapt a record with the app's own parseCreature/parseHazard and render it; returns { c, html }. */
export function renderThroughApp(core, { rec, file, hazard }) {
  const c = hazard ? core.SB.parseHazard(rec) : core.SB.parseCreature(rec, file)
  return { c, html: core.renderRecord(c) }
}
