/**
 * @suite sim/exploration-system
 * @group unit
 * @covers src/sim/systems/ExplorationSystem.ts src/sim/pois.ts src/sim/World.ts src/sim/Simulation.ts
 * @desc ExplorationSystem extraction (Phase 14): discovery radius, supply-drop
 * schedule and burial, site-side salvage rewards (takeSalvage / recoverSiteCells),
 * and the architecture guard that discovery + drop landing + burial write only
 * through ExplorationSystem — World still owns scatter; RoverSystem still owns
 * the salvage *task*.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import { ExplorationSystem } from '../../src/sim/systems/ExplorationSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import {
  POI_DISCOVER_M,
} from '../../src/sim/config';
import { POI_KINDS, isPickedClean, salvageTotalKg, makePoi } from '../../src/sim/pois';
import { ROVERS } from '../../src/sim/defs';
import { mulberry32 } from '../../src/lib/rng';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 55): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

function nearestSite(sim: Simulation) {
  return sim.world.pois
    .filter((p) => !isPickedClean(p) && p.kind !== 'settlementSite')
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
}

function parkAt(sim: Simulation, x: number, z: number) {
  const r = sim.rovers[0];
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.battery = ROVERS[r.kind].maxBatteryKWh;
  r.recharge = false;
  return r;
}

// ============================================================ discovery ====

group('Discovery');

test('ExplorationSystem.tickDiscovery reveals a site inside POI_DISCOVER_M and raises an opportunity', () => {
  const sim = fresh();
  const site = nearestSite(sim);
  assert.ok(site);
  assert.equal(site.discovered, false);

  const r = parkAt(sim, site.x + POI_DISCOVER_M + 12, site.z);
  ExplorationSystem.tickDiscovery(sim.state);
  assert.equal(site.discovered, false, 'outside the radius stays unknown');

  r.x = site.x + 6;
  ExplorationSystem.tickDiscovery(sim.state);
  assert.equal(site.discovered, true, 'arriving reveals it');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes(POI_KINDS[site.kind].label)),
    'a find is logged',
  );

  // Permanent: leaving does not un-find it.
  r.x = site.x + 400;
  ExplorationSystem.tickDiscovery(sim.state);
  assert.equal(site.discovered, true);
});

test('the colonist can discover a site the same way a rover can', () => {
  const sim = fresh();
  const site = nearestSite(sim);
  // Park every rover far away so only the colonist counts.
  for (const r of sim.rovers) {
    r.x = site.x + POI_DISCOVER_M + 80;
    r.z = site.z;
  }
  sim.colonist.x = site.x + 4;
  sim.colonist.z = site.z;
  ExplorationSystem.tickDiscovery(sim.state);
  assert.equal(site.discovered, true);
});

test('Simulation.pois / poiById read world.pois directly', () => {
  const sim = fresh();
  assert.equal(sim.pois, sim.world.pois);
  const site = sim.pois[0];
  assert.ok(site);
  assert.equal(sim.poiById(site.id), site);
  assert.equal(sim.poiById(-1), undefined);
});

// ========================================================= supply drops ====

group('Supply drops');

test('landSupplyDrop places a discovered supplyDrop and books the next mission', () => {
  const sim = fresh();
  const before = sim.world.pois.filter((p) => p.kind === 'supplyDrop').length;
  const nextBefore = sim.nextDropSol;
  ExplorationSystem.landSupplyDrop(sim.state);
  const drops = sim.world.pois.filter((p) => p.kind === 'supplyDrop' && !p.buried);
  assert.equal(drops.length, before + 1, 'one container on the ground');
  const drop = drops[drops.length - 1];
  assert.equal(drop.discovered, true, 'the transponder gives the bearing');
  assert.ok(drop.solsToBury > 0, 'the burial clock is running');
  assert.ok(sim.nextDropSol > nextBefore || sim.nextDropSol > 0, 'the next mission is booked');
  assert.ok(
    sim.alerts.history().some((e) => e.text.toLowerCase().includes('transponder')),
    'landing is announced',
  );
});

test('tickSupplyDrops buries a live drop when the clock runs out', () => {
  const sim = fresh();
  ExplorationSystem.landSupplyDrop(sim.state);
  const drop = sim.world.pois.find((p) => p.kind === 'supplyDrop' && !p.buried)!;
  assert.ok(drop);
  drop.solsToBury = 0.0001;
  // One tick of burial at calm weather is enough.
  sim.weather.debugSuppressRolls();
  ExplorationSystem.tickSupplyDrops(sim.state);
  assert.equal(drop.buried, true);
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('dust took')),
    'burial is announced',
  );
});

test('a recovered (picked-clean) drop clears its deadline alert without burying', () => {
  const sim = fresh();
  ExplorationSystem.landSupplyDrop(sim.state);
  const drop = sim.world.pois.find((p) => p.kind === 'supplyDrop' && !p.buried)!;
  // Raise the live alert once.
  ExplorationSystem.tickSupplyDrops(sim.state);
  assert.ok(sim.alerts.list().some((a) => a.key === `drop-live-${drop.id}`));

  // Strip it — the site side of salvage.
  for (const k of Object.keys(drop.salvage)) drop.salvage[k as keyof typeof drop.salvage] = 0;
  ExplorationSystem.tickSupplyDrops(sim.state);
  assert.equal(drop.buried, false, 'stripping is not burial');
  assert.ok(
    !sim.alerts.list().some((a) => a.key === `drop-live-${drop.id}`),
    'the deadline leaves the board',
  );
});

// ============================================== salvage rewards (site) ====

group('Site-side salvage rewards');

test('takeSalvage depletes the site by exactly what it reports', () => {
  const rng = mulberry32(9);
  const p = makePoi(1, 'meteorite', 100, 100, rng);
  const before = salvageTotalKg(p);
  const { takenKg, perResource } = ExplorationSystem.takeSalvage(p, 50, 26, 1);
  assert.ok(takenKg > 0 && takenKg <= 50);
  const reported = Object.values(perResource).reduce((a, b) => a + (b ?? 0), 0);
  assert.ok(Math.abs(reported - takenKg) < 1e-9);
  assert.ok(Math.abs(before - salvageTotalKg(p) - takenKg) < 1e-6);
});

test('recoverSiteCells hands surviving charge to the grid and zeros the site', () => {
  const sim = fresh();
  const rng = mulberry32(3);
  const p = makePoi(99, 'scienceCache', 0, 0, rng);
  p.energyKWh = 40;
  const before = sim.state.storedKWh;
  ExplorationSystem.recoverSiteCells(sim.state, p);
  assert.equal(p.energyKWh, 0);
  assert.ok(sim.state.storedKWh > before);
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('Recovered from the site')),
    'the reward is logged',
  );
});

test('RoverSystem.recoverSiteCells is a one-line forward to ExplorationSystem', () => {
  const sim = fresh();
  const rng = mulberry32(4);
  const p = makePoi(7, 'wreckRover', 0, 0, rng);
  p.energyKWh = 20;
  const before = sim.state.storedKWh;
  RoverSystem.recoverSiteCells(sim.state, p);
  assert.equal(p.energyKWh, 0);
  assert.ok(sim.state.storedKWh >= before);
});

test('a full grid store still clears the site cells and warns about the loss', () => {
  const sim = fresh();
  // Fill the batteries to the brim.
  const cap = sim.batteryCapacity();
  sim.state.storedKWh = cap;
  const rng = mulberry32(5);
  const p = makePoi(8, 'scienceCache', 0, 0, rng);
  p.energyKWh = 30;
  ExplorationSystem.recoverSiteCells(sim.state, p);
  assert.equal(p.energyKWh, 0, 'the site is emptied either way');
  assert.equal(sim.state.storedKWh, cap, 'nothing fitted');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('would not fit')),
    'the overflow is warned',
  );
});

// ============================================== wiring through the tick ====

group('Tick wiring');

test('Simulation.step runs ExplorationSystem — a nearby rover discovers without a direct call', () => {
  const sim = fresh();
  const site = nearestSite(sim);
  parkAt(sim, site.x + 4, site.z);
  assert.equal(site.discovered, false);
  run(sim, 0.05);
  assert.equal(site.discovered, true, 'the main loop tick discovers');
});

// ============================================== architecture guard ====

group('Architecture guard — discovery has one owner');

/**
 * Walk src/sim looking for the runtime mutations that *are* exploration:
 * marking a site discovered, burying a drop, landing via makeSupplyDrop in a
 * tick path, and advancing nextDropSol. World generation (makePoi) and the
 * save/restore path are allowed owners; the tick path must be ExplorationSystem.
 */
test('discovered / buried / nextDropSol tick writes live only in ExplorationSystem', () => {
  const simRoot = fileURLToPath(new URL('../../src/sim', import.meta.url));

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  const discoveredWriters = new Set<string>();
  const buriedWriters = new Set<string>();
  const nextDropWriters = new Set<string>();

  for (const file of walk(simRoot)) {
    const rel = relative(simRoot, file).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    if (/\.discovered\s*=/.test(src)) discoveredWriters.add(rel);
    if (/\.buried\s*=/.test(src)) buriedWriters.add(rel);
    // nextDropSol assignments (not reads / types)
    if (/nextDropSol\s*=/.test(src)) nextDropWriters.add(rel);
  }

  // Discovery / burial flags: only ExplorationSystem writes them at runtime.
  // Constructors (pois.ts) and save restore (Simulation → world.setPois) use
  // object literals (`discovered: false`), which this guard deliberately does
  // not match — same "element write vs whole-object write" split Phase 13 used.
  assert.deepEqual(
    [...discoveredWriters].sort(),
    ['systems/ExplorationSystem.ts'],
    `discovered writers: ${[...discoveredWriters].join(', ')}`,
  );
  assert.deepEqual(
    [...buriedWriters].sort(),
    ['systems/ExplorationSystem.ts'],
    `buried writers: ${[...buriedWriters].join(', ')}`,
  );

  // nextDropSol: ColonyState init/reset, ExplorationSystem land, Simulation
  // accessor/save path.
  const allowedNext = new Set([
    'systems/ExplorationSystem.ts',
    'state/ColonyState.ts',
    'Simulation.ts',
  ]);
  for (const f of nextDropWriters) {
    assert.ok(allowedNext.has(f), `unexpected nextDropSol= writer: ${f}`);
  }
  assert.ok(nextDropWriters.has('systems/ExplorationSystem.ts'));
});

test('World still owns scatter; ExplorationSystem does not call generatePois', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/ExplorationSystem.ts', import.meta.url)),
    'utf8',
  );
  // Mentions in the "does NOT live here" header are fine; a call is not.
  assert.ok(!/[^\w]generatePois\s*\(/.test(src), 'exploration must not regenerate the planet');
  assert.ok(src.includes('World generation'), 'header names the boundary');
  // A fresh world still has undiscovered sites — generation happened.
  const sim = fresh(31);
  assert.ok(sim.world.pois.length > 0);
  assert.ok(sim.world.pois.every((p) => !p.discovered || p.kind === 'supplyDrop'));
});

finish();
