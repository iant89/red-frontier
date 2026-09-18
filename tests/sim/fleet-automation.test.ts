/**
 * @suite sim/fleet-automation
 * @group integration
 * @covers src/sim/systems/FleetAutomationSystem.ts src/sim/Simulation.ts
 * @desc Refactor roadmap Phase 12: the job model and the dispatch passes. The
 * evaluators are tested as pure functions (state in, scored jobs out) and the
 * passes through the live tick, covering §16's scenario list: low battery,
 * storm, a disabled rover, urgent construction, a full depot, missing
 * materials, a rescue, and several jobs competing for one rover.
 *
 * Every test parks *all* rovers first: the fleet's own dispatch runs on every
 * tick, so a test that parks one rover and leaves the other idle is a test
 * about two rovers, not one.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  FleetAutomationSystem,
  JOB_PRIORITY,
  canMakeRun,
  dispatchMaintenance,
  dispatchRescues,
  dispatchSupplyRuns,
  haulDemand,
  haulWanted,
  idlePool,
  isStormBlocked,
  maintenanceJobs,
  maintenancePending,
  orderJobs,
  pickHaul,
  rescueFeasible,
  rescueJobs,
  servicingRover,
  waitingSite,
  type FleetAutomationHostHooks,
  type JobOrderKey,
} from '../../src/sim/systems/FleetAutomationSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { enterIdle, type Rover } from '../../src/sim/state/RoverState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { AUTO_CLEAN_THRESHOLD, SIM_TICK, SPAWN_X, SPAWN_Z } from '../../src/sim/config';
import { ALL_RESOURCES, ROVERS, type BuildingKind } from '../../src/sim/defs';
import { run, build, buildOnline, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const hooks: FleetAutomationHostHooks = {
  // The suite's own copy of the haul question: cargo with room anywhere.
  canDeliverCargo: (r) => ALL_RESOURCES.some((res) => r.cargo[res] > 0.01),
};

function fresh(seed = 31): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls(); // storms are scripted in this suite
  return sim;
}

/** A parked rover: no task, no queue, no charge run, no shelter, not stranded. */
function park(sim: Simulation, idx = 0, x = 260, z = -180): Rover {
  const r = sim.rovers[idx];
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.navPath = [];
  r.navI = 0;
  enterIdle(r);
  r.command = { type: 'idle' };
  r.pending = [];
  r.autoTask = false;
  r.recharge = false;
  r.sheltered = false;
  r.routePaused = false;
  return r;
}

/** Every rover parked, spread apart — the clean slate for a dispatch test. */
function parkAll(sim: Simulation): Rover[] {
  return sim.rovers.map((_, i) => park(sim, i, 260 + i * 60, -180 - i * 40));
}

/** A damaged online building — reachable state: storm damage trips exactly this. */
function damage(b: { damaged: boolean; health: number }, health = 40): void {
  b.damaged = true;
  b.health = health;
}

/** Run until the scripted storm is actually on the colony. */
function stormOn(sim: Simulation): void {
  sim.devForceStorm('severe');
  for (let i = 0; i < 2000 && !isStormBlocked(sim.state); i++) sim.step(SIM_TICK);
  assert.equal(isStormBlocked(sim.state), true, 'precondition: the storm arrived');
}

// ---------------------------------------------------------------------------

group('The job model');

test('jobs order by priority band, then urgency, stably', () => {
  const jobs: Array<{ name: string } & JobOrderKey> = [
    { name: 'clean', priority: JOB_PRIORITY.construction, urgency: 0.2, stormBlocked: true },
    { name: 'repair', priority: JOB_PRIORITY.survival, urgency: 90, stormBlocked: true },
    { name: 'haul', priority: JOB_PRIORITY.routine, urgency: 0, stormBlocked: false },
    { name: 'repair', priority: JOB_PRIORITY.survival, urgency: 10, stormBlocked: true },
  ];
  const ordered = orderJobs(jobs);
  assert.deepEqual(
    ordered.map((j) => `${j.name}:${j.urgency}`),
    ['repair:10', 'repair:90', 'clean:0.2', 'haul:0'],
    'survival outranks construction outranks routine; within a band, urgent first',
  );
});

test('maintenance evaluates repairs worst-health-first, then the dirtiest arrays', () => {
  const sim = fresh();
  const a = buildOnline(sim, 'solar');
  const b = buildOnline(sim, 'warehouse');
  const c = buildOnline(sim, 'solar');
  damage(b, 55);
  damage(a, 22);
  c.cleanliness = 0.5;

  const jobs = maintenanceJobs(sim.state);
  assert.deepEqual(
    jobs.map((j) => `${j.kind}:${j.building.id}`),
    [`repair:${a.id}`, `repair:${b.id}`, `clean:${c.id}`],
    'repairs before cleans, and each list sorted by its own key',
  );
  assert.equal(jobs[0].priority, JOB_PRIORITY.survival);
  assert.equal(jobs[0].rule, null, 'repairs ignore the auto-service opt-out');
  assert.equal(jobs[2].rule, 'autoService');
  assert.equal(jobs[2].stormBlocked, true, 'a shelter order calls both off');
});

test('a clean job only appears for an online, undamaged solar array past the threshold', () => {
  const sim = fresh();
  const solar = buildOnline(sim, 'solar');
  const depot = buildOnline(sim, 'warehouse');
  solar.cleanliness = AUTO_CLEAN_THRESHOLD + 0.05;
  depot.cleanliness = 0.1; // a filthy warehouse is not a cleaning job
  assert.deepEqual(maintenanceJobs(sim.state), [], 'nothing to do yet');
  solar.cleanliness = AUTO_CLEAN_THRESHOLD - 0.01;
  assert.deepEqual(
    maintenanceJobs(sim.state).map((j) => j.building.id),
    [solar.id],
    'one pass under the threshold and it is a job',
  );
  damage(solar);
  assert.deepEqual(maintenanceJobs(sim.state).map((j) => j.kind), ['repair'], 'damage outranks dirt');
});

test('servicingRover sees the crew already sent, so maintenancePending says no', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  damage(b);
  assert.equal(servicingRover(sim.state, b.id), false);
  assert.equal(maintenancePending(sim.state), true, 'a damaged structure is pending work');
  const r = park(sim, 0);
  RoverSystem.autoAssign(r, { type: 'repair', buildingId: b.id });
  assert.equal(servicingRover(sim.state, b.id), true);
  assert.equal(maintenancePending(sim.state), false, 'someone is already on it');
});

test('rescue jobs skip a stranded rover that already has a rescuer', () => {
  const sim = fresh();
  const [a, b] = sim.rovers;
  b.battery = 0;
  RoverSystem.disable(sim.state, b);
  assert.deepEqual(rescueJobs(sim.state).map((j) => j.stranded.id), [b.id]);
  RoverSystem.autoAssign(a, { type: 'recover', roverId: b.id });
  assert.deepEqual(rescueJobs(sim.state), [], 'no second rescuer is dispatched');
});

test('the haul ledger sums the build shortfall and adds the standing ice order', () => {
  const sim = fresh();
  build(sim, 'warehouse'); // a hungry site: regolith demand
  sim.storage.ice = 0;
  const demand = haulDemand(sim.state);
  assert.ok(demand.regolith > 0, `the site still needs regolith, got ${demand.regolith}`);
  assert.equal(demand.ice, 0, 'with a full water reserve there is no standing ice order yet');

  buildOnline(sim, 'extractor'); // the extractor burns ice continuously
  assert.ok(haulDemand(sim.state).ice > 0, 'the extractor makes ice a standing order');

  // A full silo is not demand, even with a queue behind it.
  sim.storage.regolith = sim.storageCapacity();
  const wanted = haulWanted(sim.state, haulDemand(sim.state));
  assert.ok(!wanted.includes('regolith'), 'a full silo is not a haul target');
  assert.ok(wanted.includes('ice'), 'and an empty one still is');
});

test('a trip the rover cannot afford is refused, and a near one is allowed', () => {
  const sim = fresh();
  const r = park(sim, 0, SPAWN_X, SPAWN_Z);
  r.battery = ROVERS[r.kind].maxBatteryKWh;

  const near = nearDeposit(sim, 'regolith');
  assert.equal(canMakeRun(r, near, 'regolith'), true, 'a near seam is a morning’s drive');

  const far = sim.world.deposits
    .filter((d) => d.resource === 'regolith' && d.amount > 0)
    .sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z))[0];
  assert.ok(
    Math.hypot(far.x - r.x, far.z - r.z) > 300,
    'precondition: the far seam is genuinely far',
  );
  assert.equal(
    canMakeRun(r, far, 'regolith'),
    false,
    'a full 80 kWh pack cannot make a ~570 m round trip in compressed time',
  );
});

test('the seam scorer prefers an unclaimed close seam, and holds a scrap heap against a rival', () => {
  const sim = fresh();
  const r = park(sim, 0, SPAWN_X, SPAWN_Z);
  const deposits = sim.world.deposits
    .filter((d) => d.resource === 'ice' && d.amount > 0)
    .sort((a, b) => Math.hypot(a.x - r.x, a.z - r.z) - Math.hypot(b.x - r.x, b.z - r.z));
  const near = deposits[0];
  const demand = { ...sim.storage, ice: 500 } as typeof sim.storage;

  const pick = pickHaul(sim.state, r, ['ice'], demand)!;
  assert.equal(pick.deposit.id, near.id, 'the closest seam wins');
  assert.ok(pick.energyKWh > 0, 'and the trip is costed');

  // A worked-out seam another rover holds is held *against* a second rover.
  near.reservedBy = sim.rovers[1].id;
  near.amount = ROVERS[r.kind].capacityKg; // small enough to count as a scrap heap
  const second = pickHaul(sim.state, r, ['ice'], demand)!;
  assert.notEqual(second.deposit.id, near.id, 'the held seam is not the first choice');
});

// ---------------------------------------------------------------------------

group('Dispatch: maintenance');

test('an idle rover is sent to repair a damaged structure, and nothing is dispatched when it is whole', () => {
  const sim = fresh();
  const solar = buildOnline(sim, 'solar');
  parkAll(sim);
  dispatchMaintenance(sim.state);
  assert.deepEqual(
    sim.rovers.map((r) => r.command.type),
    ['idle', 'idle'],
    'nothing to fix, nothing dispatched',
  );

  damage(solar);
  dispatchMaintenance(sim.state);
  const worker = sim.rovers[0];
  const command: string = worker.command.type;
  assert.equal(command, 'repair');
  assert.equal(worker.command.type === 'repair' ? worker.command.buildingId : -1, solar.id);
  assert.equal(worker.autoTask, true, 'fleet decisions are auto tasks — a player order can steal them');
});

test('cleaning respects the auto-service opt-out; repair does not', () => {
  const sim = fresh();
  const solar = buildOnline(sim, 'solar');
  solar.cleanliness = 0.4;
  for (const r of parkAll(sim)) r.rules.autoService = false;

  dispatchMaintenance(sim.state);
  assert.deepEqual(sim.rovers.map((r) => r.command.type), ['idle', 'idle'], 'the chore is opted out');

  damage(solar);
  dispatchMaintenance(sim.state);
  assert.equal(sim.rovers[0].command.type, 'repair', 'but survival-critical work ignores the opt-out');
});

test('a storm cancels maintenance dispatch, and the job is still waiting afterwards', () => {
  const sim = fresh();
  const solar = buildOnline(sim, 'solar');
  parkAll(sim);
  stormOn(sim);
  // Damage lands *after* the storm is on: the ticks before it would otherwise
  // have dispatched the repair and finished the job.
  damage(solar);

  dispatchMaintenance(sim.state);
  assert.deepEqual(
    sim.rovers.map((r) => r.command.type),
    ['idle', 'idle'],
    'nobody drives into a storm to fix a panel',
  );
  assert.equal(maintenancePending(sim.state), true, 'the job waits for the sky to clear');
});

// ---------------------------------------------------------------------------

group('Dispatch: rescue');

test('the nearest volunteer with charge to spare is sent to a stranded rover', () => {
  const sim = fresh();
  const [miner] = parkAll(sim);
  park(sim, 1, SPAWN_X + 10, SPAWN_Z); // the utility rover, right beside the pad
  const victim = sim.devSpawnRover('cargo', SPAWN_X + 30, SPAWN_Z);
  victim.battery = 0;
  RoverSystem.disable(sim.state, victim);

  dispatchRescues(sim.state);
  const rescue = sim.rovers.find((r) => r.command.type === 'recover');
  assert.equal(rescue?.id, sim.rovers[1].id, 'the close volunteer goes');
  assert.equal(
    rescue && rescue.command.type === 'recover' ? rescue.command.roverId : -1,
    victim.id,
    'to the right rover',
  );
  assert.equal(rescue?.autoTask, true);
  assert.equal(miner.command.type, 'idle', 'the far one stays on its own work');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('heading out to jump-start')),
    'the dispatch is announced',
  );
});

test('a volunteer that cannot go, afford it and come back is refused', () => {
  const sim = fresh();
  const r = parkAll(sim)[0];
  const victim = sim.devSpawnRover('cargo', SPAWN_X + 60, SPAWN_Z);
  victim.battery = 0;
  RoverSystem.disable(sim.state, victim);
  const gift = rescueJobs(sim.state).find((j) => j.stranded.id === victim.id)!.energyKWh;

  r.battery = ROVERS[r.kind].maxBatteryKWh * 0.2; // enough to be idle, not enough to go
  assert.equal(rescueFeasible(sim.state, r, victim, gift), false);
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'idle', 'the volunteer is not sent on a suicide run');

  r.battery = ROVERS[r.kind].maxBatteryKWh; // a full pack: now it can
  assert.equal(rescueFeasible(sim.state, r, victim, gift), true);
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'recover');
});

test('autoRescue off, a queued plan, or a recharge run all keep a rover out of the rescue pool', () => {
  const sim = fresh();
  // Park the opening fleet *before* stranding anyone: parkAll resets every
  // rover it can see, and a "parked" stranded rover is no longer stranded.
  const r = parkAll(sim)[0];
  const victim = sim.devSpawnRover('cargo', SPAWN_X + 30, SPAWN_Z);
  victim.battery = 0;
  RoverSystem.disable(sim.state, victim);
  for (const other of sim.rovers) other.rules.autoRescue = false; // only `r` may answer

  r.rules.autoRescue = false;
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'idle', 'opted out');

  r.rules.autoRescue = true;
  r.pending = [{ type: 'wait', seconds: 30 }];
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'idle', 'a queued plan is not idle time');

  r.pending = [];
  r.recharge = true;
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'idle', 'a rover heading home to charge is not spare');

  r.recharge = false;
  dispatchRescues(sim.state);
  assert.equal(r.command.type, 'recover', 'and with all three cleared, it goes');
});

test('the gift a stranded rover needs is sized to its own pack, not the rescuer’s', () => {
  const sim = fresh();
  const small = sim.devSpawnRover('utility', SPAWN_X + 60, SPAWN_Z); // the 40 kWh machine
  const large = sim.devSpawnRover('cargo', SPAWN_X + 60, SPAWN_Z); // the heavier one
  for (const victim of [small, large]) {
    victim.battery = 0;
    RoverSystem.disable(sim.state, victim);
  }
  const giftSmall = rescueJobs(sim.state).find((j) => j.stranded.id === small.id)!.energyKWh;
  const giftLarge = rescueJobs(sim.state).find((j) => j.stranded.id === large.id)!.energyKWh;
  assert.ok(
    giftLarge > giftSmall,
    `the bigger pack needs the bigger gift (${giftLarge.toFixed(1)} vs ${giftSmall.toFixed(1)} kWh)`,
  );
});

// ---------------------------------------------------------------------------

group('Dispatch: supply runs & reservations');

test('an idle fleet is sent to haul what the colony is short of', () => {
  const sim = fresh();
  buildOnline(sim, 'extractor'); // ice becomes a standing order
  sim.storage.ice = 0;
  const r = parkAll(sim)[0];

  dispatchSupplyRuns(sim.state, hooks);
  const command: string = r.command.type;
  assert.equal(command, 'mine', 'the fleet fetches what is missing');
  assert.equal(r.autoTask, true);
  const picked = sim.world.deposits.find(
    (d) => r.command.type === 'mine' && d.id === r.command.depositId,
  );
  assert.equal(picked?.resource, 'ice', 'and it picked an ice seam');
  assert.equal(picked?.reservedBy, r.id, 'the seam is claimed as the reservation');
});

test('a full depot stops the haul pass, and autoHaul off stops a rover', () => {
  const sim = fresh();
  buildOnline(sim, 'extractor');
  const r = parkAll(sim)[0];
  for (const res of ALL_RESOURCES) sim.storage[res] = sim.storageCapacity();

  dispatchSupplyRuns(sim.state, hooks);
  assert.equal(r.command.type, 'idle', 'nowhere to put a load, so no trip');

  for (const res of ALL_RESOURCES) sim.storage[res] = 0;
  r.rules.autoHaul = false;
  dispatchSupplyRuns(sim.state, hooks);
  assert.equal(r.command.type, 'idle', 'a rover with auto-haul off is never dispatched');

  r.rules.autoHaul = true;
  dispatchSupplyRuns(sim.state, hooks);
  assert.equal(r.command.type, 'mine', 'switching it back on returns it to the pool');
});

test('a stocked site holds a capable rover back from the haul pass', () => {
  const sim = fresh();
  const site = build(sim, 'warehouse');
  for (const res of ALL_RESOURCES) site.remainingCost[res] = 0; // stocked: waiting on a crew
  buildOnline(sim, 'extractor'); // and the colony wants ice
  sim.storage.ice = 0;
  const [held, hauler] = parkAll(sim);
  assert.equal(waitingSite(sim.state)?.id, site.id, 'the site is a construction job');

  dispatchSupplyRuns(sim.state, hooks);
  assert.equal(held.command.type, 'idle', 'the first capable rover is held back for the site');
  assert.equal(hauler.command.type, 'mine', 'the other rover hauls');
});

test('a site missing materials is nobody’s reservation — the fleet hauls instead', () => {
  const sim = fresh();
  build(sim, 'warehouse'); // hungry: needs regolith, so not a crew job
  buildOnline(sim, 'extractor');
  sim.storage.ice = 0;
  const [a, b] = parkAll(sim);

  assert.equal(waitingSite(sim.state), null, 'a hungry site is not a crew job');
  dispatchSupplyRuns(sim.state, hooks);
  const commands = [a.command.type, b.command.type];
  assert.deepEqual(commands, ['mine', 'mine'], 'both rovers go hauling');
  const seams = sim.rovers.map((r) => (r.command.type === 'mine' ? r.command.depositId : -1));
  assert.notEqual(seams[0], seams[1], 'and the demand ledger spreads them across different seams');
});

test('with several jobs waiting, the rover takes the highest band first', () => {
  const sim = fresh();
  const solar = buildOnline(sim, 'solar');
  buildOnline(sim, 'extractor');
  solar.cleanliness = 0.3; // a clean job
  sim.storage.ice = 0; // and a haul job
  const r = parkAll(sim)[0];
  damage(solar, 30); // and a repair job on top

  // Read through a widening local: `assert.equal` narrows `r.command`, so a
  // second read of the same property compares against `never`.
  const command = (): string => r.command.type;
  FleetAutomationSystem.tick(sim.state, hooks);
  assert.equal(command(), 'repair', 'survival first');

  solar.damaged = false;
  solar.health = 100;
  RoverSystem.finishTask(r);
  FleetAutomationSystem.tick(sim.state, hooks);
  assert.equal(command(), 'clean', 'then construction');

  solar.cleanliness = 1;
  RoverSystem.finishTask(r);
  FleetAutomationSystem.tick(sim.state, hooks);
  assert.equal(command(), 'mine', 'and routine hauling fills what is left');
});

// ---------------------------------------------------------------------------

group('Live fleet behavior');

test('a stranded rover nobody is ordered to rescue gets a volunteer on the next tick', () => {
  const sim = fresh(63);
  const victim = sim.rovers[1];
  park(sim, 0, SPAWN_X + 20, SPAWN_Z); // a free volunteer beside the pad
  victim.x = SPAWN_X + 60;
  victim.z = SPAWN_Z;
  victim.battery = 0;
  RoverSystem.disable(sim.state, victim);
  assert.equal(sim.rovers.some((r) => r.command.type === 'recover'), false, 'nobody yet');

  sim.step(SIM_TICK);
  assert.deepEqual(
    sim.rovers.filter((r) => r.command.type === 'recover').map((r) => r.id),
    [sim.rovers[0].id],
    'the next tick dispatches the volunteer',
  );
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('jump-start')),
    'and says so',
  );
});

test('a rover below its ride-home floor is recalled and left out of the pool', () => {
  const sim = fresh(70);
  const [miner] = parkAll(sim);
  miner.battery = 2; // far under the floor
  sim.step(SIM_TICK);
  assert.equal(miner.recharge, true, 'the rover is heading home to charge');
  assert.equal(
    idlePool(sim.state).includes(miner),
    false,
    'and the fleet does not count it as spare',
  );
});

test('dispatch is deterministic: two same-seed colonies make the same choices', () => {
  const a = fresh(77);
  const b = fresh(77);
  for (const sim of [a, b]) {
    buildOnline(sim, 'extractor');
    sim.storage.ice = 0;
    sim.devForceStorm('regional');
  }
  run(a, 0.5);
  run(b, 0.5);
  assert.equal(hashSimulation(a), hashSimulation(b), 'no ambient randomness in the job model');
});

await finish('sim/fleet-automation');
