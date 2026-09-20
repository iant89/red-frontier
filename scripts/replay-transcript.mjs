#!/usr/bin/env node
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const entry = path.join(here, 'replay-transcript.ts');
const outfile = path.join(root, 'node_modules', '.test-dist', 'replay-transcript.mjs');

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  sourcemap: 'inline',
  logLevel: 'warning',
});

await import(outfile);
