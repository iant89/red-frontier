/**
 * @suite sim/rover-state
 * @group integration
 * @covers src/sim/state/RoverState.ts src/sim/systems/RoverSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/debug/SimulationAssertions.ts
 * @desc Refactor roadmap Phase 11: the rover state model. The transition table
 * in `docs/design/ROVER-STATE.md` is driven through the live simulation — each
 * task's entry state, its travel/arrive/work transitions, the conditions that
 * preempt a task, the restore-time rehydration — and the invariant checker that
 * machine-checks the same table is pinned by corrupting a rover on purpose.
 * The wording table is pinned too: it is now the *only* place rover wording
 * exists, so it has to say what the deleted `statusText` field used to.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { roverStatusText, enterIdle, type Rover, type RoverGoal } from '../../src/sim/state/RoverState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { checkInvariants } from '../../src/sim/debug/SimulationAssertions';
import {
  SIM_TICK,
  SPAWN_X,
  SPAWN_Z,
  HOURS_PER_SEC,
  ROVER_PROXIMITY_SPEED_MUL,
  ROVER_PROXIMITY_COLONY_SPEED_MUL,
  ROVER_WEAR_MOVE_S,
} from '../../src/sim/config';
import { ALL_RESOURCES, ROVERS, emptyAmounts } from '../../src/sim/defs';
import { salvageTotalKg } from '../../src/sim/pois';
import { run, build, buildOnline, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 11): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

/** Run until `done()`, returning the ticks used (or -1 if it never happened). */
function until(sim: Simulation, done: () => boolean, ticks = 4000): number {
  for (let i = 0; i < ticks; i++) {
    sim.step(SIM_TICK);
    if (done()) return i + 1;
  }
  return -1;
}

function said(sim: Simulation, needle: string): boolean {
  return sim.alerts.history().some((e) => e.text.includes(needle));
}

/**
 * Park a rover: a full stop with the execution state to match. Tools like this
 * used to clear `navPath` and leave `goal`/`phase` alone, which is a state the
 * sim can never reach — Phase 11's execution invariant catches exactly that.
 */
function park(sim: Simulation, idx = 0, x = 260, z = -180): Rover {
  const r = sim.rovers[idx];
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.navPath = [];
  r.navI = 0;
  r.heading = 0;
  enterIdle(r);
  r.command = { type: 'idle' };
  r.pending = [];
  r.autoTask = false;
  r.recharge = false;
  r.sheltered = false;
  r.routePaused = false;
  return r;
}

/** Point a rover straight at a target without A*: one far waypoint. */
function aimAt(r: Rover, tx: number, tz: number, goal: RoverGoal): void {
  r.goal = goal;
  r.phase = 'moving';
  r.navPath = [{ x: tx, z: tz }];
  r.navI = 0;
  r.gx = tx;
  r.gz = tz;
}

/** The farthest deposit of a kind — guaranteed not to be underfoot. */
function farDeposit(sim: Simulation, res = 'iron') {
  return sim.world.deposits
    .filter((d) => d.resource === res && d.amount > 0)
    .sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z))[0];
}

function stocked(sim: Simulation, kg = 3000): void {
  for (const res of ALL_RESOURCES) sim.storage[res] = kg;
}

// ---------------------------------------------------------------------------

group('Task → first execution state');

test('a moveTo order drives, then parks: (move, moving) → (idle, idle)', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  sim.issueMove(r.id, 60, 30);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'move', 'the order is executing as a move');
  assert.equal(r.phase, 'moving');
  assert.ok(r.navPath.length > 0, 'and carries a real nav path');

  assert.ok(until(sim, () => r.goal === 'idle') > 0, 'it arrives');
  assert.equal(r.phase, 'idle');
  assert.equal(r.command.type, 'idle', 'and the move order is complete');
});

test('a mine order away from the seam travels first, then digs', () => {
  const sim = fresh();
  const dep = nearDeposit(sim, 'iron');
  const r = park(sim, 0, dep.x + 60, dep.z);
  sim.issueMine(r.id, dep.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'mine', 'the goal names the task');
  assert.equal(r.phase, 'moving', 'while it is still walking');

  assert.ok(
    until(sim, () => r.phase === 'working' && r.goal === 'mine') > 0,
    'it reaches the seam and digs',
  );
  assert.equal(dep.reservedBy, r.id, 'and the seam is claimed');
});

test('an unload order with cargo hauls home; an empty hold is a no-op', () => {
  const sim = fresh();
  const r = park(sim, 0, 260, -180);
  r.cargo.iron = 40;
  sim.issueUnload(r.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toDepot');
  assert.equal(r.phase, 'moving');

  const empty = sim.rovers[1];
  sim.issueUnload(empty.id);
  sim.step(SIM_TICK);
  assert.equal(empty.goal, 'idle', 'nothing to pour, so nothing was ordered');
  assert.equal(empty.phase, 'idle');
});

test('a construct order walks to the site and assembles on arrival', () => {
  const sim = fresh();
  const b = build(sim, 'solar');
  stocked(sim);
  sim.step(SIM_TICK); // tickSiteMaterials pours the cost in
  const r = park(sim, 0, b.x + 60, b.z);
  // The other rover keeps a player order so construction cannot staff it too.
  sim.issueMove(sim.rovers[1].id, 300, -300);
  sim.issueConstruct(r.id, b.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toSite');
  assert.equal(r.phase, 'moving');

  assert.ok(until(sim, () => r.goal === 'build' && r.phase === 'working') > 0, 'it starts assembling');
  assert.equal(r.gid, b.id, 'with the site as its target');
});

test('a clean order services at the building: (toService, moving) → (service, working)', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  b.cleanliness = 0.4;
  const r = park(sim, 1, b.x + 60, b.z);
  sim.issueClean(r.id, b.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toService');
  assert.equal(r.phase, 'moving');

  assert.ok(until(sim, () => r.goal === 'service' && r.phase === 'working') > 0, 'it reaches the array');
});

test('a salvage order walks to the site and starts cutting', () => {
  const sim = fresh();
  const p = sim.world.pois.find((q) => q.kind !== 'settlementSite')!;
  p.discovered = true;
  const r = park(sim, 0, p.x + 60, p.z);
  sim.issueSalvage(r.id, p.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toSalvage');
  assert.equal(r.phase, 'moving');

  assert.ok(until(sim, () => r.goal === 'salvage' && r.phase === 'working') > 0, 'it starts stripping');
});

test('a recover order responds to a stranded rover: (toRecover, moving) → (recover, working)', () => {
  const sim = fresh();
  const [rescuer, stranded] = sim.rovers;
  const r = park(sim, 0, SPAWN_X + 240, SPAWN_Z - 160);
  park(sim, 1, SPAWN_X + 260, SPAWN_Z - 150);
  stranded.battery = 0;
  RoverSystem.disable(sim.state, stranded);
  assert.equal(
    sim.issueRecover(r.id, stranded.id),
    true,
    'the rescue is dispatched from a healthy pack',
  );
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toRecover');
  assert.equal(r.phase, 'moving');

  assert.ok(until(sim, () => r.goal === 'recover' && r.phase === 'working') > 0, 'it hooks up');
});

test('a wait order parks at (idle, idle) and counts the seconds down', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  sim.issueWait(r.id, 30);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'idle');
  assert.equal(r.phase, 'idle');
  assert.equal(r.command.type, 'wait');
  assert.ok(r.command.type === 'wait' && r.command.seconds < 30, 'the hold is ticking away');
});

test('an idle rover parked on a charger is charging, with no task at all', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  r.x = SPAWN_X;
  r.z = SPAWN_Z;
  r.battery = 20;
  sim.stopRover(r.id);
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'idle');
  assert.equal(r.phase, 'charging', 'the pad does the work, not the task');
  assert.equal(roverStatusText(r), 'Charging');
});

// ---------------------------------------------------------------------------

group('Transitions & preemption');

test('a full hold turns the seam into a haul: (mine, working) → (toDepot, moving) → (idle, idle)', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = nearDeposit(sim, 'iron');
  dep.amount = 40; // a small seam, so the run is a single trip
  sim.issueMine(r.id, dep.id);
  assert.ok(until(sim, () => r.goal === 'mine' && r.phase === 'working') > 0, 'it digs');
  assert.ok(until(sim, () => r.goal === 'toDepot') > 0, 'then hauls the load home');
  assert.equal(r.phase, 'moving');
  assert.ok(until(sim, () => r.goal === 'idle' && r.command.type === 'idle') > 0, 'and finishes');
});

test('the ride-home floor preempts the task without losing it', () => {
  const sim = fresh();
  const dep = farDeposit(sim);
  const r = park(sim, 0, dep.x + 60, dep.z);
  sim.issueMine(r.id, dep.id);
  r.battery = 1; // under the floor: the ride home outranks the seam
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'toCharge', 'execution state is the charge');
  assert.equal(r.phase, 'moving');
  assert.equal(r.command.type, 'mine', 'the task underneath is untouched');
  assert.equal(r.recharge, true);
});

test('a charge cycle ends parked, not charging for ever', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  r.x = SPAWN_X;
  r.z = SPAWN_Z;
  r.battery = 20;
  r.recharge = true;
  assert.ok(until(sim, () => r.goal === 'charge') > 0, 'reaches (charge, charging)');
  assert.equal(r.phase, 'charging');

  r.battery = 0.99 * ROVERS[r.kind].maxBatteryKWh;
  assert.ok(until(sim, () => r.goal === 'idle') > 0, 'a full pack releases the charge');
  assert.equal(r.phase, 'idle');
  assert.equal(r.recharge, false);
});

test('a disabled rover is parked and holds nothing', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = nearDeposit(sim, 'iron');
  sim.issueMine(r.id, dep.id);
  RoverSystem.claimDeposit(sim.state, r, dep.id);
  RoverSystem.disable(sim.state, r);
  assert.equal(r.phase, 'disabled');
  assert.equal(r.goal, 'idle', 'a disabled rover has no execution state to execute');
  assert.equal(dep.reservedBy, null, 'and no claim');
  assert.equal(roverStatusText(r), 'Disabled — out of power');
});

test('a storm recall overrides execution state but never the order', () => {
  const sim = fresh();
  const r = park(sim, 0, SPAWN_X + 240, SPAWN_Z - 160);
  sim.issueWait(r.id, 600);
  sim.devForceStorm('severe');

  assert.ok(
    until(sim, () => r.sheltered && r.phase === 'charging', 4000) > 0,
    'the rover is caught, runs for the pad and plugs in',
  );
  assert.equal(roverStatusText(r), 'Sheltering from storm');
  assert.equal(r.command.type, 'wait', 'the order underneath survives the recall');

  sim.devClearStorms();
  assert.ok(until(sim, () => !r.sheltered, 4000) > 0, 'the recall releases when the gust front passes');
  const held = r.command;
  sim.step(SIM_TICK);
  assert.equal(r.goal, 'idle', 'and the rover picks the job back up');
  assert.equal(r.command, held, 'the same order instance, never re-issued');
  assert.ok(held.type === 'wait' && held.seconds < 600, 'the hold resumes where it left off');
});

// ---------------------------------------------------------------------------

group('Presentation is derived');

test('the wording table covers every documented state', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const caseFor = (patch: Partial<Rover>): string => {
    const saved = structuredClone(r);
    Object.assign(r, patch);
    const text = roverStatusText(r);
    Object.assign(r, saved);
    return text;
  };
  const calm = { phase: 'idle' as const, goal: 'idle' as const, sheltered: false, routePaused: false };

  assert.equal(caseFor({ ...calm }), 'Idle');
  assert.equal(caseFor({ ...calm, phase: 'charging' }), 'Charging');
  assert.equal(caseFor({ ...calm, phase: 'disabled' }), 'Disabled — out of power');
  assert.equal(caseFor({ ...calm, sheltered: true }), 'Sheltering from storm');
  assert.equal(caseFor({ ...calm, routePaused: true }), 'Route paused — silo full');
  assert.equal(caseFor({ ...calm, command: { type: 'wait', seconds: 12.2 } }), 'Waiting (13 s)');
  assert.equal(caseFor({ ...calm, goal: 'move' }), 'Moving');
  assert.equal(caseFor({ ...calm, goal: 'mine', command: { type: 'mine', depositId: 1 } }), 'Mining');
  assert.equal(
    caseFor({ ...calm, goal: 'mine', command: { type: 'mine', depositId: 1, repeat: true } }),
    'Hauling route',
  );
  assert.equal(caseFor({ ...calm, goal: 'toDepot' }), 'Hauling to storage');
  assert.equal(caseFor({ ...calm, goal: 'toSite' }), 'Heading to build site');
  assert.equal(caseFor({ ...calm, goal: 'build' }), 'Building');
  assert.equal(caseFor({ ...calm, goal: 'toCharge' }), 'Returning to charge');
  assert.equal(caseFor({ ...calm, goal: 'charge', phase: 'charging' }), 'Charging');
  assert.equal(caseFor({ ...calm, goal: 'toService', command: { type: 'clean', buildingId: 1 } }), 'Cleaning panels');
  assert.equal(caseFor({ ...calm, goal: 'service', command: { type: 'repair', buildingId: 1 } }), 'Repairing');
  assert.equal(caseFor({ ...calm, goal: 'toRecover' }), 'Responding to stranded rover');
  assert.equal(caseFor({ ...calm, goal: 'recover' }), 'Jump-starting a stranded rover');
  assert.equal(caseFor({ ...calm, goal: 'toSalvage' }), 'Heading to the site');
  assert.equal(caseFor({ ...calm, goal: 'salvage' }), 'Salvaging');
});

test('wording is not state: labels and reasons never move the hash', () => {
  const sim = fresh();
  run(sim, 0.05);
  const before = hashSimulation(sim);
  sim.rovers[0].label = 'Completely Different Words';
  sim.colonist.name = 'Someone Else';
  if (sim.buildings[0]) sim.buildings[0].idleReason = 'other phrasing';
  assert.equal(hashSimulation(sim), before, 'wording is presentation, not simulation state');
});

// ---------------------------------------------------------------------------

group('Movement: one tick of the drive loop');

test('moveRover advances at cruise speed and charges wear and power', () => {
  const sim = fresh();
  const r = park(sim, 0, 260, -180);
  park(sim, 1, -260, 180);
  aimAt(r, r.x + 40, r.z, 'move');
  r.battery = 60;
  r.condition = 90;
  const [x0, z0, battery0, condition0] = [r.x, r.z, r.battery, r.condition];

  RoverSystem.moveRover(sim.state, r);

  const def = ROVERS[r.kind];
  assert.ok(Math.abs(r.x - (x0 + def.cruiseSpeed * SIM_TICK)) < 1e-9, 'one tick of cruise');
  assert.equal(r.z, z0, 'straight down the path');
  assert.ok(
    Math.abs(r.battery - (battery0 - def.movePowerKw * SIM_TICK * HOURS_PER_SEC)) < 1e-9,
    'the pack pays for the metres',
  );
  assert.ok(
    Math.abs(r.condition - (condition0 - ROVER_WEAR_MOVE_S * SIM_TICK)) < 1e-9,
    'and the odometer is not free',
  );
});

test('a flat pack mid-drive strands the rover and drops its claim', () => {
  const sim = fresh();
  const r = park(sim, 0, 260, -180);
  const dep = farDeposit(sim);
  RoverSystem.autoAssign(r, { type: 'mine', depositId: dep.id });
  RoverSystem.claimDeposit(sim.state, r, dep.id);
  aimAt(r, r.x + 400, r.z, 'move');
  r.battery = 0.0001; // less than this tick's drive
  r.condition = 30;

  RoverSystem.moveRover(sim.state, r);

  assert.equal(r.phase, 'disabled');
  assert.equal(r.goal, 'idle', 'a stranded rover holds no goal');
  assert.equal(dep.reservedBy, null, 'and the seam is released for a rescue');
  assert.equal(r.lightsActive, false);
  assert.ok(said(sim, 'battery flat'), 'the fleet is told');
  assert.equal(roverStatusText(r), 'Disabled — out of power');
});

test('proximity crawls: tighter near the pad, and the near miss slows the tick', () => {
  const sim = fresh();
  const r = park(sim, 0, 260, -180);
  assert.equal(RoverSystem.proximitySpeedMul(sim.state, r), 1, 'open terrain cruises');
  assert.ok(
    ROVER_PROXIMITY_COLONY_SPEED_MUL < ROVER_PROXIMITY_SPEED_MUL,
    'the yard is the tighter of the two rules',
  );

  const other = sim.rovers[1];
  other.x = r.x + 2;
  other.z = r.z;
  enterIdle(other);
  aimAt(r, r.x + 300, r.z, 'move');
  const x0 = r.x;
  RoverSystem.moveRover(sim.state, r);
  assert.ok(
    Math.abs(r.x - (x0 + ROVERS[r.kind].cruiseSpeed * ROVER_PROXIMITY_SPEED_MUL * SIM_TICK)) < 1e-9,
    'a near miss crawls the tick, it does not stop it',
  );

  const parked = park(sim, 0, SPAWN_X + 4, SPAWN_Z);
  const neighbour = sim.rovers[1];
  neighbour.x = parked.x + 2;
  neighbour.z = parked.z;
  enterIdle(neighbour);
  aimAt(parked, parked.x + 300, parked.z, 'move');
  assert.equal(
    RoverSystem.proximitySpeedMul(sim.state, parked),
    ROVER_PROXIMITY_COLONY_SPEED_MUL,
    'inside the yard the colony rule applies',
  );
});

// ---------------------------------------------------------------------------

group('Task bodies: finishing, pouring and salvaging');

test('a jump-start transfers kWh, wakes the stranded rover and sends both home', () => {
  const sim = fresh();
  const [rescuer, stranded] = sim.rovers;
  const r = park(sim, 0, SPAWN_X + 4, SPAWN_Z);
  park(sim, 1, SPAWN_X + 7, SPAWN_Z);
  stranded.battery = 0;
  RoverSystem.disable(sim.state, stranded);
  assert.equal(sim.issueRecover(r.id, stranded.id), true);
  const battery0 = r.battery;

  assert.ok(until(sim, () => r.command.type === 'idle', 4000) > 0, 'the transfer completes');
  assert.ok(stranded.battery > 0.5, 'the stranded rover got enough to get home');
  assert.ok(
    stranded.phase === 'idle' || stranded.phase === 'charging',
    'and is back in the fleet',
  );
  assert.equal(stranded.recharge, true);
  assert.equal(r.recharge, true, 'the rescuer heads in too');
  assert.ok(
    Math.abs(battery0 - r.battery - stranded.battery) < 1e-6,
    'not a kWh is lost in the cables',
  );
  assert.ok(said(sim, 'jump-started'), 'the rescue is logged');
});

test('a rescuer whose spare charge is under the transfer minimum stays home and says so', () => {
  const sim = fresh();
  const [rescuer, stranded] = sim.rovers;
  const r = park(sim, 0, SPAWN_X + 4, SPAWN_Z);
  park(sim, 1, SPAWN_X + 7, SPAWN_Z);
  stranded.battery = 0;
  RoverSystem.disable(sim.state, stranded);
  // Above its own ride-home floor, below the gift: it can go home, not rescue.
  // Above its own ride-home floor, below the gift: it can go home, not rescue.
  r.battery = ROVERS[r.kind].maxBatteryKWh * 0.21;
  assert.equal(sim.issueRecover(r.id, stranded.id), true, 'the dispatch itself is allowed');
  sim.step(SIM_TICK);

  assert.equal(r.command.type, 'idle', 'the rescue is called off');
  assert.ok(said(sim, "can't spare enough charge"), 'with a reason the player can act on');
  assert.equal(stranded.battery, 0, 'and no charge moved');
  assert.equal(r.recharge, false, 'the rescuer can still get itself home');
});

test('unload pours what fits, warns once about a blocked hold, and finishes', () => {
  const sim = fresh();
  const r = park(sim, 0, SPAWN_X, SPAWN_Z);
  r.cargo.iron = 60;
  const capacity = sim.storageCapacity();
  sim.storage.iron = capacity;

  sim.issueUnload(r.id);
  sim.step(SIM_TICK);
  assert.equal(r.cargo.iron, 60, 'a full silo takes nothing');
  assert.ok(said(sim, 'those silos are full'), 'and the hold warning is logged');
  assert.equal(r.command.type, 'idle', 'the task still finishes — a stuck hold is not a stuck rover');

  sim.storage.iron = capacity - 100;
  sim.issueUnload(r.id);
  const requeued: string = r.command.type;
  assert.equal(requeued, 'unload');
  sim.step(SIM_TICK);
  assert.equal(r.cargo.iron, 0, 'the hold drains as room frees up');
  assert.equal(sim.storage.iron, capacity - 40, 'and every kilogram is accounted for');
  assert.equal(r.command.type, 'idle', 'the task is done');
});

test('salvage strips a site into the hold and the surviving cells land in the grid store', () => {
  const sim = fresh();
  const r = park(sim, 0, 0, 0);
  const p = sim.world.pois.find((q) => q.kind !== 'settlementSite')!;
  p.discovered = true;
  p.buried = false;
  p.salvage = { ...emptyAmounts(), iron: 40, silicon: 10 };
  p.energyKWh = 30;
  r.x = p.x + 2;
  r.z = p.z;
  r.command = { type: 'salvage', poiId: p.id };
  const stored0 = sim.storedKWh;

  assert.ok(until(sim, () => r.command.type === 'idle', 2000) > 0, 'the site strips out');
  assert.ok(salvageTotalKg(p) <= 0.5, 'nothing left on the ground');
  assert.ok(r.cargo.iron > 0, 'the hold took the bulk home');
  assert.equal(p.energyKWh, 0, 'and the cells are drawn down');
  assert.ok(
    sim.storedKWh >= stored0 + 30 - 1e-9,
    'cells go into the grid store, never the hold',
  );
  assert.ok(said(sim, 'Recovered from the site: 30 kWh'), 'and the recovery is logged to the kWh');
  assert.ok(!said(sim, 'would not fit'), 'with room to spare');
});

// ---------------------------------------------------------------------------

group('Execution state is rebuilt, not saved');

test('a restored fleet resumes parked, with a charger-top-up rover already charging', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = nearDeposit(sim, 'iron');
  sim.issueMine(r.id, dep.id);
  run(sim, 0.2); // mid-task, definitely not at rest
  assert.notEqual(r.goal, 'idle', 'precondition: the live rover is executing');

  // Park a partially-charged rover on the pad, so one rover is mid-charge too.
  const topped = sim.rovers[1];
  park(sim, 1, SPAWN_X, SPAWN_Z);
  topped.battery = ROVERS[topped.kind].maxBatteryKWh * 0.5; // half a pack on the pad

  const save = structuredClone(sim.snapshot());
  const restored = new Simulation({ seed: 11, nearDeposits: 0.2 });
  restored.restore(save);

  for (const rr of restored.rovers) {
    assert.equal(rr.goal, 'idle', 'a restored rover starts with nothing in hand');
    assert.ok(
      rr.phase === 'idle' || rr.phase === 'charging',
      `restored phase must be a parked one, found '${rr.phase}'`,
    );
    assert.equal(rr.navPath.length, 0, 'and no stale path');
    if (rr.phase === 'charging') {
      assert.ok(restored.nearCharger(rr.x, rr.z), 'only a rover on a charger comes back charging');
    }
  }
  assert.equal(topped.id, restored.rovers[1].id);
  assert.equal(restored.rovers[1].phase, 'charging', 'the rover on the pad is charging again');
});

// ---------------------------------------------------------------------------

group('The table is machine-checked');

test('a scripted fleet run reports no execution-state violations', () => {
  const sim = fresh(21);
  const dep = nearDeposit(sim, 'iron');
  sim.issueMine(sim.rovers[0].id, dep.id);
  sim.issueMove(sim.rovers[1].id, 70, -40, true);
  run(sim, 0.6);
  assert.deepEqual(
    checkInvariants(sim).filter((v) => v.code === 'rover-execution'),
    [],
    'every (goal, phase, command) triple held through the run',
  );
});

test('an impossible execution state is reported by code', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const expect = (code: string, mutate: () => void): void => {
    const saved = structuredClone(r);
    try {
      mutate();
      const found = checkInvariants(sim).filter((v) => v.code === code);
      assert.ok(found.length > 0, `expected a '${code}' violation`);
    } finally {
      Object.assign(r, saved);
    }
    assert.deepEqual(checkInvariants(sim).filter((v) => v.code === code), [], 'restored cleanly');
  };

  expect('rover-execution', () => {
    r.goal = 'build';
    r.phase = 'moving';
  });
  expect('rover-execution', () => {
    r.goal = 'mine';
    r.command = { type: 'unload' };
    r.phase = 'working';
  });
  expect('rover-execution', () => {
    r.goal = 'toDepot';
    r.navPath = [];
  });
});

// ---------------------------------------------------------------------------

group('Characterized, not fixed');

test('a queued order behind a moveTo is stranded when the path ends (pinned quirk)', () => {
  // `onArrive`'s 'move' case marks the command idle directly instead of going
  // through `finishTask`, so the queue is never promoted. Recorded in
  // docs/design/ROVER-STATE.md §8 as a Phase 12/18 decision: fixing it changes
  // which orders execute, i.e. a behavior change, not an extraction.
  const sim = fresh();
  const r = sim.rovers[0];
  sim.issueMove(r.id, 40, 20);
  sim.issueWait(r.id, 300, true);
  assert.equal(r.pending.length, 1, 'precondition: the wait is queued');

  assert.ok(until(sim, () => r.goal === 'idle') > 0, 'the move order completes');
  assert.equal(r.command.type, 'idle', 'the moveTo did not promote the queue');
  assert.equal(r.pending.length, 1, 'the queued wait is still waiting — stranded');
  assert.equal(until(sim, () => r.command.type === 'wait', 400), -1, 'and it never runs');
});

await finish('sim/rover-state');
