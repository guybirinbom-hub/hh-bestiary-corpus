// Fetch every creature and hazard document from the Archives of Nethys public search
// endpoint into cache/aon/<category>.jsonl (one full _source per line, sorted by id).
// The live Archives is the only source of this corpus; this file is the only network step.
//
//   node scripts/fetch-aon.mjs            # fetch creature + hazard (skips a fresh cache)
//   node scripts/fetch-aon.mjs --force    # refetch
//   node scripts/fetch-aon.mjs --check    # reachability + live counts only, writes nothing
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'cache', 'aon');
const ENDPOINT = 'https://elasticsearch.aonprd.com/aon/_search';
const CATEGORIES = ['creature', 'hazard'];
const PAGE = 500;
const args = new Set(process.argv.slice(2));

async function search(body) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
}

export async function liveCounts() {
  const j = await search({ size: 0, aggs: { cat: { terms: { field: 'category', size: 200 } } } });
  const out = {};
  for (const b of j.aggregations.cat.buckets) out[b.key] = b.doc_count;
  return out;
}

async function fetchCategory(cat) {
  const docs = [];
  let after;
  for (;;) {
    const body = { size: PAGE, query: { term: { category: cat } }, sort: [{ 'id.keyword': 'asc' }] };
    if (after) body.search_after = after;
    const j = await search(body);
    const hits = j.hits.hits;
    if (!hits.length) break;
    for (const h of hits) docs.push(h._source);
    after = hits[hits.length - 1].sort;
    process.stderr.write(`  ${cat}: ${docs.length}/${j.hits.total.value}\r`);
    if (hits.length < PAGE) break;
  }
  process.stderr.write('\n');
  return docs;
}

async function main() {
  const counts = await liveCounts();
  console.log('live counts:', CATEGORIES.map(c => `${c}=${counts[c]}`).join(' '));
  if (args.has('--check')) return;
  mkdirSync(OUT, { recursive: true });
  const meta = { fetched_at: new Date().toISOString(), endpoint: ENDPOINT, live: {}, fetched: {} };
  for (const cat of CATEGORIES) {
    const file = join(OUT, `${cat}.jsonl`);
    meta.live[cat] = counts[cat];
    if (existsSync(file) && !args.has('--force')) {
      const n = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      if (n === counts[cat]) { console.log(`  ${cat}: cache has ${n} = live, skip (use --force to refetch)`); meta.fetched[cat] = n; continue; }
      console.log(`  ${cat}: cache has ${n} but live has ${counts[cat]}, refetching`);
    }
    const docs = await fetchCategory(cat);
    const ids = new Set(docs.map(d => d.id));
    if (ids.size !== docs.length) throw new Error(`${cat}: ${docs.length - ids.size} duplicate ids in fetch`);
    if (docs.length !== counts[cat]) throw new Error(`${cat}: fetched ${docs.length} but live count is ${counts[cat]}`);
    writeFileSync(file, docs.map(d => JSON.stringify(d)).join('\n') + '\n');
    meta.fetched[cat] = docs.length;
    console.log(`  ${cat}: wrote ${docs.length} docs`);
  }
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
