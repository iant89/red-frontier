/**
 * @suite sim/maintenance
 * @group integration
 * @covers src/sim/systems/MaintenanceSystem.ts src/sim/systems/RoverSystem.ts src/sim/systems/GarageSystem.ts src/sim/systems/ProductionSystem.ts src/sim/systems/FleetAutomationSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/systems/FailureSystem.ts src/sim/systems/AlertSystem.ts src/sim/Simulation.ts src/sim/defs.ts src/sim/config.ts src/sim/persistence/ColonyPersistence.ts src/sim/persistence/SaveMigrations.ts src/sim/persistence/migrations/v7.ts src/sim/persistence/migrations/v8.ts src/sim/persistence/migrations/v9.ts src/sim/persistence/migrations/v10.ts src/sim/host/projection.ts src/sim/debug/StateHash.ts src/sim/debug/SimulationAssertions.ts
 * @desc P5 installed component wear, powered/stocked replacements, cancellation,
 * bootstrap recovery, deterministic saves, worker-safe copies and automation.
 */
import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { MaintenanceSystem as M } from '../../src/sim/systems/MaintenanceSystem';
import { ComponentSystem } from '../../src/sim/systems/ComponentSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { GarageSystem } from '../../src/sim/systems/GarageSystem';
import { ProductionSystem } from '../../src/sim/systems/ProductionSystem';
import { idlePool } from '../../src/sim/systems/FleetAutomationSystem';
import { assertInvariants, checkInvariants } from '../../src/sim/debug/SimulationAssertions';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { projectView } from '../../src/sim/host/projection';
import { migrateV7Save, migrateV8Save, migrateV9Save, migrateV10Save } from '../../src/sim/persistence/SaveMigrations';
import { decodeCommand } from '../../src/sim/host';
import { BUILDINGS, ALL_COMPONENTS } from '../../src/sim/defs';
import { PART_REPLACE_SECONDS, SIM_TICK, SAVE_VERSION } from '../../src/sim/config';
import { buildOnline, run } from '../fixtures/sim';
import { test, finish } from '../harness';

function colony() {
  const sim = new Simulation({ seed: 515, nearDeposits: 0.2 });
  buildOnline(sim, 'workshop');
  const bay = buildOnline(sim, 'repairBay');
  const r = sim.rovers[0];
  sim.stopRover(r.id);
  r.x = bay.x + BUILDINGS.repairBay.radius + 3;
  r.z = bay.z;
  r.y = sim.world.heightAt(r.x, r.z);
  r.recharge = false;
  r.phase = 'idle';
  r.parts.motor = 50;
  r.parts.circuitBoard = 60;
  bay.powerSat = 1;
  bay.throughput = 1;
  ComponentSystem.store(sim.state, 'motor', 3);
  ComponentSystem.store(sim.state, 'circuitBoard', 3);
  return { sim, bay, r };
}
function service(sim: Simulation, seconds = PART_REPLACE_SECONDS) {
  for (let i = 0; i < Math.round(seconds / SIM_TICK); i++) M.tickBays(sim.state);
}

test('Repair Bay is a legal, steel-priced blueprint, not a survival prerequisite', () => {
  assert.equal(BUILDINGS.repairBay.powerDrawKw, 8);
  assert.ok(BUILDINGS.repairBay.cost.steel > 0);
  assert.ok(decodeCommand({ type: 'building/place', kind: 'repairBay', x: 50, z: 50 }).ok);
  for (const k of ['refinery', 'workshop', 'habitat', 'oxygenator'] as const) {
    assert.equal(BUILDINGS[k].cost.steel, 0, `${k} can bootstrap before refined stock`);
  }
});

test('a bay replaces one part per timed job and consumes exactly one matching spare', () => {
  const { sim, bay, r } = colony();
  service(sim, 6);
  assert.equal(r.parts.motor, 50, 'no free health before completion');
  assert.equal(sim.components.motor, 3, 'pay on completion, not every frame');
  assert.ok(Math.abs(bay.maintenance!.progress - 0.5) < 1e-9);
  service(sim, 6);
  assert.equal(r.parts.motor, 100);
  assert.equal(r.parts.circuitBoard, 60);
  assert.equal(sim.components.motor, 2);
  service(sim);
  assert.equal(r.parts.circuitBoard, 100);
  assert.equal(sim.components.circuitBoard, 2);
  service(sim, 24);
  assert.equal(sim.components.motor, 2, 'healthy parts never spend spares');
  assert.equal(bay.maintenance, null);
  assert.equal(sim.drainDomainEvents().filter((e) => e.type === 'rover/part-replaced').length, 2);
  assertInvariants(sim);
});

test('missing stock, power, a disabled bay and structural damage pause a job', () => {
  const { sim, bay, r } = colony();
  service(sim, 2);
  const progress = bay.maintenance!.progress;
  ComponentSystem.take(sim.state, 'motor', 99);
  service(sim, 20);
  assert.equal(bay.maintenance!.progress, progress);
  assert.match(bay.idleReason, /Needs 1 × Drive Motor/);
  assert.equal(ProductionSystem.desiredThroughput(sim.state, bay), 0);
  ComponentSystem.store(sim.state, 'motor', 1);
  bay.powerSat = 0;
  service(sim, 20);
  assert.match(bay.idleReason, /No power/);
  assert.equal(M.holdsRover(sim.state, r), true, 'a temporary blackout must not dispatch a funded customer away');
  assert.ok(!idlePool(sim.state).includes(r));
  assert.equal(bay.maintenance!.progress, progress);
  bay.powerSat = 1;
  bay.enabled = false;
  service(sim, 20);
  bay.enabled = true;
  bay.damaged = true;
  service(sim, 20);
  assert.equal(bay.maintenance!.progress, progress);
  assert.equal(r.parts.motor, 50);
  bay.damaged = false;
  service(sim, 10);
  assert.equal(r.parts.motor, 100);
  assert.equal(sim.components.motor, 0);
});

test('brownouts scale service time instead of granting free unpowered repairs', () => {
  const { sim, bay, r } = colony();
  bay.throughput = bay.powerSat = 0.5;
  service(sim);
  assert.equal(r.parts.motor, 50);
  assert.ok(Math.abs(bay.maintenance!.progress - 0.5) < 1e-9);
  service(sim);
  assert.equal(r.parts.motor, 100);
});

test('a missing motor does not block a stocked circuit board when choosing a new job', () => {
  const { sim, bay, r } = colony();
  ComponentSystem.take(sim.state, 'motor', 99);
  service(sim);
  assert.equal(r.parts.circuitBoard, 100);
  assert.equal(r.parts.motor, 50);
  M.tickBays(sim.state);
  assert.equal(bay.maintenance!.component, 'motor');
  assert.match(bay.idleReason, /Needs/);
});

test('leaving or taking a player order cancels without consuming a part', () => {
  const { sim, bay, r } = colony();
  service(sim, 6);
  r.x += 30;
  M.tickBays(sim.state);
  assert.equal(bay.maintenance, null);
  assert.equal(sim.components.motor, 3);
  r.x -= 30;
  service(sim, 6);
  sim.issueMove(r.id, r.x + 40, r.z);
  M.tickBays(sim.state);
  assert.equal(bay.maintenance, null);
  assert.equal(sim.components.motor, 3);
  assert.equal(M.holdsRover(sim.state, r), false);
});

test('automation leaves a funded service customer parked, but does not strand it for missing stock', () => {
  const { sim, r } = colony();
  assert.ok(M.holdsRover(sim.state, r));
  assert.ok(!idlePool(sim.state).includes(r));
  for (const c of ALL_COMPONENTS) ComponentSystem.take(sim.state, c, 99);
  assert.equal(M.holdsRover(sim.state, r), false);
  assert.ok(idlePool(sim.state).includes(r));
});

test('two overlapping bays cannot replace the same part twice', () => {
  const { sim, bay, r } = colony();
  const other = buildOnline(sim, 'repairBay');
  other.x = bay.x;
  other.z = bay.z;
  other.powerSat = other.throughput = 1;
  r.parts.circuitBoard = 100;
  service(sim, 30);
  assert.equal(sim.components.motor, 2);
  assert.equal(r.parts.motor, 100);
  assert.equal(sim.drainDomainEvents().filter((e) => e.type === 'rover/part-replaced').length, 1);
});

test('two customers competing for the last motor never overdraw the rack', () => {
  const { sim, bay, r } = colony();
  const other = buildOnline(sim, 'repairBay');
  const r2 = sim.rovers[1];
  sim.stopRover(r2.id);
  Object.assign(r2, { x: other.x + 10, z: other.z, recharge: false, phase: 'idle' });
  r.parts.circuitBoard = 100;
  r2.parts.motor = 50;
  other.powerSat = other.throughput = 1;
  ComponentSystem.take(sim.state, 'motor', 2);
  service(sim, 30);
  assert.equal(sim.components.motor, 0);
  assert.equal([r, r2].filter((x) => x.parts.motor === 100).length, 1);
  assert.ok(bay.maintenance || other.maintenance, 'the other customer still needs stock');
  assertInvariants(sim);
});

test('motor and board wear are independent, and even worn-out parts retain half performance', () => {
  const { sim, r } = colony();
  r.parts = { motor: 100, circuitBoard: 100 };
  r.phase = 'moving';
  r.x += 40;
  M.tickWear(sim.state);
  assert.ok(r.parts.motor < r.parts.circuitBoard);
  assert.ok(r.parts.circuitBoard < 100);
  r.parts = { motor: 0, circuitBoard: 0 };
  M.tickWear(sim.state);
  assert.deepEqual(r.parts, { motor: 0, circuitBoard: 0 });
  assert.equal(RoverSystem.roverWorkMul(r), 0.5);
  r.parts = { motor: 100, circuitBoard: 0 };
  assert.equal(RoverSystem.roverWorkMul(r), 0.5, 'a failed board alone reduces rate');
  assert.notEqual(r.phase, 'disabled');
});

test('storms wear exposed components but the repair gantry protects a parked customer', () => {
  const { sim, bay, r } = colony();
  sim.weather.localIntensity = () => 1;
  const before = { ...r.parts };
  M.tickWear(sim.state);
  assert.deepEqual(r.parts, before, 'inside the gantry is sheltered');
  r.x = bay.x + 30;
  M.tickWear(sim.state);
  assert.ok(r.parts.motor < before.motor && r.parts.circuitBoard < before.circuitBoard);
  const exposed = { ...r.parts };
  r.sheltered = true;
  M.tickWear(sim.state);
  assert.deepEqual(r.parts, exposed);
});

test('flat batteries and emergency charging take precedence over component service', () => {
  const { sim, bay, r } = colony();
  service(sim, 2);
  r.recharge = true;
  M.tickBays(sim.state);
  assert.equal(bay.maintenance, null);
  assert.equal(M.holdsRover(sim.state, r), false);
  r.recharge = false;
  r.battery = 0;
  r.phase = 'disabled';
  service(sim, 30);
  assert.equal(r.parts.motor, 50);
  assert.equal(sim.components.motor, 3, 'jump-start first; spare parts cannot repair a flat pack');
});

test('routine garage servicing cannot restore installed part health', () => {
  const { sim, r } = colony();
  const garage = buildOnline(sim, 'garage');
  Object.assign(r, { x: garage.x + 8, z: garage.z, condition: 50 });
  GarageSystem.tick(sim.state);
  assert.ok(r.condition > 50);
  assert.equal(r.parts.motor, 50);
  assert.equal(r.parts.circuitBoard, 60);
});

test('the real tick completes repairs, preserves the parked rover and raises/clears part alerts', () => {
  const { sim, bay, r } = colony();
  for (let i = 0; i < 4; i++) buildOnline(sim, 'rtg');
  r.parts.motor = 10;
  sim.step(SIM_TICK);
  assert.ok(sim.alerts.list().some((a) => a.key === `rover-parts-${r.id}`));
  const x = r.x, z = r.z;
  run(sim, 0.11);
  assert.equal(r.parts.motor, 100);
  assert.equal(r.parts.circuitBoard, 100);
  assert.equal(r.x, x);
  assert.equal(r.z, z);
  assert.ok(!sim.alerts.list().some((a) => a.key === `rover-parts-${r.id}`));
  assert.equal(bay.maintenance, null);
});

test('current save persists owned parts and in-flight jobs; resume spends only once', () => {
  const { sim, bay, r } = colony();
  service(sim, 6);
  const snap = sim.snapshot();
  assert.equal(snap.version, SAVE_VERSION);
  assert.equal(SAVE_VERSION, 14);
  snap.rovers[0].parts!.motor = 49;
  assert.equal(r.parts.motor, 50, 'snapshot does not alias live parts');
  const restored = new Simulation({ seed: 2 });
  restored.restore(JSON.parse(JSON.stringify(snap)));
  const rb = restored.buildingById(bay.id)!;
  rb.powerSat = rb.throughput = 1;
  const rr = restored.roverById(r.id)!;
  assert.equal(rr.parts.motor, 49);
  assert.ok(Math.abs(rb.maintenance!.progress - 0.5) < 1e-9);
  service(restored, 6);
  assert.equal(rr.parts.motor, 100);
  assert.equal(restored.components.motor, 2);
  assertInvariants(restored);
});

test('v10 colonies load with healthy parts; malformed health/jobs are sanitised', () => {
  assert.equal(migrateV7Save({ version: 7 }).version, 8);
  assert.equal(migrateV8Save({ version: 8 }).version, 9);
  assert.equal(migrateV9Save({ version: 9 }).version, 10);
  assert.equal(migrateV10Save({ version: 10 }).version, 11);
  const { sim, bay } = colony();
  const save = JSON.parse(JSON.stringify(sim.snapshot()));
  save.version = 10;
  for (const r of save.rovers) delete r.parts;
  for (const b of save.buildings) delete b.maintenance;
  sim.restore(save);
  assert.deepEqual(sim.rovers[0].parts, { motor: 100, circuitBoard: 100 });
  assert.equal(sim.buildingById(bay.id)!.maintenance, null);
  save.rovers[0].parts = { motor: -5, circuitBoard: 'broken' };
  save.buildings.find((b: any) => b.id === bay.id).maintenance = { roverId: -1, component: 'motor', progress: 0.8 };
  sim.restore(save);
  assert.deepEqual(sim.rovers[0].parts, { motor: 0, circuitBoard: 100 });
  assert.equal(sim.buildingById(bay.id)!.maintenance, null);
  assertInvariants(sim);
});

test('read models own nested parts and jobs and both participate in hashes/invariants', () => {
  const { sim, bay, r } = colony();
  service(sim, 3);
  const before = hashSimulation(sim);
  const view = projectView(sim, 'in-process', {});
  assert.notEqual(view.rovers[0].parts, r.parts);
  const vb = view.buildings.find((b) => b.id === bay.id)!;
  assert.notEqual(vb.maintenance, bay.maintenance);
  r.parts.motor--;
  bay.maintenance!.progress += 0.1;
  assert.equal(view.rovers[0].parts.motor, 50);
  assert.notEqual(hashSimulation(sim), before);
  r.parts.motor = NaN;
  assert.ok(checkInvariants(sim).some((v) => v.code === 'rover-part-health'));
  r.parts.motor = 50;
  bay.maintenance!.progress = 5;
  assert.ok(checkInvariants(sim).some((v) => v.code === 'building-maintenance'));
});

await finish('sim/maintenance');
