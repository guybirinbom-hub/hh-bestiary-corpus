// Stage 2b: sanity gates over data/ and report/coverage.json. Exits 1 when any gate fails, so the build
// can stop before rendering a corpus that is already known to be wrong.
//
//   node scripts/check-records.mjs            # print every gate, first examples of each failure
//
// Gates:
//   markup        no "<", "**", "](/" or a "---" line in any stored string outside _aon (HTML, bold and
//                 link syntax never reach a record)
//   activity      an ability whose page header carries an <actions string> cost has an activity
//   counts        corpus count equals live count per category (report/coverage.json)
//   index-files   every index row names a file that exists
//   ability-names every ability (and hazard action) has a non-empty name
//   strike-attack every strike has a finite numeric attack
//   duplicate-keys no JSON object in a data file repeats a key (a repeated spell rank key would silently
//                 overwrite the first on parse)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionStringToActivity } from './lib/text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const failures = {};
const fail = (gate, msg) => { (failures[gate] ??= []).push(msg); };
const checked = {};
const count = (gate, n = 1) => { checked[gate] = (checked[gate] ?? 0) + n; };

// ── load ──────────────────────────────────────────────────────────────────────────────────────────
const files = [];
const bdir = join(DATA, 'bestiary');
for (const f of readdirSync(bdir).filter((f) => f.endsWith('.json')).sort()) files.push({ path: join(bdir, f), rel: `bestiary/${f}`, key: 'creature' });
files.push({ path: join(DATA, 'hazards.json'), rel: 'hazards.json', key: 'hazard' });

const records = [];
for (const f of files) {
  const raw = readFileSync(f.path, 'utf8');
  count('duplicate-keys');
  for (const d of duplicateKeys(raw)) fail('duplicate-keys', `${f.rel}: key "${d.key}" repeated at offset ${d.at}`);
  for (const rec of JSON.parse(raw)[f.key] ?? []) records.push({ rec, file: f.rel, hazard: f.key === 'hazard' });
}

// ── per record ────────────────────────────────────────────────────────────────────────────────────
const MARKUP = [['<', /</], ['**', /\*\*/], ['](/', /\]\(\//], ['---', /(^|\n)\s*---\s*($|\n)/]];
for (const { rec, file, hazard } of records) {
  const id = rec._aon?.id ?? `${file}#${rec.name}`;
  // markup: every string outside _aon
  walk(rec, (s, path) => {
    count('markup');
    for (const [name, re] of MARKUP) if (re.test(s)) fail('markup', `${id} ${path}: contains "${name}": ${JSON.stringify(s.slice(0, 120))}`);
  }, '', new Set(['_aon']));

  const abilities = hazard ? (rec.actions ?? []) : ['top', 'mid', 'bot'].flatMap((s) => rec.abilities?.[s] ?? []);
  for (const a of abilities) {
    count('ability-names');
    if (!String(a.name ?? '').trim()) fail('ability-names', `${id}: an ability with an empty name`);
  }
  for (const a of rec.attacks ?? []) {
    count('strike-attack');
    if (typeof a.attack !== 'number' || !Number.isFinite(a.attack)) fail('strike-attack', `${id}: strike "${a.name}" attack ${JSON.stringify(a.attack)}`);
  }

  // activity: the page header of the ability carries a cost tag
  const md = rec._aon?.markdown ?? '';
  const nth = {};
  for (const a of abilities) {
    const name = String(a.name ?? '').trim();
    if (!name) continue;
    // the k-th ability of a name answers to the k-th header of that name ("Light of Diligence" twice)
    const k = nth[name] = (nth[name] ?? -1) + 1;
    const cost = headerCosts(md, name)[k];
    if (cost === undefined) continue;
    count('activity');
    if (actionStringToActivity(cost) && !a.activity) fail('activity', `${id}: "${name}" prints <actions string="${cost}"> on its header but has no activity`);
  }
}

// ── counts and index ──────────────────────────────────────────────────────────────────────────────
const coverage = JSON.parse(readFileSync(join(ROOT, 'report', 'coverage.json'), 'utf8'));
for (const cat of ['creature', 'hazard']) {
  count('counts');
  const live = coverage.live?.[cat], corpus = coverage.corpus?.[cat];
  if (live == null || live !== corpus) fail('counts', `${cat}: live ${live} vs corpus ${corpus}`);
}
const index = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
for (const row of index) {
  count('index-files');
  const p = join(bdir, row.file ?? '');
  if (!row.file || !existsSync(p)) fail('index-files', `index row "${row.name}" names missing file ${row.file}`);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────
let red = 0;
for (const gate of ['markup', 'activity', 'counts', 'index-files', 'ability-names', 'strike-attack', 'duplicate-keys']) {
  const f = failures[gate] ?? [];
  if (f.length) red++;
  console.log(`${f.length ? 'FAIL' : 'ok  '} ${gate.padEnd(14)} ${String(checked[gate] ?? 0).padStart(7)} checked, ${f.length} failed`);
  for (const m of f.slice(0, 5)) console.log(`       ${m}`);
  if (f.length > 5) console.log(`       … ${f.length - 5} more`);
}
console.log(red ? `check: ${red} gate(s) red` : `check: all gates green (${records.length} records)`);
process.exit(red ? 1 : 0);

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
function walk(v, fn, path, skip) {
  if (typeof v === 'string') return fn(v, path);
  if (Array.isArray(v)) return v.forEach((x, i) => walk(x, fn, `${path}[${i}]`, skip));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x, fn, path ? `${path}.${k}` : k, skip);
}

/**
 * The `<actions string>` value on each of the page's header lines for an ability, in page order
 * (undefined for a header that carries none). Header forms: **Name**, **[Name](url)**, [**Name**](url), [Name](url),
 * and an unbolded "Name <actions…/>" at the start of a line or after a <br>.
 */
function headerCosts(md, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?:^|\\n|<br\\s*/?>)\\s*(?:\\*\\*)?\\[?(?:\\*\\*)?_?${n}_?(?:\\*\\*)?(?:\\]\\([^)]*\\))?(?:\\*\\*)?(?=[\\s(<]|$)(?:\\s*<actions\\s+string="([^"]*)")?`, 'gi');
  return [...md.matchAll(re)].map((m) => m[1]);
}

/** Every repeated key in any object of a JSON text, with its offset. A small scanner, not a parser. */
function duplicateKeys(text) {
  const out = [];
  const stack = [];                                  // per open container: Set of keys, or null for arrays
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.has(key)) out.push({ key, at: i });
        top.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); }
    else if (c === '}' || c === ']') { stack.pop(); }
    else if (c === ',') { expectKey = stack[stack.length - 1] instanceof Set; }
    i++;
  }
  return out;
}
