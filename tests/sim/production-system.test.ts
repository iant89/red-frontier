/**
 * @suite sim/production-system
 * @group unit
 * @covers src/sim/systems/ProductionSystem.ts src/sim/defs.ts
 * @desc ProductionSystem extraction (Phase 8): the three answers PowerSystem
 * asks about a process — how hard it wants to run, why it is idle, and the
 * mass it moves when it runs. Missing inputs, full tanks, power shortage,
 * light-gated crops, upgrades, simultaneous lines, and deterministic replay.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ProductionSystem } from '../../src/sim/systems/ProductionSystem';
import { PowerSystem } from '../../src/sim/systems/PowerSystem';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { BUILDINGS } from '../../src/sim/defs';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  devLevelMul,
} from '../../src/sim/config';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const HOURS = SIM_TICK * HOURS_PER_SEC;

group('ProductionSystem.desiredThroughput — inputs and headroom');

test('an extractor with ice and tank room wants to run flat out', () => {
  const sim = new Simulation({ seed: 211 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 200;
  const want = ProductionSystem.desiredThroughput(sim.state, ext);
  assert.equal(want, 1, 'stocked and with headroom, want is 1');
});

test('missing ice zeros the want; the block reason names the input', () => {
  const sim = new Simulation({ seed: 212 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 0;
  assert.equal(ProductionSystem.desiredThroughput(sim.state, ext), 0);
  assert.equal(ProductionSystem.processBlockReason(sim.state, ext), 'Out of Water Ice');
});

test('full water tanks zero the want; the block reason names the tank', () => {
  const sim = new Simulation({ seed: 213 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 200;
  sim.pools.amounts.water = sim.pools.capacity.water;
  assert.equal(ProductionSystem.desiredThroughput(sim.state, ext), 0);
  assert.equal(ProductionSystem.processBlockReason(sim.state, ext), 'Water tanks full');
});

test('a partial silo scales want to the fraction of one tick the store can feed', () => {
  const sim = new Simulation({ seed: 214 });
  const ext = buildOnline(sim, 'extractor');
  const need = BUILDINGS.extractor.process!.solidIn!.ice! * HOURS; // one tick at rate 1
  sim.storage.ice = need * 0.4;
  const want = ProductionSystem.desiredThroughput(sim.state, ext);
  assert.ok(Math.abs(want - 0.4) < 1e-9, `want follows the remaining ice (got ${want})`);
});

group('ProductionSystem.runProcess — mass movement');

test('rate 1 completes the tick\'s conversion; rate 0 leaves the stores untouched', () => {
  const sim = new Simulation({ seed: 2150 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 80;
  const water0 = sim.pools.amounts.water;
  ProductionSystem.runProcess(sim.state, ext, 0, HOURS);
  assert.equal(sim.storage.ice, 80, 'a stalled line is a no-op');
  assert.equal(sim.pools.amounts.water, water0);
  ProductionSystem.runProcess(sim.state, ext, 1, HOURS);
  assert.ok(sim.storage.ice < 80 && sim.pools.amounts.water > water0, 'rate 1 actually moves mass');
});

test('one tick at rate 1 converts ice to water at the plate rates', () => {
  const sim = new Simulation({ seed: 215 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 100;
  const water0 = sim.pools.amounts.water;
  ProductionSystem.runProcess(sim.state, ext, 1, HOURS);
  const iceTaken = BUILDINGS.extractor.process!.solidIn!.ice! * HOURS;
  const waterMade = BUILDINGS.extractor.process!.fluidOut!.water! * HOURS;
  assert.ok(Math.abs(100 - sim.storage.ice - iceTaken) < 1e-9, 'ice leaves storage');
  assert.ok(Math.abs(sim.pools.amounts.water - water0 - waterMade) < 1e-9, 'water lands in the tank');
  assert.ok(Math.abs(sim.flows.water.produced - waterMade) < 1e-9, 'produced flow is accounted');
});

test('an oxygenator drinks water and emits oxygen; a greenhouse needs light', () => {
  const sim = new Simulation({ seed: 216 });
  const oxy = buildOnline(sim, 'oxygenator');
  const gh = buildOnline(sim, 'greenhouse');
  sim.pools.amounts.water = 50;
  const o2_0 = sim.pools.amounts.oxygen;
  ProductionSystem.runProcess(sim.state, oxy, 1, HOURS);
  const waterIn = BUILDINGS.oxygenator.process!.fluidIn!.water! * HOURS;
  const o2Out = BUILDINGS.oxygenator.process!.fluidOut!.oxygen! * HOURS;
  assert.ok(Math.abs(50 - sim.pools.amounts.water - waterIn) < 1e-9);
  assert.ok(Math.abs(sim.pools.amounts.oxygen - o2_0 - o2Out) < 1e-9);

  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  const noon = ProductionSystem.desiredThroughput(sim.state, gh);
  assert.equal(noon, 1, 'a clear noon sky is full light');

  sim.devSetTime(0, 0.95);
  const night = ProductionSystem.desiredThroughput(sim.state, gh);
  assert.ok(Math.abs(night - 0.15) < 1e-9, `crops crawl at 15% in the dark (got ${night})`);
  assert.equal(
    ProductionSystem.processBlockReason(sim.state, gh),
    'Waiting for daylight',
    'the idle copy names the sky, not the tanks',
  );
});

test('a developer upgrade multiplies both the want-gate and the converted mass', () => {
  const sim = new Simulation({ seed: 217 });
  const ext = buildOnline(sim, 'extractor');
  sim.devSetBuildingLevel(ext.id, 3);
  const mul = devLevelMul(3);
  assert.ok(mul > 1);
  sim.storage.ice = 400;
  const want = ProductionSystem.desiredThroughput(sim.state, ext);
  assert.equal(want, 1, 'a stocked upgraded line still wants 1');
  const ice0 = sim.storage.ice;
  ProductionSystem.runProcess(sim.state, ext, 1, HOURS);
  const iceTaken = BUILDINGS.extractor.process!.solidIn!.ice! * mul * HOURS;
  assert.ok(Math.abs(ice0 - sim.storage.ice - iceTaken) < 1e-9, 'upgrade multiplies the take');
});

group('ProductionSystem — power shortage and simultaneous processes');

test('a night brownout thins throughput; mass moved follows want × satisfaction', () => {
  const sim = new Simulation({ seed: 218 });
  buildOnline(sim, 'warehouse');
  const ext = buildOnline(sim, 'extractor');
  const oxy = buildOnline(sim, 'oxygenator');
  sim.storage.ice = 400;
  sim.devSetTime(0, 0.95);
  sim.state.storedKWh = 0;
  sim.state.dustTransmission = 1;

  const ice0 = sim.storage.ice;
  const water0 = sim.pools.amounts.water;
  PowerSystem.tick(sim.state, {
    desiredThroughput: (b) => ProductionSystem.desiredThroughput(sim.state, b),
    runProcess: (b, t, h) => ProductionSystem.runProcess(sim.state, b, t, h),
    processBlockReason: (b) => ProductionSystem.processBlockReason(sim.state, b),
  });

  assert.ok(sim.power.brownout, 'precondition: the RTG cannot cover both lines');
  assert.ok(ext.powerSat < 1 && ext.powerSat > 0, 'tier 1 is thinned, not shed');
  assert.ok(Math.abs(ext.throughput - ext.powerSat) < 1e-9, 'throughput is want × sat');
  const iceTaken = BUILDINGS.extractor.process!.solidIn!.ice! * ext.throughput * HOURS;
  assert.ok(
    Math.abs(ice0 - sim.storage.ice - iceTaken) < 1e-9,
    'the extractor moved mass at the shed fraction',
  );
  assert.ok(sim.pools.amounts.water !== water0 || oxy.throughput > 0, 'something ran');
  assert.equal(oxy.powerSat, ext.powerSat, 'both tier-1 lines share the hit evenly');
});

test('two stocked lines convert in the same tick without stealing each other\'s inputs unfairly', () => {
  const sim = new Simulation({ seed: 219 });
  const panel = buildOnline(sim, 'solar');
  const ext = buildOnline(sim, 'extractor');
  const oxy = buildOnline(sim, 'oxygenator');
  sim.storage.ice = 400;
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  sim.devSetBuildingCleanliness(panel.id, 1);

  const ice0 = sim.storage.ice;
  const o2_0 = sim.pools.amounts.oxygen;
  const water0 = sim.pools.amounts.water;
  PowerSystem.tick(sim.state, {
    desiredThroughput: (b) => ProductionSystem.desiredThroughput(sim.state, b),
    runProcess: (b, t, h) => ProductionSystem.runProcess(sim.state, b, t, h),
    processBlockReason: (b) => ProductionSystem.processBlockReason(sim.state, b),
  });

  const iceTaken = BUILDINGS.extractor.process!.solidIn!.ice! * HOURS;
  const waterMade = BUILDINGS.extractor.process!.fluidOut!.water! * HOURS;
  const waterIn = BUILDINGS.oxygenator.process!.fluidIn!.water! * HOURS;
  const o2Made = BUILDINGS.oxygenator.process!.fluidOut!.oxygen! * HOURS;
  assert.equal(ext.throughput, 1, 'extractor ran at 1');
  assert.equal(oxy.throughput, 1, 'oxygenator ran at 1');
  assert.ok(Math.abs(ice0 - sim.storage.ice - iceTaken) < 1e-9, 'extractor ice take');
  assert.ok(
    Math.abs(sim.pools.amounts.water - (water0 + waterMade - waterIn)) < 1e-9,
    'water is made then drunk in the same tick',
  );
  assert.ok(Math.abs(sim.pools.amounts.oxygen - o2_0 - o2Made) < 1e-9, 'oxygen at plate rate');
});

group('ProductionSystem — idle reasons through the live wiring');

test('PowerSystem asks the domain why only when power is fine', () => {
  const sim = new Simulation({ seed: 220 });
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 0;
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  sim.step(1 / 20);
  assert.equal(ext.idleReason, 'Out of Water Ice', 'a powered, empty extractor confesses the input');

  sim.storage.ice = 200;
  sim.devSetBuildingDamaged(ext.id, true);
  sim.step(1 / 20);
  assert.equal(ext.idleReason, 'Damaged — needs repair');
  assert.equal(ext.throughput, 0);

  sim.devSetBuildingDamaged(ext.id, false);
  sim.setBuildingEnabled(ext.id, false);
  sim.step(1 / 20);
  assert.equal(ext.idleReason, 'Switched off');
  assert.equal(ext.throughput, 0);
});

group('ProductionSystem — determinism');

test('same seed, same stores: two colonies convert identically', () => {
  const build = (seed: number) => {
    const sim = new Simulation({ seed });
    buildOnline(sim, 'warehouse');
    buildOnline(sim, 'solar');
    buildOnline(sim, 'extractor');
    buildOnline(sim, 'oxygenator');
    sim.storage.ice = 350;
    sim.devSetTime(0, 0.45);
    for (const r of sim.rovers) r.rules.autoHaul = false;
    return sim;
  };
  const a = build(221);
  const b = build(221);
  run(a, 0.3);
  run(b, 0.3);
  assert.equal(hashSimulation(a), hashSimulation(b), 'the chain replayed');
  assert.ok(a.storage.ice < 350, 'precondition: ice actually moved');
  assert.ok(a.pools.amounts.oxygen > 12, 'precondition: oxygen was made');
});

await finish('sim/production-system');
