/**
 * @suite sim/build
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/World.ts src/sim/defs.ts
 * @desc Sites, materials and silos: placement, delivery, refunds, per-resource storage
 * bounds, and the rovers that feed the queue.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ALL_RESOURCES } from '../../src/sim/defs';
import { nearDeposit, run, build, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Construction & logistics');

test('materials flow into a site without a rover parked on it', () => {
  const sim = new Simulation({ seed: 3, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = 300;
  const b = build(sim, 'warehouse');
  sim.step(1 / 20);
  const site = sim.buildingById(b.id)!;
  let remaining = 0;
  for (const r of ALL_RESOURCES) remaining += site.remainingCost[r];
  assert.equal(remaining, 0, 'a stocked site should absorb its materials immediately');
});

test('a warehouse can be built and increases storage capacity', () => {
  const sim = new Simulation({ seed: 3, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = 300;
  const baseCap = sim.storageCapacity();
  buildAndWait(sim, 'warehouse');
  assert.ok(sim.storageCapacity() > baseCap, 'storage capacity did not grow');
});

test('cancelling a site refunds the materials already delivered', () => {
  const sim = new Simulation({ seed: 4, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = sim.storageCapacity();
  const before = sim.storageTotal();
  const b = build(sim, 'warehouse');
  sim.step(1 / 20); // materials get committed
  assert.ok(sim.storageTotal() < before, 'materials should have left storage');
  sim.demolish(b.id);
  assert.ok(
    Math.abs(sim.storageTotal() - before) < 1,
    'cancelling should return the delivered materials',
  );
});

test('rovers automatically fetch what the build queue is short of', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  build(sim, 'warehouse');
  run(sim, 2);
  assert.ok(
    sim.storage.regolith > 0 || sim.storage.iron > 0,
    'idle rovers should have hauled something toward the site',
  );
});

test('mining extracts ore into colony storage', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.18 });
  const dep = nearDeposit(sim, 'iron')!;
  sim.issueMine(sim.rovers[0].id, dep.id);
  const before = dep.amount;
  run(sim, 2);
  assert.ok(dep.amount < before, 'the deposit should have been worked');
  assert.ok(sim.storage.iron > 0, 'iron should have reached storage');
});

test('storage is bounded per resource, and one full silo does not block others', () => {
  const sim = new Simulation({ seed: 5, nearDeposits: 0.18 });
  sim.storage.regolith = 1e9;
  sim.recomputeCapacities();
  assert.equal(sim.storageRoom('regolith'), 0, 'regolith silo should be full');
  assert.ok(sim.storageRoom('iron') > 0, 'a full regolith silo must not block iron');
  assert.ok(!sim.storageFull(), 'the colony is not full while any silo has room');
});

await finish('sim/build');
