/**
 * Behavior baseline — the A/B tool for refactor phases.
 *
 * Every extraction phase in this project has been verified by diffing a
 * *behavior trace* before and after the move (`ARCHITECTURAL-REFACTOR-ROADMAP.md`
 * §44, and the mnemosyne entries for Phases 5, 9, 10 and 12). Endpoint hashes
 * alone are not enough: a change in a *rate* can move a trace while landing on
 * the same final hash — the Phase 9 lesson.
 *
 * This script is that trace, and it lives in the repo so it cannot be lost with
 * a scratch directory. It is not part of `npm test` (it is a slower, whole-colony
 * scenario); run it by hand around a refactor:
 *
 *     npx esbuild scripts/behavior-baseline.ts --bundle --format=esm \
 *       --platform=node --outfile=/tmp/behavior-baseline.mjs
 *     node /tmp/behavior-baseline.mjs --write /tmp/before.txt
 *     ...refactor...
 *     node /tmp/behavior-baseline.mjs --check /tmp/before.txt
 *
 * What it covers, per seed:
 *   - a scripted colony: sites placed and completed through the real APIs, a
 *     standard mining order with a queued one behind it, a forced storm, a flat
 *     pack in the field (which the rescue pass has to answer), a new site, and
 *     dust — with the fleet's own automatic dispatch running throughout;
 *   - `StateHash` checkpoints (the simulation's own notion of "the same
 *     colony");
 *   - a per-tick trace sampled every 4 ticks — rover x/z/heading/battery/
 *     condition/phase/goal/navI/recharge/sheltered/routePaused/lights/task/
 *     queue/cargo plus storage — folded into one FNV-1a digest;
 *   - a `structuredClone`d snapshot → restore equality pair, and a same-seed
 *     determinism pair.
 *
 * Determinism: every draw comes from the sim's own seeded RNG and fixed tick
 * size, so the same inputs print the same lines on any machine.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Simulation } from '../src/sim/Simulation';
import { hashSimulation } from '../src/sim/debug/StateHash';
import { SIM_TICK, SOL_SECONDS } from '../src/sim/config';
import { ALL_RESOURCES, type BuildingKind } from '../src/sim/defs';

/** Ticks per trace sample — 4 ticks at the fixed 20 Hz step. */
const SAMPLE_EVERY = 4;
/** Sols of scripted colony per seed. */
const SOLS = 2;
const TICKS = 20 * SOL_SECONDS * SOLS;
const CHECKPOINTS = 6;

const args = process.argv.slice(2);
const outPath = args.includes('--write') ? args[args.indexOf('--write') + 1] : null;
const checkPath = args.includes('--check') ? args[args.indexOf('--check') + 1] : null;

/** FNV-1a over a sample string — cheap, order-sensitive, stable across runs. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** First legal spot on a ring around the base — the API refuses illegal ground. */
function findSpot(sim: Simulation, kind: BuildingKind): { x: number; z: number } {
  for (let r = 34; r <= 120; r += 3) {
    for (let a = 0; a < 360; a += 7) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      if (sim.canPlace(kind, x, z) === null) return { x, z };
    }
  }
  throw new Error(`no legal spot for ${kind}`);
}

function placeOnline(sim: Simulation, kind: BuildingKind): void {
  const spot = findSpot(sim, kind);
  const b = sim.placeBuilding(kind, spot.x, spot.z);
  if (!b) throw new Error(`${kind} refused to site`);
  sim.devCompleteBuilding(b.id);
}

/** Everything a rover's future depends on, as one line. */
function sampleRovers(sim: Simulation): string {
  const rovers = sim.rovers
    .map((r) =>
      [
        r.id,
        r.x.toFixed(3),
        r.z.toFixed(3),
        r.heading.toFixed(3),
        r.battery.toFixed(3),
        r.condition.toFixed(2),
        r.phase,
        r.goal,
        r.navI,
        r.recharge ? 1 : 0,
        r.sheltered ? 1 : 0,
        r.routePaused ? 1 : 0,
        r.lightsActive ? 1 : 0,
        r.command.type,
        r.pending.map((t) => t.type).join('|'),
        ALL_RESOURCES.map((res) => r.cargo[res].toFixed(1)).join(','),
      ].join(':'),
    )
    .join(';');
  const storage = ALL_RESOURCES.map((res) => sim.storage[res].toFixed(2)).join(',');
  return `${rovers}|${storage}`;
}

type Sampler = (sim: Simulation, tick: number) => void;

/** A fixed opening, then a scripted colony that exercises every dispatch path. */
function scenario(seed: number, onTick: Sampler): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls(); // storms are scripted, not rolled

  for (const kind of ['warehouse', 'solar', 'battery', 'extractor'] as BuildingKind[]) {
    placeOnline(sim, kind);
  }
  const [a, b] = sim.rovers;
  const ice = sim.world.deposits
    .filter((d) => d.resource === 'ice' && d.amount > 0)
    .sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z))[0];
  sim.issueMine(a.id, ice.id, true); // a player haul route
  sim.issueWait(b.id, 30, true); // …with a queued hold behind it

  /**
   * The script walks the fleet through every dispatch path, in the order the
   * tick consults them: a storm (shelter, then the maintenance pass), a rover
   * flat in the field with a free volunteer (the rescue pass), a new site (the
   * construction hold-back), rising dust (cleaning), and finally a quiet hour
   * with nobody under orders, when the automation does all the work itself.
   */
  let volunteerSpawned = false;
  for (let tick = 0; tick < TICKS; tick++) {
    if (tick === Math.round(TICKS * 0.2)) sim.devForceStorm('regional');
    if (tick === Math.round(TICKS * 0.35)) sim.devClearStorms();
    if (tick === Math.round(TICKS * 0.5)) {
      sim.issueMove(b.id, 260, -180);
      b.battery = 0.5; // flat in the field: the rescue pass must answer
    }
    if (!volunteerSpawned && b.phase === 'disabled') {
      // Spawn the volunteer the moment the victim strands, so the rescue pass
      // gets to answer before the haul pass can claim it.
      sim.devSpawnRover('utility', 30, 0);
      volunteerSpawned = true;
    }
    if (tick === Math.round(TICKS * 0.62)) placeOnline(sim, 'garage');
    if (tick === Math.round(TICKS * 0.75)) sim.devSetDust(0.9);
    if (tick === Math.round(TICKS * 0.78)) {
      // Dust-caked array: a routine cleaning job for the maintenance pass.
      for (const b of sim.buildings) if (b.kind === 'solar') b.cleanliness = 0.5;
    }
    if (tick === Math.round(TICKS * 0.82)) {
      // A storm-damaged structure: a survival-priority repair job.
      for (const b of sim.buildings) {
        if (b.kind === 'garage') {
          b.damaged = true;
          b.health = 40;
        }
      }
    }
    if (tick === Math.round(TICKS * 0.85)) {
      // Nobody under orders: whatever happens now, the fleet chose it.
      for (const r of sim.rovers) sim.stopRover(r.id);
    }
    sim.step(SIM_TICK);
    onTick(sim, tick);
  }
  return sim;
}

/** Run one seed and return the lines the A/B compares. */
function runSeed(seed: number): string[] {
  const lines: string[] = [];
  let trace = '';
  let samples = 0;
  const perCheckpoint = Math.floor(TICKS / CHECKPOINTS);

  const sim = scenario(seed, (s, tick) => {
    if (tick % SAMPLE_EVERY === 0) {
      trace += sampleRovers(s) + '\n';
      samples++;
    }
    if (tick % perCheckpoint === 0) {
      const cp = tick / perCheckpoint;
      lines.push(
        `[seed ${seed}] cp${cp} t=${s.simTime.toFixed(1)}s sol=${s.clock.sol} state=${hashSimulation(s)}`,
      );
    }
  });

  lines.push(`[seed ${seed}] trace=${fnv1a(trace)} samples=${samples}`);

  // Restore equality: two restores of one mid-run save must stay identical as
  // they run. (Not "restored == live at the save instant": a round trip
  // deliberately drops derived runtime state — history, flow windows, per-tick
  // power readings — and the hash covers those.) This is the pair that catches
  // shared state between a live sim and its snapshot, i.e. the weather-aliasing
  // trap recorded in the Phase 5 notes.
  const save = structuredClone(sim.snapshot());
  const restored = new Simulation({ seed, nearDeposits: 0.2 });
  restored.restore(save);
  const second = new Simulation({ seed, nearDeposits: 0.2 });
  second.restore(structuredClone(save));
  for (let i = 0; i < 600; i++) {
    restored.step(SIM_TICK);
    second.step(SIM_TICK);
  }
  lines.push(
    `[seed ${seed}] restore600=${hashSimulation(restored) === hashSimulation(second) ? 'same' : 'drifted'}`,
  );

  // Determinism: same seed, same script, same colony.
  const twin = scenario(seed, () => {});
  lines.push(
    `[seed ${seed}] determinism=${hashSimulation(sim) === hashSimulation(twin) ? 'equal' : 'differs'}`,
  );
  return lines;
}

function main(): void {
  const lines: string[] = [];
  for (const seed of [11, 24]) lines.push(...runSeed(seed));

  const text = lines.join('\n') + '\n';
  if (outPath) {
    writeFileSync(outPath, text);
    console.log(`wrote ${outPath}`);
  }
  if (checkPath) {
    const expected = readFileSync(checkPath, 'utf8');
    if (expected === text) {
      console.log('behavior baseline: identical');
      process.exit(0);
    }
    const a = expected.split('\n');
    const b = text.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`behavior baseline: DIFFERS at line ${i + 1}`);
        console.log(`  before: ${a[i] ?? '<missing>'}`);
        console.log(`  after:  ${b[i] ?? '<missing>'}`);
        break;
      }
    }
    process.exit(1);
  }
  if (!outPath && !checkPath) console.log(text.trimEnd());
}

main();
