/**
 * @suite sim/logistics-system
 * @group unit
 * @covers src/sim/systems/LogisticsSystem.ts src/sim/systems/RoverSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/systems/ProductionSystem.ts
 * @desc LogisticsSystem extraction (Phase 13): the storage ledger's own
 * arithmetic and clamping rules, cargo transfers, site delivery and the garage
 * spend, deposit reservations with the competing-hauler rules that read them,
 * and the live seams every other system now routes through it — pickup,
 * delivery, cancellation, failed delivery, a full silo, and a destination that
 * no longer exists. Ends with the architecture guard for the phase's design
 * rule: resource accounting has one authoritative owner.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import { LogisticsSystem } from '../../src/sim/systems/LogisticsSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { ConstructionSystem } from '../../src/sim/systems/ConstructionSystem';
import { ProductionSystem } from '../../src/sim/systems/ProductionSystem';
import { pickHaul } from '../../src/sim/systems/FleetAutomationSystem';
import { enterIdle, cargoMass, type Rover } from '../../src/sim/state/RoverState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { ALL_RESOURCES, ROVERS, type ResourceId } from '../../src/sim/defs';
import { run, build, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** A colony with the weather dice off: every storm in here is scripted. */
function fresh(seed = 41): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

/** A parked rover: no task, no queue, no charge run, not stranded. */
function park(sim: Simulation, idx = 0, x = 260, z = -180): Rover {
  const r = sim.rovers[idx];
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.navPath = [];
  r.navI = 0;
  r.battery = ROVERS[r.kind].maxBatteryKWh;
  enterIdle(r);
  r.command = { type: 'idle' };
  r.pending = [];
  r.autoTask = false;
  r.recharge = false;
  r.sheltered = false;
  r.routePaused = false;
  return r;
}

function parkAll(sim: Simulation): Rover[] {
  return sim.rovers.map((_, i) => park(sim, i, 260 + i * 60, -180 - i * 40));
}

/** Every silo to the brim, through the ledger's own store. */
function fillAll(sim: Simulation): void {
  for (const res of ALL_RESOURCES) LogisticsSystem.store(sim.state, res, 1e9);
}

function said(sim: Simulation, needle: string): boolean {
  return sim.alerts.history().some((l) => l.text.includes(needle));
}

/** Hold the given cargo exactly, bypassing the rover's own rules. */
function hold(r: Rover, res: ResourceId, kg: number): void {
  for (const k of ALL_RESOURCES) r.cargo[k] = 0;
  r.cargo[res] = kg;
}

// ============================================================ the ledger ====

group('The storage ledger');

test('store fits what it can and reports it; a full silo accepts nothing', () => {
  const sim = fresh();
  const state = sim.state;
  const cap = LogisticsSystem.capacity(state);
  assert.equal(cap, sim.storageCapacity(), 'the ledger is the capacity the sim reports');

  assert.equal(LogisticsSystem.store(state, 'regolith', cap / 4), cap / 4, 'a quarter fits');
  assert.equal(state.storage.regolith, cap / 4);
  assert.equal(
    LogisticsSystem.store(state, 'regolith', cap),
    cap * 0.75,
    'an oversized pour lands only the room that was left',
  );
  assert.equal(state.storage.regolith, cap, 'and the silo is exactly full');
  assert.equal(LogisticsSystem.store(state, 'regolith', 10), 0, 'a full silo accepts nothing');
  assert.equal(LogisticsSystem.room(state, 'regolith'), 0);
});

test('take floors at zero and reports what was actually there', () => {
  const sim = fresh();
  const state = sim.state;
  state.storage.iron = 40;
  assert.equal(LogisticsSystem.take(state, 'iron', 15), 15);
  assert.equal(state.storage.iron, 25);
  assert.equal(LogisticsSystem.take(state, 'iron', 100), 25, 'a rate over the stock takes the stock');
  assert.equal(state.storage.iron, 0, 'and never goes negative');
  assert.equal(LogisticsSystem.take(state, 'iron', 5), 0, 'an empty silo gives nothing');
  assert.equal(state.storage.iron, 0);
});

test('refund is the one over-fill rule, and the capacity recompute clamps it back', () => {
  const sim = fresh();
  const state = sim.state;
  const cap = LogisticsSystem.capacity(state);

  LogisticsSystem.refund(state, 'silicon', cap * 2);
  assert.equal(state.storage.silicon, cap * 2, 'the refund lands in full, past capacity');
  assert.equal(LogisticsSystem.room(state, 'silicon'), 0, 'and the silo reports no room');

  // The pinned quirk (Phase 9 record): the next capacity recompute clamps the
  // over-fill away, which is what makes the promise above conditional on the
  // silo having had room. Preserved, not fixed.
  sim.recomputeCapacities();
  assert.equal(state.storage.silicon, cap, 'recomputeCapacitiesState clamps the over-fill');
});

test('negative and non-finite masses are no-ops, not holes in the ledger', () => {
  const sim = fresh();
  const state = sim.state;
  LogisticsSystem.store(state, 'ice', 30);

  assert.equal(LogisticsSystem.store(state, 'ice', -10), 0);
  assert.equal(LogisticsSystem.store(state, 'ice', NaN), 0);
  assert.equal(LogisticsSystem.store(state, 'ice', Infinity), 0);
  assert.equal(LogisticsSystem.take(state, 'ice', -10), 0);
  assert.equal(LogisticsSystem.take(state, 'ice', NaN), 0);
  LogisticsSystem.refund(state, 'ice', -10);
  LogisticsSystem.refund(state, 'ice', NaN);
  assert.equal(state.storage.ice, 30, 'the ledger only ever moved the one honest pour');
});

test('the sim\'s storage surface is the ledger\'s answer, projected', () => {
  const sim = fresh();
  buildOnline(sim, 'warehouse');
  LogisticsSystem.store(sim.state, 'regolith', 123.4);
  LogisticsSystem.store(sim.state, 'iron', 7.5);

  assert.equal(sim.storageCapacity(), LogisticsSystem.capacity(sim.state));
  assert.equal(sim.storageRoom('regolith'), LogisticsSystem.room(sim.state, 'regolith'));
  assert.equal(sim.storageTotal(), LogisticsSystem.total(sim.state));
  assert.equal(sim.storageTotalCapacity(), LogisticsSystem.totalCapacity(sim.state));
  assert.equal(sim.storageFull(), LogisticsSystem.isFull(sim.state));
  assert.deepEqual(sim.fullResources(), LogisticsSystem.fullResources(sim.state));
  assert.equal(sim.storageTotal(), 130.9, 'and the total is the sum of the silos');

  fillAll(sim);
  assert.equal(sim.storageFull(), true, 'everything full is the only thing "full" means');
  assert.equal(sim.fullResources().length, ALL_RESOURCES.length);
  LogisticsSystem.take(sim.state, 'ice', 1);
  assert.equal(sim.storageFull(), false, 'one silo with room is enough to unload into');
  assert.deepEqual(sim.fullResources(), ALL_RESOURCES.filter((r) => r !== 'ice'));
});

test('canDeliver answers per resource, not per total', () => {
  const sim = fresh();
  const r = park(sim, 0);
  fillAll(sim);

  hold(r, 'iron', 100);
  assert.equal(LogisticsSystem.canDeliver(sim.state, r), false, 'every silo is full');

  LogisticsSystem.take(sim.state, 'ice', 50);
  assert.equal(LogisticsSystem.canDeliver(sim.state, r), false, 'room for ice is not room for iron');

  LogisticsSystem.take(sim.state, 'iron', 50);
  assert.equal(LogisticsSystem.canDeliver(sim.state, r), true);

  hold(r, 'iron', 0);
  assert.equal(LogisticsSystem.canDeliver(sim.state, r), false, 'an empty hold has nothing to deliver');
});

// ============================================================== cargo ======

group('Cargo');

test('loadCargo clamps to the hold and reports what fitted', () => {
  const sim = fresh();
  const r = park(sim, 0);
  const cap = ROVERS[r.kind].capacityKg;

  assert.equal(LogisticsSystem.loadCargo(r, 'regolith', cap - 100), cap - 100);
  assert.equal(LogisticsSystem.loadCargo(r, 'iron', 500), 100, 'the hold is one shared budget');
  assert.equal(cargoMass(r), cap);
  assert.equal(LogisticsSystem.loadCargo(r, 'iron', 1), 0, 'a full hold takes nothing');
  assert.equal(LogisticsSystem.loadCargo(r, 'iron', -5), 0, 'and a negative pour is a no-op');
});

test('unloadCargo moves only what fits, and says what is stuck', () => {
  const sim = fresh();
  const state = sim.state;
  const r = park(sim, 0);
  const cap = LogisticsSystem.capacity(state);
  hold(r, 'regolith', cap + 500);

  const first = LogisticsSystem.unloadCargo(state, r);
  assert.equal(first.moved, cap, 'the silo took exactly its capacity');
  assert.equal(first.blocked, false, 'it had room when the pour started');
  assert.equal(state.storage.regolith, cap);
  assert.equal(cargoMass(r), 500, 'the rest rides in the hold');

  const second = LogisticsSystem.unloadCargo(state, r);
  assert.deepEqual(second, { moved: 0, blocked: true }, 'now the silo is full and it says so');
  assert.equal(cargoMass(r), 500, 'and nothing is destroyed to make the report tidy');

  LogisticsSystem.take(state, 'regolith', cap);
  assert.equal(LogisticsSystem.unloadCargo(state, r).moved, cap, 'freed room drains the hold again');
  assert.equal(cargoMass(r), 500 - cap, 'exactly as far as the freed room goes');

  LogisticsSystem.take(state, 'regolith', cap);
  assert.equal(LogisticsSystem.unloadCargo(state, r).moved, 500 - cap, 'and again for the last of it');
  assert.equal(cargoMass(r), 0);

  assert.deepEqual(
    LogisticsSystem.unloadCargo(state, r),
    { moved: 0, blocked: false },
    'an empty hold is a quiet no-op',
  );
});

test('the rover-side hold uses the ledger for both directions', () => {
  const sim = fresh();
  const state = sim.state;
  const r = park(sim, 0, 0, 0); // on the pad: the pod is a depot
  park(sim, 1);
  // A dev cargo write is clamped by the same capacity rule as loadCargo.
  const wrote = sim.devSetRoverCargo(r.id, 'regolith', 1e6);
  assert.equal(wrote, ROVERS[r.kind].capacityKg, 'the panel cannot overfill a hold either');
  const moved = LogisticsSystem.room(state, 'regolith');
  sim.issueUnload(r.id);
  run(sim, 0.05);
  assert.equal(cargoMass(r), ROVERS[r.kind].capacityKg - moved, 'the tick poured through the ledger');
  assert.equal(state.storage.regolith, moved);
});

// ================================ site delivery, the garage spend, inputs ====

group('Delivering to a site, spending for the garage, feeding a process');

test('deliverToSite commits what storage has, and the ConstructionSystem façade is that same call', () => {
  const sim = fresh();
  const state = sim.state;
  const site = build(sim, 'oxygenator');
  const need = site.remainingCost.regolith;
  assert.ok(need > 0, 'precondition: the site wants regolith');

  for (const res of ALL_RESOURCES) state.storage[res] = 0;
  state.storage.regolith = need / 2;
  assert.equal(
    LogisticsSystem.deliverToSite(state, site),
    need / 2,
    'a half-full silo commits half the line',
  );
  assert.equal(site.remainingCost.regolith, need / 2, 'and the site notices');
  assert.equal(state.storage.regolith, 0, 'the silo is empty, not negative');

  state.storage.regolith = need;
  assert.equal(
    ConstructionSystem.commitAvailableMaterials(state, site),
    need / 2,
    'the façade is the ledger call, so it commits exactly the outstanding line',
  );
  assert.equal(site.remainingCost.regolith, 0);
  assert.equal(LogisticsSystem.deliverToSite(state, site), 0, 'a fed line is not fed twice');
});

test('an empty stockpile delivers nothing to a hungry site', () => {
  const sim = fresh();
  const state = sim.state;
  const site = build(sim, 'oxygenator');
  for (const res of ALL_RESOURCES) state.storage[res] = 0;
  const before = { ...site.remainingCost };

  assert.equal(LogisticsSystem.deliverToSite(state, site), 0, 'there is nothing to give');
  assert.deepEqual(site.remainingCost, before, 'and the site waits exactly where it was');
  assert.ok(ConstructionSystem.missingList(site.remainingCost) !== 'materials', 'still hungry, and listed');
});

test('hasMaterials / consumeMaterials / missingList are the one garage ledger', () => {
  const sim = fresh();
  const state = sim.state;
  for (const res of ALL_RESOURCES) state.storage[res] = 0;
  state.storage.regolith = 10;
  state.storage.iron = 5;

  state.storage.ice = 5;
  assert.equal(LogisticsSystem.hasMaterials(state, { ...state.storage, ice: 6 }), false, 'one short fails');
  assert.equal(ConstructionSystem.hasMaterials(state, { ...state.storage, ice: 5 }), true, 'the façade agrees');

  // Two spends in one tick must not drive the silo negative.
  ConstructionSystem.consumeMaterials(state, { ...state.storage, regolith: 30 });
  LogisticsSystem.consumeMaterials(state, { ...state.storage, iron: 30 });
  assert.equal(state.storage.regolith, 0, 'the spend floors at zero');
  assert.equal(state.storage.iron, 0);

  assert.equal(
    ConstructionSystem.missingList({ ...state.storage, regolith: 12.4 }),
    '13 kg Regolith',
    'the missing list rounds up to whole kilograms',
  );
  assert.equal(LogisticsSystem.missingList({ ...state.storage }), 'materials', 'and falls back to a word');
});

test('a process draws its solids through the ledger and never goes negative', () => {
  const sim = fresh();
  const state = sim.state;
  const plant = buildOnline(sim, 'extractor');
  for (const res of ALL_RESOURCES) state.storage[res] = 0;

  // Less than one tick of feed: the ledger floors the draw, and the process's
  // own gate is what decides whether it runs at all.
  state.storage.ice = 0.001;
  const want = ProductionSystem.desiredThroughput(state, plant);
  ProductionSystem.runProcess(state, plant, want, 1);
  assert.equal(state.storage.ice, 0, 'the draw floors at zero, however small the ask');
  assert.equal(
    ProductionSystem.processBlockReason(state, plant),
    'Out of Water Ice',
    'and the plant reports the empty silo',
  );
});

// ================================= reservations & competing haulers ========

group('Reservations');

test('a claim holds the seam; a second rover without force is refused', () => {
  const sim = fresh();
  const [a, b] = parkAll(sim);
  const dep = sim.devSpawnDeposit('regolith', 45, 0, 900);

  RoverSystem.claimDeposit(sim.state, a, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), a.id);
  RoverSystem.claimDeposit(sim.state, b, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), a.id, 'an auto claim never steals');

  RoverSystem.releaseDeposit(sim.state, a, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null, 'a released seam is free again');
  RoverSystem.claimDeposit(sim.state, b, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), b.id, 'and the next claimant gets it');
});

test('a forced claim bumps the auto-run and finishes its task', () => {
  const sim = fresh();
  const [a, b] = parkAll(sim);
  const dep = sim.devSpawnDeposit('regolith', 45, 0, 900);
  a.command = { type: 'mine', depositId: dep.id };
  a.autoTask = true;
  RoverSystem.claimDeposit(sim.state, a, dep.id);

  RoverSystem.claimDeposit(sim.state, b, dep.id, true);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), b.id, 'the player order takes the seam');
  assert.equal(a.command.type, 'idle', 'and the auto-run it took it from re-plans');
  assert.ok(said(sim, 'took over that seam'), 'with the reason on the log');
});

test('competing haulers: a claim steers the fleet apart, and cancelling hands the seam back', () => {
  const sim = fresh();
  const [a, b] = parkAll(sim);
  // Drain the starting field so the two scripted seams are the only candidates.
  for (const d of sim.state.world.deposits) if (d.resource === 'regolith') d.amount = 0;
  const near = sim.devSpawnDeposit('regolith', 40, 0, 1000);
  const far = sim.devSpawnDeposit('regolith', 90, 60, 1000);
  b.battery = 500; // the subject is the reservation, not the energy budget
  const shortfall = { ...sim.state.storage, regolith: 5000 };

  assert.equal(
    pickHaul(sim.state, b, ['regolith'], shortfall)?.deposit.id,
    near.id,
    'unclaimed, the nearer seam is the best pick',
  );

  sim.issueMine(a.id, near.id); // the task is what holds the claim
  assert.equal(LogisticsSystem.reservationOf(sim.state, near.id), a.id);
  assert.equal(
    pickHaul(sim.state, b, ['regolith'], shortfall)?.deposit.id,
    far.id,
    'a poor seam held by another rover sends the second hauler elsewhere',
  );

  sim.stopRover(a.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, near.id), null, 'cancelling releases the claim');
  assert.equal(
    pickHaul(sim.state, b, ['regolith'], shortfall)?.deposit.id,
    near.id,
    'and the near seam is the best pick once more',
  );

  // A claim on a seam that runs dry must not pin the fleet to a dead deposit.
  sim.issueMine(a.id, near.id);
  near.amount = 0;
  assert.equal(
    pickHaul(sim.state, b, ['regolith'], shortfall)?.deposit.id,
    far.id,
    'a worked-out seam is skipped, claim or no claim',
  );
});

test('claims follow the task: a cancel, a new order, and a flat battery all release', () => {
  const sim = fresh();
  const [a] = parkAll(sim);
  const dep = sim.devSpawnDeposit('regolith', 45, 0, 900);

  sim.issueMine(a.id, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), a.id);

  sim.stopRover(a.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null, 'a cancel drops the claim');

  sim.issueMine(a.id, dep.id);
  sim.issueMove(a.id, 60, 60);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null, 'so does a replacing order');

  sim.issueMine(a.id, dep.id);
  RoverSystem.disable(sim.state, a);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null, 'and a stranded rover frees its seam');

  assert.equal(LogisticsSystem.rescueTargeted(sim.state, a.id), false, 'nobody is coming yet');
  sim.state.rovers[1].command = { type: 'recover', roverId: a.id };
  assert.equal(LogisticsSystem.rescueTargeted(sim.state, a.id), true, 'a rescue is a claim on a rover');
});

// ======================================================== the live seams ====

group('Through the live tick');

test('pickup then delivery: the seam shrinks by exactly what storage gains', () => {
  const sim = fresh();
  const [, b] = parkAll(sim);
  const dep = sim.devSpawnDeposit('regolith', 48, 0, 900);
  const rover = sim.rovers[0];
  const before = { seam: dep.amount, stored: sim.state.storage.regolith };

  sim.issueMine(rover.id, dep.id);
  run(sim, 0.12);
  assert.ok(dep.amount < before.seam, 'precondition: the rover dug');
  const mined = before.seam - dep.amount;

  sim.issueUnload(rover.id);
  run(sim, 0.12);
  assert.equal(cargoMass(rover), 0, 'the hold emptied into the ledger');
  assert.ok(
    Math.abs(sim.state.storage.regolith - (before.stored + mined)) < 1e-6,
    'storage gained exactly the mass the seam lost',
  );
  assert.equal(b.command.type, 'idle', 'and the parked rover never joined in');
});

test('a failed delivery keeps the load and says why', () => {
  const sim = fresh();
  const rover = park(sim, 0, 0, 0); // park on the pad: the pod is a depot
  const b = park(sim, 1);
  fillAll(sim);
  hold(rover, 'regolith', 200);
  const stored = LogisticsSystem.total(sim.state);

  sim.issueUnload(rover.id);
  run(sim, 0.05);

  assert.equal(LogisticsSystem.total(sim.state), stored, 'nothing fitted, so nothing moved');
  assert.equal(cargoMass(rover), 200, 'the load is still aboard');
  assert.ok(said(sim, 'those silos are full'), 'and the colony is told why');
  assert.equal(b.command.type, 'idle');

  LogisticsSystem.take(sim.state, 'regolith', 300);
  sim.issueUnload(rover.id);
  run(sim, 0.05);
  assert.equal(cargoMass(rover), 0, 'room appears → the retry lands');
  assert.equal(LogisticsSystem.room(sim.state, 'regolith'), 60, 'and takes exactly the load');
});

test('a haul route parks on a full silo and resumes when the ledger has room', () => {
  const sim = fresh();
  buildOnline(sim, 'warehouse');
  const rover = park(sim, 0);
  const dep = sim.devSpawnDeposit('regolith', 48, 0, 900);
  sim.issueMine(rover.id, dep.id);
  sim.setRepeatRoute(rover.id, true);
  fillAll(sim);

  run(sim, 0.02);
  assert.equal(rover.routePaused, true, 'the ledger has no room, so the route parks');
  assert.equal(rover.command.type, 'mine', 'the task survives the pause');

  LogisticsSystem.take(sim.state, 'regolith', 200);
  assert.ok(LogisticsSystem.room(sim.state, 'regolith') >= 60, 'precondition: room past the resume mark');
  run(sim, 0.02);
  assert.equal(rover.routePaused, false, 'and the route sets out again');
});

test('a destination destroyed mid-run strands no mass', () => {
  const sim = fresh();
  const w = sim.devSpawnBuilding('warehouse', 45, 0)!;
  sim.devCompleteBuilding(w.id);
  const rover = park(sim, 0, 110, 40); // far enough that the haul is still running
  park(sim, 1);
  hold(rover, 'regolith', 200);
  sim.issueUnload(rover.id);
  run(sim, 0.01);
  assert.equal(cargoMass(rover), 200, 'precondition: the load is still aboard, en route');
  assert.equal(rover.goal, 'toDepot');

  // The depot is gone before the rover gets there.
  sim.demolish(w.id);
  const stored = sim.state.storage.regolith;
  run(sim, 0.2);
  assert.equal(cargoMass(rover), 0, 'the rover re-planned and delivered anyway');
  assert.equal(
    sim.state.storage.regolith - stored,
    200,
    'to the pod: a destroyed destination costs the colony no mass',
  );
  assert.equal(sim.storageCapacity(), LogisticsSystem.capacity(sim.state), 'and the shrink is the ledger\'s');
  for (const res of ALL_RESOURCES) assert.ok(sim.state.storage[res] >= 0, `${res} never negative`);
});

test('a seam that runs dry under a claim leaves the ledger asking after nothing', () => {
  const sim = fresh();
  const [a] = parkAll(sim);
  const dep = sim.devSpawnDeposit('regolith', 48, 0, 900);
  sim.issueMine(a.id, dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), a.id);

  dep.amount = 0; // worked out
  sim.stopRover(a.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null, 'the claim went with the task');

  // The record leaving the world entirely (a loaded save, a hand-edited
  // world): the ledger's queries and its release must be null-safe.
  sim.state.world.deposits = sim.state.world.deposits.filter((d) => d.id !== dep.id);
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null);
  RoverSystem.releaseDeposit(sim.state, a, dep.id); // no-op, not a throw
  RoverSystem.claimDeposit(sim.state, a, dep.id); // also a no-op
  assert.equal(LogisticsSystem.reservationOf(sim.state, dep.id), null);
  assert.equal(a.command.type, 'idle', 'and no task was invented for it');
});

test('cancelling a site refunds exactly what was committed, through the ledger', () => {
  const sim = fresh();
  parkAll(sim);
  const site = build(sim, 'oxygenator');
  const cost = { ...site.remainingCost };
  for (const res of ALL_RESOURCES) sim.state.storage[res] = 0;
  sim.state.storage.regolith = cost.regolith / 2;
  const committed = LogisticsSystem.deliverToSite(sim.state, site);
  assert.equal(committed, cost.regolith / 2, 'precondition: half a line is committed');
  const stored = sim.state.storage.regolith;

  sim.demolish(site.id);
  assert.ok(
    Math.abs(sim.state.storage.regolith - (stored + committed)) < 1e-6,
    'the refund is the commitment, to the kilogram',
  );
  assert.ok(said(sim, 'recovered'), 'and the log says how much came back');
});

test('two colonies that run the same logistics script end in the same state', () => {
  const script = (sim: Simulation) => {
    buildOnline(sim, 'warehouse');
    const dep = sim.devSpawnDeposit('regolith', 60, 20, 1500);
    const [, b] = parkAll(sim);
    sim.issueMine(sim.rovers[0].id, dep.id);
    run(sim, 0.1);
    sim.issueUnload(sim.rovers[0].id);
    run(sim, 0.1);
    sim.devSpawnBuilding('solar', 70, 40);
    run(sim, 0.05);
    assert.equal(b.command.type, 'idle', 'the second rover stays parked in both colonies');
  };
  const a = fresh(59);
  const b = fresh(59);
  script(a);
  script(b);
  assert.equal(hashSimulation(a), hashSimulation(b), 'the ledger is deterministic');
});

// ================================================== the design rule (§17) ====

group('One authoritative owner');

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Every module allowed to write the storage ledger, and why. §17's design rule
 * is that resource accounting has *one* authoritative owner: the other systems
 * move mass by asking `LogisticsSystem`, never by doing the arithmetic
 * themselves. This guard is the executable form of that rule — the Phase 12
 * precedent (`rogueRoverMutation`, `sim/host`) is that a structural rule gets a
 * source-text test when the type system cannot express it.
 */
/** Who may write one silo (`storage[res] = …`). */
const ELEMENT_WRITERS = new Set([
  'src/sim/systems/LogisticsSystem.ts', // the owner (Phase 13)
  'src/sim/state/ColonyState.ts', // recomputeCapacitiesState clamps a silo to capacity (Phase 2)
]);

/** Who may replace the whole ledger (`storage = …`) — the boundary, not accounting. */
const WHOLE_WRITERS = new Set([
  'src/sim/Simulation.ts', // the accessor and the save/restore path
]);

test('no module outside the ledger writes storage — §17\'s design rule', () => {
  const ELEMENT_WRITE = /storage\[[^\]]*\]\s*[-+*/]?=(?!=)/;
  const WHOLE_WRITE = /\.storage\s*=\s*(?!=)/;
  const offenders: string[] = [];
  const writers = { element: [] as string[], whole: [] as string[] };

  for (const file of tsFiles(`${SRC}/sim`)) {
    const rel = file.replace(`${SRC}/`, 'src/');
    const source = readFileSync(file, 'utf8');
    if (ELEMENT_WRITE.test(source)) {
      writers.element.push(rel);
      if (!ELEMENT_WRITERS.has(rel)) offenders.push(rel);
    }
    if (WHOLE_WRITE.test(source)) {
      writers.whole.push(rel);
      if (!WHOLE_WRITERS.has(rel)) offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'resource accounting belongs to LogisticsSystem (§17): ask the ledger to move ' +
      'mass instead of writing storage here',
  );
  assert.ok(
    writers.element.includes('src/sim/systems/LogisticsSystem.ts'),
    'sanity: the owner is still the module doing the writing',
  );
  // The exemption lists are the whole truth, not a superset — a stale entry is
  // a lie that would let the rule rot.
  assert.deepEqual(writers.element.sort(), [...ELEMENT_WRITERS].sort());
  assert.deepEqual(writers.whole.sort(), [...WHOLE_WRITERS].sort());
});

await finish();
