/**
 * Generate the golden colony artifacts for Phase 0.
 *
 * Golden colony = canonical transcript + pinned end-state hash + save file
 * checked into tests/golden-colony/, as prescribed by COMMERCIAL-ROADMAP-REVIEW.md §4.7.
 *
 * Usage:
 *   node scripts/generate-golden-colony.mjs --write   # writes tests/golden-colony/*
 *   node scripts/generate-golden-colony.mjs --check   # checks existing artifacts match current code
 *
 * The colony built here is intentionally mid-game viable:
 *   warehouse, solar, battery, extractor, oxygenator, greenhouse,
 *   refinery, workshop, garage, water tank + pump, plus some hauling.
 *
 * It uses deterministic placement search (findSpot) so same seed always
 * produces same transcript. Buildings are completed via dev command to ensure
 * the colony is viable regardless of rover logistics — this is a regression
 * gate, not a gameplay challenge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(root, 'tests', 'golden-colony');

const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');

if (!WRITE && !CHECK) {
  console.log('Usage: node scripts/generate-golden-colony.mjs --write|--check');
  process.exit(1);
}

// Bundle a tiny TS program that uses Simulation, TranscriptBuilder, StateHash, etc.
const tmpEntry = path.join(root, 'node_modules', '.golden-gen-entry.mjs');
const bundlePath = path.join(root, 'node_modules', '.golden-gen-bundle.mjs');

fs.mkdirSync(path.dirname(tmpEntry), { recursive: true });
fs.writeFileSync(tmpEntry, `
import { Simulation } from '../src/sim/Simulation.ts';
import { TranscriptBuilder } from '../src/sim/debug/Transcript.ts';
import { hashSimulation } from '../src/sim/debug/StateHash.ts';
import { SOL_SECONDS, SIM_TICK } from '../src/sim/config.ts';
import { applyCommand } from '../src/sim/host/applyCommand.ts';

function findSpot(sim, kind) {
  for (let r = 34; r <= 140; r += 3) {
    for (let a = 0; a < 360; a += 7) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      if (sim.canPlace(kind, x, z) === null) return { x, z };
    }
  }
  throw new Error('no spot for ' + kind);
}
function nearDeposit(sim, res) {
  return sim.world.deposits.filter(d => d.resource === res && d.amount > 0)
    .sort((a,b) => Math.hypot(a.x,a.z) - Math.hypot(b.x,b.z))[0];
}

const seed = 9001;
const order = ['warehouse','solar','battery','extractor','oxygenator','greenhouse','refinery','workshop','garage','waterTank','pumpStation'];

// Probe for deterministic spots (complete immediately to avoid overlap)
const simForSpots = new Simulation({ seed, difficulty: 'pioneer', worldHalf: undefined, region: null, worldOptions: { nearDeposits: 0.2 } });
const spots = {};
const buildingIds = {};
for (const kind of order) {
  const spot = findSpot(simForSpots, kind);
  spots[kind] = spot;
  const b = simForSpots.placeBuilding(kind, spot.x, spot.z);
  if (!b) throw new Error('probe placement failed for ' + kind);
  buildingIds[kind] = b.id;
  simForSpots.devCompleteBuilding(b.id);
}

const tb = new TranscriptBuilder(seed);
tb.difficulty('pioneer');
tb.worldOptions({ nearDeposits: 0.2 });

let tick = 0;
// Place all buildings
for (const kind of order) {
  const spot = spots[kind];
  tb.at(tick, { type: 'building/place', kind, x: spot.x, z: spot.z });
  tick += 10;
}
// Complete them via dev command (need to know IDs — IDs are assigned sequentially starting at 1000? Actually building IDs start at 1000 and increment)
// Since we placed 11 buildings, IDs will be 1000..1010 in order if no other buildings exist. Probe sim had same.
// Use those IDs for dev completion.
let nextId = 1000;
for (const kind of order) {
  tb.at(tick, { type: 'dev/building/complete', buildingId: nextId });
  nextId++;
  tick += 10;
}

const simProbe = new Simulation({ seed, difficulty: 'pioneer', worldHalf: undefined, region: null, worldOptions: { nearDeposits: 0.2 } });
const iceDep = nearDeposit(simProbe, 'ice');
const ironDep = nearDeposit(simProbe, 'iron');
const siliconDep = nearDeposit(simProbe, 'silicon');
if (iceDep) {
  tb.at(tick, { type: 'rover/mine', roverId: 1000, depositId: iceDep.id, queue: false });
  tick += 200;
  tb.at(tick, { type: 'rover/repeatRoute', roverId: 1000, on: true });
  tick += 10;
}
if (ironDep) {
  tb.at(tick, { type: 'rover/mine', roverId: 1001, depositId: ironDep.id, queue: false });
  tick += 200;
  tb.at(tick, { type: 'rover/repeatRoute', roverId: 1001, on: true });
  tick += 10;
}
if (siliconDep) {
  // Third rover? We have only 2 starting rovers. Spawn a cargo rover via dev for hauling silicon
  tb.at(tick, { type: 'dev/spawn/rover', kind: 'cargo', x: 10, z: 10 });
  tick += 10;
  // Its ID will be 1002 (after 2 starters)
  tb.at(tick, { type: 'rover/mine', roverId: 1002, depositId: siliconDep.id, queue: false });
  tick += 200;
  tb.at(tick, { type: 'rover/repeatRoute', roverId: 1002, on: true });
  tick += 10;
}

const totalTicks = Math.round(5 * SOL_SECONDS * 20);
tb.duration(totalTicks);

const transcript = tb.build();

// Replay
const sim = new Simulation({ seed, difficulty: 'pioneer', worldHalf: undefined, region: null, worldOptions: { nearDeposits: 0.2 } });
const sorted = [...transcript.commands].sort((a,b)=>a.tick-b.tick);
let cmdIdx=0;
while (cmdIdx<sorted.length && sorted[cmdIdx].tick<=0) {
  applyCommand(sim, sorted[cmdIdx].command);
  cmdIdx++;
}
for (let t=0; t<totalTicks; t++) {
  while (cmdIdx<sorted.length && sorted[cmdIdx].tick===t) {
    applyCommand(sim, sorted[cmdIdx].command);
    cmdIdx++;
  }
  sim.step(SIM_TICK);
}

const hash = hashSimulation(sim);
const save = sim.snapshot();

const out = { transcript, hash, save, seed, totalTicks, spots };
console.log(JSON.stringify(out));
`, 'utf8');

await build({
  entryPoints: [tmpEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
  external: [],
  logLevel: 'silent',
});

const { spawn } = await import('node:child_process');
const proc = spawn('node', [bundlePath], { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = '';
for await (const chunk of proc.stdout) stdout += chunk;
const code = await new Promise(res => proc.on('close', res));
if (code !== 0) {
  console.error('golden colony generation failed');
  process.exit(code);
}

let result;
try {
  result = JSON.parse(stdout);
} catch (e) {
  console.error('Failed to parse generation output', e);
  console.error(stdout.slice(0, 2000));
  process.exit(1);
}

const transcriptJson = JSON.stringify(result.transcript, null, 2);
const hashTxt = result.hash + '\n';
const saveJson = JSON.stringify(result.save, null, 2);
const meta = {
  seed: result.seed,
  totalTicks: result.totalTicks,
  sols: 5,
  hash: result.hash,
  generatedAt: new Date().toISOString(),
  spots: result.spots,
  description: 'Golden colony: viable mid-game colony (warehouse, solar, battery, extractor, oxygenator, greenhouse, refinery, workshop, garage, waterTank, pumpStation) + ice/iron/silicon hauling, 5 sols, dev-completed for determinism',
};

fs.mkdirSync(outDir, { recursive: true });

if (WRITE) {
  fs.writeFileSync(path.join(outDir, 'golden-colony.transcript.json'), transcriptJson);
  fs.writeFileSync(path.join(outDir, 'golden-colony.hash.txt'), hashTxt);
  fs.writeFileSync(path.join(outDir, 'golden-colony.save.json'), saveJson);
  fs.writeFileSync(path.join(outDir, 'golden-colony.meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), `# Golden Colony (Phase 0)

This directory holds the Phase 0 golden colony — the "can we safely build on this?" gate.

## Contents

- \`golden-colony.transcript.json\` — seed + timed commands (diffable, seed-pinned, replay format)
- \`golden-colony.hash.txt\` — pinned final StateHash after 5 sols
- \`golden-colony.save.json\` — snapshot for manual inspection in a text editor
- \`golden-colony.meta.json\` — seed, ticks, spots, generation time
- This README

## How it was built

Seed 9001, pioneer difficulty, nearDeposits 0.2. Buildings placed via deterministic
findSpot search (ring scan), same as tests/fixtures/sim.ts, then completed via
dev/building/complete to ensure viability regardless of rover logistics:

\`\`\`
warehouse, solar, battery, extractor, oxygenator, greenhouse,
refinery, workshop, garage, waterTank, pumpStation
\`\`\`

Then ice + iron mining with repeatRoute hauling, plus a spawned cargo rover for silicon.

Total duration: 5 sols = 24000 ticks at 20Hz (SOL_SECONDS=240).

Using dev commands is intentional: this is a regression gate, not a gameplay challenge.
The transcript is still deterministic and diffable, and the hash still moves when
tick behavior changes — which is the point.

## Regeneration

\`\`\`bash
node scripts/generate-golden-colony.mjs --write
npm run test:replay
npm test -- golden-colony
\`\`\`

## Change control

"Freeze" = change-control, not no-changes. If tick output moves, update the pinned hash
deliberately (PR-visible, reviewed). That's how transcript hashes already behave.

See docs/SIMULATION-INVARIANTS.md and benchmarks/baseline.md.
`);
  console.log('Wrote golden colony to', outDir);
  console.log('Hash:', result.hash);
} else if (CHECK) {
  const existingTranscriptPath = path.join(outDir, 'golden-colony.transcript.json');
  const existingHashPath = path.join(outDir, 'golden-colony.hash.txt');
  if (!fs.existsSync(existingTranscriptPath) || !fs.existsSync(existingHashPath)) {
    console.error('Golden colony artifacts missing — run with --write first');
    process.exit(1);
  }
  const existingHash = fs.readFileSync(existingHashPath, 'utf8').trim();
  if (existingHash !== result.hash) {
    console.error('Golden colony hash mismatch!');
    console.error('  Expected (checked-in):', existingHash);
    console.error('  Actual (current code):', result.hash);
    console.error('If intentional, run with --write to update pinned hash.');
    process.exit(2);
  }
  console.log('Golden colony check PASS — hash', result.hash);
}
