// Stage 2 of the corpus pipeline (docs/DESIGN.md): cache -> records + reports.
//
//   node scripts/build-records.mjs
//
// Reads cache/aon/{creature,hazard}.jsonl, reads every document twice (facets and page text), writes
// data/bestiary/creatures-<source>.json, data/hazards.json, data/index.json and report/{agreement,
// unparsed,coverage}.json, then prints a one-screen summary. Serialization: JSON.stringify with no
// indentation and no trailing newline.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creatureFacets, hazardFacets } from './lib/facets.mjs';
import { parseCreaturePage } from './lib/parse-creature.mjs';
import { parseHazardPage } from './lib/parse-hazard.mjs';
import { compareCreature, compareHazard } from './lib/agreement.mjs';
import { agreementReason } from './lib/agreement-reasons.mjs';
import { creatureIndexRow, creatureRecord, dedupIndex, fileKey, hazardIndexRow, hazardRecord } from './lib/record.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'cache', 'aon');
const DATA = join(ROOT, 'data');
const REPORT = join(ROOT, 'report');

const idNum = (id) => parseInt(String(id).replace(/^\D+/, ''), 10);
function load(cat) {
  const file = join(CACHE, `${cat}.jsonl`);
  if (!existsSync(file)) throw new Error(`missing ${file}: run npm run fetch first`);
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => idNum(a.id) - idNum(b.id));
}
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };

const creatures = load('creature');
const hazards = load('hazard');
const meta = JSON.parse(readFileSync(join(CACHE, 'meta.json'), 'utf8'));

const agreementRows = [];
const unparsedRows = [];
const onlyStructured = {}, onlyText = {};
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

const shards = new Map();
const indexIn = [];
let creaturesWithMarkdown = 0;
let placeholderFlavor = 0;        // creatures whose flavor was only the Archives' "No description" note, or held it
for (const doc of creatures) {
  if (!String(doc.markdown ?? '').trim()) { unparsedRows.push({ id: doc.id, name: doc.name, section: '', heading: '', line: '', reason: 'document has no markdown' }); continue; }
  creaturesWithMarkdown++;
  const S = creatureFacets(doc);
  const T = parseCreaturePage(doc);
  const cmp = compareCreature(S, T);
  for (const r of cmp.rows) agreementRows.push({ id: doc.id, name: doc.name, ...r, reason: agreementReason(r, { S, T, doc, rows: cmp.rows }) });
  for (const f of cmp.onlyStructured) bump(onlyStructured, f);
  for (const f of cmp.onlyText) bump(onlyText, f);
  for (const u of T.unparsed) unparsedRows.push({ id: doc.id, name: doc.name, ...u });
  if (T.placeholderFlavor) placeholderFlavor++;
  const rec = creatureRecord(doc, S, T);
  const { key } = fileKey(doc);
  if (!shards.has(key)) shards.set(key, []);
  shards.get(key).push(rec);
  indexIn.push({ doc, row: creatureIndexRow(doc, rec) });
}

const hazardRecords = [];
for (const doc of hazards) {
  if (!String(doc.markdown ?? '').trim()) { unparsedRows.push({ id: doc.id, name: doc.name, section: '', heading: '', line: '', reason: 'document has no markdown' }); continue; }
  const S = hazardFacets(doc);
  const T = parseHazardPage(doc);
  const cmp = compareHazard(S, T);
  for (const r of cmp.rows) agreementRows.push({ id: doc.id, name: doc.name, ...r, reason: agreementReason(r, { S, T, doc, rows: cmp.rows }) });
  for (const f of cmp.onlyStructured) bump(onlyStructured, `hazard.${f}`);
  for (const f of cmp.onlyText) bump(onlyText, `hazard.${f}`);
  for (const u of T.unparsed) unparsedRows.push({ id: doc.id, name: doc.name, ...u });
  const rec = hazardRecord(doc, S, T);
  hazardRecords.push(rec);
  indexIn.push({ doc, row: hazardIndexRow(doc, rec) });
}

// ── write data ────────────────────────────────────────────────────────────────────────────────────
const bestiaryDir = join(DATA, 'bestiary');
if (existsSync(bestiaryDir)) for (const f of readdirSync(bestiaryDir)) if (f.endsWith('.json')) rmSync(join(bestiaryDir, f));
mkdirSync(bestiaryDir, { recursive: true });
for (const [key, list] of shards) write(join(bestiaryDir, `creatures-${key}.json`), { creature: list });
write(join(DATA, 'hazards.json'), { hazard: hazardRecords });
const { index, droppedByRemasterLink, droppedByPriority } = dedupIndex(indexIn);
write(join(DATA, 'index.json'), index);

// ── reports ───────────────────────────────────────────────────────────────────────────────────────
const byField = {};
for (const r of agreementRows) bump(byField, r.field);
const agByReason = {};
for (const r of agreementRows) bump(agByReason, r.reason);
write(join(REPORT, 'agreement.json'), { total: agreementRows.length, byReason: sortDesc(agByReason), byField: sortDesc(byField), rows: agreementRows });
const byReason = {};
for (const r of unparsedRows) bump(byReason, r.reason);
write(join(REPORT, 'unparsed.json'), { total: unparsedRows.length, byReason: sortDesc(byReason), rows: unparsedRows });
const files = [...shards.keys()].map((k) => `creatures-${k}.json`);
const named = new Set(index.filter((r) => r.file !== '../hazards.json').map((r) => r.file));
// A shard no index row names: say why, from the records in it (never assumed).
const corpusIds = new Set(indexIn.map((x) => x.doc.id));
const orphanShards = files.filter((f) => !named.has(f)).map((f) => {
  const docs = indexIn.filter((x) => x.row.file === f).map((x) => x.doc);
  const superseded = docs.filter((d) => (Array.isArray(d.remaster_id) ? d.remaster_id : d.remaster_id ? [d.remaster_id] : []).some((id) => corpusIds.has(id)));
  const reason = superseded.length === docs.length ? 'every record superseded by a linked remaster'
    : `${docs.length - superseded.length} of ${docs.length} records lost to the source-priority rule, the rest superseded by a linked remaster`;
  return { file: f, records: docs.length, supersededByRemaster: superseded.length, reason };
});
const live = { creature: meta.live?.creature, hazard: meta.live?.hazard };
const corpus = { creature: creaturesWithMarkdown, hazard: hazardRecords.length };
const coverage = {
  live, corpus,
  byCategory: Object.fromEntries(['creature', 'hazard'].map((c) => [c, { live: live[c], corpus: corpus[c], match: live[c] === corpus[c] }])),
  files: files.length,
  orphanShards,
  // the Archives' "Nethys Note: No description has been provided…" placeholder, removed from flavor
  placeholderFlavor,
  index: {
    rows: index.length,
    creatures: index.filter((r) => !r.isHazard).length,
    hazards: index.filter((r) => r.isHazard).length,
    droppedByRemasterLink, droppedByPriority,
  },
  onlyStructured: sortDesc(onlyStructured),
  onlyText: sortDesc(onlyText),
};
write(join(REPORT, 'coverage.json'), coverage);

function sortDesc(o) { return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); }

// ── summary ───────────────────────────────────────────────────────────────────────────────────────
const orphans = orphanShards.map((o) => o.file);
const top = (o, n) => Object.entries(o).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
console.log(`records    ${creaturesWithMarkdown} creatures (live ${meta.live?.creature}), ${hazardRecords.length} hazards (live ${meta.live?.hazard})`);
console.log(`files      ${files.length} bestiary shards + hazards.json${orphans.length ? `; ${orphans.length} shard(s) named by no index row: ${orphans.join(', ')}` : ''}`);
console.log(`index      ${index.length} rows (${coverage.index.creatures} creatures, ${coverage.index.hazards} hazards); dropped ${droppedByRemasterLink} by remaster link, ${droppedByPriority} by priority`);
console.log(`agreement  ${agreementRows.length} rows: ${top(sortDesc(byField), 12)}`);
console.log(`  reasons  ${top(sortDesc(agByReason), 30)}`);
console.log(`unparsed   ${unparsedRows.length} rows: ${top(sortDesc(byReason), 12)}`);
console.log(`onlyStruct ${top(coverage.onlyStructured, 8)}`);
console.log(`onlyText   ${top(coverage.onlyText, 8)}`);
