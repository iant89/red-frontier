/**
 * @suite sim/property-testing
 * @group unit
 * @covers src/sim/Simulation.ts src/sim/debug/SimulationAssertions.ts src/sim/host/applyCommand.ts
 * @desc Property-Based Simulation Testing (Phase 25): generates arbitrary pseudo-random
 * command sequences across multiple simulation seeds and verifies simulation invariants
 * after every step.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { assertInvariants, checkInvariants } from '../../src/sim/debug/SimulationAssertions';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { applyCommand } from '../../src/sim/host/applyCommand';
import type { PlayerCommand, SimCommand } from '../../src/sim/host/protocol';
import { BUILDINGS, BuildingKind } from '../../src/sim/defs';
import { mulberry32 } from '../../src/lib/rng';
import { group, test, finish } from '../harness';

function freshSim(seed = 42): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

const BUILDING_KINDS = Object.keys(BUILDINGS) as BuildingKind[];

/** Generates a pseudo-random player command for the current simulation state. */
function randomPlayerCommand(sim: Simulation, rand: () => number): PlayerCommand {
  const rovers = sim.rovers;
  const buildings = sim.buildings;
  const deposits = sim.world.deposits;
  const pois = sim.world.pois;

  const rIndex = Math.floor(rand() * rovers.length);
  const roverId = rovers[rIndex]?.id ?? 1000;
  const queue = rand() > 0.5;

  const choice = Math.floor(rand() * 12);
  switch (choice) {
    case 0: {
      // move
      const x = (rand() - 0.5) * 300;
      const z = (rand() - 0.5) * 300;
      return { type: 'rover/move', roverId, x, z, queue };
    }
    case 1: {
      // mine
      if (deposits.length > 0) {
        const dep = deposits[Math.floor(rand() * deposits.length)];
        return { type: 'rover/mine', roverId, depositId: dep.id, queue };
      }
      return { type: 'rover/unload', roverId, queue };
    }
    case 2:
      return { type: 'rover/unload', roverId, queue };
    case 3:
      return { type: 'rover/wait', roverId, seconds: Math.floor(rand() * 30) + 1, queue };
    case 4: {
      // construct / clean / repair
      if (buildings.length > 0) {
        const b = buildings[Math.floor(rand() * buildings.length)];
        const sub = Math.floor(rand() * 3);
        if (sub === 0) return { type: 'rover/construct', roverId, buildingId: b.id, queue };
        if (sub === 1) return { type: 'rover/clean', roverId, buildingId: b.id, queue };
        return { type: 'rover/repair', roverId, buildingId: b.id, queue };
      }
      return { type: 'rover/stop', roverId };
    }
    case 5: {
      // recover
      if (rovers.length > 1) {
        const other = rovers[(rIndex + 1) % rovers.length];
        return { type: 'rover/recover', roverId, strandedId: other.id, queue };
      }
      return { type: 'rover/stop', roverId };
    }
    case 6: {
      // salvage
      if (pois.length > 0) {
        const poi = pois[Math.floor(rand() * pois.length)];
        return { type: 'rover/salvage', roverId, poiId: poi.id, queue };
      }
      return { type: 'rover/stop', roverId };
    }
    case 7:
      return { type: 'rover/stop', roverId };
    case 8: {
      // place building
      const kind = BUILDING_KINDS[Math.floor(rand() * BUILDING_KINDS.length)];
      const x = (rand() - 0.5) * 200;
      const z = (rand() - 0.5) * 200;
      return { type: 'building/place', kind, x, z };
    }
    case 9: {
      // building toggle / maintain
      if (buildings.length > 0) {
        const b = buildings[Math.floor(rand() * buildings.length)];
        if (rand() > 0.5) {
          return { type: 'building/toggle', buildingId: b.id, enabled: rand() > 0.5 };
        }
        return { type: 'building/maintain', buildingId: b.id };
      }
      return { type: 'rover/stop', roverId };
    }
    case 10: {
      // rover settings
      const rSub = Math.floor(rand() * 4);
      if (rSub === 0) return { type: 'rover/repeatRoute', roverId, on: rand() > 0.5 };
      if (rSub === 1) return { type: 'rover/chargeFloor', roverId, pct: Math.floor(rand() * 100) };
      if (rSub === 2) return { type: 'rover/lights', roverId, on: rand() > 0.5 };
      return { type: 'rover/rule', roverId, rule: 'autoHaul', on: rand() > 0.5 };
    }
    default: {
      // colonist order
      if (rand() > 0.5) return { type: 'colonist/order', order: { type: 'shelter' } };
      return {
        type: 'colonist/order',
        order: { type: 'moveTo', x: (rand() - 0.5) * 60, z: (rand() - 0.5) * 60 },
      };
    }
  }
}

group('Phase 25 — Property-Based Simulation Testing');

test('fuzzing randomized player command sequences preserves all simulation invariants', () => {
  const rand = mulberry32(98765);
  const sim = freshSim(101);

  // Run 60 rounds of random commands and ticks
  for (let round = 0; round < 60; round++) {
    // Generate 1-3 commands per round
    const numCmds = Math.floor(rand() * 3) + 1;
    for (let c = 0; c < numCmds; c++) {
      const cmd = randomPlayerCommand(sim, rand);
      applyCommand(sim, cmd);
    }

    // Step varying delta
    const dt = 0.05 + rand() * 0.45;
    sim.step(dt);

    // Verify invariants after every single step
    assertInvariants(sim, `fuzz-round-${round}`);
  }

  const violations = checkInvariants(sim);
  assert.equal(violations.length, 0, 'no invariant violations after fuzz run');
});

test('property: rapid placement and demolition maintains valid reservations and task references', () => {
  const rand = mulberry32(112233);
  const sim = freshSim(202);

  for (let i = 0; i < 20; i++) {
    // Attempt placing buildings
    const kind = BUILDING_KINDS[Math.floor(rand() * BUILDING_KINDS.length)];
    const x = Math.round((rand() - 0.5) * 120);
    const z = Math.round((rand() - 0.5) * 120);
    const placeCmd: SimCommand = { type: 'building/place', kind, x, z };
    const ack = applyCommand(sim, placeCmd);

    // If placed, assign a rover to build it
    if (ack.ok && ack.entityId) {
      applyCommand(sim, {
        type: 'rover/construct',
        roverId: sim.rovers[0].id,
        buildingId: ack.entityId,
        queue: rand() > 0.5,
      });
    }

    sim.step(0.5);
    assertInvariants(sim, `place-step-${i}`);

    // Randomly demolish existing buildings
    if (sim.buildings.length > 0 && rand() > 0.5) {
      const target = sim.buildings[Math.floor(rand() * sim.buildings.length)];
      applyCommand(sim, { type: 'building/demolish', buildingId: target.id });
    }

    sim.step(0.5);
    assertInvariants(sim, `demolish-step-${i}`);
  }
});

test('property: environmental storm stress under continuous rover commands preserves invariants', () => {
  const rand = mulberry32(445566);
  const sim = freshSim(303);

  // Force severe storm
  sim.devForceStorm('severe');

  for (let step = 0; step < 40; step++) {
    const cmd = randomPlayerCommand(sim, rand);
    applyCommand(sim, cmd);

    // Random storm modulation
    if (step === 20) sim.devClearStorms();
    if (step === 30) sim.devForceStorm('regional');

    sim.step(0.2);
    assertInvariants(sim, `storm-step-${step}`);
  }
});

test('property: deterministic replay — identical random command sequences yield identical StateHash', () => {
  const seed = 555;
  const rand1 = mulberry32(777);
  const rand2 = mulberry32(777);

  const sim1 = freshSim(seed);
  const sim2 = freshSim(seed);

  // Record 25 steps of commands
  for (let i = 0; i < 25; i++) {
    const cmd1 = randomPlayerCommand(sim1, rand1);
    const cmd2 = randomPlayerCommand(sim2, rand2);

    assert.deepEqual(cmd1, cmd2, 'generated command stream must be deterministic');

    applyCommand(sim1, cmd1);
    applyCommand(sim2, cmd2);

    sim1.step(0.2);
    sim2.step(0.2);

    assertInvariants(sim1, `replay-sim1-${i}`);
    assertInvariants(sim2, `replay-sim2-${i}`);
  }

  const hash1 = hashSimulation(sim1);
  const hash2 = hashSimulation(sim2);

  assert.equal(hash1, hash2, 'replay of identical fuzz sequence must produce identical StateHash');
});

await finish('sim/property-testing');
