// The last gate. Reads the four reports, checks every condition the corpus promises, and writes
// STATUS.md only when all of them hold. Otherwise it prints which gate is red and exits 1, and any
// existing STATUS.md is left untouched (it describes the last green build, and says so).
//
// Gates:
//   1. coverage: corpus count equals live count per category
//   2. agreement: every row carries a reason, and none is "unexplained"
//   3. unparsed: every row carries a reason (the report groups them; a reason is the explanation)
//   4. render: every parse, merged or value row carries a note explaining it
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const coverage = rd('report/coverage.json');
const agreement = rd('report/agreement.json');
const unparsed = rd('report/unparsed.json');
const render = rd('report/render.json');
const meta = existsSync(join(ROOT, 'cache/aon/meta.json')) ? rd('cache/aon/meta.json') : null;

const red = [];
for (const cat of ['creature', 'hazard']) {
  if (coverage.live?.[cat] !== coverage.corpus?.[cat]) red.push(`coverage: ${cat} live ${coverage.live?.[cat]} vs corpus ${coverage.corpus?.[cat]}`);
}
const agRows = agreement.rows ?? [];
const agUnexplained = agRows.filter(r => !r.reason || r.reason === 'unexplained');
if (agUnexplained.length) red.push(`agreement: ${agUnexplained.length} rows without a reason`);
const unRows = unparsed.rows ?? [];
const unNoReason = unRows.filter(r => !r.reason);
if (unNoReason.length) red.push(`unparsed: ${unNoReason.length} rows without a reason`);
const rdRows = render.rows ?? [];
const rdOpen = rdRows.filter(r => (r.verdict === 'parse' || r.verdict === 'merged' || r.verdict === 'value') && !r.note);
if (rdOpen.length) red.push(`render: ${rdOpen.length} parse/merged/value rows without a note`);

const count = (rows, key) => { const m = {}; for (const r of rows) m[r[key]] = (m[r[key]] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
const table = (pairs) => pairs.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

if (red.length) {
  console.error('STATUS: red\n  ' + red.join('\n  '));
  process.exit(1);
}

const today = (meta?.fetched_at ?? new Date().toISOString()).slice(0, 10);
const md = `# Status

Last complete green build: ${today} (Archives fetched ${meta?.fetched_at ?? 'unknown'}).
Every gate below passed when this file was written; a build whose gates fail does not rewrite it.

## Coverage

| category | live on the Archives | in the corpus | match |
|---|---|---|---|
| creature | ${coverage.live.creature} | ${coverage.corpus.creature} | ${coverage.live.creature === coverage.corpus.creature ? 'yes' : 'NO'} |
| hazard | ${coverage.live.hazard} | ${coverage.corpus.hazard} | ${coverage.live.hazard === coverage.corpus.hazard ? 'yes' : 'NO'} |

Shard files: ${coverage.files}. Index rows: ${coverage.index?.rows} (${coverage.index?.creatures} creatures, ${coverage.index?.hazards} hazards); ${coverage.index?.droppedByRemasterLink} legacy twins dropped where the Archives link a remaster, ${coverage.index?.droppedByPriority} same-name twins dropped by the app's source-priority rule.${coverage.orphanShards?.length ? ` ${coverage.orphanShards.length} shard files are named by no index row because every record in them is superseded by a linked remaster (listed in report/coverage.json).` : ''}

## Agreement (structured fields vs page text)

${agRows.length} disagreements, every one carrying a reason. The record holds the page-text value; the structured value sits beside it in report/agreement.json.

| reason | rows |
|---|---|
${table(count(agRows, 'reason'))}

| field | rows |
|---|---|
${table(count(agRows, 'field'))}

## Unparsed (page content with no home in the record shape)

${unRows.length} rows, every one carrying a reason.

| reason | rows |
|---|---|
${table(count(unRows, 'reason'))}

## Render check (every record through the pinned StatBlock, ${render.summary.vendor})

${render.summary.records} records rendered, ${render.summary.clean} with no rows, ${render.summary.rows} rows. Page headings matched without a row: ${render.summary.matchedWithoutRow.optionLines} option lines and ${render.summary.matchedWithoutRow.unboldedHeaders} unbolded headers, each listed in report/render.json under \`accepted\`.

| verdict | rows | meaning |
|---|---|---|
| parse | ${render.summary.byVerdict.parse ?? 0} | the record lacks the heading (each row explained in its note) |
| merged | ${render.summary.byVerdict.merged ?? 0} | two page headings became one (each row explained in its note) |
| value | ${render.summary.byVerdict.value ?? 0} | the heading matches but a value the page prints on it (action cost, Trigger, focus pool) is not on the record (each row explained in its note) |
| adapter | ${render.summary.byVerdict.adapter ?? 0} | the app's parseCreature/parseHazard dropped it before the component |
| render | ${render.summary.byVerdict.render ?? 0} | the component did not show a value the adapter passed |
| order | ${render.summary.byVerdict.order ?? 0} | present, but not in the page's order |

The adapter, render and order rows are the app's own defects and are reported, not hidden by changing the data.
`;
writeFileSync(join(ROOT, 'STATUS.md'), md);
console.log('STATUS: green, wrote STATUS.md');
