/**
 * @suite sim/fleet
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/config.ts src/sim/defs.ts
 * @desc The fleet on the road: emptying a hold on the charger, keeping cargo aboard
 * when the silos are full, drivetrain wear, jump-starting a stranded rover, and
 * the per-rover automation rules that decide all of it.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ROVERS } from '../../src/sim/defs';
import { nearDeposit, run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Recharge logistics');

test("a rover with cargo empties its hold while recharging when silos have room", () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2; // parked at the pod depot
  rv.cargo.ice = 200;
  rv.battery = 5; // flat enough to trigger the return-to-charge rule
  const before = sim.storage.ice;
  run(sim, 0.02);
  assert.ok(
    rv.cargo.ice < 1,
    `the hold should be empty, still has ${rv.cargo.ice.toFixed(0)} kg`,
  );
  assert.ok(sim.storage.ice > before, 'the cargo should have reached storage');
});

test('a recharging rover keeps cargo the silos have no room for', () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  sim.storage.ice = sim.storageCapacity(); // a full silo takes nothing
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2;
  rv.cargo.ice = 200;
  rv.battery = 5;
  run(sim, 0.05);
  assert.ok(
    rv.cargo.ice > 199,
    `cargo should stay aboard, has ${rv.cargo.ice.toFixed(0)} kg`,
  );
  assert.equal(sim.storage.ice, sim.storageCapacity(), 'a full silo must not overfill');
});

test('after charging, the rover rolls back out to its mining job', () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2;
  rv.cargo.ice = 200;
  rv.battery = 5;
  run(sim, 0.4); // plenty of time to charge and drive back out
  assert.equal(rv.command.type, 'mine', 'the mining order survives the charge cycle');
  assert.equal(rv.recharge, false, 'the rover should be off the charger');
  assert.ok(
    Math.hypot(rv.x, rv.z) > 15,
    `the rover should be back in the field, is at (${rv.x.toFixed(0)}, ${rv.z.toFixed(0)})`,
  );
});

group('Wear, recovery & automation rules');

test('a flat rover strands, and another rover can jump-start it', () => {
  const sim = new Simulation({ seed: 63, nearDeposits: 0.2 });
  const [rescuer, victim] = sim.rovers;
  // Send the victim into the field and run its battery flat there — the
  // low-power recall cannot make it home from that far out.
  victim.x = 150;
  victim.z = 150;
  victim.battery = 3;
  assert.equal(
    sim.issueRecover(rescuer.id, victim.id),
    false,
    'a running rover needs no rescue',
  );
  sim.issueMove(victim.id, 200, 200);
  let sols = 0;
  while (victim.phase !== 'disabled' && sols < 5) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.equal(victim.phase, 'disabled', 'the victim should be stranded');

  const ok = sim.issueRecover(rescuer.id, victim.id);
  assert.ok(ok, 'the rescue dispatch should be accepted');
  sols = 0;
  while (victim.phase === 'disabled' && sols < 6) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.notEqual(victim.phase, 'disabled', 'the victim should be running again');
  assert.ok(victim.battery > 0, 'the jump-start should have left charge in the battery');
  assert.ok(rescuer.battery < ROVERS[rescuer.kind].maxBatteryKWh, 'the rescuer paid for it');
});

test('tool work wears the drivetrain, and worn rovers work slower', () => {
  const sim = new Simulation({ seed: 64, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'iron');
  sim.issueMine(rv.id, dep.id);
  const before = dep.amount;
  run(sim, 1);
  assert.ok(dep.amount < before, 'the rover should be mining');
  assert.ok(
    rv.condition < 100,
    `a sol of digging should wear the drivetrain, got ${rv.condition.toFixed(1)}%`,
  );

  // Same dig, half-worn drivetrain: materially less rock moves.
  const sim2 = new Simulation({ seed: 64, nearDeposits: 0.2 });
  const rv2 = sim2.rovers[0];
  rv2.condition = 20;
  const dep2 = sim2.world.deposits.find((d) => d.id === dep.id)!;
  sim2.issueMine(rv2.id, dep2.id);
  run(sim2, 1);
  assert.ok(
    before - dep2.amount < before - dep.amount - 5,
    `a worn rover should mine slower (${(before - dep.amount).toFixed(0)} kg vs ${(before - dep2.amount).toFixed(0)} kg)`,
  );
});

test('rover automation rules are per-rover levers', () => {
  const sim = new Simulation({ seed: 66, nearDeposits: 0.2 });
  const [mining, utility] = sim.rovers;

  // Charge floor clamps to the UI's 10–60% range.
  sim.setChargeFloor(mining.id, 95);
  assert.equal(mining.rules.chargeFloorPct, 60, 'floor clamps high');
  sim.setChargeFloor(mining.id, 2);
  assert.equal(mining.rules.chargeFloorPct, 10, 'floor clamps low');
  sim.setChargeFloor(mining.id, 45);
  assert.equal(mining.rules.chargeFloorPct, 45, 'sane values pass through');

  // A high floor recalls the rover even with plenty of battery left.
  utility.battery = 20; // 50% of its 40 kWh pack
  sim.setChargeFloor(utility.id, 60); // 24 kWh floor — above its charge
  sim.step(1 / 20);
  assert.ok(utility.recharge, 'the rover should be heading in to charge');

  // Auto-haul off stops the scheduler from using that rover.
  sim.setRoverRule(utility.id, 'autoHaul', false);
  sim.setRoverRule(mining.id, 'autoHaul', false);
  sim.storage.ice = 0;
  sim.recomputeCapacities();
  run(sim, 0.1);
  for (const rv of [mining, utility]) {
    assert.equal(
      rv.command.type,
      'idle',
      `auto-haul-off ${rv.label} must not be dispatched, got ${rv.command.type}`,
    );
  }
});

await finish('sim/fleet');
