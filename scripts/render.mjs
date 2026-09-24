#!/usr/bin/env node
// Stage 3, the render check: render every record through the tracker's own StatBlock (vendored at the
// commit in vendor/PIN.md) and compare the headings it shows with the headings the Archives page prints.
//
//   node scripts/render.mjs [--data <dir>] [--out <file>] [--only <id,id>] [--limit N] [--html <dir>]
//
// Three layers are probed for every heading so each difference is blamed on the layer that lost it:
//   page (scripts/lib/page-headings.mjs, the oracle)  ->  record JSON  ->  parseCreature/parseHazard
//   (the app's adapter)  ->  StatBlock DOM.
// verdicts: parse   the record JSON lacks the heading (or carries one the page does not print)
//           adapter the JSON has it, the adapter dropped (or invented) it before the component
//           render  the adapter passed it and StatBlock did not show it (or showed one nobody gave it)
//           merged  two page headings became one
//           order   present on both sides but out of page order
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pageHeadings, printsUnboldedHeader } from './lib/page-headings.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const DATA = resolve(opt('--data', join(ROOT, 'data')))
const OUT = resolve(opt('--out', join(ROOT, 'report', 'render.json')))
const ONLY = opt('--only', '') ? new Set(opt('--only').split(',')) : null
const LIMIT = +opt('--limit', 0) || 0
const HTML_DIR = opt('--html', '')

// ── 1. bundle the vendored component ─────────────────────────────────────────────────────────────
const VENDOR_SRC = join(ROOT, 'vendor', 'src')
const STUBS = join(ROOT, 'vendor', 'stubs')
const BUNDLE = join(ROOT, 'cache', 'render', 'statblock.mjs')
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

// ── 2. a browser-ish global environment, then the bundle ─────────────────────────────────────────
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

// ── 3. rendered headings from the DOM ─────────────────────────────────────────────────────────────
const GLYPH_BACK = { A: '◆', D: '◆◆', T: '◆◆◆', F: '◇', R: '↺' }
const host = dom.window.document.createElement('div')
dom.window.document.body.appendChild(host)
const text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

function renderedHeadings(html) {
  host.innerHTML = html
  // Interactive UI that is not stat-block text: buttons (attack/dmg rollers, Reset uses, UsesChip),
  // spell pips. Action-glyph font letters are mapped back to the glyphs they draw.
  for (const el of host.querySelectorAll('button, .spell-pips')) el.remove()
  for (const el of host.querySelectorAll('.pf2-action-glyph')) el.textContent = GLYPH_BACK[el.textContent] ?? el.textContent
  const root = host.querySelector('.stat-block')
  const out = []
  const traits = []
  let languagesText = ''
  let section = ''
  const push = (label, kind, extra) => out.push({ label, kind, ...extra })
  const walk = el => {
    for (const child of el.children) visit(child)
  }
  const visit = el => {
    const cls = el.classList
    if (cls.contains('stat-bar')) {
      section = text(el)
      if (['Rituals', 'Routine', 'Reset', 'Full Text'].includes(section)) push(section, 'stat')
      return
    }
    const style = el.getAttribute('style') || ''
    if (!cls.length && /padding:12px 24px 10px/.test(style)) {           // trait pills row
      for (const p of el.children) traits.push(text(p))
      return
    }
    if (!cls.length && text(el).startsWith('⚠ Hazard')) {                 // hazard banner + complexity badge
      if (el.children.length > 1) push('Complexity', 'stat', { value: text(el.children[1]) })
      return
    }
    if (cls.contains('pf-label')) { push(text(el), 'stat'); return }
    if (cls.contains('def-box-label')) { push(text(el), 'stat'); return }
    if (cls.contains('stat-line') && !cls.contains('def-strip')) {
      if (section === 'Attacks') {
        const row = el.firstElementChild
        const range = text(row?.querySelector('.stat-label'))
        const name = row?.querySelector('.stat-label')?.parentElement?.querySelector(':scope > span[style*="font-weight:600"]')
        push(`${range.charAt(0).toUpperCase()}${range.slice(1)} ${text(name)}`, 'strike')
        return
      }
      if (section === 'Spellcasting') { push(text(el.firstElementChild?.firstElementChild), 'spells'); return }
      if (section === 'Abilities & Actions') { push(text(el.firstElementChild?.firstElementChild), 'ability'); return }
      if (section === 'Defense' && ['AC', 'Saves', 'Speed'].includes(text(el.querySelector('.stat-label')))) return // note rows
      if (section === 'Rituals' || section === 'Full Text') return
      if (el.querySelector('.roll-check') && /^str\b/i.test(text(el.querySelector('.roll-check')))) {
        push('Ability Modifiers', 'stat'); return
      }
      for (const lab of el.querySelectorAll('.stat-label')) {
        const l = text(lab)
        if (l === 'BT' || l === 'DC') continue
        if (l === 'Languages') languagesText = text(el)
        push(l, 'stat')
      }
      return
    }
    walk(el)
  }
  if (root) walk(root)
  return { headings: out, traits, languagesText }
}

// ── 4. the record and adapter probes ─────────────────────────────────────────────────────────────
const norm = s => String(s ?? '').toLowerCase()
  .replace(/<actions\b[^>]*>/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[◆◇↺]/g, ' ').replace(/[’‘]/g, "'").replace(/[*_]/g, '')
  .replace(/\s+/g, ' ').trim().replace(/[\s:;,.]+$/, '')
const keyOf = h => (h.kind === 'stat' ? 'stat:' : h.kind + ':') + norm(h.label)
const cut = v => {
  if (v == null) return v
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 400 ? (typeof v === 'string' ? s.slice(0, 400) + '…' : JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'string' && x.length > 200 ? x.slice(0, 200) + '…' : x))) : v
}
const nonEmpty = v => Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : v != null && v !== ''
const flatText = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(flatText).join(' ') : v && typeof v === 'object' ? Object.values(v).map(flatText).join(' ') : v == null ? '' : String(v)

function rawAbilities(raw, hazard) {
  if (hazard) return [...(raw.actions ?? []), ...(raw.abilities?.mid ?? [])]
  return ['top', 'mid', 'bot'].flatMap(s => (raw.abilities?.[s] ?? []).map(a => ({ ...a, _slot: s })))
}
const cleanAbilityName = n => String(n).replace(/<actions\b[^>]*>/gi, '').replace(/\s+/g, ' ').trim()

/** The record's value for a heading (null when the record does not carry it). */
function rawValue(raw, h, hazard, { extra = false } = {}) {
  const d = raw.defenses ?? {}
  // For a heading the page does not print, only the record's structured fields count: the hazard
  // description blob is the page text itself, and a hazard's 0 is how the record spells "absent".
  const blob = hazard && !extra ? flatText(raw.description) : ''
  const inBlob = label => hazard && new RegExp(`(^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(blob)
  const zeroIsAbsent = v => (v?.std == null || (hazard && extra && v.std === 0) ? null : v)
  switch (h.kind) {
    case 'strike': {
      const k = norm(h.label)
      const a = (raw.attacks ?? []).find(a => norm(`${a.range} ${a.name}`) === k)
      if (a) return a
      return hazard && inBlob(h.label.replace(/^(Melee|Ranged) /, '')) ? { inDescription: h.label } : null
    }
    case 'spells': return (raw.spellcasting ?? []).find(s => norm(s.name) === norm(h.label)) ?? null
    case 'ability': {
      const a = rawAbilities(raw, hazard).find(a => norm(cleanAbilityName(a.name)) === norm(h.label))
      if (a) return a
      return hazard && inBlob(h.label) ? { inDescription: h.label } : null
    }
  }
  switch (h.label) {
    case 'Recall Knowledge': return /Recall Knowledge\b[^\n]*\bDC\s*\d/.test(raw.flavor ?? '') ? (raw.flavor.match(/Recall Knowledge[^\n]*/)?.[0] ?? null) : null
    case 'Perception': return raw.perception ?? null
    case 'Languages': return nonEmpty(raw.languages?.languages) || nonEmpty(raw.languages?.abilities) ? raw.languages : null
    case 'Skills': return nonEmpty(raw.skills) ? raw.skills : null
    case 'Ability Modifiers': return nonEmpty(raw.abilityMods) ? raw.abilityMods : null
    case 'Items': return nonEmpty(raw.items) ? raw.items : null
    case 'AC': return zeroIsAbsent(d.ac)
    case 'Fort': return zeroIsAbsent(d.savingThrows?.fort)
    case 'Ref': return zeroIsAbsent(d.savingThrows?.ref)
    case 'Will': return zeroIsAbsent(d.savingThrows?.will)
    case 'HP': return Array.isArray(d.hp) && d.hp.length && (d.hp[0].hp || !hazard) ? d.hp : null
    case 'Hardness': return d.hardness ?? null
    case 'Immunities': return nonEmpty(d.immunities) ? d.immunities : null
    case 'Resistances': return nonEmpty(d.resistances) ? d.resistances : null
    case 'Weaknesses': return nonEmpty(d.weaknesses) ? d.weaknesses : null
    case 'Speed': return nonEmpty(raw.speed) ? raw.speed : raw.speedNote ? { speedNote: raw.speedNote } : null
    case 'Rituals': return raw.rituals ?? null
    case 'Complexity': return hazard ? raw.complex : null
    case 'Stealth': return hazard && (raw.stealth?.dc != null || (raw.stealth?.bonus != null && inBlob('Stealth'))) ? raw.stealth : (inBlob('Stealth') ? { inDescription: 'Stealth' } : null)
    case 'Description': return hazard && blob.trim() ? blob : null
    case 'Disable': return nonEmpty(raw.disable?.entries) ? raw.disable : (inBlob('Disable') ? { inDescription: 'Disable' } : null)
    case 'Routine': return nonEmpty(raw.routine) ? raw.routine : (inBlob('Routine') ? { inDescription: 'Routine' } : null)
    case 'Reset': return nonEmpty(raw.reset) ? raw.reset : (inBlob('Reset') ? { inDescription: 'Reset' } : null)
    case 'Full Text': return null
  }
  return null
}

/** Whether the adapter's Creature carries the heading. */
function adaptedHas(c, h) {
  const d = c.defenses
  const hd = c.hazardData
  switch (h.kind) {
    case 'strike': return c.attacks.some(a => norm(`${a.range} ${a.name}`) === norm(h.label))
    case 'spells': return c.spellcasting.some(s => norm(s.name) === norm(h.label))
    case 'ability': return c.abilities.some(a => norm(cleanAbilityName(a.name)) === norm(h.label))
  }
  switch (h.label) {
    case 'Recall Knowledge': return !c.isHazard && !!(c.recallKnowledge || /Recall Knowledge/.test(c.flavor ?? ''))
    case 'Perception': case 'Ability Modifiers': return !c.isHazard
    case 'Languages': return c.languages.length > 0
    case 'Skills': return Object.keys(c.skills).length > 0
    case 'Items': return c.items.length > 0
    case 'AC': return !!d.ac || !c.isHazard
    case 'Fort': return d.fort !== undefined
    case 'Ref': return d.ref !== undefined
    case 'Will': return d.will !== undefined
    case 'HP': return d.hp > 0 || !c.isHazard
    case 'Hardness': return d.hardness !== undefined
    case 'Immunities': return d.immunities.length > 0
    case 'Resistances': return d.resistances.length > 0
    case 'Weaknesses': return d.weaknesses.length > 0
    case 'Speed': return Object.values(c.speed ?? {}).some(Boolean)
    case 'Rituals': return !!c.rituals
    case 'Complexity': return !!hd
    case 'Stealth': return !!hd?.stealth
    case 'Description': return !!hd?.description
    case 'Disable': return !!hd?.disable
    case 'Routine': return !!hd?.routine
    case 'Reset': return !!hd?.reset
  }
  return false
}

// Why StatBlock hides something the adapter passed it (contract section 4).
function renderNote(c, h, extra = false) {
  if (extra && c.isHazard && ['Fort', 'Ref', 'Will'].includes(h.label)) return 'renderer: hazard saves render all three once any is non-zero, so a save the page does not print shows as +0'
  if (c.isHazard && h.label === 'AC') return 'renderer: StatBlock pushes the AC cube only for non-hazards (StatBlock.tsx L1181); parseHazard fills defenses.ac'
  if (c.isHazard && ['Fort', 'Ref', 'Will'].includes(h.label)) return 'renderer: hazard saves render only when fort, ref or will is non-zero, all three together'
  if (h.label === 'Speed') return 'renderer: a speed of 0 is falsy and the Speed cube needs one truthy mode'
  if (h.label === 'Recall Knowledge') return 'renderer: StatBlock computes a Recall Knowledge DC from level, rarity and traits when the page prints none'
  if (h.label === 'Full Text') return 'renderer: raw-markdown fallback fires when there are no attacks and every ability body is empty'
  return 'renderer: the adapter passed it and StatBlock did not show it'
}

// ── 5. compare ────────────────────────────────────────────────────────────────────────────────────
function lis(seq) {
  // Longest increasing subsequence of rendered indexes (seq sorted by page order); returns kept positions.
  // Ties keep the earliest page headings, so the later one of a swapped pair is the one reported.
  const n = seq.length, len = Array(n).fill(1), prev = Array(n).fill(-1)
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j }
  let best = -1
  for (let i = 0; i < n; i++) if (best < 0 || len[i] > len[best]) best = i
  const keep = new Set()
  for (let i = best; i >= 0; i = prev[i]) keep.add(i)
  return keep
}

// A later HP pool that carries a part's own stat row ("**HP** 36 (head), …; **Immunities** area damage",
// a second form's "AC 42; Fort +32…"): the record keeps that row on the pool it describes.
function partPool(rec, label) {
  const re = { Weaknesses: /\bWeakness(es)?\b/, Resistances: /\bResistances?\b/, Immunities: /\bImmunit(y|ies)\b/ }[label] ?? new RegExp(`\\b${label}\\b`)
  return (rec.defenses?.hp ?? []).slice(1).find(p => re.test(p.name ?? '')) ?? null
}
const partNote = (label, part) => `adapter: the page's second ${label} row belongs to a part; the record keeps it on that HP pool ("${part.name}"), and parseCreature/parseHazard keep only the first HP pool (defenses.hp[0])`
const stats = { optionLines: 0, unboldedHeaders: 0, explainedByUnparsed: 0 }

function compare(rec, file, hazard) {
  const id = rec._aon?.id ?? `${file}#${rec.name}`
  const rows = []
  const row = (heading, verdict, expected, rendered, json, note) =>
    rows.push({ id, name: rec.name, heading, expected: expected ?? null, rendered: rendered ?? null, json: cut(json) ?? null, verdict, note: note ?? '' })

  const page = pageHeadings(rec._aon?.markdown ?? '', { hazard, name: rec.name })
  const c = hazard ? SB.parseHazard(rec) : SB.parseCreature(rec, file)
  let html
  try { html = renderRecord(c) } catch (e) {
    row('(render)', 'render', null, null, null, `renderer threw: ${e.message}`)
    return { rows, html: '' }
  }
  const got = renderedHeadings(html)

  // traits: compared as a set (the record order is the Foundry order, not the page's)
  const pt = new Set(page.traits.map(norm)), rt = new Set(got.traits.map(norm)), jt = new Set((rec.traits ?? []).map(norm))
  for (const t of page.traits) if (!rt.has(norm(t))) {
    row(`Trait ${t}`, jt.has(norm(t)) ? 'render' : 'parse', t, null, rec.traits, jt.has(norm(t)) ? 'renderer: trait on the record but no pill' : 'record traits lack it')
  }
  for (const t of got.traits) if (!pt.has(norm(t))) {
    row(`Trait ${t}`, jt.has(norm(t)) ? 'parse' : 'adapter', null, t, rec.traits, 'the page does not print this trait')
  }

  // headings: match by key, in order, with multiplicity
  const exp = page.headings.map(h => ({ ...h, key: keyOf(h) }))
  const seenKey = {}
  for (const e of exp) e.occ = (seenKey[e.key] = (seenKey[e.key] ?? -1) + 1)
  const ren = got.headings.map(h => ({ ...h, key: keyOf(h) }))
  const used = new Set()
  for (const e of exp) {
    const j = ren.findIndex((r, k) => !used.has(k) && r.key === e.key)
    if (j >= 0) { used.add(j); e.r = j }
  }
  // same name, different kind ("Signature Spells" kept as an ability, "Champion Focus Spell" as a spell block):
  // the heading is shown, so it matches
  for (const e of exp) {
    if (e.r !== undefined) continue
    if (e.kind === 'stat') continue
    const j = ren.findIndex((r, k) => !used.has(k) && r.kind !== 'stat' && norm(r.label) === norm(e.label))
    if (j >= 0) { used.add(j); e.r = j }
  }
  const missing = exp.filter(e => e.r === undefined)
  const extra = ren.map((r, k) => ({ ...r, k })).filter(r => !used.has(r.k))

  // merged: one rendered heading carries two missing page headings
  const mergedAway = new Set()
  for (const x of extra) {
    const parts = missing.filter(m => !mergedAway.has(m) && m.kind === x.kind && norm(x.label).includes(norm(m.label)))
    if (parts.length >= 2) {
      for (const p of parts) mergedAway.add(p)
      x.done = true
      const inRaw = rawValue(rec, x, hazard, { extra: true })
      row(x.label, 'merged', parts.map(p => p.label).join(' + '), x.label, inRaw,
        inRaw ? 'the record already carries them as one entry' : 'the adapter joined them')
    }
  }
  // renamed: a missing page heading and an extra rendered one of the same kind, one name a prefix of the other
  for (const m of missing) {
    if (mergedAway.has(m) || m.kind === 'stat') continue
    const a = norm(m.label), b = x => norm(x.label)
    const strikeTail = x => m.kind === 'strike' && a.split(' ')[0] === b(x).split(' ')[0] && b(x).endsWith(a.split(' ').slice(1).join(' '))
    const x = extra.find(x => !x.done && x.kind === m.kind && (b(x).startsWith(a) || a.startsWith(b(x)) || strikeTail(x)))
    if (!x) continue
    x.done = true; mergedAway.add(m)
    const inRaw = rawValue(rec, x, hazard, { extra: true })
    row(m.label, inRaw ? 'parse' : 'adapter', m.label, x.label, inRaw, `rendered under a different name: "${x.label}"`)
  }

  for (const m of missing) {
    if (mergedAway.has(m)) continue
    if (m.kind === 'stat' && m.occ > 0) {
      // the page prints this stat again (a second HP pool, a second form's AC, "Web Hardness" after
      // "Door Hardness"); the record has one slot for it, except HP, which keeps every pool
      const pools = m.label === 'HP' ? (rec.defenses?.hp ?? []) : []
      const part = partPool(rec, m.label)
      if (pools.length > m.occ) row(m.label, 'adapter', `${m.label} #${m.occ + 1}`, null, pools[m.occ],
        'adapter: parseCreature/parseHazard keep only the first HP pool (defenses.hp[0])')
      else if (part) row(m.label, 'adapter', `${m.label} #${m.occ + 1}`, null, part, partNote(m.label, part))
      else row(m.label, 'parse', `${m.label} #${m.occ + 1}`, null, null, `the page prints ${m.label} ${m.occ + 1} times; the record holds one`)
      continue
    }
    const raw = rawValue(rec, m, hazard)
    if (raw == null || raw === false && m.label !== 'Complexity') {
      // folded into the entry before it on the page?
      const i = exp.indexOf(m)
      const prev = exp.slice(0, i).reverse().find(p => rawValue(rec, p, hazard) != null)
      const prevRaw = prev && rawValue(rec, prev, hazard)
      const prevBody = prev?.kind === 'ability' ? flatText([prevRaw.trigger, prevRaw.entries]) : ''
      const esc = m.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const part = m.kind === 'stat' && partPool(rec, m.label)
      if (m.kind === 'ability' && new RegExp(`(^|\\n|[.!?:]\\s+)(?:•\\s*)?${esc}(?=[\\s.:;,]|$)`, 'i').test(prevBody)) {
        // the page's bold option label ("**Ally** …" under Angry Rant, "… again. **Air** tailwind, …" under
        // All Made One) opens a line or a sentence of the ability that lists it
        stats.optionLines++
      } else if (part) {
        row(m.label, 'adapter', m.label, null, part, partNote(m.label, part))
      } else if (m.kind === 'ability' && new RegExp(`(^|[\\s.;])${esc}\\b`).test(prevBody)) {
        row(m.label, 'merged', m.label, null, prevRaw, `the record folds it into "${prev.label}"`)
      } else {
        row(m.label, 'parse', m.label, null, null, 'the record does not carry it')
      }
    } else if (!adaptedHas(c, m)) {
      let note = 'adapter: parseCreature/parseHazard dropped it'
      if (!hazard && m.label === 'Hardness') note = 'adapter: parseCreature builds creature Defenses without hardness (parseCreature.ts L254-264)'
      else if (m.label === 'Languages') note = 'adapter: parseCreature keeps only languages.languages; languages.abilities is dropped (parseCreature.ts L281)'
      else if (hazard && raw?.inDescription) note = 'adapter: parseHazard reads this from the description text and did not find it'
      row(m.label, 'adapter', m.label, null, raw, note)
    } else {
      row(m.label, 'render', m.label, null, raw, renderNote(c, m))
    }
  }

  for (const x of extra) {
    if (x.done) continue
    const raw = rawValue(rec, x, hazard, { extra: true })
    if (hazard && ['Fort', 'Ref', 'Will'].includes(x.label) && (raw == null)) {
      row(x.label, 'render', null, x.label, rec.defenses?.savingThrows?.[x.label.toLowerCase()] ?? null, renderNote(c, x, true))
    } else if (x.label === 'Description' && hazard) {
      row(x.label, 'adapter', null, x.label, cut(raw), 'adapter: parseHazard falls back to the whole description text when it parses no flavor paragraph')
    } else if (raw != null && raw !== false && x.kind === 'ability' && printsUnboldedHeader(rec._aon?.markdown, cleanAbilityName(x.label), { hazard, name: rec.name })) {
      stats.unboldedHeaders++                    // the page prints it at the start of a line without bold
    } else if (raw != null && raw !== false) {
      const k = norm(x.label)
      const where = page.asides.some(a => norm(a) === k) ? 'the page prints it in a sidebar (<aside>), not the stat block; the record made it an entry'
        : page.listOptions.some(a => norm(a) === k) ? 'the page prints it as a list option inside another entry; the record made it a separate entry'
        : x.kind === 'stat' ? 'the record carries a value the page does not print'
        : 'the record carries a heading the page does not print as a bold entry label'
      row(x.label, 'parse', null, x.label, raw, where)
    } else if (adaptedHas(c, x) && x.label !== 'Recall Knowledge') {
      const note = x.label === 'Stealth' ? "adapter: parseHazard defaults stealth to '—', so the row always renders"
        : x.kind === 'ability' ? 'adapter: splitMergedAbility / the hazard prose parser produced an entry the record does not have'
        : 'adapter: parseCreature/parseHazard produced a heading the record does not have'
      row(x.label, 'adapter', null, x.label, raw, note)
    } else {
      row(x.label, 'render', null, x.label, raw, renderNote(c, x, true))
    }
  }

  // languages.abilities: a heading-level match can still lose half the row
  if (!hazard && nonEmpty(rec.languages?.abilities) && exp.some(e => e.label === 'Languages' && e.r !== undefined)) {
    const lost = rec.languages.abilities.filter(a => !norm(got.languagesText).includes(norm(String(a).replace(/[{}@]|\b(spell|trait)\s/g, ''))))
    if (lost.length) row('Languages', 'adapter', 'Languages', 'Languages', rec.languages,
      `adapter: languages.abilities dropped (${lost.join(', ')}); parseCreature keeps only languages.languages (parseCreature.ts L281)`)
  }

  // constant spells: the record keys them "constant-N"; parseCreature reads only a nested entry.constant
  if (!hazard) for (const sc of rec.spellcasting ?? []) {
    const keys = Object.keys(sc.entry ?? {}).filter(k => /^constant-/.test(k))
    const block = c.spellcasting.find(b => norm(b.name) === norm(sc.name))
    const shown = block?.spellsByLevel.some(s => s.isConstant)
    if (keys.length && !shown) row(sc.name, 'adapter', `${sc.name} (${keys.join(', ')})`, sc.name, Object.fromEntries(keys.map(k => [k, sc.entry[k]])),
      'adapter: constant spells dropped; the record keys them "constant-N" and parseCreature reads only a nested entry.constant (parseCreature.ts L195), so parseInt("constant-N") is NaN and the rank is skipped')
  }

  // order
  const matched = exp.filter(e => e.r !== undefined)
  const displaced = []
  for (const [kinds, label] of [[k => k !== 'ability', 'non-ability'], [k => k === 'ability', 'ability']]) {
    const seq = matched.filter(e => kinds(e.kind) && e.label !== 'Speed')
    const keep = lis(seq.map(e => e.r))
    seq.forEach((e, i) => {
      if (keep.has(i)) return
      const pagePrev = exp[exp.indexOf(e) - 1]
      const renPrev = ren[e.r - 1]
      row(e.label, 'order', `after ${pagePrev?.label ?? '(start)'}`, `after ${renPrev?.label ?? '(start)'}`, rawValue(rec, e, hazard),
        label === 'ability' ? 'abilities render in record order' : 'renderer: fixed section order differs from the page')
    })
  }
  // Speed: the page prints it first in the bottom section; StatBlock draws it as a cube in the Defense strip.
  const sp = matched.find(e => e.label === 'Speed')
  if (sp) {
    const before = matched.filter(e => e !== sp && e.kind === 'stat' && exp.indexOf(e) < exp.indexOf(sp) && e.r > sp.r)
    if (before.length) row('Speed', 'order', `after ${before.map(b => b.label).join(', ')}`, `before ${before.map(b => b.label).join(', ')}`, rec.speed,
      'renderer: Speed is drawn as a cube in the Defense strip, ahead of HP and IWR; the page prints it at the top of the bottom section')
  }
  // top/mid abilities: the adapter flattens top/mid/bot, so they all render after Attacks/Spellcasting/Rituals
  if (!hazard) {
    const firstBlock = ren.findIndex(r => r.kind === 'strike' || r.kind === 'spells' || r.label === 'Rituals')
    for (const e of matched) {
      if (e.kind !== 'ability') continue
      const slot = e.slot                                  // the page's section, not the record's
      if ((slot === 'top' || slot === 'mid') && firstBlock >= 0 && e.r > firstBlock) displaced.push(`${e.label} (${slot})`)
    }
    if (displaced.length) row('Ability placement', 'adapter', 'top/mid abilities in their sections', 'after Attacks/Spellcasting/Rituals', displaced,
      'adapter: parseCreature flattens abilities.top/mid/bot into one list (parseCreature.ts L178), so StatBlock renders them all under Abilities & Actions')
  }
  return { rows, html }
}

// ── 6. run ────────────────────────────────────────────────────────────────────────────────────────
const t0 = Date.now()
const records = []
const bdir = join(DATA, 'bestiary')
for (const f of readdirSync(bdir).filter(f => f.endsWith('.json')).sort()) {
  const j = JSON.parse(readFileSync(join(bdir, f), 'utf8'))
  for (const rec of j.creature ?? []) records.push({ rec, file: f, hazard: false })
}
const hz = JSON.parse(readFileSync(join(DATA, 'hazards.json'), 'utf8'))
for (const rec of hz.hazard ?? []) records.push({ rec, file: 'hazards.json', hazard: true })

let todo = ONLY ? records.filter(r => ONLY.has(r.rec._aon?.id) || ONLY.has(r.rec.name)) : records
if (LIMIT) todo = todo.slice(0, LIMIT)

const origError = console.error
console.error = (...a) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) origError(...a) }
const allRows = []
let clean = 0
if (HTML_DIR) mkdirSync(HTML_DIR, { recursive: true })
for (const { rec, file, hazard } of todo) {
  const { rows, html } = compare(rec, file, hazard)
  if (HTML_DIR) writeFileSync(join(HTML_DIR, `${rec._aon?.id ?? rec.name}.html`), html)
  if (!rows.length) clean++
  allRows.push(...rows)
}
console.error = origError

// A parse or merged row the record parser already reported as page content with no home: say so in the
// note, so every surviving row either names its unparsed row or stands as a parser defect.
const UNPARSED = join(ROOT, 'report', 'unparsed.json')
if (existsSync(UNPARSED)) {
  const byId = new Map()
  for (const u of JSON.parse(readFileSync(UNPARSED, 'utf8')).rows) {
    if (!byId.has(u.id)) byId.set(u.id, [])
    byId.get(u.id).push(u)
  }
  for (const r of allRows) {
    if (r.verdict !== 'parse' && r.verdict !== 'merged') continue
    const h = norm(String(r.expected ?? r.heading).replace(/ #\d+$/, ''))
    const bare = h.replace(/^(melee|ranged) /, '')
    const u = (byId.get(r.id) ?? []).find(u => !u.used && (() => {
      const uh = norm(u.heading), ul = norm(u.line)
      return (uh && (uh === h || uh === bare || uh.endsWith(' ' + h))) || (bare.length > 2 && ul.includes(bare))
    })())
    if (u) u.used = true
    if (u) { r.note = `${r.note}; page oddity, reported in report/unparsed.json: "${u.reason}"`; r.unparsed = u.reason; stats.explainedByUnparsed++ }
  }
}

const byVerdict = {}
for (const r of allRows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1
const topHeadings = {}
for (const v of Object.keys(byVerdict).sort()) {
  const n = {}
  for (const r of allRows) if (r.verdict === v) {
    const h = r.heading.startsWith('Trait ') ? 'Trait *' : r.heading
    n[h] = (n[h] ?? 0) + 1
  }
  topHeadings[v] = Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([heading, rows]) => ({ heading, rows }))
}
const summary = {
  records: todo.length, clean, withRows: todo.length - clean, rows: allRows.length,
  byVerdict: Object.fromEntries(Object.entries(byVerdict).sort()), topHeadings,
  // page headings matched without a row: a bold option label kept as a line of the ability that lists it,
  // and a record ability the page prints unbolded at the start of a line (the oracle cannot list those)
  matchedWithoutRow: { optionLines: stats.optionLines, unboldedHeaders: stats.unboldedHeaders },
  parseOrMergedExplainedByUnparsed: stats.explainedByUnparsed,
  data: DATA.startsWith(ROOT) ? DATA.slice(ROOT.length + 1) : DATA,
  vendor: readFileSync(join(ROOT, 'vendor', 'PIN.md'), 'utf8').match(/Source: Heroes-Heaven `([0-9a-f]+)`/)?.[1] ?? null,
  scope: 'StatBlock only: name, level, source and rarity line are rendered by CombatantDetail and are not compared; trait pills are compared as a set; BT and ritual DC labels are values, not headings.',
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ summary, rows: allRows }, null, 1) + '\n')
console.log(`render: ${todo.length} records, ${clean} clean, ${allRows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`)
console.log(JSON.stringify(summary.byVerdict))
