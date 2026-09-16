/**
 * @suite sim/state-hash
 * @group unit
 * @covers src/sim/debug/StateHash.ts src/sim/Simulation.ts
 * @desc Milestone 1's deterministic state hash: same seed + commands + time
 * must hash identically, every state mutation must hash differently, and a
 * save round-trip must rebuild the same state. This is the comparison tool
 * the extraction phases will be policed with.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { run, build, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 7): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

/** Drive a sim through a fixed command script — a miniature transcript. */
function scriptedRun(seed: number): Simulation {
  const sim = fresh(seed);
  const dep = nearDeposit(sim, 'iron');
  sim.step(0.05);
  if (dep) sim.issueMine(sim.rovers[0].id, dep.id);
  sim.issueMove(sim.rovers[1].id, 40, -30, true);
  run(sim, 0.2);
  sim.issueWait(sim.rovers[1].id, 60);
  run(sim, 0.05);
  return sim;
}

group('Determinism');

test('the format is stable and self-describing', () => {
  assert.match(hashSimulation(fresh()), /^rf1-[0-9a-f]{14}-[0-9a-f]{14}$/);
});

test('identical seed and drive hash identically', () => {
  const a = scriptedRun(777);
  const b = scriptedRun(777);
  assert.equal(hashSimulation(a), hashSimulation(b));
});

test('hashing is repeatable on the same state', () => {
  const sim = scriptedRun(31);
  const h = hashSimulation(sim);
  assert.equal(hashSimulation(sim), h, 'hashing must be a pure read');
});

test('a different seed hashes differently', () => {
  assert.notEqual(hashSimulation(fresh(1)), hashSimulation(fresh(2)));
});

test('a divergent command history hashes differently', () => {
  const a = fresh(55);
  const b = fresh(55);
  b.issueMove(b.rovers[0].id, 120, 80);
  run(a, 0.1);
  run(b, 0.1);
  assert.notEqual(hashSimulation(a), hashSimulation(b));
});

test('time alone changes the hash', () => {
  const sim = fresh();
  const before = hashSimulation(sim);
  run(sim, 0.05);
  assert.notEqual(hashSimulation(sim), before);
});

group('Sensitivity');

test('every state family moves the hash', () => {
  const sim = fresh(123);
  build(sim, 'solar');
  run(sim, 0.1);
  const dep = nearDeposit(sim, 'iron');
  assert.ok(dep, 'test world must have an iron seam');
  const poi = sim.world.pois[0];
  const b = sim.buildings[sim.buildings.length - 1];
  const r = sim.rovers[0];

  // Each case mutates exactly one thing; the restore puts back the exact old
  // value (inverse arithmetic would leave float error and defeat the final
  // back-to-baseline comparison).
  const cases: Array<[string, () => () => void]> = [
    ['rover battery', () => { const o = r.battery; r.battery = o + 1; return () => { r.battery = o; }; }],
    ['rover cargo', () => { const o = r.cargo.iron; r.cargo.iron = o + 1; return () => { r.cargo.iron = o; }; }],
    ['rover condition', () => { const o = r.condition; r.condition = o - 1; return () => { r.condition = o; }; }],
    ['rover position', () => { const o = r.x; r.x = o + 0.5; return () => { r.x = o; }; }],
    ['rover queue', () => { r.pending.push({ type: 'wait', seconds: 5 }); return () => { r.pending.pop(); }; }],
    ['rover rules', () => { const o = r.rules.chargeFloorPct; r.rules.chargeFloorPct = o + 1; return () => { r.rules.chargeFloorPct = o; }; }],
    ['building progress', () => { const o = b.progress; b.progress = o === 0.5 ? 0.25 : 0.5; return () => { b.progress = o; }; }],
    ['building health', () => { const o = b.health; b.health = o - 1; return () => { b.health = o; }; }],
    ['storage', () => { const o = sim.storage.iron; sim.storage.iron = o + 1; return () => { sim.storage.iron = o; }; }],
    ['fluids', () => { const o = sim.pools.amounts.water; sim.pools.amounts.water = o + 0.1; return () => { sim.pools.amounts.water = o; }; }],
    ['grid battery', () => { const o = sim.storedKWh; sim.storedKWh = o + 0.1; return () => { sim.storedKWh = o; }; }],
    ['colonist health', () => { const o = sim.colonist.health; sim.colonist.health = o - 1; return () => { sim.colonist.health = o; }; }],
    ['colonist suit', () => { const o = sim.colonist.suitO2; sim.colonist.suitO2 = o - 0.01; return () => { sim.colonist.suitO2 = o; }; }],
    ['deposit amount', () => { const o = dep!.amount; dep!.amount = o - 1; return () => { dep!.amount = o; }; }],
    ['deposit reservation', () => { const o = dep!.reservedBy; dep!.reservedBy = r.id; return () => { dep!.reservedBy = o; }; }],
    ['poi salvage', () => { const o = poi.energyKWh; poi.energyKWh = o + 1; return () => { poi.energyKWh = o; }; }],
    ['poi discovery', () => { const o = poi.discovered; poi.discovered = !o; return () => { poi.discovered = o; }; }],
    ['drop schedule', () => { const o = sim.nextDropSol; sim.nextDropSol = o + 0.5; return () => { sim.nextDropSol = o; }; }],
    ['clock', () => { const o = sim.clock.frac; sim.clock.frac = (o + 0.01) % 1; return () => { sim.clock.frac = o; }; }],
    ['sim time', () => { const o = sim.simTime; sim.simTime = o + 0.05; return () => { sim.simTime = o; }; }],
  ];

  const baseline = hashSimulation(sim);
  for (const [name, mutate] of cases) {
    const restore = mutate();
    try {
      assert.notEqual(hashSimulation(sim), baseline, `${name} must move the hash`);
    } finally {
      restore();
    }
  }
  assert.equal(hashSimulation(sim), baseline, 'restores must return to the exact state');
});

test('presentation wording does not move the hash', () => {
  const sim = fresh();
  const baseline = hashSimulation(sim);
  sim.rovers[0].statusText = 'completely different words';
  sim.colonist.name = 'Someone Else';
  if (sim.buildings[0]) sim.buildings[0].idleReason = 'other phrasing';
  assert.equal(hashSimulation(sim), baseline, 'labels and reasons are presentation');
});

group('Persistence round-trip');

test('two restorations of one save continue in lockstep', () => {
  // A save deliberately drops in-flight runtime (rovers resume at rest), so
  // the meaningful restore assertion is that two colonies rebuilt from the
  // same save then advance identically — not that they equal the live sim
  // at the instant of the load.
  const source = fresh(909);
  build(source, 'solar');
  const dep = nearDeposit(source, 'iron');
  if (dep) source.issueMine(source.rovers[0].id, dep.id);
  run(source, 0.1);
  const save = JSON.stringify(source.snapshot());

  const a = fresh(1);
  const b = fresh(2); // different starting worlds — the restore must win
  a.restore(JSON.parse(save));
  b.restore(JSON.parse(save));
  assert.equal(hashSimulation(a), hashSimulation(b), 'the restore itself is deterministic');

  run(a, 0.1);
  run(b, 0.1);
  assert.equal(hashSimulation(a), hashSimulation(b), 'restored colonies stay in lockstep');
});

group('Integration');

test('a busy colony still hashes identically across runs', () => {
  const drive = (): string => {
    const sim = fresh(2026);
    build(sim, 'warehouse');
    build(sim, 'solar');
    const dep = nearDeposit(sim, 'iron');
    if (dep) sim.issueMine(sim.rovers[0].id, dep.id);
    run(sim, 0.5);
    return hashSimulation(sim);
  };
  assert.equal(drive(), drive());
});

await finish('sim/state-hash');
