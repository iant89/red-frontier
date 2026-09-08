// Bundles the headless simulation tests with esbuild and runs them in Node.
// (The simulation has no DOM/three.js dependencies, so it runs fine outside a browser.)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'node_modules', '.test-dist', 'sim.test.mjs');

await build({
  entryPoints: [path.join(here, '..', 'tests', 'sim.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  sourcemap: false,
});

await import(pathToFileURL(out).href);
