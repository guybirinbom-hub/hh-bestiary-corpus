// The single build command: regenerates everything from a clean checkout, in order.
//
//   npm run build              # fetch (cached when counts match live), records, check, render, sample, status
//   npm run build -- --force   # refetch the Archives
//
// Each stage is its own script and can be run alone; this file only sequences them and stops at
// the first failing stage so a red gate is never papered over by a later one.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const stages = [
  ['fetch',   ['scripts/fetch-aon.mjs', ...(force ? ['--force'] : [])]],
  ['records', ['scripts/build-records.mjs']],
  ['check',   ['scripts/check-records.mjs']],
  ['render',  ['scripts/render.mjs']],
  ['sample',  ['scripts/sample.mjs']],
  ['status',  ['scripts/status.mjs']],
];

const t0 = Date.now();
for (const [name, args] of stages) {
  const s = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  } catch (e) {
    console.error(`\nbuild stopped: stage "${name}" exited ${e.status}`);
    process.exit(e.status || 1);
  }
  console.log(`=== ${name} done in ${((Date.now() - s) / 1000).toFixed(1)}s`);
}
console.log(`\nbuild complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
