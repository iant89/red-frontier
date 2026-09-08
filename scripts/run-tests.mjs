// Bundles the headless test suites with esbuild and runs them in Node.
//
// The simulation has no DOM or three.js dependency, so it runs directly. The
// HUD suite is DOM-only and runs against jsdom. Neither needs a GPU.
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(root, 'node_modules', '.test-dist');

const only = process.argv[2];
const suites = [
  { name: 'sim', entry: 'tests/sim.test.ts', external: [] },
  { name: 'hud', entry: 'tests/hud.test.ts', external: ['jsdom'] },
].filter((s) => !only || s.name === only);

let failed = false;
for (const suite of suites) {
  const entry = path.join(root, suite.entry);
  if (!fs.existsSync(entry)) continue;
  const out = path.join(outDir, `${suite.name}.test.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    sourcemap: false,
    external: suite.external,
  });
  console.log(`\n\u001b[1m── ${suite.name} suite ──\u001b[0m`);
  try {
    await import(pathToFileURL(out).href);
  } catch (err) {
    failed = true;
    console.error(err);
  }
}
if (failed) process.exit(1);
