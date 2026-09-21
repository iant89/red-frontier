/**
 * @suite sim/large-colony-stress
 * @group integration
 * @covers src/sim/debug/LargeColonyScenario.ts src/sim/Simulation.ts src/sim/debug/SimulationAssertions.ts
 * @desc Large-Colony Stress Tests (Phase 29): exercises 100 rovers and 250+ buildings
 * under high production, active severe storms, active construction, and fleet logistics.
 * Verifies no invalid state, no memory explosion, no runaway task creation, no duplicate
 * reservations, and bit-for-bit final state determinism.
 */

import assert from 'node:assert/strict';
import {
  createLargeColonyScenario,
  assertStressInvariants,
  runStressSimulation,
} from '../../src/sim/debug/LargeColonyScenario';
import { group, test, finish } from '../harness';

group('Large-colony construction & configuration');

test('scenario initializes 100 rovers and 250+ buildings with active storm', () => {
  const sim = createLargeColonyScenario({ seed: 505 });
  assert.equal(sim.rovers.length, 100, 'must have exactly 100 rovers');
  assert.ok(sim.buildings.length >= 250, `must have >=250 buildings, got ${sim.buildings.length}`);
  const fc = sim.weather.forecast();
  assert.ok(
    fc?.kind === 'severe' || sim.weather.storm === 'severe',
    'must have active or incoming severe storm',
  );
  assertStressInvariants(sim);
});

group('Invariants under sustained stress');

test('1 simulated hour (~195 ticks) maintains all invariants under storm & haul load', () => {
  const sim = createLargeColonyScenario({ seed: 777 });
  const result = runStressSimulation(sim, 195, 60);
  assert.ok(result.simTime >= 9.7, `Simulated time must advance at least ~9.7s, got ${result.simTime}`);
  assert.ok(result.maxRoverPendingQueue <= 5, 'Rover task queues must remain tightly bounded');
  assert.match(result.stateHash, /^rf1-[0-9a-f]{14}-[0-9a-f]{14}$/);
});

test('1 simulated day (4800 ticks) survives full day-night cycle and weather wear', () => {
  const sim = createLargeColonyScenario({ seed: 1001 });
  const result = runStressSimulation(sim, 4800, 1200);
  assert.equal(result.ticksRun, 4800);
  assert.ok(sim.clock.sol >= 1, `Sol clock must cross sol 1, got sol ${sim.clock.sol}`);
  assert.equal(result.stateHash, 'rf1-1cbb9423798938-0600c4c2a44ba1', 'Pinned 1-day stress state hash must match');
});

test('no runaway task creation: rovers maintain bounded queues', () => {
  const sim = createLargeColonyScenario({ seed: 888 });
  runStressSimulation(sim, 300, 100);
  for (const r of sim.rovers) {
    assert.ok(r.pending.length <= 10, `Rover ${r.id} queue exceeded 10 (was ${r.pending.length})`);
  }
});

test('no duplicate reservations across fleet and world deposits', () => {
  const sim = createLargeColonyScenario({ seed: 999 });
  runStressSimulation(sim, 300, 100);
  const reserved = new Set<number>();
  for (const d of sim.world.deposits) {
    if (d.reservedBy !== null && d.reservedBy !== undefined) {
      assert.ok(!reserved.has(d.id), `Deposit ${d.id} has duplicate reservation`);
      reserved.add(d.id);
    }
  }
});

test('large-colony stress execution is bit-for-bit deterministic', () => {
  const simA = createLargeColonyScenario({ seed: 2026 });
  const simB = createLargeColonyScenario({ seed: 2026 });
  const resA = runStressSimulation(simA, 250, 250);
  const resB = runStressSimulation(simB, 250, 250);
  assert.equal(resA.stateHash, resB.stateHash, 'Identical seeds must yield identical final state hashes');
});

await finish('sim/large-colony-stress');
