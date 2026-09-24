#!/usr/bin/env node
// Stage 4, the sample: fifty creatures shown three ways side by side in SAMPLE.md, so a reader can check
// the corpus against the Archives by eye instead of trusting the gates.
//
//   node scripts/sample.mjs [--data <dir>] [--out <file>]
//
// For each creature:
//   (a) the stat block AS THE APP RENDERS IT: the record adapted by the tracker's own parseCreature and
//       rendered by its StatBlock (vendored, scripts/lib/render-core.mjs, the same bundle as the render
//       check), read back from the DOM as ordered "Heading: value" lines;
//   (b) THE WORDING OF THE ARCHIVES PAGE: the record's _aon.markdown from its second <title> onward,
//       links unwrapped, tags removed, <actions> tags shown as glyphs, one entry per line;
//   (c) what differs: the report/render.json rows for the id, then a word-level comparison of (a) and (b).
//
// Selection is deterministic (no randomness): creatures are ordered by sha256(_aon.id), and a greedy pass
// over that order takes the first creature that satisfies each coverage requirement, then fills the level
// bands evenly, preferring a source file and printing not yet sampled. The run fails (exit 1) when the
// fifty do not cover every requirement, so the sample can never quietly lose a category.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStatBlock, loadRecords, renderThroughApp, GLYPH_BACK } from './lib/render-core.mjs'
import { unlink, actionStringToActivity, activityGlyph } from './lib/text.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const DATA = resolve(opt('--data', join(ROOT, 'data')))
const OUT = resolve(opt('--out', join(ROOT, 'SAMPLE.md')))
const RENDER_JSON = join(ROOT, 'report', 'render.json')
const CACHE = join(ROOT, 'cache', 'aon', 'creature.jsonl')
const N = 50
const MAX_BYTES = 1.5 * 1024 * 1024

// ── 1. the pool, with the facts selection needs ─────────────────────────────────────────────────────
if (!existsSync(CACHE)) { console.error(`sample: ${CACHE} is missing (run npm run fetch)`); process.exit(1) }
if (!existsSync(RENDER_JSON)) { console.error(`sample: ${RENDER_JSON} is missing (run npm run render)`); process.exit(1) }
const docs = new Map()
for (const l of readFileSync(CACHE, 'utf8').split('\n')) {
  if (!l) continue
  const d = JSON.parse(l)
  docs.set(d.id, { release_date: d.release_date, alignment: d.alignment, legacy_id: d.legacy_id, remaster_id: d.remaster_id })
}
const renderRows = new Map()
for (const r of JSON.parse(readFileSync(RENDER_JSON, 'utf8')).rows) {
  if (!renderRows.has(r.id)) renderRows.set(r.id, [])
  renderRows.get(r.id).push(r)
}

const BANDS = [[-1, 0], [1, 3], [4, 6], [7, 9], [10, 12], [13, 15], [16, 18], [19, 21], [22, 25]]
const bandOf = lvl => BANDS.findIndex(([lo, hi]) => lvl >= lo && lvl <= hi)
const bandName = i => `${BANDS[i][0]}..${BANDS[i][1]}`

// Printing: a document that names a legacy twin is a remaster printing and one that names a remaster twin
// is legacy; otherwise a page released on/after Player Core (2023-11-15) that prints no alignment is a
// remaster printing, and everything else is legacy (legacy stat blocks carry an alignment trait).
function printing(doc) {
  if (!doc) return 'unknown'
  if (doc.legacy_id) return 'remaster'
  if (doc.remaster_id) return 'legacy'
  return doc.release_date >= '2023-11-15' && !doc.alignment ? 'remaster' : 'legacy'
}

const hasPipeTable = rec => /(^|\n)\s*\|.*\|/.test(JSON.stringify({ ...rec, _aon: undefined }).replace(/\\n/g, '\n').replace(/"/g, '\n'))
const FEATURES = [
  ['prepared', 'prepared spellcaster', 1, r => r.spellcasting.some(s => s.type === 'Prepared')],
  ['spontaneous', 'spontaneous spellcaster', 1, r => r.spellcasting.some(s => s.type === 'Spontaneous')],
  ['innate-constant', 'innate spells with a constant rank', 1, r => r.spellcasting.some(s => s.type === 'Innate' && Object.keys(s.entry ?? {}).some(k => k.startsWith('constant')))],
  ['focus', 'focus spells', 1, r => r.spellcasting.some(s => s.type === 'Focus')],
  ['rituals', 'rituals', 1, r => !!r.rituals],
  ['multi-hp', 'more than one HP pool', 2, r => (r.defenses?.hp?.length ?? 0) > 1],
  ['troop', 'troop', 2, r => (r.traits ?? []).includes('Troop')],
  ['pipe-table', 'pipe table in the record', 3, hasPipeTable],
  ['legacy', 'legacy printing', 1, r => r._printing === 'legacy'],
  ['remaster', 'remaster printing', 1, r => r._printing === 'remaster'],
]

const hash = s => createHash('sha256').update(s).digest('hex')
const all = loadRecords(DATA).filter(r => !r.hazard)
const seenIds = new Set()
const pool = []
for (const r of all) {
  const id = r.rec._aon?.id
  if (!id || seenIds.has(id)) continue                // one entry per Archives document
  seenIds.add(id)
  r.rec._printing = printing(docs.get(id))
  r.band = bandOf(r.rec.level)
  r.h = hash(id)
  if (r.band >= 0) pool.push(r)
}
pool.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))

// ── 2. deterministic greedy selection ───────────────────────────────────────────────────────────────
const chosen = []
const chosenIds = new Set()
const usedFiles = new Set()
const bandCount = Array(BANDS.length).fill(0)
const printCount = { legacy: 0, remaster: 0, unknown: 0 }
const why = new Map()
function take(r, reason) {
  chosen.push(r); chosenIds.add(r.rec._aon.id); usedFiles.add(r.file); bandCount[r.band]++; printCount[r.rec._printing]++
  why.set(r.rec._aon.id, reason)
}
// Preference among candidates satisfying a predicate: a new source file, then the least-filled band,
// then hash order.
function best(cands) {
  let b = null, bk = null
  for (const r of cands) {
    const k = [usedFiles.has(r.file) ? 1 : 0, bandCount[r.band], r.h]
    if (!b || k[0] < bk[0] || (k[0] === bk[0] && (k[1] < bk[1] || (k[1] === bk[1] && k[2] < bk[2])))) { b = r; bk = k }
  }
  return b
}
for (const [key, , count, pred] of FEATURES) {
  let have = chosen.filter(r => pred(r.rec)).length
  while (have < count) {
    const r = best(pool.filter(r => !chosenIds.has(r.rec._aon.id) && pred(r.rec)))
    if (!r) break
    take(r, `coverage: ${key}`); have++
  }
}
// Fill: the least-filled band first (ties: the lower band), alternating printings, new source files first.
while (chosen.length < N) {
  const band = bandCount.indexOf(Math.min(...bandCount))
  const wantPrint = printCount.legacy <= printCount.remaster ? 'legacy' : 'remaster'
  const inBand = pool.filter(r => !chosenIds.has(r.rec._aon.id) && r.band === band)
  const r = best(inBand.filter(r => r.rec._printing === wantPrint)) ?? best(inBand)
  if (!r) { bandCount[band] = Infinity; continue }
  take(r, `fill: level band ${bandName(band)}`)
}

// Coverage check: fail loudly rather than publish a sample that misses a category.
const failures = []
for (let i = 0; i < BANDS.length; i++) if (!chosen.some(r => r.band === i)) failures.push(`level band ${bandName(i)}`)
const files = new Set(chosen.map(r => r.file))
if (files.size < 25) failures.push(`only ${files.size} source files`)
for (const [key, , count, pred] of FEATURES) {
  const n = chosen.filter(r => pred(r.rec)).length
  if (n < count) failures.push(`${key}: ${n} < ${count}`)
}
if (failures.length) { console.error(`sample: coverage not met: ${failures.join('; ')}`); process.exit(1) }
// Present in level order (then name, then id) so the file reads from weakest to strongest.
chosen.sort((a, b) => a.rec.level - b.rec.level || a.rec.name.localeCompare(b.rec.name) || a.rec._aon.id.localeCompare(b.rec._aon.id))

// ── 3. (a) the app's rendering, read back from the DOM as lines ─────────────────────────────────────
const core = await loadStatBlock(ROOT)
const { host } = core

// Reading text back from static markup: adjacent inline spans carry no whitespace between them, and a
// word may be split over two spans ("ear-" + a glossary link "piercing"), so text nodes are joined as the
// browser would lay them out: raw inside inline runs, with a space around each block element, each flex,
// inline-flex or grid item, and each action glyph.
const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'TD', 'TH', 'TABLE', 'TBODY', 'THEAD', 'TR'])
// classes StatBlock lays out as flex rows from its stylesheet rather than an inline style
const PADDED = ['pf2-action-glyph', 'spell-rank-head', 'spell-rank-label', 'atwill', 'spell-srows', 'spell-list', 'def-box']
const isFlex = el => /display:\s*(inline-)?(flex|grid)/.test(el?.getAttribute?.('style') || '') || /\bgrid\b/.test(el?.className || '')
function spaced(el) {
  const parts = []
  const walk = n => {
    if (n.nodeType === 3) { parts.push(n.nodeValue); return }
    if (n.nodeType !== 1) return
    if (n.tagName === 'TR') { parts.push('\n| ' + [...n.children].map(c => spaced(c)).join(' | ') + ' |\n'); return }
    if (n.tagName === 'BR') { parts.push('\n'); return }
    const pad = BLOCK.has(n.tagName) || /margin-(left|right)|padding-(left|right)/.test(n.getAttribute('style') || '') || isFlex(n.parentElement) || PADDED.some(c => n.classList.contains(c)) || PADDED.some(c => n.parentElement?.classList.contains(c))
    if (pad) parts.push(' ')
    for (const c of n.childNodes) walk(c)
    if (pad) parts.push(' ')
  }
  walk(el)
  return parts.join('')
    .split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').replace(/ ([,;:.)\]])/g, '$1').replace(/([(\[]) /g, '$1').trim()).filter(Boolean).join('\n')
}

/** Lines of an ability body: each block element its own line (recursively), a run of inline nodes one
 *  line, table rows one line each. */
function bodyLines(el) {
  const out = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const frag = el.ownerDocument.createElement('span')
    for (const n of run) frag.appendChild(n.cloneNode(true))
    for (const l of spaced(frag).split('\n')) if (l) out.push(l)
    run = []
  }
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && (n.tagName === 'TABLE')) { flush(); for (const l of spaced(n).split('\n')) if (l) out.push(l) }
    else if (n.nodeType === 1 && BLOCK.has(n.tagName)) { flush(); out.push(...bodyLines(n)) }
    else run.push(n)
  }
  flush()
  return out
}

function renderedLines(html) {
  host.innerHTML = html
  for (const el of host.querySelectorAll('button')) el.remove()
  for (const el of host.querySelectorAll('.pf2-action-glyph')) el.textContent = GLYPH_BACK[el.textContent] ?? el.textContent
  const root = host.querySelector('.stat-block')
  const lines = []                                     // { text, chrome }
  const push = (t, chrome = false) => lines.push({ text: t, chrome })
  let section = ''
  const visit = el => {
    const cls = el.classList
    const style = el.getAttribute('style') || ''
    if (cls.contains('stat-bar')) {
      section = spaced(el.firstElementChild?.tagName === 'SPAN' ? el.firstElementChild : el)
      push(`== ${section} ==`, true)
      return
    }
    if (!cls.length && /padding:12px 24px 10px/.test(style)) {
      push(`Traits: ${[...el.children].map(p => spaced(p)).join(' · ')}`)
      return
    }
    if (cls.contains('def-strip')) {
      for (const box of el.querySelectorAll('.def-box')) push(`${spaced(box.querySelector('.def-box-label'))}: ${spaced(box.querySelector('.def-box-val'))}`)
      return
    }
    if (cls.contains('stat-line')) {
      if (section === 'Attacks') {
        const t = spaced(el)
        const range = spaced(el.querySelector('.stat-label'))
        push(t.startsWith(range) ? `${range.charAt(0).toUpperCase()}${range.slice(1)}:${t.slice(range.length)}` : t)
        return
      }
      if (section === 'Spellcasting') {
        const [head, sub] = el.children
        for (const pp of head?.querySelectorAll('.spell-pips') ?? []) {           // focus-point pips
          const n = pp.querySelectorAll('.spell-pip').length
          pp.textContent = ` ${n} pip${n === 1 ? '' : 's'} `
        }
        push(`${spaced(head)}: ${sub && !sub.classList.contains('spell-ranks') ? spaced(sub) : ''}`.trim())
        for (const rank of el.querySelectorAll('.spell-rank')) {
          const label = spaced(rank.querySelector('.spell-rank-head'))
          const names = []
          const list = rank.querySelector('.spell-list, .spell-srows')
          if (list?.classList.contains('spell-list')) {
            for (const s of list.children) names.push(spaced(s).replace(/\s*·$/, ''))
          } else if (list) {
            for (const s of list.children) {
              if (s.classList.contains('spell-srow-name')) names.push(spaced(s))
              else if (s.classList.contains('spell-pips')) {
                const t = s.getAttribute('title') || ''
                const n = +(t.match(/^(\d+) uses?$/)?.[1] ?? 0)
                if (n > 1 && names.length) names[names.length - 1] += ` (×${n})`          // N pips, written as the page writes it
                else if (!n && t && names.length) names[names.length - 1] += ` [${t}]`
              } else if (spaced(s)) names.push(spaced(s))
            }
          } else {
            names.push(spaced(rank).slice(label.length).trim())
          }
          push(`  ${label}: ${names.join(', ')}`)
        }
        return
      }
      if (section === 'Abilities & Actions') {
        const head = el.firstElementChild
        const body = [...el.children].slice(1).flatMap(c => bodyLines(c))
        push(`${spaced(head)}:${body.length ? ' ' + body[0] : ''}`)
        for (const l of body.slice(1)) push(`    ${l}`)
        return
      }
      const ab = [...el.querySelectorAll('.roll-check')].filter(r => /^(str|dex|con|int|wis|cha)\b/i.test(spaced(r)))
      if (ab.length && ab.length === el.querySelectorAll('.roll-check').length) {
        push(ab.map(r => spaced(r).replace(/^\w/, c => c.toUpperCase())).join(', '))       // the app prints no heading on this row
        return
      }
      const t = spaced(el)
      const label = spaced(el.querySelector('.stat-label'))
      for (const [i, l] of t.split('\n').entries()) {
        if (section === 'Rituals' && i === 0) push(`Rituals: ${l}`)                       // the bar is its heading
        else if (i === 0 && label && l.startsWith(label)) push(`${label}:${l.slice(label.length)}`)
        else push(i ? `    ${l}` : l)
      }
      return
    }
    if (el.children.length) { for (const c of el.children) visit(c); return }
    const t = spaced(el)
    if (t) push(t)
  }
  if (root) for (const c of root.children) visit(c)
  return lines
}

// ── 4. (b) the Archives page wording ────────────────────────────────────────────────────────────────
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
function pageLines(md) {
  // The stat block's own title (<title level="2" right="Creature N">); a page with none starts at its
  // second <title>. Text a page prints above the stat block title (flavor, Recall Knowledge, a sidebar
  // heading before it) is outside (b).
  let i = md.search(/<title level="2"[^>]*right="(?:Creature|NPC)/)
  if (i < 0) for (let k = 0, from = 0; k < 2; k++) { i = md.indexOf('<title', from); if (i < 0) break; from = i + 1 }
  if (i < 0) return []
  let s = md.slice(i).replace(/\r/g, '')
  s = s.replace(/<document\b[^>]*\/>/g, '')
  s = s.replace(/<title\b([^>]*)>([\s\S]*?)<\/title>/g, (_, attrs, t) => {
    const right = attrs.match(/right="([^"]*)"/)?.[1]
    return `\n\n@@TITLE ${t}${right ? ` — ${right}` : ''}\n\n`
  })
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // An entry starts on a line that opens with a bold label (a strike's "**Damage**" continues its strike);
  // mark it before bold markers are removed.
  s = s.replace(/^[ \t]*(?=(?:\*\*|\[\*\*)(?!Damage\*\*))/gm, '\u0001')
  s = s.replace(/<traits>([\s\S]*?)<\/traits>/g, (_, t) => `\n\nTraits: ${[...t.matchAll(/label="([^"]*)"/g)].map(m => m[1]).join(' · ')}\n\n`)
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_, t) => '\n\n' + [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(r => '| ' + [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].replace(/\s+/g, ' ').trim()).join(' | ') + ' |').join('\n') + '\n\n')
  s = s.replace(/<aside>([\s\S]*?)<\/aside>/g, (_, t) => '\n\n' + t.trim().split(/\n\s*\n/).map(p => {
    const ls = p.split('\n').map(l => l.replace(/\u0001/g, '').trim()).filter(Boolean)
    if (ls.length && ls.every(l => l.startsWith('|'))) return ls.map(l => `[sidebar] ${l}`).join('\n')   // a table: one row per line
    return `[sidebar] ${ls.join(' ').replace(/@@TITLE /g, '# ')}`
  }).join('\n\n') + '\n\n')
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/g, (_, t) => `\n- ${t.replace(/\s+/g, ' ').trim()}\n`).replace(/<\/?[uo]l\b[^>]*>/g, '\n')
  s = s.replace(/<actions\s+string="([^"]*)"\s*\/?>/gi, (_, a) => ` ${activityGlyph(actionStringToActivity(a)) || `[${a}]`} `)
  s = s.replace(/<\/?(?:column|row|sup|b|i|strong|em|span|div|p)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/?[a-z][^>]*>/gi, '')                  // any other tag
  s = unlink(s).replace(/\*\*/g, '').replace(/(^|[\s(])_([^_\n]+)_(?=[\s),.;:]|$)/g, '$1$2')
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENT[m])
  const out = []
  for (const block of s.split(/\n\s*\n/)) {
    let cur = ''
    for (let l of block.split('\n')) {
      const starts = l.includes('\u0001')
      l = l.replace(/\u0001/g, '').replace(/[ \t]+/g, ' ').trim()
      if (!l) continue
      if (/^(\||\[sidebar\]|@@TITLE|Traits:|---$)/.test(l)) { if (cur) out.push(cur); out.push(l); cur = ''; continue }
      if ((starts || /^-\s/.test(l)) && cur) { out.push(cur); cur = '' }        // an entry or a bullet starts a line
      cur = cur ? `${cur} ${l}` : l
    }
    if (cur) out.push(cur)
  }
  return out.map(l => l.replace(/ ([,;:.)])/g, '$1').replace(/\( /g, '('))
}

// ── 5. (c) the word-level comparison ────────────────────────────────────────────────────────────────
// Normalised before comparing, on both sides alike: case, whitespace, curly quotes, surrounding
// punctuation, and the action glyphs (each run of ◆ is one token, as are ◇ and ↺). Nothing else is folded:
// "feet" and "ft" are different words here, because they are different words on the screen.
const GLYPH = /(◆+|◇|↺)/g
function tokens(line) {
  return line.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(GLYPH, ' $1 ')
    .split(/[\s,;:()\[\]{}|·•"]+/)
    .map(t => t.replace(/^[.!?'*_—–-]+(?=[^\d])/, '').replace(/[.!?'*_—–]+$/, ''))
    .filter(t => t && /[\p{L}\p{N}◆◇↺]/u.test(t))
}

/** Match page tokens to app tokens line by line: each page line takes a token first from the app line
 *  that shares the most words with it, then from any app line that still holds it. What is left on
 *  either side is a difference, reported with the line it came from. */
function wordDiff(pageLs, appLs) {
  const P = pageLs.map(l => ({ text: l, toks: tokens(l) }))
  // App entries: a line and the indented lines under it (an ability's Trigger/Effect/Stage lines, a spell
  // block's ranks), so an entry the app splits over several lines is matched as one.
  const A = []
  for (const l of appLs) {
    const line = { text: l, toks: tokens(l) }
    if (/^\s/.test(l) && A.length) A[A.length - 1].lines.push(line)
    else A.push({ lines: [line] })
  }
  for (const a of A) {
    a.bag = new Map()
    for (const ln of a.lines) for (const t of ln.toks) a.bag.set(t, (a.bag.get(t) ?? 0) + 1)
    a.size = a.lines.reduce((n, l) => n + l.toks.length, 0)
  }
  // Two passes over all page lines, the second wider than the first, so a common word ("feet", "+15") is
  // first matched where it belongs: (1) the app entry most similar to the page line (Dice coefficient of
  // the two word bags, so a long entry that happens to share a few words does not win), (2) any app
  // entry at least 30% as similar that shares two or more words. A word the app prints only in an
  // unrelated entry is not a match: the sentence it belongs to is not shown.
  const plan = P.map(p => {
    const want = new Map()
    for (const t of p.toks) want.set(t, (want.get(t) ?? 0) + 1)
    const ranked = A.map((a, i) => {
      let ov = 0
      for (const [t, n] of want) ov += Math.min(n, a.bag.get(t) ?? 0)
      return { a, i, ov, dice: (2 * ov) / (p.toks.length + a.size) }
    }).filter(x => x.ov > 0).sort((x, y) => y.dice - x.dice || x.i - y.i)
    const top = ranked.length ? ranked[0].dice : 0
    return { p, top, got: Array(p.toks.length).fill(false), tiers: [ranked.filter(x => x.dice === top).map(x => x.a), ranked.filter(x => x.ov >= 2 && x.dice >= top * 0.3).map(x => x.a)] }
  })
  // the most confident pairings take their words first (ties in page order)
  const byConfidence = plan.map((x, i) => ({ x, i })).sort((a, b) => b.x.top - a.x.top || a.i - b.i).map(({ x }) => x)
  for (let tier = 0; tier < 2; tier++) for (const { p, got, tiers } of byConfidence) {
    p.toks.forEach((t, k) => {
      if (got[k]) return
      for (const a of tiers[tier]) if ((a.bag.get(t) ?? 0) > 0) {
        a.bag.set(t, a.bag.get(t) - 1); got[k] = true
        p.partners ??= new Set(); p.partners.add(a); (a.partners ??= new Set()).add(p)
        break
      }
    })
  }
  // The counts above decide HOW MANY of each word differ; which occurrence is shown as the difference is
  // decided by aligning the line with the text it was matched against (longest common subsequence), so a
  // repeated word ("1", "the") is blamed where the two texts actually part.
  const mark = (toks, partnerToks, missingCount) => {
    const inLcs = lcsMask(toks, partnerToks)
    const miss = Array(toks.length).fill(false)
    for (const pass of [false, true]) toks.forEach((t, k) => {
      if (miss[k] || inLcs[k] !== pass || !(missingCount.get(t) > 0)) return
      miss[k] = true; missingCount.set(t, missingCount.get(t) - 1)
    })
    return miss
  }
  const count = (toks, flags) => { const m = new Map(); toks.forEach((t, k) => { if (flags[k]) m.set(t, (m.get(t) ?? 0) + 1) }); return m }
  const pageMissing = []
  for (const { p, got } of plan) {
    if (!got.some(g => !g)) continue
    const partnerToks = [...(p.partners ?? [])].sort((x, y) => A.indexOf(x) - A.indexOf(y)).flatMap(a => a.lines.flatMap(l => l.toks))
    pageMissing.push({ line: p.text, toks: p.toks, miss: mark(p.toks, partnerToks, count(p.toks, got.map(g => !g))) })
  }
  const appExtra = []
  for (const a of A) {
    const left = new Map([...a.bag].filter(([, n]) => n > 0))
    if (!left.size) continue
    const all = a.lines.flatMap(l => l.toks)
    const partnerToks = [...(a.partners ?? [])].sort((x, y) => P.indexOf(x) - P.indexOf(y)).flatMap(p => p.toks)
    const miss = mark(all, partnerToks, left)
    let k = 0
    for (const ln of a.lines) {
      const m = miss.slice(k, k + ln.toks.length); k += ln.toks.length
      if (m.some(Boolean)) appExtra.push({ line: ln.text.trim(), toks: ln.toks, miss: m })
    }
  }
  return { pageMissing, appExtra }
}

/** For each token of a, whether it is part of a longest common subsequence with b. */
function lcsMask(a, b) {
  const n = a.length, m = b.length
  const mask = Array(n).fill(false)
  if (!n || !m) return mask
  const W = m + 1
  const L = new Uint16Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { mask[i] = true; i++; j++ }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++
    else j++
  }
  return mask
}

/** Consecutive unmatched tokens of a line as phrases. */
const phrases = ({ toks, miss }) => {
  const out = []
  let cur = []
  toks.forEach((t, k) => { if (miss[k]) cur.push(t); else if (cur.length) { out.push(cur.join(' ')); cur = [] } })
  if (cur.length) out.push(cur.join(' '))
  return out
}
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const code = s => '`' + String(s).replace(/`/g, "'").replace(/\|/g, '\\|') + '`'
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

// ── 6. write SAMPLE.md ──────────────────────────────────────────────────────────────────────────────
const origError = console.error
console.error = (...a) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) origError(...a) }

const fenceFor = body => { let f = '```'; while (body.includes(f)) f += '`'; return f }
const anchor = r => `${r.rec.name}-${r.rec._aon.id}`.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
const entries = []
const totals = { pageOnlyWords: 0, appOnlyWords: 0, rows: {} }
for (const r of chosen) {
  const { rec } = r
  const id = rec._aon.id
  const { html } = renderThroughApp(core, r)
  const app = renderedLines(html)
  const page = pageLines(rec._aon.markdown)
  // Out of StatBlock scope (the entry heading carries them; CombatantDetail renders them in the app):
  // the page's title line and its Source line. Section bars are the app's chrome, not stat-block text.
  const pageCompared = page.filter(l => !l.startsWith('@@TITLE') && !/^Source\b/.test(l)).map(l => l.replace(/^\[sidebar\] /, '\u0002'))
  const appCompared = app.filter(l => !l.chrome).map(l => l.text)
  const { pageMissing, appExtra } = wordDiff(pageCompared, appCompared)
  const rows = renderRows.get(id) ?? []
  const nPage = pageMissing.reduce((n, m) => n + m.miss.filter(Boolean).length, 0)
  const nApp = appExtra.reduce((n, m) => n + m.miss.filter(Boolean).length, 0)
  totals.pageOnlyWords += nPage; totals.appOnlyWords += nApp
  for (const [list, key] of [[pageMissing.filter(m => !m.line.startsWith('\u0002')), 'pageWords'], [appExtra, 'appWords']]) {
    const seen = new Set(list.flatMap(m => m.toks.filter((t, k) => m.miss[k])))
    for (const t of seen) (totals[key] ??= new Map()).set(t, ((totals[key].get(t)) ?? 0) + 1)
  }
  for (const x of rows) totals.rows[x.verdict] = (totals.rows[x.verdict] ?? 0) + 1
  r.summary = { nPage, nApp, rows: rows.length }

  const feats = FEATURES.filter(([, , , p]) => p(rec)).map(([k]) => k)
  const pageRK = unlink(rec._aon.markdown).replace(/\*\*/g, '').match(/Recall Knowledge[^\n]*\n?[^\n]*?DC\s*\d+/)?.[0]?.replace(/\s+/g, ' ')
  const L = []
  L.push(`## ${rec.name} — level ${rec.level}, ${rec.source}${rec.page ? ` pg. ${rec.page}` : ''}`)
  L.push('')
  L.push(`[${rec._aon.url}](${rec._aon.url}) · \`${id}\` · \`data/bestiary/${r.file}\` · ${rec._printing} printing · picked by ${why.get(id)}${feats.length ? ` · covers: ${feats.join(', ')}` : ''}`)
  L.push('')
  const aText = app.map(l => l.text).join('\n')
  const bText = page.map(l => l.replace(/^@@TITLE /, '# ')).join('\n')
  L.push('**(a) As the app renders it** (tracker StatBlock at the pinned commit, read back from the DOM; `== … ==` lines are its section bars)')
  L.push('')
  L.push(fenceFor(aText) + 'text', aText, fenceFor(aText))
  L.push('')
  L.push('**(b) The wording of the Archives page** (`_aon.markdown` from the stat block title; links unwrapped, tags removed, actions as glyphs)')
  L.push('')
  L.push(fenceFor(bText) + 'text', bText, fenceFor(bText))
  L.push('')
  L.push('**(c) What differs**')
  L.push('')
  if (rows.length) {
    L.push(`report/render.json rows for \`${id}\` (${rows.length}):`)
    L.push('')
    L.push('| verdict | heading | expected → rendered | note |')
    L.push('|---|---|---|---|')
    for (const x of rows) L.push(`| ${x.verdict} | ${cell(x.heading)} | ${cell(x.expected ?? '—')} → ${cell(x.rendered ?? '—')} | ${cell(x.note)} |`)
  } else {
    L.push(`report/render.json has no rows for \`${id}\`.`)
  }
  L.push('')
  L.push(`Word-level comparison (case, whitespace, punctuation and glyph form normalised; the page's title and Source lines are out of StatBlock scope): **${nPage}** word(s) on the page not in the app, **${nApp}** in the app not on the page.`)
  L.push('')
  if (pageMissing.length) {
    L.push('On the page, not in the app:')
    L.push('')
    const side = pageMissing.filter(m => m.line.startsWith('\u0002'))
    for (const m of pageMissing) if (!side.includes(m)) L.push(`- ${phrases(m).map(code).join(', ')} — from ${code(clip(m.line))}`)
    if (side.length) {
      const words = side.reduce((n, m) => n + m.miss.filter(Boolean).length, 0)
      const heads = side.filter(m => m.line.startsWith('\u0002# ')).map(m => m.line.slice(3))
      L.push(`- sidebar (\`<aside>\`) text, ${words} word(s) in ${side.length} paragraph(s)${heads.length ? `: ${heads.map(h => `"${h}"`).join(', ')}` : ''}; the record keeps sidebars in \`flavor\`, which StatBlock does not render`)
    }
    L.push('')
  }
  if (appExtra.length) {
    L.push('In the app, not on the page:')
    L.push('')
    for (const m of appExtra) L.push(`- ${phrases(m).map(code).join(', ')} — from ${code(clip(m.line))}`)
    L.push('')
  }
  if (appExtra.some(m => /^Recall Knowledge\b/.test(m.line))) {
    L.push(pageRK ? `The app computes its Recall Knowledge line; the page prints its own above the stat block, outside (b): ${code(pageRK)}.`
      : 'The app computes its Recall Knowledge line; the page prints none.')
    L.push('')
  }
  entries.push({ r, text: L.join('\n') })
}
console.error = origError

const H = []
H.push('# Sample: fifty creatures, as the app renders them and as the Archives prints them')
H.push('')
H.push('Generated by `npm run sample` (`scripts/sample.mjs`, stage 4 of `npm run build`). Do not edit by hand.')
H.push('')
H.push(`**How the fifty were picked.** Deterministically, with no randomness: every creature record (one per Archives document, hazards excluded) is ordered by \`sha256(_aon.id)\`. A greedy pass over that order first takes, for each coverage requirement below, the first creature that meets it, preferring a source file not yet sampled and then the least-filled level band; it then fills the nine level bands evenly (least-filled band first), alternating legacy and remaster printings and again preferring new source files. The script exits 1 if the fifty miss any requirement. Entries are listed in level order.`)
H.push('')
H.push(`**Printing.** A document naming a legacy twin (\`legacy_id\`) is remaster, one naming a remaster twin (\`remaster_id\`) is legacy; otherwise a page released on or after 2023-11-15 that prints no alignment is remaster, anything else legacy.`)
H.push('')
H.push('| requirement | needed | in sample | creatures |')
H.push('|---|---|---|---|')
for (let i = 0; i < BANDS.length; i++) {
  const in_ = chosen.filter(r => r.band === i)
  H.push(`| level ${bandName(i)} | 1 | ${in_.length} | ${in_.map(r => r.rec.name).join(', ')} |`)
}
H.push(`| source files | 25 | ${files.size} | |`)
for (const [key, label, count, pred] of FEATURES) {
  const in_ = chosen.filter(r => pred(r.rec))
  H.push(`| ${label} (\`${key}\`) | ${count} | ${in_.length} | ${in_.map(r => r.rec.name).join(', ')} |`)
}
H.push('')
H.push('**Transcription of (a).** Each line is a heading and its value as the StatBlock shows it: trait pills joined by `·`; one line per defense box; strikes as `Melee: ◆ name +N (traits) Damage …`; each spell block with one indented line per rank, a spell\'s N slot pips written `(×N)` and a block\'s focus-point pips as `N pips`; the ritual line under the Rituals bar headed `Rituals:`; each ability as `Name glyph (traits): first line`, with its further clauses and table rows indented beneath. The ability-modifier row has no heading in the app and gets none here. Buttons (attack and damage rollers, Reset uses) are left out.')
H.push('')
H.push('**Reading an entry.** (a) is what a GM sees: the record through the tracker\'s own `parseCreature` and `StatBlock` (vendored at the commit in `vendor/PIN.md`, the same bundle `npm run render` uses), read back from the rendered DOM. The name, level and source line above the StatBlock are drawn by `CombatantDetail` and are not in (a). (b) is the page text itself. (c) repeats the render check\'s rows for that id, then compares the words of (a) and (b): every word the page prints that the app does not show, and every word the app shows that the page does not print, each with the line it came from. The comparison normalises case, whitespace, curly quotes, punctuation around words and the form of action glyphs, nothing else, so `25 feet` → `25 ft` shows up as a difference, and so do values the app computes (Recall Knowledge) or labels it adds. Order is not compared here: the render check reports it as `order` rows.')
H.push('')
H.push(`**Totals over the fifty.** render.json rows: ${Object.entries(totals.rows).sort().map(([v, n]) => `${v} ${n}`).join(', ') || 'none'}. Words on the page not in the app: ${totals.pageOnlyWords}. Words in the app not on the page: ${totals.appOnlyWords}.`)
H.push('')
const common = m => [...(m ?? new Map())].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${code(t)} ${n}`).join(', ') || 'none'
H.push(`**Words that differ in five or more entries** (number of entries). On the page, not in the app: ${common(totals.pageWords)}. In the app, not on the page: ${common(totals.appWords)}. The recurring ones are the app's own wording: \`Speed\` in \`ft\` where the page prints \`feet\`; a computed Recall Knowledge line; \`rank\` and \`at will\` in spell-rank labels; a \`Saves:\` label on the save note; the uses counter (\`1 /1 1/day\`) beside a limited-use ability; on the page side, an empty \`Languages\` label the page prints for a creature with no language, which the app omits. Everything else in an entry's (c) is specific to that creature. Counts are exact; when a word repeats, which occurrence is shown as the difference is chosen by aligning the two texts and can land one line off.`)
H.push('')
H.push('| # | creature | level | source file | printing | render rows | page-only words | app-only words |')
H.push('|---|---|---|---|---|---|---|---|')
entries.forEach(({ r }, k) => H.push(`| ${k + 1} | [${cell(r.rec.name)}](#${anchor(r)}) | ${r.rec.level} | ${r.file.replace(/^creatures-|\.json$/g, '')} | ${r.rec._printing} | ${r.summary.rows} | ${r.summary.nPage} | ${r.summary.nApp} |`))
H.push('')

// Heading anchors: GitHub derives them from the heading text; give each entry an explicit one too.
const body = entries.map(({ r, text }) => `<a id="${anchor(r)}"></a>\n\n${text}`).join('\n\n---\n\n')
const md = H.join('\n') + '\n---\n\n' + body + '\n'
const bytes = Buffer.byteLength(md)
if (bytes > MAX_BYTES) { console.error(`sample: SAMPLE.md would be ${bytes} bytes, over the ${MAX_BYTES} limit`); process.exit(1) }
writeFileSync(OUT, md)
console.log(`sample: ${chosen.length} creatures, ${files.size} source files, ${bytes} bytes -> ${OUT}`)
