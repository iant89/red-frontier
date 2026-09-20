/**
 * @suite sim/components
 * @group integration
 * @covers src/sim/defs.ts src/sim/config.ts src/sim/systems/ComponentSystem.ts src/sim/systems/ProductionSystem.ts src/sim/systems/GarageSystem.ts src/sim/state/ColonyState.ts src/sim/state/BuildingState.ts src/sim/Simulation.ts src/sim/host/protocol.ts src/sim/host/applyCommand.ts src/sim/host/projection.ts src/sim/persistence/ColonyPersistence.ts src/sim/persistence/SaveMigrations.ts src/sim/debug/StateHash.ts src/sim/debug/SimulationAssertions.ts
 * @desc P5 (Engineering), second slice: manufacturing. A Workshop runs one of
 * two *selectable* lines — drive motors out of steel and aluminum, circuit
 * boards out of silica — and what comes off the bench is counted, not weighed:
 * whole units on a component rack, the unfinished fraction still on the
 * building that is making it. Covers the recipe model (a list replaces the
 * blueprint's fixed process, never both), the ledger's whole-unit discipline,
 * the rack-full stall, rack space arriving and leaving with the workshop, rovers
 * costing machines as well as metal, the `building/recipe` command and its
 * refusals, the v9→v10 save step, and the read model the HUD renders from.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ProductionSystem } from '../../src/sim/systems/ProductionSystem';
import { ComponentSystem } from '../../src/sim/systems/ComponentSystem';
import { LogisticsSystem } from '../../src/sim/systems/LogisticsSystem';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { assertInvariants } from '../../src/sim/debug/SimulationAssertions';
import { decodeCommand } from '../../src/sim/host';
import { projectView } from '../../src/sim/host/projection';
import { migrateSave } from '../../src/sim/persistence/SaveMigrations';
import {
  ALL_COMPONENTS,
  ALL_RESOURCES,
  BUILDINGS,
  COMPONENTS,
  RECIPES,
  RESOURCES,
  ROVERS,
  activeProcess,
  activeSummary,
  emptyAmounts,
  emptyComponents,
  hasProcess,
  hasRecipes,
  recipesFor,
  type BuildingKind,
  type RoverKind,
} from '../../src/sim/defs';
import { emptyCraft } from '../../src/sim/state/BuildingState';
import {
  BASE_COMPONENT_SLOTS,
  HOURS_PER_SEC,
  SAVE_VERSION,
  SIM_TICK,
  SOL_SECONDS,
} from '../../src/sim/config';
import { buildOnline, run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** Mars hours covered by one simulation tick — the unit every process rate is in. */
const HOURS = SIM_TICK * HOURS_PER_SEC;

/** Mars hours in `sols` of play: how long a line has been running. */
function hoursIn(sols: number): number {
  return sols * SOL_SECONDS * HOURS_PER_SEC;
}

/**
 * A colony with an online workshop, a silo full of refined stock and daylight on
 * the arrays — ready to craft. Raised complete on legal ground so the subject of
 * these tests is manufacturing, not the construction queue.
 */
function workshopColony(seed = 909, solarArrays = 4) {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.devSetTime(1, 0.4); // mid-morning: the arrays are producing
  const workshop = buildOnline(sim, 'workshop');
  buildOnline(sim, 'warehouse');
  for (let i = 0; i < solarArrays; i++) buildOnline(sim, 'solar');
  sim.recomputeCapacities();
  for (const r of ['steel', 'aluminum', 'silicon'] as const) {
    LogisticsSystem.store(sim.state, r, 100000); // clamps to silo room
  }
  sim.recomputeCapacities();
  return { sim, workshop };
}

group('Components — counted on a rack, not weighed in a silo');

test('components are their own ledger, and only a workshop has room for them', () => {
  assert.deepEqual(ALL_COMPONENTS, ['motor', 'circuitBoard']);
  assert.deepEqual(emptyComponents(), { motor: 0, circuitBoard: 0 });
  assert.deepEqual(emptyCraft(), { motor: 0, circuitBoard: 0 });
  for (const c of ALL_COMPONENTS) {
    const info = COMPONENTS[c];
    assert.ok(info.label.length > 0 && info.short.length > 0, `${c} is named`);
    assert.ok(info.description.length > 0, `${c} is described`);
    assert.ok(Number.isInteger(info.color), `${c} has a colour the HUD can swatch`);
  }

  // They are deliberately not bulk material: nothing about the kg ledger knows
  // them, so no capacity, haul or reservation rule has to pretend a motor weighs
  // something.
  for (const c of ALL_COMPONENTS) {
    assert.ok(!(ALL_RESOURCES as string[]).includes(c), `${c} is not on the bulk ledger`);
    assert.ok(!(c in emptyAmounts()), `${c} is not a ResourceAmounts key`);
  }

  // The landing pod has no rack, so a fresh colony cannot hold a single motor.
  assert.equal(BASE_COMPONENT_SLOTS, 0, 'the pod brings no rack');
  const bare = new Simulation({ seed: 5, nearDeposits: 0.2 });
  assert.equal(bare.componentCapacity(), 0, 'no workshop, nowhere to put a finished unit');
  assert.equal(ComponentSystem.total(bare.state), 0);

  const { sim } = workshopColony();
  const slots = BUILDINGS.workshop.componentSlots!;
  assert.ok(slots > 0, 'the workshop blueprint carries the rack');
  assert.equal(sim.componentCapacity(), slots, 'one online workshop is one rack');
  assert.equal(
    ComponentSystem.totalCapacity(sim.state),
    slots * ALL_COMPONENTS.length,
    'every component type gets the whole rack',
  );
  assert.equal(ComponentSystem.room(sim.state, 'motor'), slots);
});

test('the ledger only ever moves whole units', () => {
  const { sim } = workshopColony();
  // A fraction asked for is a fraction refused: the bench keeps it, the rack
  // does not.
  assert.equal(ComponentSystem.store(sim.state, 'motor', 0.9), 0, 'not a unit yet');
  assert.equal(sim.components.motor, 0);
  assert.equal(ComponentSystem.store(sim.state, 'motor', 2.7), 2, 'floored to whole units');
  assert.equal(sim.components.motor, 2);
  assert.equal(ComponentSystem.total(sim.state), 2);

  // And it never stores more than the rack holds, nor takes more than is there.
  assert.equal(ComponentSystem.store(sim.state, 'motor', 9999), sim.componentCapacity() - 2);
  assert.equal(sim.components.motor, sim.componentCapacity(), 'clamped to rack space');
  assert.equal(ComponentSystem.store(sim.state, 'motor', 1), 0, 'a full rack accepts nothing');
  assert.equal(ComponentSystem.room(sim.state, 'motor'), 0);

  assert.equal(ComponentSystem.take(sim.state, 'motor', 9999), sim.componentCapacity());
  assert.equal(sim.components.motor, 0, 'emptied, never negative');
  assert.equal(ComponentSystem.take(sim.state, 'motor', 1), 0, 'nothing left to take');

  // `has` / `consume` are the pair a cost is spent through.
  const cost = ROVERS.utility.componentCost;
  assert.equal(ComponentSystem.has(sim.state, cost), false, 'an empty rack cannot build a rover');
  ComponentSystem.store(sim.state, 'motor', cost.motor);
  ComponentSystem.store(sim.state, 'circuitBoard', cost.circuitBoard);
  assert.equal(ComponentSystem.has(sim.state, cost), true);
  ComponentSystem.consume(sim.state, cost);
  assert.deepEqual(sim.components, emptyComponents(), 'spent exactly');
  assert.equal(
    ComponentSystem.missingList(cost),
    `${cost.motor} × ${COMPONENTS.motor.label}, ${cost.circuitBoard} × ${COMPONENTS.circuitBoard.label}`,
    'the shortfall reads as a sentence',
  );
});

group('Recipes — one line per blueprint, chosen by the player');

test('a recipe list replaces the blueprint line — a kind never has both', () => {
  const kinds = Object.keys(RECIPES) as BuildingKind[];
  assert.ok(kinds.length > 0, 'P5 shipped at least one selectable line');
  for (const kind of kinds) {
    const list = recipesFor(kind);
    assert.ok(hasRecipes(kind), `${kind} offers a choice, not a menu of one`);
    assert.ok(list.length >= 2, 'and the choice is a real one');
    assert.equal(
      BUILDINGS[kind].process,
      undefined,
      `${kind} has no fixed process to disagree with its recipes`,
    );
    for (const r of list) {
      assert.ok(r.id.length > 0 && r.label.length > 0, `${kind}/${r.id} is named`);
      assert.ok(r.process.summary.length > 0, `${kind}/${r.id} describes itself`);
      assert.equal(activeProcess(kind, list.indexOf(r)), r.process, 'and resolves to itself');
    }
    assert.equal(activeSummary(kind, 0), list[0].process.summary, 'the HUD reads the same line');
  }

  // A kind with no list still runs its blueprint process, untouched.
  assert.equal(activeProcess('refinery', 0), BUILDINGS.refinery.process);
  assert.equal(activeProcess('solar', 0), undefined, 'a solar array converts nothing');
  assert.equal(hasProcess('workshop'), true);
  assert.equal(hasProcess('refinery'), true);
  assert.equal(hasProcess('solar'), false);
  assert.equal(recipesFor('refinery').length, 0, 'the refinery has nothing to choose');
});

test('a stale or corrupt recipe index falls back instead of taking the tick down', () => {
  const first = recipesFor('workshop')[0].process;
  for (const bad of [99, -1, 1.5, NaN, Infinity]) {
    assert.equal(activeProcess('workshop', bad), first, `index ${bad} resolves to the first line`);
    assert.equal(activeSummary('workshop', bad), first.summary);
  }
  // A save from a build with more lines than this one must still run.
  const { sim, workshop } = workshopColony();
  workshop.recipe = 42;
  assert.doesNotThrow(() => ProductionSystem.desiredThroughput(sim.state, workshop));
  assert.equal(ProductionSystem.processBlockReason(sim.state, workshop), 'Idle');
});

group('Manufacturing — the bench, the rack and the line that feeds them');

test('a fed workshop with an empty rack wants to run flat out', () => {
  const { sim, workshop } = workshopColony();
  assert.equal(ProductionSystem.desiredThroughput(sim.state, workshop), 1, 'stock in, room on the rack');
  assert.equal(ProductionSystem.processBlockReason(sim.state, workshop), 'Idle');
});

test('one tick on the motor line eats steel and aluminum at the blueprint rate', () => {
  const { sim, workshop } = workshopColony();
  const p = activeProcess('workshop', 0)!;
  const steelIn = p.solidIn!.steel!;
  const aluIn = p.solidIn!.aluminum!;
  const motorRate = p.componentOut!.motor!;

  const steelBefore = sim.storage.steel;
  const aluBefore = sim.storage.aluminum;
  sim.state.domainEvents.clear();

  ProductionSystem.runProcess(sim.state, workshop, 1, HOURS);

  assert.ok(
    Math.abs(steelBefore - sim.storage.steel - steelIn * HOURS) < 1e-12,
    'the steel draw is the blueprint rate',
  );
  assert.ok(
    Math.abs(aluBefore - sim.storage.aluminum - aluIn * HOURS) < 1e-12,
    'and so is the aluminum draw',
  );
  // A motor takes two Mars hours, so one tick is nowhere near a whole unit: the
  // fraction belongs on the bench and the ledger stays at zero.
  assert.ok(
    Math.abs(workshop.craft.motor - motorRate * HOURS) < 1e-12,
    'progress accumulates on the bench',
  );
  assert.equal(sim.components.motor, 0, 'the rack only ever holds whole units');
  assert.equal(sim.components.circuitBoard, 0, 'and the motor line makes no boards');
  const crafted = sim.state.domainEvents
    .drain()
    .filter((e) => e.type === 'component/crafted');
  assert.equal(crafted.length, 0, 'nothing was racked, so nothing was announced');
});

test('a powered workshop racks whole motors and announces each one', () => {
  const { sim, workshop } = workshopColony();
  const p = activeProcess('workshop', 0)!;
  const sols = 0.1;
  sim.state.domainEvents.clear();
  run(sim, sols);

  const racked = sim.components.motor;
  const progress = racked + workshop.craft.motor;
  const expected = p.componentOut!.motor! * hoursIn(sols);
  assert.ok(racked >= 1, `motors came off the line (got ${racked})`);
  assert.ok(
    Math.abs(progress - expected) / expected < 0.05,
    `output matches the line's rate: ${progress.toFixed(3)} made vs ${expected.toFixed(3)} expected`,
  );
  assert.ok(
    workshop.craft.motor >= 0 && workshop.craft.motor < 1,
    'the bench holds a fraction, never a whole unit',
  );
  assert.equal(sim.components.circuitBoard, 0, 'the motor line makes motors');

  const crafted = sim.state.domainEvents
    .drain()
    .filter((e) => e.type === 'component/crafted');
  const announced = crafted.reduce((n, e) => n + (e.type === 'component/crafted' ? e.amount : 0), 0);
  assert.equal(announced, racked, 'every unit on the rack was announced, once');
  assert.ok(
    crafted.every((e) => e.type === 'component/crafted' && e.component === 'motor' && Number.isInteger(e.amount)),
    'as whole motors, from this building',
  );
  assertInvariants(sim);
});

test('switching lines changes what the workshop eats', () => {
  const { sim, workshop } = workshopColony();
  assert.ok(sim.setBuildingRecipe(workshop.id, 1), 'the switch is accepted');
  assert.equal(workshop.recipe, 1, 'and it is state, not a mood');

  const silicaBefore = sim.storage.silicon;
  const steelBefore = sim.storage.steel;
  run(sim, 0.1);
  assert.ok(sim.storage.silicon < silicaBefore, 'the board line draws silica');
  assert.ok(
    sim.components.circuitBoard + workshop.craft.circuitBoard > 0,
    'and makes boards',
  );
  assert.equal(sim.components.motor, 0, 'it is no longer making motors');
  // The boards line still touches steel (0.2 kg/hr of frame), so the honest
  // check is the ratio, not an absence.
  const p = activeProcess('workshop', 1)!;
  const steelUsed = steelBefore - sim.storage.steel;
  const silicaUsed = silicaBefore - sim.storage.silicon;
  assert.ok(
    Math.abs(steelUsed / silicaUsed - p.solidIn!.steel! / p.solidIn!.silicon!) < 1e-6,
    'the two draws are the blueprint ratio',
  );
  assert.ok(
    sim.alerts.history().some((l) => l.text.includes('switched to')),
    'the log says the line changed',
  );
});

test('work in progress survives a changeover', () => {
  const { sim, workshop } = workshopColony();
  const motorRate = activeProcess('workshop', 0)!.componentOut!.motor!;
  // Run part way through a unit: progress on the bench, nothing racked yet.
  let guard = 0;
  while (workshop.craft.motor < 0.2 && guard++ < 400) sim.step(1 / 20);
  const bench = workshop.craft.motor;
  assert.ok(bench >= 0.2, 'there is a half-made motor on the bench');
  assert.equal(sim.components.motor, 0, 'unfinished, so not on the rack');

  assert.ok(sim.setBuildingRecipe(workshop.id, 1), 'switch to boards');
  assert.equal(workshop.craft.motor, bench, 'the motor progress is still there');
  assert.ok(sim.setBuildingRecipe(workshop.id, 0), 'and back to motors');
  assert.equal(workshop.craft.motor, bench, 'a changeover throws nothing away');

  // It finishes from where it left off rather than starting over.
  const ticks = Math.ceil((1 - bench) / motorRate / HOURS) + 2;
  for (let i = 0; i < ticks; i++) sim.step(1 / 20);
  assert.equal(sim.components.motor, 1, 'the half-made motor finished');
  assert.ok(workshop.craft.motor < 1, 'and the bench is back to a fraction');
});

test('the sim refuses a recipe it does not have, and says why', () => {
  const { sim, workshop } = workshopColony();
  const solar = buildOnline(sim, 'solar');
  const before = sim.alerts.history().length;

  assert.equal(sim.setBuildingRecipe(workshop.id, 99), false, 'no such line');
  assert.equal(sim.setBuildingRecipe(solar.id, 0), false, 'a solar array runs no line at all');
  assert.equal(sim.setBuildingRecipe(999999, 0), false, 'no such structure');
  assert.equal(workshop.recipe, 0, 'a refused switch changes nothing');
  assert.equal(
    sim.alerts.history().length - before,
    3,
    'each refusal is a line the player can read',
  );
  assert.ok(
    sim.alerts.history().some((l) => l.text.includes('fixed line')),
    'including the one that explains a building with nothing to choose',
  );

  // Selecting the line already running is a no-op success, so a stale panel
  // click cannot spam the log.
  const n = sim.alerts.history().length;
  assert.equal(sim.setBuildingRecipe(workshop.id, 0), true, 'already running it');
  assert.equal(sim.alerts.history().length, n, 'and it says nothing about that');

  // The wire agrees: a recipe is a bounded integer index, not any number.
  assert.equal(decodeCommand({ type: 'building/recipe', buildingId: 1, recipe: 1 }).ok, true);
  for (const recipe of [1.5, -1, 99999, '1', null, undefined]) {
    assert.equal(
      decodeCommand({ type: 'building/recipe', buildingId: 1, recipe }).ok,
      false,
      `recipe ${String(recipe)} is refused at the gate`,
    );
  }
  assert.equal(
    decodeCommand({ type: 'building/recipe', buildingId: 1, recipe: 1, extra: true }).ok,
    false,
    'and so is an unknown key',
  );
});

test('a full rack stops the line instead of inventing storage', () => {
  const { sim, workshop } = workshopColony();
  const cap = sim.componentCapacity();
  for (const c of ALL_COMPONENTS) ComponentSystem.store(sim.state, c, 9999);
  assert.equal(sim.components.motor, cap, 'the rack is full');
  assert.equal(ComponentSystem.room(sim.state, 'motor'), 0, 'no room left');

  assert.equal(
    ProductionSystem.desiredThroughput(sim.state, workshop),
    0,
    'nowhere to put a motor, no want to run',
  );
  assert.equal(
    ProductionSystem.processBlockReason(sim.state, workshop),
    `${COMPONENTS.motor.label} rack full`,
    'and the inspector can say so',
  );

  const steelBefore = sim.storage.steel;
  const benchBefore = workshop.craft.motor;
  run(sim, 0.05);
  assert.equal(sim.storage.steel, steelBefore, 'a stalled line eats no steel');
  assert.equal(sim.components.motor, cap, 'the rack does not overflow');
  assert.ok(workshop.craft.motor <= 1, 'nor does the bench pile up invisible progress');
  assert.ok(
    workshop.craft.motor >= benchBefore,
    'whatever was half-made is still half-made',
  );
  assert.ok(workshop.idleReason.includes('rack full'), `the building reports it: "${workshop.idleReason}"`);
  assertInvariants(sim);
});

test('rack space arrives and leaves with the workshop', () => {
  const { sim, workshop } = workshopColony();
  ComponentSystem.store(sim.state, 'motor', 10);
  assert.equal(sim.components.motor, 10);
  assert.equal(sim.componentCapacity(), BUILDINGS.workshop.componentSlots!);

  sim.demolish(workshop.id);

  assert.equal(sim.componentCapacity(), 0, 'a dismantled workshop takes its rack with it');
  assert.equal(
    sim.components.motor,
    0,
    'and the units that no longer have a rack are gone — the same rule the silo follows',
  );
  assertInvariants(sim);
});

group('Rovers — the end of the chain');

test('every rover is a machine, and the rack is part of every price', () => {
  for (const kind of Object.keys(ROVERS) as RoverKind[]) {
    const cost = ROVERS[kind].componentCost;
    assert.ok(cost.motor > 0, `${kind} rolls on motors`);
    assert.ok(cost.circuitBoard > 0, `${kind} needs a controller`);
    assert.ok(
      Number.isInteger(cost.motor) && Number.isInteger(cost.circuitBoard),
      `${kind} costs whole units, because the rack holds whole units`,
    );
  }
  assert.ok(
    ROVERS.cargo.componentCost.motor > ROVERS.utility.componentCost.motor,
    'a hauler is more machine than a runabout',
  );
});

test('a garage refuses a rover it cannot build, naming the missing components', () => {
  const { sim } = workshopColony(5150, 3);
  const garage = buildOnline(sim, 'garage');
  const cargo = ROVERS.cargo;
  // Metal in the silo, machines nowhere: the bulk ledger is not the problem.
  for (const r of ALL_RESOURCES) {
    if (cargo.cost[r] > 0) sim.state.storage[r] = cargo.cost[r] * 2;
  }

  const before = sim.alerts.history().length;
  assert.equal(sim.assembleRover(garage.id, 'cargo'), false, 'no components, no rover');
  const line = sim.alerts.history()[sim.alerts.history().length - 1].text;
  assert.ok(line.includes('component'), `the refusal says what kind of shortage: "${line}"`);
  assert.ok(line.includes(COMPONENTS.motor.label), 'and names the part');
  assert.equal(sim.alerts.history().length, before + 1, 'once');
  assert.equal(garage.assembly, null, 'the line did not start');
  assert.equal(sim.rovers.filter((r) => r.kind === 'cargo').length, 0, 'and no rover appeared');

  // Rack the components and the same click succeeds, spending both ledgers.
  ComponentSystem.store(sim.state, 'motor', cargo.componentCost.motor);
  ComponentSystem.store(sim.state, 'circuitBoard', cargo.componentCost.circuitBoard);
  const steelBefore = sim.storage.steel;
  assert.ok(sim.assembleRover(garage.id, 'cargo'), 'with the parts on the rack, the line starts');
  assert.deepEqual(
    sim.components,
    emptyComponents(),
    'the rack paid exactly what the blueprint asks',
  );
  assert.ok(
    sim.storage.steel < steelBefore || cargo.cost.steel === 0,
    'and the silo paid its share too',
  );
  // Re-read through the sim: `assert.equal` above narrowed the local to null.
  assert.equal(sim.buildingById(garage.id)!.assembly?.kind, 'cargo');
  assertInvariants(sim);
});

test('the chain connects: refined stock becomes motors becomes a rover', () => {
  // Two workshops, one per line, so the slice's whole promise is exercised in
  // one run: steel and silica in, counted machines out, rover on the line.
  const sim = new Simulation({ seed: 606, nearDeposits: 0.2 });
  sim.devSetTime(1, 0.05); // early morning: a full sol of daylight ahead
  buildOnline(sim, 'warehouse');
  for (let i = 0; i < 6; i++) buildOnline(sim, 'solar');
  const motors = buildOnline(sim, 'workshop');
  const boards = buildOnline(sim, 'workshop');
  const garage = buildOnline(sim, 'garage');
  sim.recomputeCapacities();
  for (const r of ['steel', 'aluminum', 'silicon', 'iron'] as const) {
    LogisticsSystem.store(sim.state, r, 100000);
  }
  sim.recomputeCapacities();
  assert.ok(sim.setBuildingRecipe(boards.id, 1), 'one workshop on motors, one on boards');

  const need = ROVERS.utility.componentCost;
  run(sim, 0.4);

  assert.ok(sim.components.motor >= need.motor, `the motor line delivered (${sim.components.motor})`);
  assert.ok(
    sim.components.circuitBoard >= need.circuitBoard,
    `and the board line delivered (${sim.components.circuitBoard})`,
  );
  for (const r of ALL_RESOURCES) {
    if (need.circuitBoard > 0 && ROVERS.utility.cost[r] > 0) {
      sim.state.storage[r] = ROVERS.utility.cost[r] * 2;
    }
  }
  const motorsLeft = sim.components.motor;
  const boardsLeft = sim.components.circuitBoard;
  assert.ok(sim.assembleRover(garage.id, 'utility'), 'so the garage can start a rover');
  assert.equal(
    sim.components.motor,
    motorsLeft - need.motor,
    'the line spent exactly the motors the rover costs',
  );
  assert.equal(
    sim.components.circuitBoard,
    boardsLeft - need.circuitBoard,
    'and exactly the boards',
  );
  assertInvariants(sim);
  assert.equal(motors.recipe, 0, 'neither workshop changed line by itself');
  assert.equal(boards.recipe, 1);
});

test('the survival chain never touches the rack', () => {
  // The bootstrap guarantee for this slice: a colony that never builds a
  // workshop still has everything it needs to stay alive. Components sit at the
  // end of the chain — ore → steel → motors and boards → vehicle — not at a toll
  // booth on the way to oxygen.
  const sim = new Simulation({ seed: 808, nearDeposits: 0.2 });
  for (const kind of ['solar', 'battery', 'extractor', 'oxygenator', 'greenhouse', 'warehouse'] as const) {
    buildOnline(sim, kind);
    const def = BUILDINGS[kind];
    assert.equal(def.componentSlots ?? 0, 0, `${def.label} brings no rack`);
    for (const r of ALL_RESOURCES) {
      if (def.cost[r] > 0) {
        assert.equal(RESOURCES[r].origin, 'mined', `${def.label} is built from dug material`);
      }
    }
  }
  sim.recomputeCapacities();
  assert.equal(sim.componentCapacity(), 0, 'no workshop stands, so nothing can be racked');
  run(sim, 0.25);
  assert.deepEqual(sim.components, emptyComponents(), 'a quarter sol of survival crafted nothing');
  assert.equal(sim.gameOver, null, 'and the colony is alive without ever making a motor');
  assertInvariants(sim);
});

group('Determinism, the read model and the save');

test('two identical workshops hash the same, and the line is part of the state', () => {
  const a = workshopColony(31337, 3);
  run(a.sim, 0.05);
  const b = workshopColony(31337, 3);
  run(b.sim, 0.05);
  assert.equal(hashSimulation(a.sim), hashSimulation(b.sim), 'crafting is deterministic');
  assert.ok(a.sim.components.motor + a.workshop.craft.motor > 0, 'and both actually crafted');

  // The same colony running the other line is a different colony.
  const c = workshopColony(31337, 3);
  c.sim.setBuildingRecipe(c.workshop.id, 1);
  run(c.sim, 0.05);
  assert.notEqual(
    hashSimulation(a.sim),
    hashSimulation(c.sim),
    'which line is running is state, not presentation',
  );
});

test('the rack and the running line are in the payload, as owned copies', () => {
  const { sim, workshop } = workshopColony();
  sim.setBuildingRecipe(workshop.id, 1);
  run(sim, 0.02);
  const benchBefore = { ...workshop.craft };
  const rackedBefore = { ...sim.components };

  const payload = projectView(sim, 'in-process', {});
  assert.deepEqual(payload.components, rackedBefore, 'the rack travels');
  assert.equal(payload.componentCapacity, sim.componentCapacity(), 'and so does the rack space');
  const b = payload.buildings.find((x) => x.id === workshop.id)!;
  assert.equal(b.recipe, 1, 'the panel can highlight the line that is running');
  assert.deepEqual(b.craft, benchBefore, 'and show what is on the bench');

  // Presentation gets a copy: editing what the panel holds cannot edit the sim.
  (payload.components as { motor: number }).motor = 999;
  (b.craft as { motor: number }).motor = 0.75;
  assert.deepEqual(sim.components, rackedBefore, 'the ledger is not the payload');
  assert.deepEqual(workshop.craft, benchBefore, 'the bench is not the payload');
});

test('a snapshot carries the rack, the line and the bench, and restores them', () => {
  const { sim, workshop } = workshopColony(777, 3);
  run(sim, 0.06);
  sim.setBuildingRecipe(workshop.id, 1);
  run(sim, 0.04);
  const racked = { ...sim.components };
  const bench = { ...workshop.craft };
  assert.ok(racked.motor + bench.circuitBoard > 0, 'there is something worth saving');

  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.equal(snap.version, SAVE_VERSION, 'the snapshot is on the current schema');
  assert.equal(SAVE_VERSION, 10, 'P5 slice 2 opened v10 for the component rack');
  assert.deepEqual(snap.components, racked, 'the rack is in the save');
  const saved = snap.buildings.find((x: { id: number }) => x.id === workshop.id);
  assert.equal(saved.recipe, 1, 'so is the line the player chose');
  assert.deepEqual(saved.craft, bench, 'and the work in progress');

  const next = new Simulation({ seed: 777, nearDeposits: 0.2 });
  next.restore(snap);
  assert.deepEqual(next.components, racked, 'the rack survives the round trip');
  const w = next.buildingById(workshop.id)!;
  assert.equal(w.recipe, 1, 'the workshop comes back on its line');
  assert.ok(Math.abs(w.craft.circuitBoard - bench.circuitBoard) < 1e-9, 'with the bench as it was');
  assertInvariants(next);

  // And a colony that reloads keeps crafting rather than starting over.
  run(next, 0.02);
  assert.ok(
    next.components.circuitBoard + w.craft.circuitBoard >= racked.circuitBoard + bench.circuitBoard - 1e-9,
    'the line resumes where the save left it',
  );
});

test('a v9 save migrates: an older colony has never crafted anything', () => {
  const { sim, workshop } = workshopColony(778, 3);
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as Record<string, unknown>;

  // Rewrite it into the shape v9 actually wrote: no rack, no line, no bench.
  delete snap.components;
  for (const b of snap.buildings as Array<Record<string, unknown>>) {
    delete b.recipe;
    delete b.craft;
  }
  snap.version = 9;

  const migrated = migrateSave(snap);
  assert.equal(migrated.version, SAVE_VERSION, 'the chain lands on the current version');

  const next = new Simulation({ seed: 778, nearDeposits: 0.2 });
  next.restore(migrated);
  assert.deepEqual(next.components, emptyComponents(), 'an empty rack');
  const w = next.buildingById(workshop.id)!;
  assert.equal(w.recipe, 0, 'on the first line');
  assert.deepEqual(w.craft, emptyCraft(), 'with an empty bench');
  assertInvariants(next);

  // Re-saving lands back on v10 with the new keys present.
  const again = next.snapshot();
  assert.equal(again.version, SAVE_VERSION);
  assert.deepEqual(again.components, emptyComponents());
  assert.equal(again.buildings.find((x) => x.id === workshop.id)!.recipe, 0);
});

test('a hand-edited rack is sanitised, not trusted', () => {
  const { sim, workshop } = workshopColony(779, 3);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  snap.components = { motor: -3.5, circuitBoard: 1e9 };
  const saved = snap.buildings.find((b: { id: number }) => b.id === workshop.id);
  saved.recipe = 99;
  saved.craft = { motor: 5, circuitBoard: NaN };

  sim.restore(snap);
  const w = sim.buildingById(workshop.id)!;
  assert.equal(sim.components.motor, 0, 'a negative count is not a count');
  assert.ok(
    Number.isInteger(sim.components.motor) && Number.isInteger(sim.components.circuitBoard),
    'the ledger holds whole units',
  );
  assert.ok(
    sim.components.circuitBoard <= sim.componentCapacity(),
    'and never more than the rack holds',
  );
  assert.ok(w.craft.motor <= 1 && w.craft.motor >= 0, 'the bench holds a fraction');
  assert.equal(Number.isNaN(w.craft.circuitBoard), false, 'and never NaN');
  // An out-of-range line is kept as data but resolves to a real one, so a save
  // from a build with a longer menu cannot take the tick down.
  assert.equal(activeProcess(w.kind, w.recipe), recipesFor(w.kind)[0].process);
  assert.doesNotThrow(() => run(sim, 0.01));
  assertInvariants(sim);
});

await finish('sim/components');
