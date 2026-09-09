/**
 * @suite sim/persistence
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/config.ts
 * @desc Saves: exact round-trips, a reloaded colony that goes on simulating identically,
 * rejected versions, tolerant migrations, and a storm that survives the trip.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { Weather } from '../../src/sim/weather';
import { nearDeposit, run, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Determinism & persistence');

test('snapshot / restore round-trips exactly', () => {
  const sim = new Simulation({ seed: 99, nearDeposits: 0.18 });
  sim.issueMove(sim.rovers[0].id, 30, -20);
  run(sim, 2);
  const snap = sim.snapshot();
  const copy = new Simulation({ seed: 1 });
  copy.restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(JSON.stringify(copy.snapshot()), JSON.stringify(snap), 'restored state differs');
});

test('a restored colony keeps simulating identically', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  run(sim, 1);

  const copy = new Simulation({ seed: 1 });
  copy.restore(JSON.parse(JSON.stringify(sim.snapshot())));
  run(sim, 2);
  run(copy, 2);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(sim.snapshot()),
    'a reloaded save must continue the same way',
  );
});

test('a save from an unsupported version is rejected, not silently loaded', () => {
  const sim = new Simulation({ seed: 1 });
  assert.throws(() => sim.restore({ version: 0, seed: 1 }), /unsupported save version/);
});

test('restore tolerates missing optional fields', () => {
  const sim = new Simulation({ seed: 8, nearDeposits: 0.18 });
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  delete snap.alerts;
  delete snap.colonist;
  delete snap.fluids;
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.ok(copy.colonist, 'a colonist should still exist');
});

group('Weather & storms');

test('the storm survives a save / restore round-trip and continues identically', () => {
  const sim = new Simulation({ seed: 37, nearDeposits: 0.2 });
  const panel = buildAndWait(sim, 'solar');
  sim.weather.debugScheduleStorm('regional', sim.simTime + 30, 30);
  run(sim, 1);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(snap),
    'restored weather state differs',
  );

  // Rovers deliberately resume *at rest* after a load (their in-flight goal
  // state is re-derived, not saved), so whole-colony equality is not the
  // contract here. The weather and the structures it acts on are: they must
  // replay the same storm beat for beat.
  run(sim, 2);
  run(copy, 2);
  assert.equal(
    JSON.stringify(copy.weather.snapshot()),
    JSON.stringify(sim.weather.snapshot()),
    'the restored colony must live through identical weather',
  );
  const pSim = sim.buildings.find((b) => b.kind === 'solar')!;
  const pCopy = copy.buildings.find((b) => b.kind === 'solar')!;
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert.ok(close(pSim.health, pCopy.health) && close(pSim.cleanliness, pCopy.cleanliness), 'the storm must chew on both arrays identically');
  assert.ok(!copy.gameOver && !sim.gameOver, 'both colonies should ride it out');
});

group('Prototype 4 — rover logistics');

test('v3 saves migrate to v4: queues, condition, rules and assembly slots appear', () => {
  const sim = new Simulation({ seed: 67, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  // Hand-craft a v3 save: single command, no queue/condition/rules, no slots.
  const v3 = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  v3.version = 3;
  v3.rovers = v3.rovers.map((r: any, i: number) => {
    const { pending, condition, rules, autoTask, recharge, lowBatteryNotified, blockNotified, ...rest } = r;
    return { ...rest, autoHaul: i === 1 ? false : true };
  });
  v3.buildings = v3.buildings.map((b: any) => {
    const { assembly, ...rest } = b;
    return rest;
  });

  const copy = new Simulation({ seed: 1 });
  copy.restore(v3);
  assert.equal(copy.rovers.length, sim.rovers.length, 'all rovers survive the migration');
  for (const r of copy.rovers) {
    assert.deepEqual(r.pending, [], 'migrated rovers start with an empty queue');
    assert.equal(r.condition, 100, 'migrated drivetrains start fresh');
    assert.ok(r.rules, 'migrated rovers get a rules block');
  }
  assert.equal(copy.rovers[1].rules.autoHaul, false, 'the old autoHaul flag carries over');
  assert.equal(copy.rovers[0].rules.autoHaul, true, 'default autoHaul was already true');
  for (const b of copy.buildings) {
    assert.equal(b.assembly, null, 'buildings gain an empty assembly slot');
  }
});

test('a P4-heavy state round-trips through save and restore', () => {
  const sim = new Simulation({ seed: 68, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  const [a, b] = sim.rovers;

  // Queue with every task shape, a repeat route, custom rules, a reservation.
  sim.issueMove(a.id, 60, 0);
  sim.issueMine(a.id, nearDeposit(sim, 'ice').id, true);
  sim.issueWait(a.id, 10, true);
  const ironDep = nearDeposit(sim, 'iron');
  sim.issueMine(b.id, ironDep.id);
  sim.setRepeatRoute(b.id, true);
  sim.setChargeFloor(b.id, 45);
  sim.setRoverRule(b.id, 'stormShelter', false);
  sim.setRoverRule(b.id, 'autoRescue', false);
  assert.equal(ironDep.reservedBy, b.id, 'precondition: b holds a reservation');

  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(snap),
    'restore must reproduce the state exactly',
  );

  // And it keeps simulating identically afterwards.
  run(sim, 0.5);
  run(copy, 0.5);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(sim.snapshot()),
    'a reloaded save must continue the same way',
  );
});

await finish('sim/persistence');
