#!/usr/bin/env node
// Recopy the vendored StatBlock import graph from a Heroes-Heaven checkout and check the pin.
//
//   node scripts/vendor-sync.mjs <heroes-heaven-checkout>          copy, failing if any sha1 moved
//   node scripts/vendor-sync.mjs <heroes-heaven-checkout> --check  compare only, copy nothing
//   node scripts/vendor-sync.mjs --verify                          vendored copies vs PIN.md, no checkout
//   node scripts/vendor-sync.mjs <heroes-heaven-checkout> --pin    rewrite PIN.md from the checkout (re-pin)
//
// vendor/PIN.md is the source of truth: its file table lists every copied path and its sha1. The render
// check is only meaningful against the StatBlock it was pinned to, so a moved sha1 is a hard failure, not
// a silent refresh. Re-pinning is a deliberate act (--pin) that rewrites the table and the commit line.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor')
const PIN = join(VENDOR, 'PIN.md')

// The runtime import graph of StatBlock.tsx + parseCreature.ts under tracker/src, with FloatingWindow.tsx
// replaced by a stub (see PIN.md). types/pf2e.ts is type-only but kept so the copies type-check as a set.
const FILES = [
  'components/StatBlock.tsx', 'components/TagRenderer.tsx', 'components/MarkdownTable.tsx',
  'components/TraitTags.tsx', 'components/Tooltip.tsx', 'components/GlossaryTerm.tsx',
  'components/ActionGlyph.tsx', 'components/Icons.tsx', 'components/UsesChip.tsx', 'components/SpellPips.tsx',
  'utils/parseCreature.ts', 'utils/parseHazardText.ts', 'utils/weakElite.ts', 'utils/conditionEffects.ts',
  'utils/tags.ts', 'utils/dice.ts', 'utils/limitedUses.ts', 'utils/searchRank.ts', 'utils/zoomFix.ts',
  'utils/pcDetail.ts', 'utils/themeColors.ts',
  'data/gameDataContext.tsx', 'data/dataStore.ts', 'data/monsterPartsRules.ts', 'data/glossary.ts',
  'store/combatStore.ts', 'store/windowStore.ts', 'store/settingsStore.ts', 'store/customThemesStore.ts',
  'store/partyStore.ts', 'store/dmAverageStore.ts', 'store/persistBus.ts',
  'types/pf2e.ts',
]
const SRC_PREFIX = 'tracker/src/'

const sha1 = buf => createHash('sha1').update(buf).digest('hex')

function readPin() {
  if (!existsSync(PIN)) throw new Error(`${PIN} missing; run with --pin to create it`)
  const rows = []
  for (const line of readFileSync(PIN, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{40})`\s*\|/)
    if (m) rows.push({ src: m[1], dest: m[2], sha1: m[3] })
  }
  if (!rows.length) throw new Error('PIN.md has no file rows')
  return rows
}

function git(checkout, ...args) {
  try { return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim() } catch { return '' }
}

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const checkout = args.find(a => !a.startsWith('--'))

if (flags.has('--verify')) {
  let bad = 0
  for (const r of readPin()) {
    const p = join(ROOT, r.dest)
    const got = existsSync(p) ? sha1(readFileSync(p)) : 'missing'
    if (got !== r.sha1) { bad++; console.error(`MISMATCH ${r.dest}: pinned ${r.sha1}, vendored ${got}`) }
  }
  if (bad) { console.error(`${bad} vendored file(s) differ from PIN.md`); process.exit(1) }
  console.log(`vendor/: all ${readPin().length} files match PIN.md`)
  process.exit(0)
}

if (!checkout) { console.error('usage: vendor-sync.mjs <heroes-heaven-checkout> [--check|--pin] | --verify'); process.exit(2) }

if (flags.has('--pin')) {
  const head = git(checkout, 'rev-parse', 'HEAD') || 'unknown'
  const sbLast = git(checkout, 'log', '-1', '--format=%H', '--', SRC_PREFIX + 'components/StatBlock.tsx') || 'unknown'
  const rows = FILES.map(f => {
    const buf = readFileSync(join(checkout, SRC_PREFIX + f))
    return { src: SRC_PREFIX + f, dest: 'vendor/src/' + f, sha1: sha1(buf) }
  })
  const old = existsSync(PIN) ? readFileSync(PIN, 'utf8') : ''
  // Everything below the file table (the stub notes) is kept as written.
  const tail = old.includes('\n## Stubs') ? old.slice(old.indexOf('\n## Stubs') + 1) : '## Stubs\n\n(none)\n'
  const out = [
    '# Vendored StatBlock pin', '',
    `Source: Heroes-Heaven \`${head}\``,
    `StatBlock.tsx last changed in: \`${sbLast}\``, '',
    'Check with `node scripts/vendor-sync.mjs --verify` (vendored copies) or',
    '`node scripts/vendor-sync.mjs <checkout> --check` (a Heroes-Heaven checkout still matches the pin).',
    'Files are byte-for-byte copies; nothing under `vendor/src/` is edited.', '',
    '## Files', '',
    '| source | vendored | sha1 |', '|---|---|---|',
    ...rows.map(r => `| \`${r.src}\` | \`${r.dest}\` | \`${r.sha1}\` |`), '',
    tail.trimEnd(), '',
  ].join('\n')
  writeFileSync(PIN, out)
  console.log(`PIN.md written: ${rows.length} files at ${head}`)
}

let bad = 0
const rows = readPin()
for (const r of rows) {
  const p = join(checkout, r.src)
  const buf = existsSync(p) ? readFileSync(p) : null
  const got = buf ? sha1(buf) : 'missing'
  if (got !== r.sha1) { bad++; console.error(`MOVED ${r.src}: pinned ${r.sha1}, checkout ${got}`); continue }
  if (!flags.has('--check')) {
    const dest = join(ROOT, r.dest)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
  }
}
if (bad) {
  console.error(`${bad} file(s) in ${checkout} no longer match PIN.md; re-pin deliberately with --pin`)
  process.exit(1)
}
console.log(`${flags.has('--check') ? 'checked' : 'copied'} ${rows.length} files; all match PIN.md`)
