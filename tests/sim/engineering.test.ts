/**
 * @suite sim/engineering
 * @group integration
 * @covers src/sim/engineering/upgrades.ts src/sim/systems/UpgradeSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/systems/GarageSystem.ts src/sim/systems/PowerSystem.ts src/sim/systems/RoverSystem.ts src/sim/systems/ProductionSystem.ts src/sim/persistence/EngineeringPersistence.ts src/sim/persistence/migrations/v12.ts
 * @desc Permanent refits, paid timed service, on-site work, effective stats,
 * cancellation, manufacturing, safe saves and immutable command/view boundaries.
 */
import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { UpgradeSystem as U } from '../../src/sim/systems/UpgradeSystem';
import { ProductionSystem as P } from '../../src/sim/systems/ProductionSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { PowerSystem } from '../../src/sim/systems/PowerSystem';
import { idlePool } from '../../src/sim/systems/FleetAutomationSystem';
import {
  effectiveRoverDef,
  effectiveBuildingDef,
  upgradePrice,
  buildingUpgrades,
  roverUpgrades,
  type UpgradeId,
} from '../../src/sim/engineering/upgrades';
import {
  BUILDINGS,
  ROVERS,
  ALL_RESOURCES,
  ALL_COMPONENTS,
} from '../../src/sim/defs';
import {
  assertInvariants,
  checkInvariants,
} from '../../src/sim/debug/SimulationAssertions';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { projectView, decodeCommand } from '../../src/sim/host';
import { SIM_TICK, HOURS_PER_SEC, SAVE_VERSION } from '../../src/sim/config';
import { buildOnline } from '../fixtures/sim';
import { test, finish } from '../harness';
function colony() {
  const sim = new Simulation({ seed: 515 });
  const shop = buildOnline(sim, 'workshop'),
    garage = buildOnline(sim, 'garage');
  for (let i = 0; i < 4; i++) buildOnline(sim, 'rtg');
  for (const r of sim.rovers) {
    sim.stopRover(r.id);
    r.rules.autoHaul = false;
    r.rules.autoService = false;
  }
  for (const k of ALL_RESOURCES)
    sim.storage[k] = Math.min(sim.storageCapacity(), 1000);
  for (const k of ALL_COMPONENTS) sim.components[k] = 24;
  const r = sim.rovers[0];
  r.x = garage.x + BUILDINGS.garage.radius + 3;
  r.z = garage.z;
  r.recharge = false;
  r.phase = 'idle';
  garage.powerSat = 1;
  garage.loadKw = 6;
  return {
    sim,
    shop,
    garage,
    r,
    target: { entity: 'rover' as const, id: r.id },
  };
}
function fit(sim: Simulation, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds / SIM_TICK) + 1; i++) U.tick(sim.state);
}
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('each blueprint has role-specific upgrades and only miners can fit teeth', () => {
  for (const kind of Object.keys(BUILDINGS) as Array<keyof typeof BUILDINGS>)
    assert.ok(buildingUpgrades(kind).length, kind);
  assert.ok(roverUpgrades('mining').includes('teeth'));
  assert.ok(!roverUpgrades('cargo').includes('teeth'));
  const { sim, r, target } = colony();
  r.kind = 'cargo';
  assert.equal(sim.startUpgrade(target, 'teeth'), false);
});
test('refits debit both ledgers exactly once and install only after timed powered work', () => {
  const { sim, r, target } = colony();
  const price = upgradePrice('drivetrain', 1),
    steel = sim.storage.steel,
    motors = sim.components.motor;
  assert.ok(sim.startUpgrade(target, 'drivetrain'));
  assert.equal(sim.storage.steel, steel - price.solids.steel);
  assert.equal(sim.components.motor, motors - price.parts.motor);
  assert.equal(sim.startUpgrade(target, 'battery'), false);
  fit(sim, 5);
  assert.equal(r.upgrades?.drivetrain, undefined);
  assert.ok(r.upgradeJob!.progress > 0);
  fit(sim, 20);
  assert.equal(r.upgrades?.drivetrain, 1);
  assert.equal(r.upgradeJob, null);
  assert.equal(sim.components.motor, motors - price.parts.motor);
  assertInvariants(sim);
});
test('funding is atomic; insufficient components or a missing garage spend nothing', () => {
  const { sim, r, target } = colony();
  sim.components.batteryPack = 0;
  const steel = sim.storage.steel;
  assert.equal(sim.startUpgrade(target, 'battery'), false);
  assert.equal(sim.storage.steel, steel);
  sim.components.batteryPack = 24;
  r.x += 100;
  assert.equal(sim.startUpgrade(target, 'battery'), false);
  assert.equal(sim.storage.steel, steel);
});
test('blackout, disabled garage, damage, departure and player orders pause funded work', () => {
  const { sim, r, target, garage } = colony();
  sim.startUpgrade(target, 'battery');
  fit(sim, 2);
  const progress = r.upgradeJob!.progress;
  garage.powerSat = 0;
  fit(sim, 8);
  assert.equal(r.upgradeJob!.progress, progress);
  garage.powerSat = 1;
  garage.enabled = false;
  fit(sim, 8);
  garage.enabled = true;
  garage.damaged = true;
  fit(sim, 8);
  garage.damaged = false;
  assert.equal(r.upgradeJob!.progress, progress);
  r.x += 100;
  fit(sim, 8);
  r.x -= 100;
  r.command = { type: 'moveTo', x: 200, z: 200 };
  fit(sim, 8);
  assert.equal(r.upgradeJob!.progress, progress);
  r.command = { type: 'idle' };
  garage.powerSat = 0.5;
  fit(sim, 4);
  near(
    r.upgradeJob!.progress,
    progress + (Math.ceil(4 / SIM_TICK + 1) * SIM_TICK * 0.5) / 24,
  );
});
test('a reserved garage cannot assemble or refit a second rover; automation leaves its customer alone', () => {
  const { sim, r, target, garage } = colony();
  sim.startUpgrade(target, 'battery');
  assert.ok(!idlePool(sim.state).includes(r));
  assert.equal(sim.assembleRover(garage.id, 'utility'), false);
  const other = sim.rovers[1];
  other.x = r.x;
  other.z = r.z;
  assert.equal(
    sim.startUpgrade({ entity: 'rover', id: other.id }, 'cargo'),
    false,
  );
});
test('cancellation refunds once, bounded by storage; demolishing a garage releases its customer', () => {
  const { sim, r, target, garage } = colony();
  const before = sim.storage.steel;
  sim.startUpgrade(target, 'drivetrain');
  assert.ok(sim.cancelUpgrade(target));
  near(sim.storage.steel, before);
  assert.equal(sim.cancelUpgrade(target), false);
  sim.startUpgrade(target, 'drivetrain');
  sim.demolish(garage.id);
  assert.equal(r.upgradeJob, null);
  assertInvariants(sim);
});
test('tiers scale effective rover stats and preserve wear and stored energy', () => {
  const { sim, r, target } = colony();
  r.parts.motor = 44;
  const charge = r.battery;
  sim.startUpgrade(target, 'battery');
  fit(sim, 25);
  near(r.battery, charge);
  near(effectiveRoverDef(r).maxBatteryKWh, ROVERS[r.kind].maxBatteryKWh * 1.35);
  r.upgrades = { drivetrain: 2, cargo: 3, teeth: 1, battery: 1 };
  const d = effectiveRoverDef(r);
  near(d.cruiseSpeed, ROVERS[r.kind].cruiseSpeed * 1.4);
  near(d.capacityKg, ROVERS[r.kind].capacityKg * 2.2);
  near(d.mineSpeedMul, ROVERS[r.kind].mineSpeedMul * 1.3);
  assert.equal(r.parts.motor, 44);
  assert.equal(sim.startUpgrade(target, 'cargo'), false);
});
test('upgraded battery headroom is charged by the real power resolver', () => {
  const { sim, r } = colony();
  r.upgrades = { battery: 1 };
  r.battery = ROVERS[r.kind].maxBatteryKWh;
  r.phase = 'charging';
  PowerSystem.tick(sim.state, {
    desiredThroughput: () => 0,
    processBlockReason: () => '',
    runProcess: () => {},
  });
  assert.ok(r.battery > ROVERS[r.kind].maxBatteryKWh);
  assert.ok(r.battery <= effectiveRoverDef(r).maxBatteryKWh);
});
test('Workshop makes the three new upgrade components on separate paid lines', () => {
  const { sim, shop } = colony();
  for (const [recipe, item] of [
    [3, 'batteryPack'],
    [4, 'cargoFrame'],
    [5, 'drillTeeth'],
  ] as const) {
    sim.components[item] = 0;
    shop.recipe = recipe;
    const before = sim.storage.steel;
    P.runProcess(sim.state, shop, 1, 2);
    assert.equal(sim.components[item], 1);
    assert.ok(sim.storage.steel < before);
  }
});
test('building refits use real on-site builder work and preserve existing tank contents', () => {
  const { sim } = colony();
  const tank = buildOnline(sim, 'waterTank');
  assert.ok(sim.startUpgrade({ entity: 'building', id: tank.id }, 'storage'));
  for (let i = 0; i < 2200 && tank.upgradeJob; i++) sim.step(SIM_TICK);
  assert.equal(tank.upgrades?.storage, 1);
  assert.equal(tank.upgradeJob, null);
  near(effectiveBuildingDef(tank).fluidCapacity!.water!, 350);
  assertInvariants(sim);
});
test('generation, production, efficiency and service upgrades expose independent real multipliers', () => {
  const { sim, shop, garage } = colony();
  const rtg = sim.buildings.find((b) => b.kind === 'rtg')!;
  rtg.upgrades = { generation: 2 };
  near(
    effectiveBuildingDef(rtg).powerProduceKw,
    BUILDINGS.rtg.powerProduceKw * 1.5,
  );
  shop.upgrades = { production: 2, efficiency: 1 };
  near(
    effectiveBuildingDef(shop).powerDrawKw,
    BUILDINGS.workshop.powerDrawKw * 0.88,
  );
  shop.recipe = 0;
  sim.components.motor = 0;
  for (let i = 0; i < 6; i++) P.runProcess(sim.state, shop, 1, 1 / 3);
  assert.equal(sim.components.motor, 1);
  near(shop.craft.motor, 0.5);
  garage.upgrades = { service: 3 };
  assert.equal(buildingUpgrades('garage').includes('service'), true);
});
test('v13 owns nested jobs/levels/paint and resumes prepaid refits without charging again', () => {
  const { sim, r, target } = colony();
  sim.paintEntity(target, '#d67635');
  sim.startUpgrade(target, 'cargo');
  fit(sim, 5);
  const save = sim.snapshot();
  assert.equal(save.version, SAVE_VERSION);
  assert.notEqual(save.rovers[0].upgradeJob, r.upgradeJob);
  const restored = new Simulation({ seed: 1 });
  restored.restore(save);
  const rr = restored.roverById(r.id)!;
  assert.equal(rr.paint, '#d67635');
  assert.deepEqual(rr.upgradeJob, r.upgradeJob);
  const parts = restored.components.cargoFrame;
  const g = restored.buildingById(rr.upgradeJob!.facilityId!)!;
  g.powerSat = 1;
  rr.command = { type: 'idle' };
  rr.phase = 'idle';
  fit(restored, 30);
  assert.equal(rr.upgrades?.cargo, 1);
  assert.equal(restored.components.cargoFrame, parts);
  assertInvariants(restored);
});
test('old saves default unmodified; malformed upgrade levels/jobs/paint are discarded', () => {
  const { sim } = colony();
  const raw = sim.snapshot() as any;
  raw.version = 12;
  for (const r of raw.rovers) {
    delete r.upgrades;
    delete r.upgradeJob;
    delete r.paint;
  }
  const restored = new Simulation({ seed: 2 });
  restored.restore(raw);
  assert.deepEqual(restored.rovers[0].upgrades, {});
  raw.version = 13;
  raw.rovers[0].upgrades = {
    battery: 99,
    cargo: -1,
    teeth: 1.5,
    drivetrain: 1,
  };
  raw.rovers[0].paint = '<script>';
  raw.rovers[0].upgradeJob = {
    upgrade: 'battery',
    tier: 9,
    progress: 1,
    facilityId: 100,
  };
  restored.restore(raw);
  assert.deepEqual(restored.rovers[0].upgrades, { drivetrain: 1 });
  assert.equal(restored.rovers[0].paint, null);
  assert.equal(restored.rovers[0].upgradeJob, null);
});
test('commands validate enums and owned view copies cannot mutate engineering state', () => {
  const { sim, r, target } = colony();
  sim.startUpgrade(target, 'cargo');
  assert.ok(
    decodeCommand({ type: 'engineering/paint', ...target, paint: '#d67635' })
      .ok,
  );
  assert.equal(
    decodeCommand({
      type: 'engineering/upgrade',
      ...target,
      upgrade: 'teleport',
    }).ok,
    false,
  );
  const view = projectView(sim, 'in-process', {});
  (view.rovers[0].upgradeJob as any).progress = 0.99;
  assert.notEqual(r.upgradeJob!.progress, 0.99);
  const hash = hashSimulation(sim);
  sim.paintEntity(target, '#4b896a');
  assert.notEqual(hashSimulation(sim), hash);
});
test('mid-installation replays are deterministic and invalid permanent state is reported', () => {
  const { sim, target } = colony();
  sim.startUpgrade(target, 'battery');
  fit(sim, 4);
  const save = sim.snapshot();
  const a = new Simulation({ seed: 1 }),
    b = new Simulation({ seed: 2 });
  a.restore(save);
  b.restore(JSON.parse(JSON.stringify(save)));
  for (let i = 0; i < 600; i++) {
    a.step(SIM_TICK);
    b.step(SIM_TICK);
  }
  assert.equal(hashSimulation(a), hashSimulation(b));
  assert.equal(a.rovers[0].upgrades?.battery, 1);
  assertInvariants(a);
  a.rovers[0].upgrades = { battery: 9 };
  assert.ok(checkInvariants(a).some((v) => v.code === 'engineering-state'));
});
await finish('sim/engineering');
