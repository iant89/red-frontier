/**
 * @suite sim/bottlenecks
 * @group unit
 * @covers src/sim/bottlenecks/analyzer.ts src/sim/bottlenecks/types.ts src/sim/bottlenecks/solutions.ts src/sim/host/projection.ts src/sim/host/mirror.ts
 * @desc Phase 5 — the pure bottleneck analyzer: three kinds (water, oxygen,
 * power), measured causes, static advice, ranked worst-first. Nothing it
 * says crosses back as a command; the same colony analyzed twice says the
 * same thing, across both transports, in plain JSON.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { bottleneckSnapshot } from '../../src/sim/bottlenecks/analyzer';
import { STATIC_SOLUTIONS } from '../../src/sim/bottlenecks/solutions';
import type { BottleneckReport } from '../../src/sim/bottlenecks/types';
import { ColonyMirror } from '../../src/sim/host/mirror';
import { projectView } from '../../src/sim/host/projection';
import { group, test, finish } from '../harness';
import { findSpot, run } from '../fixtures/sim';

type PlaceableKind = Parameters<typeof findSpot>[1];

/** Place a building and force it online (construction is not this suite's subject). */
function placeOnline(sim: Simulation, kind: PlaceableKind) {
  const spot = findSpot(sim, kind);
  const b = sim.placeBuilding(kind, spot.x, spot.z);
  assert.ok(b, `${kind} placement failed`);
  assert.ok(sim.devCompleteBuilding(b.id), `${kind} could not be completed for setup`);
  return b;
}

function reportFor(snap: ReturnType<typeof bottleneckSnapshot>, kind: string): BottleneckReport | undefined {
  return snap.bottlenecks.find((b) => b.kind === kind);
}

// ------------------------------------------------------------- healthy ----

group('a healthy colony has nothing to advise');

test('fresh colony after a quarter sol: no bottlenecks, no next', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.25);
  const snap = bottleneckSnapshot(sim.state);
  assert.deepEqual(snap.bottlenecks, []);
  assert.equal(snap.next, null);
});

test('full tanks and a fed grid stay quiet', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.25);
  for (const f of ['water', 'oxygen', 'food'] as const) {
    sim.state.pools.amounts[f] = sim.state.pools.capacity[f];
  }
  const snap = bottleneckSnapshot(sim.state);
  assert.deepEqual(snap.bottlenecks, [], 'a colony with full reserves is described, never advised');
});

// --------------------------------------------------------------- water ----

group('water: the mock, measured');

test('starved water raises a critical water bottleneck with real causes', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.25);
  sim.state.pools.amounts.water = 2;
  run(sim, 0.05);
  const snap = bottleneckSnapshot(sim.state);
  const water = reportFor(snap, 'water');
  assert.ok(water, 'the shortage is named');
  assert.equal(water.title, 'WATER BOTTLENECK');
  assert.equal(water.severity, 'critical');
  assert.equal(water.unit, 'kg');
  assert.ok(water.consumptionPerSol > 0, 'the colonist drinks every tick');
  assert.ok(
    water.projectedShortageSols != null && water.projectedShortageSols < 1,
    'the mock\'s "Projected shortage: 3.2 sols" line, under one sol here',
  );
  const factorKeys = water.factors.map((f) => f.key);
  assert.ok(factorKeys.includes('no-producer'), 'nothing makes the first drop');
  assert.ok(factorKeys.includes('feed/empty'), 'and the silo confirms it');
  const solutionKeys = water.solutions.map((s) => s.key);
  assert.ok(solutionKeys.includes('build-producer'), 'the concrete fix first');
  assert.ok(solutionKeys.includes('haul-ice'), 'the roadmap\'s "Increase mining"');
  assert.ok(solutionKeys.includes('cut-consumption'), 'the roadmap\'s "Reduce consumption"');
  assert.ok(solutionKeys.includes('build-storage'), 'the roadmap\'s "Build storage"');
  assert.equal(snap.next, snap.bottlenecks[0], 'next is the worst one');
});

test('a damaged extractor is the cause, and the solution is its repair', () => {
  const sim = new Simulation({ seed: 9001 });
  const ex = placeOnline(sim, 'extractor');
  run(sim, 0.2);
  ex.damaged = true;
  sim.state.pools.amounts.water = 3;
  run(sim, 0.05);
  const water = reportFor(bottleneckSnapshot(sim.state), 'water');
  assert.ok(water);
  const factor = water.factors.find((f) => f.key === `damaged/${ex.id}`);
  assert.ok(factor, 'the machine is named');
  assert.match(factor.label, /Water Extractor #\d+ damaged — tripped offline/);
  assert.equal(factor.entityId, ex.id, 'the row can focus it');
  const repair = water.solutions.find((s) => s.key === `repair/${ex.id}`);
  assert.ok(repair, 'the roadmap\'s "Repair Rover 3" echo, for the machine');
  assert.equal(repair.entityId, ex.id);
  assert.ok(!water.factors.some((f) => f.key === 'no-producer'), 'the source stands — it is hurt, not missing');
});

test('a switched-off extractor suggests switching it back on', () => {
  const sim = new Simulation({ seed: 9001 });
  const ex = placeOnline(sim, 'extractor');
  run(sim, 0.2);
  ex.enabled = false;
  sim.state.pools.amounts.water = 3;
  run(sim, 0.05);
  const water = reportFor(bottleneckSnapshot(sim.state), 'water');
  assert.ok(water);
  assert.ok(water.factors.some((f) => f.key === `disabled/${ex.id}`));
  assert.ok(water.solutions.some((s) => s.key === `switch-on/${ex.id}` && s.entityId === ex.id));
});

test('factors and solutions stay within the mock\'s proportions', () => {
  const sim = new Simulation({ seed: 9001 });
  // Six damaged extractors: plenty of causes, and the card still caps.
  for (let i = 0; i < 6; i++) {
    const ex = placeOnline(sim, 'extractor');
    ex.damaged = true;
  }
  sim.state.pools.amounts.water = 3;
  run(sim, 0.05);
  const water = reportFor(bottleneckSnapshot(sim.state), 'water');
  assert.ok(water);
  assert.ok(water.factors.length <= 4, `4 factors max, got ${water.factors.length}`);
  assert.ok(water.solutions.length <= 4, `4 solutions max, got ${water.solutions.length}`);
});

// -------------------------------------------------------------- oxygen ----

group('oxygen: breath is made of water');

test('when water fails first, oxygen is named as the symptom, not the cause', () => {
  const sim = new Simulation({ seed: 9001 });
  placeOnline(sim, 'oxygenator');
  run(sim, 0.2);
  sim.state.pools.amounts.water = 0.5;
  sim.state.pools.amounts.oxygen = 0.5;
  run(sim, 0.05);
  const snap = bottleneckSnapshot(sim.state);
  const oxygen = reportFor(snap, 'oxygen');
  assert.ok(oxygen, 'breath running short is a bottleneck');
  assert.ok(oxygen.factors.some((f) => f.key === 'feed/water'), 'the feed problem is named');
  assert.ok(oxygen.solutions.some((s) => s.key === 'fix-feed'), '"Fix water first" outranks "make more O₂"');
  // And water itself, the actual deficit, is there too.
  assert.ok(reportFor(snap, 'water'), 'the water report stands beside it');
});

// --------------------------------------------------------------- power ----

group('power: the grid keeps its own books');

test('a drained reserve is a warning; near-empty is critical', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.1);
  // 10% of the pod's pack: the night is not survivable, but not yet tonight.
  sim.state.storedKWh = sim.state.power.capacityKWh * 0.1;
  sim.state.power.storedKWh = sim.state.storedKWh;
  let power = reportFor(bottleneckSnapshot(sim.state), 'power');
  assert.ok(power, '10% reserve is advice-worthy');
  assert.equal(power.severity, 'warning');
  assert.ok(power.factors.some((f) => f.key === 'reserve/low'));

  const sim2 = new Simulation({ seed: 9001 });
  run(sim2, 0.1);
  sim2.state.storedKWh = sim2.state.power.capacityKWh * 0.04;
  sim2.state.power.storedKWh = sim2.state.storedKWh;
  power = reportFor(bottleneckSnapshot(sim2.state), 'power');
  assert.ok(power, '4% reserve is louder');
  assert.equal(power.severity, 'critical');
});

test('a measured demand/generation gap names both numbers', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.1);
  // Pure read: the analyzer checks whatever the grid measured this tick.
  sim.state.power.demandKw = 20;
  sim.state.power.generationKw = 8;
  sim.state.power.batteryFlowKw = -5;
  sim.state.power.brownout = true;
  sim.state.power.storedKWh = 30;
  sim.state.storedKWh = 30;
  const power = reportFor(bottleneckSnapshot(sim.state), 'power');
  assert.ok(power);
  const deficit = power.factors.find((f) => f.key === 'deficit');
  assert.ok(deficit, 'the gap is the headline cause');
  assert.match(deficit.label, /20\.0 kW wanted · 8\.0 kW made/);
  // 30 kWh at a 5 kW drain is 6 hours ≈ 0.24 sols of runway.
  assert.ok(power.projectedShortageSols != null);
  assert.ok(Math.abs(power.projectedShortageSols - 6 / 24.6597) < 0.01, 'runway converts hours to sols');
});

test('a battery that dies before dawn says so, at night only', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.1);
  (sim as unknown as { devSetTime: (sol: number, frac: number) => void }).devSetTime(0, 0.9);
  sim.state.power.batteryFlowKw = -4;
  sim.state.power.storedKWh = 6; // 1.5h ≈ 0.06 sols — the night has 0.35 left
  sim.state.storedKWh = 6;
  sim.state.power.demandKw = 14;
  sim.state.power.generationKw = 10;
  const power = reportFor(bottleneckSnapshot(sim.state), 'power');
  assert.ok(power);
  const night = power.factors.find((f) => f.key === 'night/runs-out');
  assert.ok(night, 'the dead-of-night forecast is a factor');
  assert.match(night.label, /runs out before dawn/);
});

test('only the pod pack prompts for battery advice', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.1);
  sim.state.storedKWh = sim.state.power.capacityKWh * 0.1;
  sim.state.power.storedKWh = sim.state.storedKWh;
  const power = reportFor(bottleneckSnapshot(sim.state), 'power');
  assert.ok(power);
  assert.ok(power.factors.some((f) => f.key === 'storage/pod-only'));
  assert.ok(power.solutions.some((s) => s.key === 'add-battery'));
});

// ---------------------------------------------------------- advice tone ----

group('the solutions are advice, never action');

test('every solution table row is concrete nouns and verbs, no commands', () => {
  for (const rows of Object.values(STATIC_SOLUTIONS)) {
    assert.ok(rows.length >= 3, 'each kind offers more than one door');
    for (const row of rows) {
      assert.ok(row.key.length > 0 && row.label.length > 10, 'a solution is a sentence, not a button id');
    }
  }
});

// --------------------------------------------------------------- ranking ----

group('ranking is severity, then the clock, then triage');

test('critical oxygen outranks warning water', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.25);
  // Oxygen gone by dawn; water merely tight.
  sim.state.pools.amounts.oxygen = 0.2;
  sim.state.pools.amounts.water = 8;
  run(sim, 0.05);
  const snap = bottleneckSnapshot(sim.state);
  assert.ok(snap.bottlenecks.length >= 2, 'both shortages are named');
  assert.equal(snap.bottlenecks[0].kind, 'oxygen', 'breath comes before water');
  assert.equal(snap.next, snap.bottlenecks[0]);
});

// ------------------------------------------------------------ determinism ----

group('the analyzer is pure and boundary-safe');

test('the same state reports identically twice, in plain JSON', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.2);
  sim.state.pools.amounts.water = 3;
  sim.state.pools.amounts.oxygen = 0.4;
  sim.state.storedKWh = sim.state.power.capacityKWh * 0.1;
  sim.state.power.storedKWh = sim.state.storedKWh;
  run(sim, 0.02);
  const a = bottleneckSnapshot(sim.state);
  const b = bottleneckSnapshot(sim.state);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same colony, same advice');
  const roundTripped = JSON.parse(JSON.stringify(a));
  assert.deepEqual(roundTripped, a, 'no Infinity, no Map, no undefined — the worker can carry it');
  assert.ok(a.bottlenecks.every((r) => r.projectedShortageSols === null || Number.isFinite(r.projectedShortageSols)));
});

test('both transports answer the same advisory', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.2);
  sim.state.pools.amounts.water = 2;
  run(sim, 0.02);
  const local = sim.bottlenecks; // the in-process getter
  const payload = projectView(sim, 'worker', {});
  assert.deepEqual(payload.bottlenecks, local, 'the payload is the same snapshot');
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    payload,
  );
  assert.deepEqual(mirror.bottlenecks, local, 'and the mirror serves it to the panel');
});

finish();
