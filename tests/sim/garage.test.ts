/**
 * @suite sim/garage
 * @group integration
 * @covers src/sim/config.ts src/sim/defs.ts src/sim/Simulation.ts
 * @desc The rover garage: the assembly line, bay servicing and 32 kW fast charging.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ROVERS } from '../../src/sim/defs';
import { SOL_SECONDS } from '../../src/sim/config';
import { run, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Prototype 4 — rover logistics');

test('a garage services drivetrains, fast-charges, and assembles rovers', () => {
  const sim = new Simulation({ seed: 65, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  const garage = buildAndWait(sim, 'garage');

  // --- assembly: the line builds a cargo rover from stockpiled parts ---
  sim.storage.iron = 300;
  sim.storage.aluminum = 200;
  sim.storage.silicon = 200;
  sim.recomputeCapacities();
  assert.ok(sim.assembleRover(garage.id, 'cargo'), 'assembly should start');
  assert.ok(!sim.assembleRover(garage.id, 'utility'), 'the line takes one job at a time');
  const nBefore = sim.rovers.length;
  let sols = 0;
  while (sim.rovers.length === nBefore && sols < 2) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.equal(sim.rovers.length, nBefore + 1, 'a new rover should roll out');
  const fresh = sim.rovers[sim.rovers.length - 1];
  assert.equal(fresh.kind, 'cargo');
  assert.ok(
    fresh.battery >= ROVERS.cargo.maxBatteryKWh - 0.01,
    'fresh off the line, fully charged',
  );
  assert.equal(garage.assembly, null, 'the line should be free again');

  // --- service: parking a worn rover in the bay restores condition ---
  const worn = sim.rovers[0];
  worn.condition = 40;
  worn.x = garage.x;
  worn.z = garage.z;
  run(sim, 0.2);
  assert.ok(
    worn.condition > 40,
    `the bay should service the drivetrain, got ${worn.condition.toFixed(1)}%`,
  );

  // --- fast charge: 32 kW in the bay vs the pod's 16 kW ---
  const bayRv = sim.rovers[1];
  bayRv.x = garage.x + 2;
  bayRv.z = garage.z;
  bayRv.battery = 10;
  const bayBefore = bayRv.battery;
  run(sim, 1 / (SOL_SECONDS * 20)); // exactly one tick
  const bayGain = bayRv.battery - bayBefore;
  const podRv = sim.rovers[2]; // the fresh cargo rover
  podRv.x = 2; // next to the lander pod, away from any garage
  podRv.z = 2;
  podRv.battery = 10;
  podRv.recharge = true;
  const podBefore = podRv.battery;
  run(sim, 1 / (SOL_SECONDS * 20));
  const podGain = podRv.battery - podBefore;
  assert.ok(
    bayGain >= podGain * 1.5,
    `garage charging should dwarf pod charging (${bayGain.toFixed(3)} vs ${podGain.toFixed(3)} kWh/tick)`,
  );
});

await finish('sim/garage');
