/**
 * @suite sim/rover-system
 * @group integration
 * @covers src/sim/systems/RoverSystem.ts src/sim/Simulation.ts src/sim/state/RoverState.ts
 * @desc RoverSystem extraction (Phase 10): the task lifecycle and deposit
 * reservations, movement execution with proximity awareness, the ride-home
 * battery floor, storm recall and position lights, and one isolated check per
 * task body — mine, unload, charge, clean, repair, construct, salvage, disable
 * and jump-start recovery — plus the two host-hook seams and deterministic
 * replay. The behavior itself is unchanged from before the extraction; this
 * suite is what pins it while the phases after Phase 10 redesign it.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { RoverSystem, type RoverHostHooks } from '../../src/sim/systems/RoverSystem';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { ROVERS, RESOURCES, BUILDINGS } from '../../src/sim/defs';
import { salvageTotalKg } from '../../src/sim/pois';
import { roverStatusText, type Rover, type RoverGoal } from '../../src/sim/state/RoverState';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  SPAWN_X,
  SPAWN_Z,
  ROVER_PROXIMITY_SPEED_MUL,
  ROVER_PROXIMITY_COLONY_SPEED_MUL,
  ROVER_WEAR_MOVE_S,
  ROVER_CLEAN_RATE,
  REPAIR_RESTART_HEALTH,
  DAMAGED_HEALTH,
  ROUTE_RESUME_ROOM_KG,
} from '../../src/sim/config';
import { run, buildOnline, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const HOURS = SIM_TICK * HOURS_PER_SEC;

function fresh(seed = 11): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

/** `assert.equal` narrows `r.command.type` to a literal; re-read it fresh. */
function commandOf(r: Rover): string {
  return r.command.type;
}

/** Seconds left on a `wait` order, or -1 for anything else. */
function waitSeconds(r: Rover): number {
  return r.command.type === 'wait' ? r.command.seconds : -1;
}

/** Did the colony log say it? (Alerts are conditions; the log is the story.) */
function said(sim: Simulation, needle: string): boolean {
  return sim.alerts.history().some((l) => l.text.includes(needle));
}

/** Host hooks that record what the rover asked the other domains to do. */
function recorder(canDeliver = true): {
  hooks: RoverHostHooks;
  constructs: string[];
  deliveries: number;
} {
  const rec = {
    constructs: [] as string[],
    deliveries: 0,
    hooks: {
      constructSite: (r: { id: number }, b: { id: number }) => {
        rec.constructs.push(`r${r.id}->b${b.id}`);
      },
      canDeliverCargo: () => {
        rec.deliveries++;
        return canDeliver;
      },
    } as RoverHostHooks,
  };
  return rec;
}

/** Park a rover on open ground, well clear of everything. */
function parkOpen(sim: Simulation, idx = 0, x = 260, z = -180): void {
  const r = sim.rovers[idx];
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.navPath = [];
  r.navI = 0;
  r.goal = 'idle';
  r.phase = 'idle';
  r.heading = 0;
  r.recharge = false;
}

/**
 * Aim a rover with a single far waypoint. `setTravel` runs the real A* over
 * the generated terrain, whose first waypoint is the current cell centre —
 * fine in the sim, useless for measuring one tick of movement. This pins the
 * movement maths without the pathfinder in the way.
 */
function aimAt(r: Rover, tx: number, tz: number, goal: RoverGoal): void {
  r.goal = goal;
  r.phase = 'moving';
  r.navPath = [{ x: tx, z: tz }];
  r.navI = 0;
  r.gx = tx;
  r.gz = tz;
}

/** Nearest live deposit of `res` that is not inside the base. */
function outerDeposit(sim: Simulation, res = 'iron') {
  return sim.world.deposits
    .filter((d) => d.resource === res && d.amount > 0)
    .sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z))[0];
}

/** A legal spot for `kind`, searched outward from the pad. */
function spotFor(sim: Simulation, kind: 'solar'): [number, number] {
  for (let radius = 30; radius <= 140; radius += 2) {
    for (let a = 0; a < 360; a += 5) {
      const x = Math.cos((a * Math.PI) / 180) * radius;
      const z = Math.sin((a * Math.PI) / 180) * radius;
      if (sim.canPlace(kind, x, z) === null) return [x, z];
    }
  }
  throw new Error(`no legal ${kind} site`);
}

// ---------------------------------------------------------------------------

group('Task queue & reservations');

test('a shift order queues behind the current task; a plain order replaces the queue', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  sim.issueMove(r.id, 40, 10);
  sim.issueWait(r.id, 30, true);
  assert.equal(commandOf(r), 'moveTo', 'the plain order is active');
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].type, 'wait');

  sim.issueWait(r.id, 5);
  assert.equal(commandOf(r), 'wait', 'a plain order interrupts');
  assert.equal(r.pending.length, 0, 'and clears the queue');
});

test('automation only ever fills idle time: an order always replaces an auto task, queued or not', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  RoverSystem.autoAssign(r, { type: 'mine', depositId: dep.id });
  assert.equal(r.autoTask, true);

  sim.issueMove(r.id, 30, 0, true); // even a queued order
  assert.equal(commandOf(r), 'moveTo');
  assert.equal(r.autoTask, false);
  assert.equal(r.pending.length, 0);
});

test('a player mine order bumps an auto run off the seam and the bumped rover re-plans', () => {
  const sim = fresh();
  const [a, b] = sim.rovers;
  const dep = outerDeposit(sim);
  RoverSystem.autoAssign(a, { type: 'mine', depositId: dep.id });
  RoverSystem.claimDeposit(sim.state, a, dep.id);
  assert.equal(dep.reservedBy, a.id);

  sim.issueMine(b.id, dep.id);
  assert.equal(dep.reservedBy, b.id, 'the player order owns the seam');
  assert.equal(commandOf(a), 'idle', 'the bumped auto run re-planned');
  assert.ok(said(sim, 'took over that seam'), 'and the log says why');
});

test('finishTask promotes the queue, and only clears autoTask once the hold is empty', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  r.autoTask = true;
  r.command = { type: 'mine', depositId: 1 };
  r.pending = [{ type: 'wait', seconds: 10 }];
  RoverSystem.finishTask(r);
  assert.equal(commandOf(r), 'wait', 'the queued task is promoted');
  assert.equal(r.autoTask, true, 'still an auto run while it carries cargo');

  r.cargo.iron = 40;
  RoverSystem.finishTask(r);
  assert.equal(commandOf(r), 'idle');
  assert.equal(r.autoTask, true, 'cargo keeps the auto flag');

  r.cargo.iron = 0;
  RoverSystem.finishTask(r);
  assert.equal(r.autoTask, false, 'an empty hold returns the rover to the pool');
});

test('stopRover drops the claim, the queue and the recharge', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  sim.issueMine(r.id, dep.id);
  sim.issueWait(r.id, 20, true);
  r.recharge = true;
  assert.equal(dep.reservedBy, r.id);

  sim.stopRover(r.id);
  assert.equal(commandOf(r), 'idle');
  assert.equal(r.pending.length, 0);
  assert.equal(r.recharge, false);
  assert.equal(dep.reservedBy, null, 'the seam is free again');
});

// ---------------------------------------------------------------------------

group('Movement');

test('moveRover advances at cruise speed and bills movePowerKw × hours', () => {
  const sim = fresh();
  parkOpen(sim, 0, 260, -180);
  parkOpen(sim, 1, -260, 180);
  const r = sim.rovers[0];
  const def = ROVERS[r.kind];
  const battery0 = r.battery;
  const condition0 = r.condition;

  aimAt(r, r.x + 40, r.z, 'move');
  const x0 = r.x;
  RoverSystem.moveRover(sim.state, r);

  assert.ok(Math.abs(r.x - (x0 + def.cruiseSpeed * SIM_TICK)) < 1e-9, 'one tick of cruise');
  assert.ok(
    Math.abs(battery0 - r.battery - def.movePowerKw * HOURS) < 1e-9,
    'energy maths is exact, not vibes',
  );
  assert.ok(
    Math.abs(condition0 - r.condition - ROVER_WEAR_MOVE_S * SIM_TICK) < 1e-9,
    'driving wears the drivetrain',
  );
});

test('setTravel keeps an in-flight path while the goal holds, and re-plans when it changes', () => {
  const sim = fresh();
  parkOpen(sim, 0, 260, -180);
  const r = sim.rovers[0];
  RoverSystem.setTravel(sim.state, r, 300, -180, 'move');
  const path = r.navPath;
  RoverSystem.setTravel(sim.state, r, 300, -180, 'move');
  assert.equal(r.navPath, path, 'the in-flight path is kept (no per-tick A*)');

  RoverSystem.setTravel(sim.state, r, 300, -180, 'toDepot');
  assert.notEqual(r.navPath, path, 'a different goal re-plans');
  assert.equal(r.navI, 0, 'and starts the new path from the top');
});

test('a flat pack strands the rover mid-drive and releases its claim', () => {
  const sim = fresh();
  parkOpen(sim, 0, 260, -180);
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  RoverSystem.autoAssign(r, { type: 'mine', depositId: dep.id });
  RoverSystem.claimDeposit(sim.state, r, dep.id);
  r.battery = 0.0001;
  aimAt(r, r.x + 400, r.z, 'mine');
  RoverSystem.moveRover(sim.state, r);

  assert.equal(r.phase, 'disabled');
  assert.equal(r.goal, 'idle');
  assert.equal(roverStatusText(r), 'Disabled — out of power');
  assert.equal(r.lightsActive, false, 'the strobe takes over from the lights');
  assert.equal(dep.reservedBy, null, 'a stranded rover holds no seam');
  assert.ok(said(sim, 'battery flat'), 'and the colony is told');
});

test('proximity crawls in the open and crawls slower still inside the colony yard', () => {
  const sim = fresh();
  parkOpen(sim, 0, 260, -180);
  const r = sim.rovers[0];
  const other = sim.rovers[1];
  other.x = r.x + 2; // nose to nose
  other.z = r.z;
  assert.equal(RoverSystem.proximitySpeedMul(sim.state, r), ROVER_PROXIMITY_SPEED_MUL);

  const def = ROVERS[r.kind];
  aimAt(r, r.x + 40, r.z, 'move');
  const before = r.x;
  RoverSystem.moveRover(sim.state, r);
  const crawled = r.x - before;
  assert.ok(
    Math.abs(crawled - def.cruiseSpeed * ROVER_PROXIMITY_SPEED_MUL * SIM_TICK) < 1e-9,
    'the crawl is the measured step',
  );

  // Inside the yard the bubble is wider and the crawl slower.
  parkOpen(sim, 0, SPAWN_X + 6, SPAWN_Z);
  other.x = r.x + 2;
  other.z = r.z;
  assert.equal(
    RoverSystem.proximitySpeedMul(sim.state, r),
    ROVER_PROXIMITY_COLONY_SPEED_MUL,
    'the yard uses the colony constant',
  );
  assert.ok(ROVER_PROXIMITY_COLONY_SPEED_MUL < ROVER_PROXIMITY_SPEED_MUL);
});

// ---------------------------------------------------------------------------

group('Charge, storm & lights');

test('a low pack turns a parked rover for home, and it plugs in at the pad', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  r.x = SPAWN_X + 1;
  r.z = SPAWN_Z;
  r.battery = ROVERS[r.kind].maxBatteryKWh * 0.02;
  r.recharge = false;
  RoverSystem.updateRover(sim.state, r, recorder().hooks);

  assert.equal(r.recharge, true, 'the ride-home floor caught it');
  assert.ok(r.lowBatteryNotified);
  assert.equal(r.goal, 'charge');
  assert.equal(r.phase, 'charging');
  assert.equal(roverStatusText(r), 'Charging');
});

test('storm recall shelters the rover, preserves its orders, and releases them when the sky clears', () => {
  const sim = fresh();
  parkOpen(sim, 0, 240, -160);
  const r = sim.rovers[0];
  sim.issueWait(r.id, 600); // a long hold order to survive the storm

  sim.devForceStorm('severe');
  let ticks = 0;
  while (!(r.sheltered && r.phase === 'charging') && ticks < 6000) {
    sim.step(SIM_TICK);
    ticks++;
  }
  assert.ok(ticks < 6000, 'precondition: the storm reached the rover and it plugged in');
  assert.equal(roverStatusText(r), 'Sheltering from storm');
  assert.equal(commandOf(r), 'wait', 'its orders are preserved underneath');

  // The held order must not tick down while the rover is hunkered down.
  const secondsHeld = waitSeconds(r);
  for (let i = 0; i < 200; i++) sim.step(SIM_TICK);
  assert.equal(r.sheltered, true, 'the storm is still on it');
  assert.equal(waitSeconds(r), secondsHeld, 'and untouched');

  sim.devClearStorms();
  for (let i = 0; i < 6000 && r.sheltered; i++) sim.step(SIM_TICK);
  assert.equal(r.sheltered, false, 'the recall releases when the gust front passes');

  const seconds0 = waitSeconds(r);
  sim.step(SIM_TICK);
  assert.ok(waitSeconds(r) < seconds0, 'and the held order picks up where it left off');
});

test('position lights switch on at night and are billed to the rover pack', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  sim.devSetTime(1, 0.5); // noon
  assert.equal(RoverSystem.lightsNeeded(sim.state), false, 'a clear midday runs dark');
  RoverSystem.tickLights(sim.state, r);
  assert.equal(r.lightsActive, false);

  sim.devSetTime(2, 0.9); // night
  assert.equal(RoverSystem.lightsNeeded(sim.state), true);
  const battery0 = r.battery;
  RoverSystem.tickLights(sim.state, r);
  assert.equal(r.lightsActive, true);
  assert.ok(
    Math.abs(battery0 - r.battery - ROVERS[r.kind].lightsPowerKw * HOURS) < 1e-9,
    'the lights drink the pack, not the grid',
  );
});

// ---------------------------------------------------------------------------

group('Task bodies');

test('mining digs at the plate rate, claims the seam, and wears the drivetrain', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  r.x = dep.x;
  r.z = dep.z;
  r.command = { type: 'mine', depositId: dep.id };
  r.autoTask = false;
  const before = r.cargo[dep.resource];
  const condition0 = r.condition;
  const amount0 = dep.amount;

  const def = ROVERS[r.kind];
  const expected =
    RESOURCES[dep.resource].mineRateKg *
    def.mineSpeedMul *
    sim.weather.workMultiplierAt(r.x, r.z) *
    RoverSystem.roverWorkMul(r) *
    SIM_TICK;
  RoverSystem.updateRover(sim.state, r, recorder().hooks);

  assert.equal(r.phase, 'working');
  assert.equal(r.goal, 'mine');
  assert.ok(Math.abs(r.cargo[dep.resource] - before - expected) < 1e-9, 'the plate rate, measured');
  assert.ok(Math.abs(amount0 - dep.amount - expected) < 1e-9, 'and the seam is drawn down');
  assert.equal(dep.reservedBy, r.id, 'the seam is claimed');
  assert.ok(condition0 - r.condition > 0, 'digging wears the rover');
});

test('an automatic mining run stops at what the silos can actually take', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  r.x = dep.x;
  r.z = dep.z;
  r.autoTask = true;
  r.command = { type: 'mine', depositId: dep.id };
  // Only 80 kg of room, so the auto target is the colony's appetite, not the hopper.
  sim.storage[dep.resource] = sim.storageCapacity() - 80;
  r.cargo[dep.resource] = 80;

  RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(r.goal, 'toDepot', 'it turns for home with the load it has');
});

test('a stuck haul route parks with "Route paused" until the silos have room again', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const dep = outerDeposit(sim);
  r.x = dep.x;
  r.z = dep.z;
  r.command = { type: 'mine', depositId: dep.id, repeat: true };
  sim.storage[dep.resource] = sim.storageCapacity(); // the silo is full
  r.cargo[dep.resource] = 200;

  const rec = recorder(false); // nothing fits
  RoverSystem.updateRover(sim.state, r, rec.hooks);
  assert.equal(r.routePaused, true);
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.command, { type: 'mine', depositId: dep.id, repeat: true }, 'the route survives');

  sim.storage[dep.resource] = sim.storageCapacity() - ROUTE_RESUME_ROOM_KG * 2;
  const rec2 = recorder(true);
  RoverSystem.updateRover(sim.state, r, rec2.hooks);
  assert.equal(r.routePaused, false, 'room in the silo resumes the route');
});

test('unload pours what fits, warns once about a blocked hold, and finishes', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  parkOpen(sim, 0, SPAWN_X, SPAWN_Z);
  r.cargo.iron = 60;
  const capacity = sim.storageCapacity();
  sim.storage.iron = capacity; // the silo cannot take it

  sim.issueUnload(r.id);
  RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(r.cargo.iron, 60, 'nothing fits');
  assert.ok(said(sim, 'those silos are full'), 'and the hold warning is logged');
  assert.equal(commandOf(r), 'idle', 'the task still finishes — a stuck hold is not a stuck rover');

  sim.storage.iron = capacity - 100;
  sim.issueUnload(r.id);
  assert.equal(commandOf(r), 'unload', 'the order is taken again');
  RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(r.cargo.iron, 0, 'the hold drains as room frees up');
  assert.equal(sim.storage.iron, capacity - 40);
  assert.equal(commandOf(r), 'idle', 'and the task is done');
});

test('cleaning scrubs at the plate rate on half power', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  const r = sim.rovers[1];
  r.x = b.x + BUILDINGS.solar.radius + 1;
  r.z = b.z;
  r.command = { type: 'clean', buildingId: b.id };
  b.cleanliness = 0;
  const battery0 = r.battery;
  const expected = ROVER_CLEAN_RATE * RoverSystem.roverWorkMul(r) * SIM_TICK;

  RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(roverStatusText(r), 'Cleaning panels');
  assert.ok(Math.abs(b.cleanliness - expected) < 1e-9, 'the plate rate, measured');
  assert.ok(
    Math.abs(battery0 - r.battery - ROVERS[r.kind].workPowerKw * HOURS * 0.5) < 1e-9,
    'tool work is half-power',
  );
});

test('repair re-commissions a damaged building at the restart threshold', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  const r = sim.rovers[1];
  r.x = b.x + BUILDINGS.solar.radius + 1;
  r.z = b.z;
  r.command = { type: 'repair', buildingId: b.id };
  sim.devSetBuildingHealth(b.id, DAMAGED_HEALTH - 5);
  sim.devSetBuildingDamaged(b.id, true);
  assert.equal(b.damaged, true);

  for (let i = 0; i < 4000 && b.damaged; i++) RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(b.damaged, false, 'repaired back online');
  assert.ok(b.health >= REPAIR_RESTART_HEALTH, 'at the documented restart health');
  assert.ok(said(sim, 'repaired and back online'), 'and the colony is told');
});

test('a construct task is handed to the construction domain, and a finished site releases the worker', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar'); // online: the worker must be released
  const r = sim.rovers[0];
  r.command = { type: 'construct', buildingId: b.id };
  b.workerId = r.id;
  const rec = recorder();
  RoverSystem.updateRover(sim.state, r, rec.hooks);
  assert.equal(rec.constructs.length, 0, 'nothing to build');
  assert.equal(b.workerId, null, 'the stale worker reference is cleared');
  assert.equal(commandOf(r), 'idle');

  // And a live site really does reach the construction system.
  const site = sim.placeBuilding('solar', ...spotFor(sim, 'solar'))!;
  r.command = { type: 'construct', buildingId: site.id };
  r.x = site.x;
  r.z = site.z;
  const rec2 = recorder();
  RoverSystem.updateRover(sim.state, r, rec2.hooks);
  assert.deepEqual(rec2.constructs, [`r${r.id}->b${site.id}`], "the site assembly is ConstructionSystem's");
});

test('a full hold turns for home before the site — the salvage ping-pong guard', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const p = sim.world.pois.find((q) => q.kind !== 'settlementSite' && q.kind !== 'supplyDrop')!;
  p.discovered = true;
  parkOpen(sim, 0, p.x + 3, p.z);
  r.cargo.iron = ROVERS[r.kind].capacityKg; // full
  r.command = { type: 'salvage', poiId: p.id };

  RoverSystem.updateRover(sim.state, r, recorder().hooks);
  assert.equal(r.goal, 'toDepot', 'the full hold wins over the distance check');
  assert.equal(r.phase, 'moving');
});

test('salvage strips a small site into the hold, and the cells land in the grid store', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const p = sim.world.pois.find((q) => q.kind !== 'settlementSite')!;
  p.discovered = true;
  p.buried = false;
  p.salvage = { iron: 40, silicon: 10 }; // small enough for one hold: no haul detour
  p.energyKWh = 30;
  parkOpen(sim, 0, p.x + 2, p.z);
  r.command = { type: 'salvage', poiId: p.id };
  const stored0 = sim.storedKWh;

  let ticks = 0;
  while (r.command.type === 'salvage' && ticks < 2000) {
    RoverSystem.updateRover(sim.state, r, recorder().hooks);
    ticks++;
  }
  assert.ok(ticks < 2000, 'the site strips out');
  assert.ok(salvageTotalKg(p) <= 0.5, 'nothing salvagable is left on the ground');
  assert.ok(r.cargo.iron > 0, 'the bulk rode home in the hold');
  assert.equal(p.energyKWh, 0, 'and the cells are drawn down');
  assert.ok(
    Math.abs(sim.storedKWh - (stored0 + 30)) < 1e-6,
    'cells go into the grid store, never the hold',
  );
  assert.ok(said(sim, 'Recovered from the site'), 'and the recovery is logged');
});

test('a jump-start transfers kWh and sends both rovers home to charge', () => {
  const sim = fresh();
  const [rescuer, stranded] = sim.rovers;
  parkOpen(sim, 0, 240, -160);
  parkOpen(sim, 1, 243, -160);
  stranded.phase = 'disabled';
  stranded.battery = 0;
  stranded.goal = 'idle';
  rescuer.battery = ROVERS[rescuer.kind].maxBatteryKWh;
  rescuer.command = { type: 'recover', roverId: stranded.id };

  const battery0 = rescuer.battery;
  let ticks = 0;
  while (rescuer.command.type === 'recover' && ticks < 4000) {
    RoverSystem.updateRover(sim.state, rescuer, recorder().hooks);
    ticks++;
  }
  assert.ok(ticks < 4000, 'the hook-up completes');
  assert.ok(stranded.battery > 0, 'the stranded rover took the charge');
  assert.equal(stranded.recharge, true, 'and heads for a charger');
  assert.equal(commandOf(stranded), 'idle');
  assert.equal(stranded.lowBatteryNotified, true, 'it is low — the warning is not repeated');
  assert.equal(rescuer.recharge, true, 'the rescuer also tops up');
  assert.equal(commandOf(rescuer), 'idle', 'and its task is finished');
  assert.ok(
    Math.abs(battery0 - rescuer.battery - stranded.battery) < 1e-6,
    'every kWh that left the rescuer’s pack arrived in the stranded one',
  );
  assert.ok(said(sim, 'jump-started'), 'and the colony hears about it');
});

test('a rescuer with spare charge under the transfer minimum stays home and says so', () => {
  const sim = fresh();
  const [rescuer, stranded] = sim.rovers;
  parkOpen(sim, 0, SPAWN_X + 4, SPAWN_Z);
  parkOpen(sim, 1, SPAWN_X + 7, SPAWN_Z);
  stranded.phase = 'disabled';
  stranded.battery = 0;
  // Above its own ride-home floor, so it is not simply told to charge, but
  // close enough to the floor that the gift under RECOVER_MIN_GIVE_KWH fails.
  rescuer.battery = ROVERS[rescuer.kind].maxBatteryKWh * 0.21;
  rescuer.command = { type: 'recover', roverId: stranded.id };

  RoverSystem.updateRover(sim.state, rescuer, recorder().hooks);
  assert.equal(rescuer.recharge, false, 'the rescuer is not low itself');
  assert.equal(commandOf(rescuer), 'idle', 'the rescue is called off');
  assert.ok(said(sim, "can't spare enough charge"), 'with a reason the player can act on');
  assert.equal(stranded.battery, 0, 'and no charge moved');
});

// ---------------------------------------------------------------------------

group('Determinism');

test('two same-seed fleets driven identically hash identically', () => {
  const drive = (): Simulation => {
    const sim = fresh(912);
    const dep = nearDeposit(sim, 'iron');
    sim.issueMine(sim.rovers[0].id, dep.id);
    sim.issueMove(sim.rovers[1].id, 50, -30, true);
    sim.setRepeatRoute(sim.rovers[0].id, true);
    run(sim, 0.3);
    sim.issueWait(sim.rovers[1].id, 45);
    run(sim, 0.2);
    return sim;
  };
  assert.equal(hashSimulation(drive()), hashSimulation(drive()));
});

await finish('sim/rover-system');
