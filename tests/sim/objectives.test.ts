/**
 * @suite sim/objectives
 * @group unit
 * @covers src/sim/systems/ObjectiveSystem.ts src/sim/projects/catalog.ts src/sim/projects/requirements.ts src/sim/unlocks.ts src/sim/state/ObjectiveState.ts src/sim/persistence/migrations/v14.ts
 * @desc Phase 2 Engineering Projects: the catalogue is data, the board is
 * deterministic, completion pays an unlock through the registry, the autonomy
 * streak cannot be faked, and a v14 save survives the schema bump.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ObjectiveSystem, objectiveSnapshot, isDirectOrder, solsWithoutOrder } from '../../src/sim/systems/ObjectiveSystem';
import { evaluateRequirement, requirementKey, requirementUnit, scaledTarget } from '../../src/sim/projects/requirements';
import { PROJECTS, PROJECT_IDS, projectById, openingProjects } from '../../src/sim/projects/catalog';
import type { Requirement } from '../../src/sim/projects/types';
import { ALL_UNLOCKS, UNLOCKS, emptyUnlocks, grantUnlock, hasUnlock, blueprintLock, blueprintLockReason } from '../../src/sim/unlocks';
import { BUILDINGS, BUILDING_ORDER } from '../../src/sim/defs';
import { ConstructionSystem } from '../../src/sim/systems/ConstructionSystem';
import { ColonyMirror } from '../../src/sim/host/mirror';
import { projectView } from '../../src/sim/host/projection';
import { applyCommand } from '../../src/sim/host';
import { emptyObjectiveState } from '../../src/sim/state/ObjectiveState';
import { migrateV14Save } from '../../src/sim/persistence/migrations/v14';
import { decodeSave } from '../../src/sim/persistence/SaveCodec';
import { snapshotColony, restoreColony } from '../../src/sim/persistence/ColonyPersistence';
import { createColonyState } from '../../src/sim/state/ColonyState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { CURRENT_SAVE_VERSION } from '../../src/sim/persistence/SaveSchema';
import { group, test, finish } from '../harness';
import { findSpot, run } from '../fixtures/sim';

/** Place a building and force it online (construction is not this suite's subject). */
function placeOnline(sim: Simulation, kind: Parameters<typeof findSpot>[1]): void {
  const spot = findSpot(sim, kind);
  const b = sim.placeBuilding(kind, spot.x, spot.z);
  assert.ok(b, `${kind} placement failed`);
  assert.ok(sim.devCompleteBuilding(b.id), `${kind} could not be completed for setup`);
}

/** Advance until `predicate` holds, or give up. Returns the sols elapsed. */
function runUntil(sim: Simulation, predicate: () => boolean, maxSols = 4): number {
  const stepSols = 0.25;
  let elapsed = 0;
  while (elapsed < maxSols) {
    run(sim, stepSols);
    elapsed += stepSols;
    if (predicate()) return elapsed;
  }
  return -1;
}

// ------------------------------------------------------------ catalogue ----

group('Project catalogue is content, not code');

test('ids are unique, prerequisites exist, and the chain is acyclic', () => {
  assert.equal(new Set(PROJECT_IDS).size, PROJECT_IDS.length, 'no duplicate project ids');
  for (const def of PROJECTS) {
    for (const id of def.after) {
      assert.ok(projectById(id), `${def.id} depends on unknown project ${id}`);
      assert.notEqual(id, def.id, `${def.id} does not depend on itself`);
    }
    assert.ok(def.requirements.length > 0, `${def.id} asks for at least one thing`);
    assert.ok(def.blurb.length > 0 && def.why.length > 0, `${def.id} explains itself`);
  }
  // Acyclic: walking `after` always terminates because every id appears after
  // the ids it depends on in the catalogue order.
  for (const def of PROJECTS) {
    for (const id of def.after) {
      assert.ok(
        PROJECT_IDS.indexOf(id) < PROJECT_IDS.indexOf(def.id),
        `${def.id} must come after ${id} in the catalogue`,
      );
    }
  }
});

test('rewards name unlocks the registry knows, and every requirement is evaluable', () => {
  const sim = new Simulation({ seed: 4242 });
  for (const def of PROJECTS) {
    for (const unlock of def.rewards) {
      assert.ok(UNLOCKS[unlock], `${def.id} rewards unknown unlock ${unlock}`);
    }
    for (const req of def.requirements) {
      const progress = evaluateRequirement(sim.state, req);
      assert.ok(progress.target > 0, `${def.id}: ${requirementKey(req)} asks for a positive target`);
      assert.ok(progress.label.length > 0, `${def.id}: ${requirementKey(req)} is labelled`);
      assert.equal(typeof progress.met, 'boolean');
    }
  }
});

test('the flagship project is last in the chain, not on the opening board', () => {
  // Review §3.2: "survive 10 sols without manual intervention" is unfair
  // before the colony is legible, so it cannot be reachable at sol 1.
  assert.ok(!openingProjects().includes('autonomousColony'), 'the flagship is not offered at sol 1');
  const flagship = projectById('autonomousColony')!;
  const reached = new Set<string>(flagship.after);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...reached]) {
      for (const next of projectById(id)!.after) {
        if (reached.has(next)) continue;
        reached.add(next);
        grew = true;
      }
    }
  }
  assert.ok(reached.has('establishSurvival') && reached.has('industrialize'), 'the survival → industry chain gates it');
  assert.equal(PROJECT_IDS[PROJECT_IDS.length - 1], 'autonomousColony', 'and it is the last project in the catalogue');
  // The storm branch runs alongside: offered by survival, and not on the path
  // to the flagship, so a player can reach the endgame without it.
  assert.deepEqual(projectById('surviveFirstStorm')!.after, ['establishSurvival']);
});

// ---------------------------------------------------------------- board ----

group('The board a new colony is handed');

test('a new colony is handed its first project immediately', () => {
  const sim = new Simulation({ seed: 7 });
  assert.deepEqual(sim.state.objectives.active, ['establishSurvival']);
  assert.deepEqual(sim.state.objectives.completed, {}, 'nothing is complete at sol 0');
  const snapshot = objectiveSnapshot(sim.state);
  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0].title, 'Establish Survival');
  assert.equal(snapshot.active[0].met, 0, 'and none of it is done yet');
  assert.equal(snapshot.unlocks.length, 0);
  assert.equal(snapshot.solsWithoutOrder, 0);
});

test('no unlock starts granted and grant is idempotent', () => {
  const reg = emptyUnlocks();
  for (const id of ALL_UNLOCKS) assert.equal(hasUnlock(reg, id), false, `${id} starts locked`);
  assert.equal(grantUnlock(reg, 'stormForecasting', 'surviveFirstStorm', 3, 14400), true);
  assert.equal(grantUnlock(reg, 'stormForecasting', 'somePoi', 9, 43200), false, 'a second grant is a no-op');
  assert.equal(reg.stormForecasting?.sol, 3, 'the first stamp is the one that counts');
  assert.equal(reg.stormForecasting?.source, 'surviveFirstStorm');
  assert.equal(grantUnlock(reg, 'notAnUnlock' as never, 'x', 1, 1), false, 'unknown ids are refused');
});

// ----------------------------------------------------------- completion ----

group('Completing a project pays an unlock');

test('a colony that builds the survival chain completes Establish Survival', () => {
  const sim = new Simulation({ seed: 9001 });
  for (const kind of ['solar', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
    placeOnline(sim, kind);
  }
  const sols = runUntil(sim, () => sim.state.objectives.completed['establishSurvival'] != null, 3);
  assert.ok(sols >= 0, 'Establish Survival completed within 3 sols of the chain coming online');

  const record = sim.state.objectives.completed['establishSurvival']!;
  assert.equal(typeof record.sol, 'number');
  assert.ok(!sim.state.objectives.active.includes('establishSurvival'), 'it leaves the board');

  const unlock = sim.state.unlocks['stableOperations'];
  assert.ok(unlock, 'the reward landed in the registry');
  assert.equal(unlock!.source, 'establishSurvival');
  assert.equal(unlock!.sol, record.sol, 'stamped with the sol the project landed');

  const snapshot = objectiveSnapshot(sim.state);
  assert.deepEqual(snapshot.unlocks.map((u) => u.id), ['stableOperations']);
  assert.deepEqual(snapshot.completed.map((c) => c.id), ['establishSurvival']);
});

test('completion is sticky and the next projects come onto the board', () => {
  const sim = new Simulation({ seed: 9001 });
  for (const kind of ['solar', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
    placeOnline(sim, kind);
  }
  assert.ok(runUntil(sim, () => sim.state.objectives.completed['establishSurvival'] != null, 3) >= 0);

  // The two branches that open off survival, offered on the following tick.
  assert.ok(
    runUntil(sim, () => sim.state.objectives.active.length >= 2, 1) >= 0,
    'Survive the First Storm and Industrialize are both offered',
  );
  assert.deepEqual(
    [...sim.state.objectives.active].sort(),
    ['industrialize', 'surviveFirstStorm'],
    'and nothing else is',
  );

  // Tearing the colony back down does not un-complete the project.
  for (const b of [...sim.state.buildings]) sim.demolish(b.id);
  run(sim, 0.1);
  assert.ok(sim.state.objectives.completed['establishSurvival'], 'completion is one-way');
  assert.ok(sim.state.unlocks['stableOperations'], 'and so is the reward');
});

test('completion is announced once, on the structured channel and the log', () => {
  const sim = new Simulation({ seed: 9001 });
  for (const kind of ['solar', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
    placeOnline(sim, kind);
  }
  assert.ok(runUntil(sim, () => sim.state.objectives.completed['establishSurvival'] != null, 3) >= 0);

  const events = sim.drainDomainEvents();
  const completed = events.filter((e) => e.type === 'objective/completed');
  assert.equal(completed.length, 1, 'exactly one completion event');
  assert.equal((completed[0] as { project: string }).project, 'establishSurvival');
  const unlocks = events.filter((e) => e.type === 'unlock/granted');
  assert.equal(unlocks.length, 1, 'and exactly one unlock event');
  assert.equal((unlocks[0] as { unlock: string }).unlock, 'stableOperations');

  const log = sim.alerts.history().map((e) => e.text).join(' | ');
  assert.match(log, /Project complete — Establish Survival/, 'and the player is told');
});

test('a project cannot complete twice, even if it is forced', () => {
  const sim = new Simulation({ seed: 11 });
  const def = projectById('establishSurvival')!;
  ObjectiveSystem.complete(sim.state, def);
  const first = sim.state.objectives.completed['establishSurvival']!;
  assert.equal(sim.drainDomainEvents().filter((e) => e.type === 'objective/completed').length, 1, 'announced once');

  ObjectiveSystem.complete(sim.state, def);
  assert.equal(sim.state.objectives.completed['establishSurvival'], first, 'the record is untouched');
  assert.equal(
    sim.drainDomainEvents().filter((e) => e.type === 'objective/completed').length,
    0,
    'and not announced again',
  );
});

// ------------------------------------------------------------- autonomy ----

group('The autonomy streak cannot be faked');

test('only orders count as orders — and dev commands never do', () => {
  assert.equal(isDirectOrder('rover/move'), true);
  assert.equal(isDirectOrder('building/place'), true);
  assert.equal(isDirectOrder('water/commission'), true);
  assert.equal(isDirectOrder('colonist/order'), true);
  assert.equal(isDirectOrder('tutorial/dismiss'), false, 'dismissing a hint is not running the colony');
  assert.equal(isDirectOrder('engineering/paint'), false, 'a one-off decision is not an order');
  assert.equal(isDirectOrder('dev/spawn/rover'), false, 'a backdoor is not the player');
  // The classification is an allow-list, so P3's future policy/* commands
  // fall outside it without anyone having to come back and exclude them.
  assert.equal(isDirectOrder('policy/stockpile'), false);
});

test('an order resets the streak; the clock then rebuilds it', () => {
  const sim = new Simulation({ seed: 3 });
  run(sim, 2);
  assert.ok(solsWithoutOrder(sim.state) >= 1.9, 'no orders yet, so the streak has been running');
  // Phase 3: the streak is the autonomy window, ended through the command path.
  applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 20, z: 20, queue: false });
  assert.equal(solsWithoutOrder(sim.state), 0, 'an order resets it');
  run(sim, 1);
  assert.ok(solsWithoutOrder(sim.state) >= 0.9, 'and it climbs again');

  const req: Requirement = { type: 'solsWithoutOrder', sols: 10, label: 'Ten sols unattended' };
  const progress = evaluateRequirement(sim.state, req);
  assert.equal(progress.unit, 'sols');
  assert.equal(progress.target, 10);
  assert.equal(progress.met, false, 'not after one sol');
});

test('the flagship streak is difficulty-scaled from the data table (review §3.2)', () => {
  const req = projectById('autonomousColony')!.requirements[0];
  assert.equal(req.type, 'solsWithoutOrder');
  const targets: Record<string, number> = {};
  for (const difficulty of ['settler', 'pioneer', 'survivor'] as const) {
    const sim = new Simulation({ seed: 11, difficulty });
    targets[difficulty] = evaluateRequirement(sim.state, req).target;
  }
  assert.equal(targets.settler, 3, 'a settler is asked for a long weekend');
  assert.equal(targets.pioneer, 5, 'a pioneer for most of a week');
  assert.equal(targets.survivor, 10, 'a survivor for the full ten the roadmap named');
  assert.ok(targets.settler < targets.pioneer && targets.pioneer < targets.survivor, 'monotonic in difficulty');

  // A plain number is the same everywhere; a partial table falls back to
  // pioneer, then to whatever it carries — never to a zero that self-completes.
  assert.equal(scaledTarget(7, 'settler'), 7);
  assert.equal(scaledTarget({ pioneer: 5 }, 'survivor'), 5);
  assert.equal(scaledTarget({ settler: 3 }, 'survivor'), 3);
  assert.equal(scaledTarget({}, 'pioneer'), 0);
});

test('a settler colony lands the flagship at three sols, a survivor does not', () => {
  const settle = (difficulty: 'settler' | 'survivor') => {
    const sim = new Simulation({ seed: 21, difficulty });
    // Skip the chain: this test is about the streak, not the industry branch.
    for (const id of ['establishSurvival', 'industrialize', 'remoteOperations'] as const) {
      ObjectiveSystem.complete(sim.state, projectById(id)!);
    }
    ObjectiveSystem.tick(sim.state);
    assert.ok(sim.state.objectives.active.includes('autonomousColony'), `${difficulty}: flagship offered`);
    sim.state.lastDirectOrderSol = sim.state.clock.sol;
    sim.state.autonomy.startedAt = sim.state.clock.solsElapsed;
    run(sim, 3.25);
    return sim.state.objectives.completed['autonomousColony'] != null;
  };
  assert.equal(settle('settler'), true, 'three unattended sols is enough on settler');
  assert.equal(settle('survivor'), false, 'and nowhere near enough on survivor');
});

test('a developer time-jump does not hand out ten sols of autonomy', () => {
  const sim = new Simulation({ seed: 5 });
  run(sim, 1);
  sim.devSetTime(30, 0.5);
  assert.equal(
    sim.state.objectives.completed['autonomousColony'],
    undefined,
    'jumping the clock is not surviving it',
  );
  // The flagship is not even on the board this early, but the marker moved with
  // the clock rather than staying at sol 0.
  assert.equal(solsWithoutOrder(sim.state), 0, 'the streak starts from the sol jumped to');
});

// ---------------------------------------------------------- requirements ----

group('Requirements read the colony, not a cached copy');

test('every requirement type evaluates against live state', () => {
  const state = createColonyState({ seed: 21 });
  const cases: Array<{ req: Requirement; pre?: (s: typeof state) => void; mutate: (s: typeof state) => void; expected: number }> = [
    { req: { type: 'buildingOnline', building: 'workshop', count: 2, label: 'x' }, mutate: (s) => {
      s.buildings.push(
        { kind: 'workshop', state: 'online', damaged: false, enabled: true } as never,
        { kind: 'workshop', state: 'online', damaged: false, enabled: true } as never,
      );
    }, expected: 2 },
    { req: { type: 'storage', resource: 'iron', kg: 300, label: 'x' }, mutate: (s) => { s.storage.iron = 120; }, expected: 120 },
    { req: { type: 'components', component: 'motor', count: 3, label: 'x' }, mutate: (s) => { s.components.motor = 2; }, expected: 2 },
    // The lander arrives with water aboard, so the pool is emptied first —
    // the point is that the requirement reads the tank, not that it reads zero.
    { req: { type: 'fluidAmount', fluid: 'water', kg: 80, label: 'x' }, pre: (s) => { s.pools.amounts.water = 0; }, mutate: (s) => { s.pools.amounts.water = 80; }, expected: 80 },
    // The pod lands with its own 90 kWh pack, so grid capacity starts above zero.
    { req: { type: 'batteryCapacity', kWh: 400, label: 'x' }, pre: (s) => { s.power.capacityKWh = 0; }, mutate: (s) => { s.power.capacityKWh = 290; }, expected: 290 },
    // Storm sheltering is on by default, so both rovers are told otherwise.
    { req: { type: 'roverRule', rule: 'stormShelter', count: 2, label: 'x' }, pre: (s) => {
      for (const r of s.rovers) r.rules.stormShelter = false;
    }, mutate: (s) => {
      s.rovers[0].rules.stormShelter = true;
    }, expected: 1 },
    { req: { type: 'repeatRoute', count: 1, label: 'x' }, mutate: (s) => {
      s.rovers[0].command = { type: 'mine', depositId: 1, repeat: true };
    }, expected: 1 },
    // Two rovers land with the pod, so a fleet of three is one assembly away.
    { req: { type: 'roverCount', count: 3, label: 'x' }, pre: (s) => { s.rovers.length = 0; }, mutate: (s) => {
      s.rovers.push({ id: 1 } as never, { id: 2 } as never);
    }, expected: 2 },
    { req: { type: 'stormsSurvived', count: 1, label: 'x' }, mutate: (s) => { s.tutorial.stats.stormsSurvived = 1; }, expected: 1 },
    { req: { type: 'poisDiscovered', count: 2, label: 'x' }, mutate: (s) => { s.world.pois[0].discovered = true; }, expected: 1 },
  ];

  for (const { req, pre, mutate, expected } of cases) {
    pre?.(state);
    const before = evaluateRequirement(state, req);
    assert.equal(before.current, 0, `${requirementKey(req)} starts at zero`);
    mutate(state);
    const after = evaluateRequirement(state, req);
    assert.equal(after.current, expected, `${requirementKey(req)} reads live state`);
    assert.equal(after.met, expected >= after.target, `${requirementKey(req)} met matches the numbers`);
  }
});

test('stable power means a grid carrying a load, not an idle one', () => {
  const state = createColonyState({ seed: 33 });
  const req: Requirement = { type: 'powerStable', minStoredFrac: 0.15, label: 'x' };
  assert.equal(requirementUnit(req), 'percent');

  // Idle: nothing is drawing, so nothing is being proven.
  state.power.capacityKWh = 200;
  state.power.storedKWh = 100;
  state.power.demandKw = 0;
  state.power.generationKw = 0;
  state.power.brownout = false;
  assert.equal(evaluateRequirement(state, req).met, false, 'an idle grid is not a stable grid');

  // Loaded but shedding.
  state.power.demandKw = 40;
  state.power.generationKw = 20;
  state.power.brownout = true;
  assert.equal(evaluateRequirement(state, req).met, false, 'brownout is not stable');

  // Loaded, covered, and with a reserve.
  state.power.generationKw = 44;
  state.power.brownout = false;
  assert.equal(evaluateRequirement(state, req).met, true);

  // Covered, but running the batteries down to nothing.
  state.power.storedKWh = 4;
  assert.equal(evaluateRequirement(state, req).met, false, 'a flat reserve is not stable');
});

test('a damaged or switched-off building does not count as online', () => {
  const state = createColonyState({ seed: 44 });
  const req: Requirement = { type: 'buildingOnline', building: 'refinery', count: 1, label: 'x' };
  state.buildings.push({ kind: 'refinery', state: 'online', damaged: false, enabled: true } as never);
  assert.equal(evaluateRequirement(state, req).met, true);
  (state.buildings[0] as { damaged: boolean }).damaged = true;
  assert.equal(evaluateRequirement(state, req).met, false, 'damage takes it off the count');
  (state.buildings[0] as { damaged: boolean }).damaged = false;
  (state.buildings[0] as { enabled: boolean }).enabled = false;
  assert.equal(evaluateRequirement(state, req).met, false, 'so does switching it off');
});

// ----------------------------------------------------------- persistence ----

group('Save compatibility (v15)');

test('the board and the registry round-trip through a save', () => {
  const sim = new Simulation({ seed: 9001 });
  for (const kind of ['solar', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
    placeOnline(sim, kind);
  }
  assert.ok(runUntil(sim, () => sim.state.objectives.completed['establishSurvival'] != null, 3) >= 0);
  const saved = snapshotColony(sim.state);
  assert.equal(saved.version, CURRENT_SAVE_VERSION);
  assert.equal(saved.version, CURRENT_SAVE_VERSION, 'the current schema');

  const target = createColonyState({ seed: 1 });
  restoreColony(target, decodeSave(JSON.parse(JSON.stringify(saved))));

  assert.deepEqual(target.objectives.completed, sim.state.objectives.completed, 'the board survives');
  assert.deepEqual(target.objectives.active, sim.state.objectives.active);
  assert.deepEqual(target.unlocks, sim.state.unlocks, 'so does the registry');
  assert.equal(target.lastDirectOrderSol, sim.state.lastDirectOrderSol);
});

test('a v14 save gets an empty board and the opening project', () => {
  const v14 = {
    version: 14,
    seed: 9001,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: {},
    simTime: 4800,
    ticksRun: 96000,
    clock: { sol: 6, frac: 0.25 },
    storage: { regolith: 0, iron: 0, silicon: 0, aluminum: 0, ice: 0, steel: 0 },
    components: { motor: 0, circuitBoard: 0, pipe: 0, batteryPack: 0, cargoFrame: 0, drillTeeth: 0 },
    fluids: { water: 40, oxygen: 10, food: 30 },
    storedKWh: 30,
    gameOver: null,
    colonist: { id: 1, name: 'Cmdr. Vega', x: 0, z: 3, heading: 0, health: 100, suitO2: 100, inside: true, shelterId: 0, order: { type: 'idle' }, dead: false },
    deposits: [],
    pois: [],
    exploration: { nextDropSol: 4 },
    rovers: [],
    buildings: [],
    weather: {},
    alerts: {},
    tutorial: null,
  };
  const migrated = migrateV14Save(v14 as never) as Record<string, unknown>;
  assert.equal(migrated.version, 15);
  // Sanitised at the boundary, then handed the opening project by the restorer:
  // an old colony should not find itself with a board that says nothing to do.
  assert.deepEqual((migrated.objectives as { active: string[] }).active, []);
  assert.deepEqual((migrated.objectives as { completed: unknown }).completed, {});
  assert.equal(
    (migrated.unlocks as { lastDirectOrderSol: number }).lastDirectOrderSol,
    6,
    'an old colony starts counting from its own sol, not from zero',
  );
  assert.equal(
    Object.values((migrated.unlocks as { unlocks: Record<string, unknown> }).unlocks).filter((v) => v != null).length,
    0,
    'with an empty registry',
  );

  // The same save through the real decode path lands on the current schema.
  const decoded = decodeSave(JSON.parse(JSON.stringify(v14)));
  assert.equal(decoded.version, CURRENT_SAVE_VERSION);
  const state = createColonyState({ seed: 1 });
  restoreColony(state, decoded);
  assert.deepEqual(state.objectives.active, ['establishSurvival']);
  assert.equal(state.lastDirectOrderSol, 6);
});

test('a hand-edited board is sanitised, not trusted', () => {
  const v14 = {
    version: 14,
    seed: 1,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: {},
    simTime: 0,
    ticksRun: 0,
    clock: { sol: 4, frac: 0 },
    storage: {},
    components: {},
    fluids: { water: 1, oxygen: 1, food: 1 },
    storedKWh: 1,
    gameOver: null,
    colonist: { id: 1, name: 'x', x: 0, z: 0, heading: 0, health: 100, suitO2: 100, inside: true, shelterId: 0, order: { type: 'idle' }, dead: false },
    deposits: [],
    pois: [],
    exploration: { nextDropSol: 3 },
    rovers: [],
    buildings: [],
    weather: {},
    alerts: {},
    // A board claiming a project this build has never heard of, a duplicate,
    // a completion with no sol stamp, and an unlock that is not in the registry.
    objectives: {
      active: ['notAProject', 'industrialize', 'industrialize'],
      completed: { industrialize: { sol: 2, tick: 10 }, notAProject: { sol: 5, tick: 1 }, establishSurvival: { sol: null } },
    },
    unlocks: { unlocks: { stableOperations: { sol: 2, tick: 10, source: 'establishSurvival' }, timeTravel: { sol: 1, tick: 1 } }, lastDirectOrderSol: 4 },
  };
  const migrated = migrateV14Save(v14 as never) as Record<string, unknown>;
  const board = migrated.objectives as { active: string[]; completed: Record<string, unknown> };
  assert.deepEqual(board.active, [], 'unknown ids are dropped, duplicates collapsed');
  assert.deepEqual(Object.keys(board.completed), ['industrialize'], 'only the well-formed completion survives');
  const reg = (migrated.unlocks as { unlocks: Record<string, unknown> }).unlocks;
  assert.ok(reg['stableOperations'], 'a real unlock is kept');
  assert.equal(Object.keys(reg).length, ALL_UNLOCKS.length, 'an invented unlock is not');
  assert.equal((migrated.unlocks as { lastDirectOrderSol: number }).lastDirectOrderSol, 4);

  // Garbage in the same shape does not throw either.
  const junk = migrateV14Save({
    ...(v14 as unknown as Record<string, unknown>),
    objectives: 'nonsense',
    unlocks: { unlocks: 42 },
  } as never) as Record<string, unknown>;
  assert.deepEqual((junk.objectives as { active: string[] }).active, []);
  assert.equal(Object.keys((junk.unlocks as { unlocks: Record<string, unknown> }).unlocks).length, ALL_UNLOCKS.length);
});

test('an empty board on a save is re-handed the opening project', () => {
  const state = createColonyState({ seed: 2 });
  restoreColony(state, {
    version: 15,
    seed: 2,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: {},
    simTime: 0,
    ticksRun: 0,
    clock: { sol: 3, frac: 0 },
    storage: {},
    components: {},
    fluids: { water: 1, oxygen: 1, food: 1 },
    storedKWh: 1,
    gameOver: null,
    colonist: { id: 1, name: 'x', x: 0, z: 0, heading: 0, health: 100, suitO2: 100, inside: true, shelterId: 0, order: { type: 'idle' }, dead: false },
    deposits: [],
    pois: [],
    exploration: { nextDropSol: 3 },
    rovers: [],
    buildings: [],
    weather: {},
    alerts: {},
    objectives: { active: [], completed: {} },
    unlocks: { unlocks: emptyUnlocks(), lastDirectOrderSol: 0 },
  } as never);
  assert.deepEqual(state.objectives.active, ['establishSurvival'], 'a board with nothing on it is not a feature');
});

// ------------------------------------------------------------ determinism ----

group('Determinism');

test('two colonies handed the same commands hold the same board', () => {
  const play = (seed: number) => {
    const sim = new Simulation({ seed });
    for (const kind of ['solar', 'solar', 'battery', 'extractor', 'oxygenator', 'greenhouse'] as const) {
      placeOnline(sim, kind);
    }
    ObjectiveSystem.noteCommand(sim.state, 'rover/move');
    run(sim, 1);
    return sim;
  };
  const a = play(9001);
  const b = play(9001);
  assert.deepEqual(a.state.objectives, b.state.objectives);
  assert.deepEqual(a.state.unlocks, b.state.unlocks);
  assert.equal(hashSimulation(a), hashSimulation(b));
});

test('the board is part of the authoritative state hash', () => {
  const sim = new Simulation({ seed: 9001 });
  run(sim, 0.25);
  const before = hashSimulation(sim);
  sim.state.objectives.completed['industrialize'] = { sol: 1, tick: 2 };
  const after = hashSimulation(sim);
  assert.notEqual(before, after, 'a completed project changes the colony');
  sim.state.objectives.completed = {};
  sim.state.unlocks['stableOperations'] = { sol: 1, tick: 2, source: 'test' };
  assert.notEqual(hashSimulation(sim), before, 'so does an earned unlock');
});

test('emptyObjectiveState is the same board every new colony starts from', () => {
  assert.deepEqual(emptyObjectiveState().active, openingProjects());
  assert.deepEqual(emptyObjectiveState().completed, {});
});

// ------------------------------------------------------- blueprint gating ----

group('Blueprint gating — the registry\'s first consumer');

test('no shipping blueprint is gated (the first projects stay completable)', () => {
  // Review §5 P2: the first projects must be completable with today's
  // building set. The mechanism exists; the table gates nothing.
  for (const kind of BUILDING_ORDER) {
    assert.equal(BUILDINGS[kind].requiresUnlock, undefined, `${kind} is available from sol 1`);
  }
  // And anything a project *asks for* can never be locked behind that project.
  for (const def of PROJECTS) {
    for (const req of def.requirements) {
      if (req.type !== 'buildingOnline') continue;
      const gate = BUILDINGS[req.building].requiresUnlock;
      assert.ok(!gate || !def.rewards.includes(gate), `${def.id} does not require what it pays`);
    }
  }
});

test('blueprintLock reads a registry, a set or a list the same way', () => {
  const reg = emptyUnlocks();
  assert.equal(blueprintLock(reg, undefined), null, 'an ungated blueprint is open');
  assert.equal(blueprintLock(reg, 'stormForecasting'), 'stormForecasting');
  assert.equal(blueprintLock(new Set<string>(), 'stormForecasting'), 'stormForecasting');
  assert.equal(blueprintLock([], 'stormForecasting'), 'stormForecasting');
  grantUnlock(reg, 'stormForecasting', 'test', 1, 1);
  assert.equal(blueprintLock(reg, 'stormForecasting'), null);
  assert.equal(blueprintLock(new Set(['stormForecasting']), 'stormForecasting'), null);
  assert.equal(blueprintLock(['stormForecasting'], 'stormForecasting'), null);
  assert.match(blueprintLockReason('stormForecasting'), /Storm Forecasting/);
});

test('a gated blueprint is refused by the sim and the ghost alike until the unlock lands', () => {
  const def = BUILDINGS.repairBay;
  const saved = def.requiresUnlock;
  def.requiresUnlock = 'stableOperations';
  try {
    const sim = new Simulation({ seed: 77 });
    const spot = (() => {
      for (let r = 34; r <= 120; r += 3) {
        for (let a = 0; a < 360; a += 7) {
          const x = Math.cos((a * Math.PI) / 180) * r;
          const z = Math.sin((a * Math.PI) / 180) * r;
          if (ConstructionSystem.verdict(sim.state, 'warehouse', x, z) === null) return { x, z };
        }
      }
      throw new Error('no spot');
    })();
    const mirror = () =>
      new ColonyMirror(
        { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
        projectView(sim, 'worker', {}),
      );

    const refused = ConstructionSystem.verdict(sim.state, 'repairBay', spot.x, spot.z);
    assert.match(refused ?? '', /Stable Operations/, 'the sim names the missing unlock');
    assert.equal(mirror().placeVerdict('repairBay', spot.x, spot.z), refused, 'the ghost gives the same answer');
    assert.equal(sim.placeBuilding('repairBay', spot.x, spot.z), null, 'and placement is refused');
    assert.equal(sim.devSpawnBuilding('repairBay', spot.x, spot.z), null, 'even the dev backdoor');
    assert.equal(ConstructionSystem.verdict(sim.state, 'warehouse', spot.x, spot.z), null, 'ungated blueprints are untouched');

    ObjectiveSystem.grant(sim.state, 'stableOperations', 'test');
    assert.equal(ConstructionSystem.verdict(sim.state, 'repairBay', spot.x, spot.z), null, 'earned: the ground decides again');
    assert.equal(mirror().placeVerdict('repairBay', spot.x, spot.z), null, 'and the mirror sees the grant');
    assert.ok(sim.placeBuilding('repairBay', spot.x, spot.z), 'so placement goes through');
  } finally {
    def.requiresUnlock = saved;
  }
});

await finish('sim/objectives');
