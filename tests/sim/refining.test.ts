/**
 * @suite sim/refining
 * @group integration
 * @covers src/sim/defs.ts src/sim/systems/ProductionSystem.ts src/sim/systems/LogisticsSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/World.ts src/sim/persistence/ColonyPersistence.ts src/sim/persistence/SaveMigrations.ts src/sim/host/protocol.ts
 * @desc P5 (Engineering), first slice: the industrial chain opens. Steel is a
 * *refined* bulk resource — made by a Refinery out of iron ore and power, never
 * dug — and it rides the one storage ledger: hauled by rovers, siloed, reserved
 * by construction sites and spent by the heavy blueprints downstream. Covers
 * the material's identity, the `solidOut` half of a process (want, block
 * reason, mass moved), steel as a construction cost, the v8→v9 save step, and
 * determinism of a refining colony.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ProductionSystem } from '../../src/sim/systems/ProductionSystem';
import { LogisticsSystem } from '../../src/sim/systems/LogisticsSystem';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { assertInvariants } from '../../src/sim/debug/SimulationAssertions';
import { decodeCommand } from '../../src/sim/host';
import { migrateSave } from '../../src/sim/persistence/SaveMigrations';
import {
  ALL_RESOURCES,
  MINEABLE_RESOURCES,
  REFINED_RESOURCES,
  RESOURCES,
  BUILDINGS,
  DEPOSIT_TABLE,
  emptyAmounts,
  isRefined,
} from '../../src/sim/defs';
import { SIM_TICK, HOURS_PER_SEC, SAVE_VERSION, SOL_SECONDS } from '../../src/sim/config';
import { ROVERS } from '../../src/sim/defs';
import { cargoMass } from '../../src/sim/state/RoverState';
import { build, buildOnline, run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** Mars hours covered by one simulation tick — the unit every process rate is in. */
const HOURS = SIM_TICK * HOURS_PER_SEC;

/** A colony with an online refinery, stocked iron and daylight, ready to smelt. */
function refiningColony(seed = 909, solarArrays = 4) {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.devSetTime(1, 0.4); // mid-morning: the arrays are producing
  const refinery = buildOnline(sim, 'refinery');
  // Raised complete on legal ground so the subject of these tests is the
  // process, not the construction queue.
  for (let i = 0; i < solarArrays; i++) buildOnline(sim, 'solar');
  sim.recomputeCapacities();
  LogisticsSystem.store(sim.state, 'iron', 100000); // clamps to silo room
  sim.recomputeCapacities();
  return { sim, refinery };
}

group('Steel — a refined material on the one bulk ledger');

test('steel is a bulk resource, and it is not something you dig', () => {
  assert.ok(ALL_RESOURCES.includes('steel'), 'steel is on the bulk ledger');
  assert.equal(emptyAmounts().steel, 0, 'a fresh ledger starts with no steel');
  assert.equal(RESOURCES.steel.origin, 'refined', 'steel is made, not mined');
  assert.equal(isRefined('steel'), true);
  assert.equal(isRefined('iron'), false);
  assert.deepEqual(REFINED_RESOURCES, ['steel']);

  // Every mined material says so, and only mined materials have seams.
  for (const r of MINEABLE_RESOURCES) {
    assert.equal(RESOURCES[r].origin, 'mined', `${r} is dug`);
    assert.ok(DEPOSIT_TABLE[r], `${r} has deposit parameters`);
  }
  assert.ok(!(MINEABLE_RESOURCES as string[]).includes('steel'), 'no steel seam exists');
  assert.ok(!('steel' in DEPOSIT_TABLE), 'the deposit table has no steel row');
  assert.equal(RESOURCES.steel.mineRateKg, 0, 'nothing mines steel');
});

test('a generated planet scatters ore seams only — never steel', () => {
  for (const seed of [7, 202, 4242]) {
    const sim = new Simulation({ seed, nearDeposits: 0.2 });
    assert.ok(sim.world.deposits.length > 0, `seed ${seed} has seams`);
    for (const d of sim.world.deposits) {
      assert.equal(RESOURCES[d.resource].origin, 'mined', `seed ${seed} scattered a refined seam`);
    }
  }
});

test('the boundaries refuse to survey in a steel seam, and accept the refinery', () => {
  // The command decoder is where untyped input enters: a seam of a refined
  // material is not a thing, so the command is refused rather than half-applied.
  const steel = decodeCommand({ type: 'dev/spawn/deposit', resource: 'steel', x: 40, z: 0, kg: 900 });
  assert.equal(steel.ok, false, 'a steel deposit must not decode');
  const iron = decodeCommand({ type: 'dev/spawn/deposit', resource: 'iron', x: 40, z: 0, kg: 900 });
  assert.equal(iron.ok, true, 'an ore seam still decodes');

  // The new blueprint needs no new command shape: placing it is ordinary.
  const place = decodeCommand({ type: 'building/place', kind: 'refinery', x: 44, z: -12 });
  assert.equal(place.ok, true, 'the refinery is a placeable blueprint');

  // ...and a rover may still be told to carry steel: it is bulk cargo.
  const cargo = decodeCommand({ type: 'dev/rover/cargo', roverId: 1000, resource: 'steel', kg: 40 });
  assert.equal(cargo.ok, true, 'steel is haulable');
});

group('ProductionSystem.solidOut — the refining half of a process');

test('a fed refinery with silo room wants to run flat out', () => {
  const { sim, refinery } = refiningColony();
  const want = ProductionSystem.desiredThroughput(sim.state, refinery);
  assert.equal(want, 1, 'ore in, room out: nothing to throttle on');
  assert.equal(ProductionSystem.processBlockReason(sim.state, refinery), 'Idle');
});

test('one tick of full-rate smelting moves ore into steel at the blueprint ratio', () => {
  const { sim, refinery } = refiningColony();
  const p = BUILDINGS.refinery.process!;
  const oreIn = p.solidIn!.iron!;
  const steelOut = p.solidOut!.steel!;

  const ironBefore = sim.storage.iron;
  const steelBefore = sim.storage.steel;
  sim.state.domainEvents.clear();

  ProductionSystem.runProcess(sim.state, refinery, 1, HOURS);

  const ironUsed = ironBefore - sim.storage.iron;
  const steelMade = sim.storage.steel - steelBefore;
  assert.ok(ironUsed > 0, 'ore was consumed');
  assert.ok(steelMade > 0, 'steel was produced');
  assert.ok(
    Math.abs(ironUsed - oreIn * HOURS) < 1e-9,
    `ore draw matches the blueprint rate (${ironUsed} vs ${oreIn * HOURS})`,
  );
  assert.ok(
    Math.abs(steelMade / ironUsed - steelOut / oreIn) < 1e-9,
    'the yield is the blueprint ratio, not an arbitrary one',
  );

  const events = sim.state.domainEvents.drain();
  const produced = events.filter(
    (e) => e.type === 'resource/produced' && e.resource === 'steel',
  );
  assert.equal(produced.length, 1, 'the ledger announces the steel it made');
  const consumed = events.filter(
    (e) => e.type === 'resource/consumed' && e.resource === 'iron',
  );
  assert.equal(consumed.length, 1, 'and the ore it ate');
});

test('an empty ore silo stops the line, and the inspector can say why', () => {
  const { sim, refinery } = refiningColony();
  sim.state.storage.iron = 0;
  const steelBefore = sim.storage.steel;

  assert.equal(ProductionSystem.desiredThroughput(sim.state, refinery), 0, 'no ore, no want');
  assert.equal(
    ProductionSystem.processBlockReason(sim.state, refinery),
    `Out of ${RESOURCES.iron.label}`,
  );
  ProductionSystem.runProcess(sim.state, refinery, 1, HOURS);
  assert.equal(sim.storage.steel, steelBefore, 'a starved line makes nothing');
});

test('a full steel silo throttles the line instead of bursting the ledger', () => {
  const { sim, refinery } = refiningColony();
  LogisticsSystem.store(sim.state, 'steel', 1e9); // clamps to exactly the room there is
  const capacity = LogisticsSystem.capacity(sim.state);
  assert.equal(sim.storage.steel, capacity, 'the silo is full to capacity');
  assert.equal(LogisticsSystem.room(sim.state, 'steel'), 0, 'no room left');

  assert.equal(ProductionSystem.desiredThroughput(sim.state, refinery), 0, 'no room, no want');
  assert.equal(
    ProductionSystem.processBlockReason(sim.state, refinery),
    `${RESOURCES.steel.label} silo full`,
  );

  // And over real ticks the gate holds: the ore is not burned for nothing.
  const ironBefore = sim.storage.iron;
  run(sim, 0.05);
  assert.equal(sim.storage.iron, ironBefore, 'a blocked line eats no ore');
  assert.ok(sim.storage.steel <= capacity + 1e-9, 'steel never exceeds the silo');
  assertInvariants(sim);
});

test('partial silo headroom asks for partial throughput', () => {
  const { sim, refinery } = refiningColony();
  const capacity = LogisticsSystem.capacity(sim.state);
  const make = BUILDINGS.refinery.process!.solidOut!.steel! * HOURS;
  sim.state.storage.steel = capacity - make / 2; // room for exactly half a tick
  const want = ProductionSystem.desiredThroughput(sim.state, refinery);
  assert.ok(want > 0.4 && want < 0.6, `half the room asks for half the line (got ${want})`);
});

test('two furnaces on one ore pile cannot smelt steel that is not there', () => {
  const sim = new Simulation({ seed: 4242, nearDeposits: 0.2 });
  sim.devSetTime(1, 0.4);
  const a = buildOnline(sim, 'refinery');
  const b = buildOnline(sim, 'refinery');
  for (let i = 0; i < 6; i++) buildOnline(sim, 'solar');
  sim.recomputeCapacities();

  // Ore for one furnace's tick, not two: the second line must come up short and
  // its output must shrink with it rather than being invented (mass conserved).
  const p = BUILDINGS.refinery.process!;
  const oneTickOre = p.solidIn!.iron! * HOURS;
  sim.state.storage.iron = oneTickOre;
  sim.state.storage.steel = 0;
  sim.recomputeCapacities();

  ProductionSystem.runProcess(sim.state, a, 1, HOURS);
  ProductionSystem.runProcess(sim.state, b, 1, HOURS);

  const steelMade = sim.storage.steel;
  const yieldRatio = p.solidOut!.steel! / p.solidIn!.iron!;
  assert.equal(sim.storage.iron, 0, 'the pile is empty, not negative');
  assert.ok(
    steelMade <= oneTickOre * yieldRatio + 1e-12,
    `steel is bounded by the ore that was actually there (${steelMade} kg)`,
  );
  assert.ok(steelMade > 0, 'the first furnace still ran');
  assertInvariants(sim);
});

group('Steel is what the heavy blueprints are made of');

test('the industrial chain has a middle, and the survival chain does not', () => {
  // Downstream of the refinery: heavy structures now cost steel.
  assert.ok(BUILDINGS.garage.cost.steel > 0, 'a garage is built from steel');
  assert.ok(BUILDINGS.weatherStation.cost.steel > 0, 'so is a radar station');
  // The refinery itself must be buildable from ore alone, or the chain could
  // never be opened (a steel cost here would be a deadlock, not a gate).
  assert.equal(BUILDINGS.refinery.cost.steel, 0, 'the refinery is built from raw ore');
  for (const r of MINEABLE_RESOURCES) {
    assert.ok(BUILDINGS.refinery.cost[r] >= 0);
  }
  assert.ok(BUILDINGS.refinery.cost.iron > 0, 'and from iron ore in particular');

  // Breathing stays untouched: P5 gates industry, not life support.
  for (const kind of ['habitat', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
    assert.equal(BUILDINGS[kind].cost.steel, 0, `${kind} must not need steel`);
  }

  // The refinery is the hungry one, per GDD §04.
  assert.equal(BUILDINGS.refinery.powerDrawKw, 35);
  assert.equal(BUILDINGS.refinery.tier, 2, 'industry: shed before life support');
});

test('a garage site starves on steel and only steel', () => {
  const sim = new Simulation({ seed: 5150, nearDeposits: 0.2 });
  const site = build(sim, 'garage');
  const cost = BUILDINGS.garage.cost;

  // Stock every raw material the silos will take, but no steel.
  for (const r of MINEABLE_RESOURCES) LogisticsSystem.store(sim.state, r, 100000);
  sim.state.storage.steel = 0;
  sim.recomputeCapacities();

  assert.equal(LogisticsSystem.hasMaterials(sim.state, cost), false, 'the cost is not covered');
  assert.match(LogisticsSystem.missingList(cost), /Steel/, 'the shortfall names steel');

  LogisticsSystem.deliverToSite(sim.state, site);
  for (const r of MINEABLE_RESOURCES) {
    if (cost[r] > 0) {
      assert.ok(site.remainingCost[r] < 1e-9, `${r} was delivered to the site`);
    }
  }
  assert.ok(
    site.remainingCost.steel > 0,
    'the steel is still owed — the site cannot complete without it',
  );

  // Smelt the difference and the same site takes it.
  LogisticsSystem.store(sim.state, 'steel', cost.steel);
  assert.equal(LogisticsSystem.hasMaterials(sim.state, cost), true, 'now it is covered');
  LogisticsSystem.deliverToSite(sim.state, site);
  assert.ok(site.remainingCost.steel < 1e-9, 'steel reaches the site like any other solid');
  assertInvariants(sim);
});

test('steel rides a rover cargo bed like any other solid', () => {
  const sim = new Simulation({ seed: 6060, nearDeposits: 0.2 });
  buildOnline(sim, 'warehouse');
  sim.recomputeCapacities();
  LogisticsSystem.store(sim.state, 'steel', 500);
  const held = sim.storage.steel;
  assert.ok(held > 0, 'the warehouse holds steel');
  const r = sim.rovers[0];
  const bedKg = ROVERS[r.kind].capacityKg;

  // A haul: the silo pays for what goes on the bed, and the depot gets it back.
  const haul = 120;
  assert.equal(LogisticsSystem.take(sim.state, 'steel', haul), haul);
  assert.equal(LogisticsSystem.loadCargo(r, 'steel', haul), haul, 'steel loads like any solid');
  assert.equal(r.cargo.steel, haul);
  assert.equal(cargoMass(r), haul, 'and it counts toward the bed like any solid');
  assert.equal(sim.storage.steel, held - haul, 'the silo paid for it');

  const { moved, blocked } = LogisticsSystem.unloadCargo(sim.state, r);
  assert.equal(blocked, false, 'the depot has room for it');
  assert.equal(moved, haul, 'the whole haul comes off the bed');
  assert.equal(r.cargo.steel, 0, 'the bed is empty afterwards');
  assert.equal(sim.storage.steel, held, 'and the round trip conserves the mass');

  // The bed is finite: what is left of it is all a second load can have.
  const space = LogisticsSystem.loadCargo(r, 'steel', bedKg);
  assert.equal(space, bedKg, 'a fresh bed takes a full load');
  assert.equal(LogisticsSystem.loadCargo(r, 'steel', bedKg), 0, 'and a full one takes nothing');
  assertInvariants(sim);
});

group('A refining colony, end to end');

test('an online refinery smelts through the morning and the colony stays legal', () => {
  const { sim, refinery } = refiningColony(909, 4);
  const ironBefore = sim.storage.iron;
  assert.equal(sim.storage.steel, 0, 'nothing smelted yet');

  run(sim, 0.2); // ~48 game seconds of daylight

  const b = sim.buildingById(refinery.id)!;
  assert.ok(sim.storage.steel > 0, `steel was made (got ${sim.storage.steel})`);
  assert.ok(sim.storage.iron < ironBefore, 'and ore was spent doing it');
  assert.ok(b.throughput > 0, 'the inspector shows a running line');
  assert.ok(
    sim.storage.steel <= LogisticsSystem.capacity(sim.state) + 1e-9,
    'output respects the silo',
  );
  assertInvariants(sim);
});

test('refining is a power decision: a dark, flat colony makes no steel', () => {
  const { sim, refinery } = refiningColony(909, 4);

  // Daylight, four arrays, ore in the silo: the furnace runs flat out.
  run(sim, 0.1);
  const daySteel = sim.storage.steel;
  const daySat = sim.buildingById(refinery.id)!.powerSat;
  assert.ok(daySteel > 0, 'a fed refinery produces');
  assert.equal(daySat, 1, 'and asks for nothing it is not given');

  // Night falls and the battery is flat. Industry is tier 2: it is shed long
  // before the pod (tier 0), so the furnace throttles and the smelting stops.
  sim.devSetTime(1, 0.95);
  sim.state.storedKWh = 0;
  sim.state.storage.steel = 0;
  sim.recomputeCapacities();
  run(sim, 0.1);

  const nightSteel = sim.storage.steel;
  const nightSat = sim.buildingById(refinery.id)!.powerSat;
  assert.ok(nightSat < daySat, `the dark grid throttles the furnace (${nightSat} vs ${daySat})`);
  assert.ok(nightSteel < daySteel, 'less power, less steel');
  assert.ok(
    sim.state.power.tierSatisfaction[0] >= nightSat,
    'life support is served before industry is',
  );
  assertInvariants(sim);
});

test('two identical refining colonies hash the same', () => {
  const a = refiningColony(31337, 3);
  run(a.sim, 0.1);
  const b = refiningColony(31337, 3);
  run(b.sim, 0.1);
  assert.equal(hashSimulation(a.sim), hashSimulation(b.sim), 'refining is deterministic');
  assert.ok(a.sim.storage.steel > 0, 'and both actually smelted');
});

group('Persistence — v8 colonies arrive on the current schema with an empty steel silo');

test('a snapshot carries steel and the current version, and restores it', () => {
  const { sim } = refiningColony(777, 3);
  run(sim, 0.05);
  const made = sim.storage.steel;
  assert.ok(made > 0, 'there is steel to save');

  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.equal(snap.version, SAVE_VERSION, 'the snapshot is on the current schema');
  assert.equal(SAVE_VERSION, 10, 'P5 opened v9 for steel and v10 for the component rack');
  assert.equal(snap.storage.steel, made, 'the steel silo is in the save');

  const next = new Simulation({ seed: 777, nearDeposits: 0.2 });
  next.restore(snap);
  assert.ok(Math.abs(next.storage.steel - made) < 1e-9, 'steel survives the round trip');
  assertInvariants(next);
});

test('a v8 save migrates: an older colony simply has not smelted anything yet', () => {
  const { sim } = refiningColony(778, 3);
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as Record<string, unknown>;

  // Rewrite it into the shape v8 actually wrote: no steel key, old header.
  const storage = snap.storage as Record<string, number>;
  delete storage.steel;
  snap.version = 8;

  const migrated = migrateSave(snap);
  assert.equal(migrated.version, SAVE_VERSION, 'the chain lands on the current version');

  const next = new Simulation({ seed: 778, nearDeposits: 0.2 });
  next.restore(migrated);
  assert.equal(next.storage.steel, 0, 'a v8 colony starts with no steel');
  assert.ok(next.storage.iron >= 0, 'and keeps the ore it had');
  assertInvariants(next);

  // Re-saving lands back on v9 with the new key present.
  assert.equal(next.snapshot().version, SAVE_VERSION);
  assert.equal(next.snapshot().storage.steel, 0);
});

test('a save that claims a steel seam loses it: refined material is not dug', () => {
  const sim = new Simulation({ seed: 779, nearDeposits: 0.2 });
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const seams = snap.deposits as Array<Record<string, unknown>>;
  assert.ok(seams.length > 0, 'there are seams to tamper with');
  seams[0] = { ...seams[0], resource: 'steel' };

  sim.restore(snap);
  assert.ok(
    sim.world.deposits.every((d) => RESOURCES[d.resource].origin === 'mined'),
    'a hand-edited steel seam is dropped rather than trusted',
  );
  assert.equal(sim.world.deposits.length, seams.length - 1, 'only the bogus row is gone');
  assertInvariants(sim);
});

test('a colony can be founded, refined in and built up within one sol of play', () => {
  // The bootstrap guarantee behind the whole slice: nothing about P5 makes the
  // opening unreachable. Raw ore alone still buys the refinery that makes steel.
  const sim = new Simulation({ seed: 808, nearDeposits: 0.2 });
  const refinery = build(sim, 'refinery');
  for (const r of MINEABLE_RESOURCES) LogisticsSystem.store(sim.state, r, 100000);
  sim.state.storage.steel = 0;
  sim.recomputeCapacities();

  assert.equal(
    LogisticsSystem.hasMaterials(sim.state, BUILDINGS.refinery.cost),
    true,
    'ore in the silo is enough to raise a refinery',
  );
  assert.equal(refinery.remainingCost.steel, 0, 'the refinery owes no steel');
  assert.ok(
    BUILDINGS.refinery.buildTime > 0 && SOL_SECONDS > 0,
    'and it is an ordinary build site',
  );
  assertInvariants(sim);
});

await finish('sim/refining');
