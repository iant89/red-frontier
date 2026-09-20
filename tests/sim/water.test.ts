/**
 * @suite sim/water
 * @group integration
 * @covers src/sim/systems/WaterSystem.ts src/sim/state/WaterState.ts src/sim/utilities/WaterNetwork.ts src/sim/systems/ProductionSystem.ts src/sim/systems/LifeSupportSystem.ts src/sim/persistence/WaterPersistence.ts src/sim/persistence/migrations/v11.ts src/sim/host/protocol.ts src/sim/host/projection.ts src/sim/debug/SimulationAssertions.ts src/sim/debug/StateHash.ts
 * @desc Paid pipe topology, safe commissioning, isolated buffers, conservation,
 * brownouts, drinking/recycling, malformed saves and immutable host payloads.
 */
import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { WaterSystem as W } from '../../src/sim/systems/WaterSystem';
import { ProductionSystem as P } from '../../src/sim/systems/ProductionSystem';
import { LifeSupportSystem as L } from '../../src/sim/systems/LifeSupportSystem';
import { ComponentSystem } from '../../src/sim/systems/ComponentSystem';
import { restoreWater } from '../../src/sim/persistence/WaterPersistence';
import { waterPorts, pipeCost } from '../../src/sim/utilities/WaterNetwork';
import {
  assertInvariants,
  checkInvariants,
} from '../../src/sim/debug/SimulationAssertions';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { applyCommand, decodeCommand, projectView } from '../../src/sim/host';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  WATER_PUMP_KG_HOUR,
  SAVE_VERSION,
} from '../../src/sim/config';
import { ROVER_PARTS, ALL_COMPONENTS } from '../../src/sim/defs';
import { buildOnline } from '../fixtures/sim';
import { test, finish } from '../harness';

const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8, `${a} ≠ ${b}`);
function colony(active = true) {
  const sim = new Simulation({ seed: 813 });
  const workshop = buildOnline(sim, 'workshop');
  const extractor = buildOnline(sim, 'extractor');
  const consumer = buildOnline(sim, 'oxygenator');
  const pump = buildOnline(sim, 'pumpStation');
  const tank = buildOnline(sim, 'waterTank');
  pump.powerSat = 1;
  pump.loadKw = 6;
  ComponentSystem.store(sim.state, 'pipe', 100);
  for (const p of waterPorts(sim.buildings))
    if (p.id !== 0) assert.ok(sim.connectWater(0, p.id));
  if (active) assert.ok(sim.commissionWater());
  return { sim, workshop, extractor, consumer, pump, tank };
}
function empty(sim: Simulation) {
  for (const p of waterPorts(sim.buildings)) W.take(sim.state, p.id, 1e9);
}

test('pipes are counted Workshop output, never installed rover parts', () => {
  const { sim, workshop } = colony(false);
  assert.ok(ALL_COMPONENTS.includes('pipe'));
  assert.deepEqual(ROVER_PARTS, ['motor', 'circuitBoard']);
  sim.setBuildingRecipe(workshop.id, 2);
  sim.storage.steel = 10;
  sim.components.pipe = 0;
  P.runProcess(sim.state, workshop, 1, 0.25);
  near(workshop.craft.pipe, 0.5);
  assert.equal(sim.components.pipe, 0);
  P.runProcess(sim.state, workshop, 1, 0.25);
  assert.equal(sim.components.pipe, 1);
  near(sim.storage.steel, 9.5);
  assert.equal(Object.keys(sim.rovers[0].parts).length, 2);
});

test('connect charges distance once; invalid endpoints, duplicates and insufficient stock refuse', () => {
  const { sim, consumer } = colony(false);
  const before = sim.components.pipe;
  assert.equal(sim.connectWater(consumer.id, 0), false);
  assert.equal(sim.connectWater(0, 0), false);
  assert.equal(sim.connectWater(0, 999999), false);
  assert.equal(sim.components.pipe, before);
  const link = sim.state.water.links.find((l) => l.b === consumer.id)!;
  assert.equal(
    link.pipes,
    pipeCost(
      waterPorts(sim.buildings)[0],
      waterPorts(sim.buildings).find((p) => p.id === consumer.id)!,
    ),
  );
  assert.ok(sim.disconnectWater(0, consumer.id));
  assert.equal(sim.components.pipe, before + Math.floor(link.pipes / 2));
  sim.components.pipe = 0;
  assert.equal(sim.connectWater(0, consumer.id), false);
  consumer.x = 400;
  sim.components.pipe = 40;
  assert.equal(sim.connectWater(0, consumer.id), false);
});

test('commission is explicit, connected and powered, preserving every kg of reserve', () => {
  const { sim, pump, consumer } = colony(false);
  const before = sim.pools.amounts.water;
  assert.equal(sim.state.water.active, false);
  assert.equal(
    W.amount(sim.state, consumer.id),
    before,
    'bootstrap supply is still shared',
  );
  sim.disconnectWater(0, consumer.id);
  assert.equal(sim.commissionWater(), false);
  sim.connectWater(0, consumer.id);
  pump.powerSat = 0;
  assert.equal(sim.commissionWater(), false);
  pump.powerSat = 1;
  assert.ok(sim.commissionWater());
  near(sim.pools.amounts.water, before);
  near(
    Object.values(sim.state.water.tanks).reduce((s, n) => s + n, 0),
    before,
  );
  assert.ok(sim.commissionWater(), 'idempotent');
  assertInvariants(sim);
});

test('isolated consumers cannot drink aggregate storage; reconnect only helps when pumped', () => {
  const { sim, consumer, tank } = colony();
  empty(sim);
  W.add(sim.state, tank.id, 100);
  sim.disconnectWater(0, consumer.id);
  assert.equal(P.desiredThroughput(sim.state, consumer), 0);
  assert.equal(P.processBlockReason(sim.state, consumer), 'Not connected');
  W.tick(sim.state);
  assert.equal(W.amount(sim.state, consumer.id), 0);
  sim.connectWater(0, consumer.id);
  assert.equal(
    W.amount(sim.state, consumer.id),
    0,
    'laying a pipe does not teleport water',
  );
  for (let i = 0; i < 100; i++) W.tick(sim.state);
  assert.ok(W.amount(sim.state, consumer.id) > 0);
  near(sim.pools.amounts.water, 100);
  assert.ok(P.desiredThroughput(sim.state, consumer) > 0);
});

test('pump conservation, power scaling, signed paths and no cross-component transfer', () => {
  const { sim, tank, pump } = colony();
  empty(sim);
  W.add(sim.state, tank.id, 100);
  pump.powerSat = 0.5;
  W.tick(sim.state);
  const moved = 100 - W.amount(sim.state, tank.id);
  near(moved, WATER_PUMP_KG_HOUR * SIM_TICK * HOURS_PER_SEC * 0.5);
  near(sim.pools.amounts.water, 100);
  assert.ok(
    sim.waterNetwork.links.some((l) => l.flowKgHour < 0),
    'tank → pod is reverse of canonical endpoints',
  );
  pump.powerSat = 0;
  const tanks = { ...sim.state.water.tanks };
  W.tick(sim.state);
  assert.deepEqual(sim.state.water.tanks, tanks);
  assert.equal(sim.waterNetwork.nodes[0].status, 'No pump power');
  assert.ok(sim.waterNetwork.links.every((l) => l.flowKgHour === 0));
  pump.powerSat = 1;
  sim.disconnectWater(0, tank.id);
  const isolated = W.amount(sim.state, tank.id);
  for (let i = 0; i < 20; i++) W.tick(sim.state);
  near(W.amount(sim.state, tank.id), isolated);
});

test('off or damaged pumps cannot transfer, but stored local buffers remain usable', () => {
  const { sim, pump, consumer } = colony();
  pump.enabled = false;
  const before = W.amount(sim.state, consumer.id);
  W.tick(sim.state);
  near(W.amount(sim.state, consumer.id), before);
  assert.ok(W.take(sim.state, consumer.id, 1) > 0);
  pump.enabled = true;
  pump.damaged = true;
  sim.recomputeCapacities();
  const tanks = { ...sim.state.water.tanks };
  W.tick(sim.state);
  assert.deepEqual(sim.state.water.tanks, tanks);
  assertInvariants(sim);
});

test('extractors write local tanks and stall at local capacity, not global headroom', () => {
  const { sim, extractor } = colony();
  empty(sim);
  sim.storage.ice = 100;
  P.runProcess(sim.state, extractor, 1, 1);
  assert.ok(W.amount(sim.state, extractor.id) > 0);
  assert.equal(W.amount(sim.state, 0), 0);
  W.add(sim.state, extractor.id, 1e9);
  assert.equal(P.desiredThroughput(sim.state, extractor), 0);
  assert.match(P.processBlockReason(sim.state, extractor), /tanks full/);
  assertInvariants(sim);
});

test('indoor drinking and reclamation use the shelter buffer; EVA provisions debit the pod', () => {
  const { sim, tank } = colony();
  const hab = buildOnline(sim, 'habitat');
  sim.connectWater(0, hab.id);
  empty(sim);
  W.add(sim.state, tank.id, 50);
  sim.colonist.x = hab.x;
  sim.colonist.z = hab.z;
  const hooks = { endMission: () => {}, completeBuilding: () => {} };
  const health = sim.colonist.health;
  L.tick(sim.state, hooks);
  assert.ok(sim.colonist.health < health, 'remote water is not drunk');
  near(W.amount(sim.state, tank.id), 50);
  W.add(sim.state, hab.id, 5);
  L.tick(sim.state, hooks);
  assert.ok(W.amount(sim.state, hab.id) < 5);
  assert.ok(sim.state.flows.water.produced > 0, 'reclaims to the same habitat');
  sim.colonist.x = 200;
  sim.colonist.z = 200;
  W.add(sim.state, 0, 5);
  L.tick(sim.state, hooks);
  assert.ok(W.amount(sim.state, 0) < 5);
  near(W.amount(sim.state, tank.id), 50);
});

test('no water, not connected and no pump power are distinct', () => {
  const { sim, pump, consumer } = colony();
  empty(sim);
  assert.equal(P.processBlockReason(sim.state, consumer), 'No water');
  pump.powerSat = 0;
  assert.equal(P.processBlockReason(sim.state, consumer), 'No pump power');
  sim.disconnectWater(0, consumer.id);
  assert.equal(P.processBlockReason(sim.state, consumer), 'Not connected');
});

test('new buildings start empty; damage and demolition remove only their own stored water', () => {
  const { sim, tank } = colony();
  const extra = buildOnline(sim, 'waterTank');
  assert.equal(W.amount(sim.state, extra.id), 0);
  const total = sim.pools.amounts.water,
    lost = W.amount(sim.state, tank.id);
  tank.damaged = true;
  sim.recomputeCapacities();
  near(sim.pools.amounts.water, total - lost);
  tank.damaged = false;
  sim.recomputeCapacities();
  assert.equal(W.amount(sim.state, tank.id), 0);
  sim.demolish(tank.id);
  assert.ok(
    !sim.state.water.links.some((l) => l.a === tank.id || l.b === tank.id),
  );
  assertInvariants(sim);
});

test('v11 colonies retain shared reserves and receive no free manufactured pipes', () => {
  const { sim } = colony(false);
  const snap = sim.snapshot() as any;
  snap.version = 11;
  delete snap.water;
  delete snap.components.pipe;
  const restored = new Simulation({ seed: 1 });
  restored.restore(snap);
  assert.equal(restored.version, SAVE_VERSION);
  assert.equal(restored.state.water.active, false);
  near(restored.pools.amounts.water, snap.fluids.water);
  assert.equal(restored.components.pipe, 0);
});

test('saves own tanks/links; restore sanitizes malformed topology without creating water', () => {
  const { sim, consumer } = colony();
  const snap = sim.snapshot();
  assert.notEqual(snap.water!.tanks, sim.state.water.tanks);
  assert.notEqual(snap.water!.links[0], sim.state.water.links[0]);
  const restored = new Simulation({ seed: 1 });
  restored.restore(snap);
  assert.deepEqual(restored.state.water.tanks, sim.state.water.tanks);
  assert.deepEqual(restored.state.water.links, sim.state.water.links);
  const link = snap.water!.links[0];
  restoreWater(restored.state, {
    active: true,
    links: [
      link,
      link,
      { a: 0, b: 9999, pipes: 1 },
      { ...link, pipes: 9999 },
      null,
    ],
    tanks: { 0: 12, [consumer.id]: -2, 9999: 100 },
  });
  assert.equal(restored.state.water.links.length, 1);
  near(restored.pools.amounts.water, 12);
  assertInvariants(restored);
});

test('host commands validate IDs including pod zero; projected networks own nested data', () => {
  const { sim, consumer } = colony(false);
  assert.ok(decodeCommand({ type: 'water/connect', a: 0, b: consumer.id }).ok);
  assert.equal(
    decodeCommand({ type: 'water/connect', a: -1, b: consumer.id }).ok,
    false,
  );
  assert.equal(
    decodeCommand({ type: 'water/connect', a: 0.5, b: consumer.id }).ok,
    false,
  );
  assert.ok(applyCommand(sim, { type: 'water/commission' }).ok);
  const view = projectView(sim, 'in-process', {});
  const value = sim.state.water.links[0].pipes;
  (view.waterNetwork.links[0] as any).pipes = 999;
  (view.waterNetwork.nodes[0] as any).water = 999;
  assert.equal(sim.state.water.links[0].pipes, value);
  assert.notEqual(W.amount(sim.state, 0), 999);
});

test('water tanks/topology participate in hashing and invariants; flow readings do not', () => {
  const { sim } = colony();
  const hash = hashSimulation(sim);
  sim.state.water.flowKgHour['0:99'] = 123;
  assert.equal(hashSimulation(sim), hash);
  W.take(sim.state, 0, 1);
  assert.notEqual(hashSimulation(sim), hash);
  sim.pools.amounts.water += 1;
  assert.ok(checkInvariants(sim).some((v) => v.code === 'water-network'));
});

test('real powered ticks transport water and commissioned saves resume deterministically', () => {
  const { sim, extractor, consumer } = colony();
  for (let i = 0; i < 5; i++) buildOnline(sim, 'rtg');
  for (const r of sim.rovers) sim.stopRover(r.id);
  empty(sim);
  W.add(sim.state, extractor.id, 20);
  sim.storage.ice = 100;
  for (let i = 0; i < 100; i++) sim.step(SIM_TICK);
  assert.ok(W.amount(sim.state, consumer.id) > 0);
  assert.ok(sim.waterNetwork.links.some((l) => Math.abs(l.flowKgHour) > 0));
  const snap = sim.snapshot();
  const a = new Simulation({ seed: 1 }),
    b = new Simulation({ seed: 2 });
  a.restore(snap);
  b.restore(JSON.parse(JSON.stringify(snap)));
  for (let i = 0; i < 200; i++) {
    a.step(SIM_TICK);
    b.step(SIM_TICK);
  }
  assert.equal(hashSimulation(a), hashSimulation(b));
  assertInvariants(a);
  assertInvariants(b);
});

await finish('sim/water');
