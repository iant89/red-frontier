/**
 * @suite sim/rovers
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/defs.ts
 * @desc Rover orders: the task queue, WAIT, a repeating haul route parking on a full
 * silo, seam reservations, auto-haul spread across the fleet, unloading, and the
 * idle query.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ALL_RESOURCES, ROVERS } from '../../src/sim/defs';
import { SOL_SECONDS } from '../../src/sim/config';
import { nearDeposit, run, build, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Task queue & routes');

test('a queued task runs after the current one; a plain order replaces the queue', () => {
  const sim = new Simulation({ seed: 61, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  sim.issueMove(rv.id, 60, 0); // starts immediately
  sim.issueMove(rv.id, -60, 0, true); // queued behind it
  sim.issueWait(rv.id, 5, true); // queued behind that
  assert.equal(rv.pending.length, 2, 'two tasks should sit in the queue');
  assert.equal(rv.command.type, 'moveTo');

  // A non-queued order is a change of plans: the queue goes.
  sim.issueMove(rv.id, 0, 60);
  assert.equal(rv.pending.length, 0, 'a plain order must clear the queue');
  assert.equal(rv.command.type, 'moveTo');

  // Queued orders on an idle rover start immediately instead.
  sim.stopRover(rv.id);
  sim.issueMove(rv.id, 60, 0, true);
  assert.equal(rv.command.type, 'moveTo', 'a queued order to an idle rover starts now');
  assert.equal(rv.pending.length, 0);
});

test('a WAIT task holds position and finishes on schedule', () => {
  const sim = new Simulation({ seed: 61, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  sim.issueWait(rv.id, 3);
  assert.equal(rv.command.type, 'wait');
  assert.equal(rv.phase, 'idle', 'waiting is holding position, not working');
  run(sim, SOL_SECONDS * 0.1); // 24 game-seconds — comfortably past 3 s
  assert.equal(rv.command.type, 'idle', 'the wait should be over');
});

test('a repeat haul route parks when the silo is full and resumes when there is room', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  // Fill the ice silo so a haul route has nowhere to deliver.
  sim.storage.ice += sim.storageRoom('ice');
  sim.recomputeCapacities();
  assert.equal(sim.storageRoom('ice'), 0, 'precondition: ice silo is full');

  const dep = nearDeposit(sim, 'ice');
  const rv = sim.rovers[0];
  // Isolate the route logic from whatever the build phase left behind: a full
  // battery (no recharge detour) and an empty hold (no half-load to finish).
  rv.battery = ROVERS[rv.kind].maxBatteryKWh;
  for (const r of ALL_RESOURCES) rv.cargo[r] = 0;
  sim.issueMine(rv.id, dep.id);
  sim.setRepeatRoute(rv.id, true);
  run(sim, 0.1);
  assert.equal(rv.routePaused, true, 'the route should park at the depot');
  assert.equal(rv.command.type, 'mine', 'the route task survives the pause');
  assert.ok(rv.command.type === 'mine' && rv.command.repeat, 'and keeps its repeat flag');

  // Consumption frees silo space → the route sets out again.
  sim.storage.ice = 0;
  sim.recomputeCapacities();
  run(sim, 0.05);
  assert.equal(rv.routePaused, false, 'the route should resume');
  assert.notEqual(rv.phase, 'idle', 'and the rover should be moving or mining');
});

test('mining orders claim seams, and reservations follow the player', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  const [a, b] = sim.rovers;
  const dep = nearDeposit(sim, 'ice');
  sim.issueMine(a.id, dep.id);
  assert.equal(dep.reservedBy, a.id, 'a player order claims the seam');
  // A second player order may share the seam (people can coordinate);
  // the reservation follows the latest claim.
  sim.issueMine(b.id, dep.id);
  assert.equal(dep.reservedBy, b.id, 'the latest claimant holds the reservation');
});

test('auto-haul spreads the fleet without idling anyone over a reservation', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  // A build site creates genuine demand with empty storage.
  build(sim, 'warehouse');
  run(sim, 0.1);
  for (const rv of sim.rovers) {
    assert.equal(
      rv.command.type,
      'mine',
      `${rv.label} should have been auto-dispatched, got ${rv.command.type}`,
    );
  }
  // The reservation contract: each seam being worked is claimed by exactly
  // one rover — unless it is rich enough that sharing wastes nothing.
  for (const rv of sim.rovers) {
    if (rv.command.type !== 'mine') continue;
    const cmd = rv.command;
    const dep = sim.world.deposits.find((d) => d.id === cmd.depositId)!;
    const holder = dep.reservedBy;
    const rich = 2.5 * ROVERS[rv.kind].capacityKg;
    assert.ok(
      holder === rv.id || dep.amount > rich,
      `seam ${dep.id} (${dep.amount.toFixed(0)} kg) worked by ${rv.label} should be claimed (by ${holder}) or rich`,
    );
  }
});

group('Rover unload order');

test('an unload order pours the hold into storage', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  r.cargo.ice = 200;
  sim.issueUnload(r.id);
  sim.step(1 / 20); // a single tick: both starters spawn within depot reach
  assert.equal(r.command.type, 'idle', 'the task completes once the hold is empty');
  assert.ok(r.cargo.ice < 0.01, 'the hold should be empty');
  assert.equal(sim.storage.ice, 200, 'everything poured into storage');
});

test('unload with an empty hold says so and issues nothing', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  sim.drainEvents();
  sim.issueUnload(r.id);
  assert.equal(r.command.type, 'idle', 'no task should be issued');
  const evs = sim.drainEvents();
  assert.ok(
    evs.some((e) => e.text.includes('already empty')),
    'the player should get a log line, not silence',
  );
});

test('unload queues behind other orders and chains forward', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  for (const o of sim.rovers) o.rules.autoHaul = false; // the scheduler stays out of the queue
  const r = sim.rovers[0];
  const x0 = r.x;
  r.cargo.iron = 50;
  sim.issueUnload(r.id);
  sim.issueMove(r.id, r.x + 60, r.z, true);
  assert.equal(r.pending.length, 1, 'the move should queue behind the unload');
  run(sim, 0.05); // 12 game seconds
  assert.equal(sim.storage.iron, 50, 'the hold poured out first');
  assert.equal(r.pending.length, 0, 'the queued move promoted');
  assert.ok(Math.abs(r.x - x0) > 5, '…and the rover drove on afterwards');
});

test('an unload task survives a save round-trip', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  r.cargo.iron = 50;
  r.x += 200; // far from any depot, so the task is still travelling
  sim.issueUnload(r.id);
  const data = JSON.parse(JSON.stringify(sim.snapshot()));
  const sim2 = new Simulation({ seed: 999 });
  sim2.restore(data);
  const r2 = sim2.roverById(r.id)!;
  assert.equal(r2.command.type, 'unload', 'the task type must restore');
  assert.equal(r2.cargo.iron, 50, 'the cargo must restore with it');
});

group('Idle rover query');

test('idleRovers finds rovers with nothing to do', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  assert.equal(sim.idleRovers().length, 2);
  sim.issueMove(sim.rovers[0].id, 50, 50);
  assert.deepEqual(
    sim.idleRovers().map((r) => r.id),
    [sim.rovers[1].id],
    'a rover with a task is not idle',
  );
});

test('idleRovers skips the stranded, the charging and the storm-bound', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const [a, b] = sim.rovers;
  a.phase = 'disabled';
  b.recharge = true;
  assert.equal(sim.idleRovers().length, 0, 'neither stranded nor charging counts');
  b.recharge = false;
  b.sheltered = true;
  assert.equal(sim.idleRovers().length, 0, 'storm shelter is not idle time');
  b.sheltered = false;
  assert.equal(sim.idleRovers().length, 1, 'releasing it makes it idle again');
});

await finish('sim/rovers');
