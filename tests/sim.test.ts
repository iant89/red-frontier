/**
 * Headless simulation tests.
 *
 * The simulation has no DOM or three.js dependency, so it runs straight in
 * Node. These cover TDD §21's four categories: unit (formulas), integration
 * (cross-system chains), determinism, and save round-trips.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation';
import type { BuildingKind } from '../src/sim/defs';
import { BUILDINGS, ALL_RESOURCES, ROVERS } from '../src/sim/defs';
import { resolvePower } from '../src/sim/power';
import { sunFor, SolClock } from '../src/sim/clock';
import { Weather } from '../src/sim/weather';
import { SOL_SECONDS, SUIT_O2_CAPACITY, POD_BATTERY_KWH, SAVE_VERSION } from '../src/sim/config';

let pass = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✘ ${name}`);
    console.log(`      ${(err as Error).message.split('\n')[0]}`);
  }
}

function group(name: string): void {
  console.log(`\n${name}`);
}

function nearDeposit(sim: Simulation, res: string) {
  return sim.world.deposits
    .filter((d) => d.resource === res && d.amount > 0)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
}

/** Advance `sols` of simulated time at the fixed step. */
function run(sim: Simulation, sols: number): void {
  const ticks = Math.round(20 * SOL_SECONDS * sols);
  for (let i = 0; i < ticks; i++) sim.step(1 / 20);
}

/** First spot on a ring around the base where `kind` may legally be placed. */
function findSpot(sim: Simulation, kind: BuildingKind): { x: number; z: number } {
  for (let r = 34; r <= 120; r += 3) {
    for (let a = 0; a < 360; a += 7) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      if (sim.canPlace(kind, x, z) === null) return { x, z };
    }
  }
  throw new Error(`no legal placement found for ${kind}`);
}

function build(sim: Simulation, kind: BuildingKind) {
  const spot = findSpot(sim, kind);
  const b = sim.placeBuilding(kind, spot.x, spot.z);
  assert.ok(b, `${kind} placement failed`);
  return b!;
}

/** Place a building and fast-forward until it is online (or give up). */
function buildAndWait(sim: Simulation, kind: BuildingKind, maxSols = 25) {
  const b = build(sim, kind);
  for (let i = 0; i < maxSols * 4; i++) {
    run(sim, 0.25);
    if (sim.buildingById(b.id)?.state === 'online') return b;
  }
  throw new Error(`${kind} never came online within ${maxSols} sols`);
}

// =========================================================== unit: power ====
group('Power network');

test('generation is spent before storage, surplus charges the pack', () => {
  const r = resolvePower(100, [{ id: 1, tier: 0, kw: 40 }], 50, 200, 1);
  assert.equal(r.servedKw, 40);
  assert.equal(r.batteryFlowKw, 60, 'surplus should charge');
  assert.equal(r.storedKWh, 110);
  assert.equal(r.brownout, false);
});

test('storage covers a deficit and discharges', () => {
  const r = resolvePower(10, [{ id: 1, tier: 0, kw: 30 }], 50, 200, 1);
  assert.equal(r.servedKw, 30);
  assert.equal(r.batteryFlowKw, -20);
  assert.equal(r.storedKWh, 30);
  assert.equal(r.brownout, false, 'covered by battery is not a brownout');
});

test('load is shed from the lowest priority tier upward', () => {
  const r = resolvePower(
    30,
    [
      { id: 1, tier: 0, kw: 20 },
      { id: 2, tier: 2, kw: 20 },
      { id: 3, tier: 3, kw: 20 },
    ],
    0,
    0,
    1,
  );
  assert.equal(r.tierSatisfaction[0], 1, 'tier 0 must be fully served');
  assert.equal(r.tierSatisfaction[2], 0.5, 'tier 2 takes the partial hit');
  assert.equal(r.tierSatisfaction[3], 0, 'tier 3 is shed entirely');
  assert.equal(r.firstShedTier, 2);
  assert.ok(r.brownout);
});

test('consumers within a tier degrade evenly, not arbitrarily', () => {
  const r = resolvePower(
    10,
    [
      { id: 1, tier: 1, kw: 10 },
      { id: 2, tier: 1, kw: 10 },
    ],
    0,
    0,
    1,
  );
  assert.equal(r.satisfaction.get(1), 0.5);
  assert.equal(r.satisfaction.get(2), 0.5);
});

test('generation with nowhere to go is reported as curtailed', () => {
  const r = resolvePower(100, [], 200, 200, 1);
  assert.equal(r.curtailedKw, 100);
  assert.equal(r.batteryFlowKw, 0);
});

test('energy is conserved across a tick', () => {
  const stored = 80;
  const r = resolvePower(25, [{ id: 1, tier: 0, kw: 40 }], stored, 200, 0.5);
  const deltaStored = r.storedKWh - stored;
  const generated = 25 * 0.5;
  const served = r.servedKw * 0.5;
  assert.ok(
    Math.abs(generated - served - deltaStored - r.curtailedKw * 0.5) < 1e-9,
    'generation must equal load + storage delta + curtailment',
  );
});

// ============================================================ unit: clock ====
group('Sol clock & sun');

test('the sun is up between sunrise and sunset only', () => {
  assert.equal(sunFor(0.1).isDay, false, 'pre-dawn');
  assert.equal(sunFor(0.5).isDay, true, 'noon');
  assert.equal(sunFor(0.9).isDay, false, 'night');
  assert.equal(sunFor(0.1).irradiance, 0, 'no light before dawn');
  assert.ok(sunFor(0.5).irradiance > 0.9, 'near-peak light at noon');
});

test('irradiance peaks at local noon and is symmetric around it', () => {
  const before = sunFor(0.4).irradiance;
  const after = sunFor(0.6).irradiance;
  assert.ok(Math.abs(before - after) < 1e-9, 'morning and afternoon should mirror');
  assert.ok(sunFor(0.5).irradiance > before);
});

test('the clock rolls over into a new sol', () => {
  const c = new SolClock();
  c.frac = 0.99;
  const rolled = c.advance(0.02 * SOL_SECONDS);
  assert.ok(rolled);
  assert.equal(c.sol, 1);
  assert.ok(c.frac < 0.02);
});

// ================================================= integration: survival ====
group('Life support chain');

test('the colonist consumes oxygen, water and food from the pod', () => {
  const sim = new Simulation({ seed: 11 });
  const before = { ...sim.pools.amounts };
  run(sim, 1);
  assert.ok(sim.pools.amounts.oxygen < before.oxygen, 'oxygen should fall');
  assert.ok(sim.pools.amounts.water < before.water, 'water should fall');
  assert.ok(sim.pools.amounts.food < before.food, 'food should fall');
  assert.equal(sim.colonist.health, 100, 'a supplied colonist stays healthy');
});

test('an unsupplied colonist dies and ends the mission', () => {
  const sim = new Simulation({ seed: 12 });
  sim.pools.amounts.oxygen = 0;
  sim.pools.amounts.water = 0;
  sim.pools.amounts.food = 0;
  sim.colonist.suitO2 = 0;
  run(sim, 3);
  assert.ok(sim.colonist.dead, 'colonist should have died');
  assert.ok(sim.gameOver, 'mission should be over');
});

test('oxygen kills far faster than food — the build order depends on it', () => {
  const noO2 = new Simulation({ seed: 13 });
  noO2.pools.amounts.oxygen = 0;
  noO2.colonist.suitO2 = 0;
  run(noO2, 0.5);

  const noFood = new Simulation({ seed: 13 });
  noFood.pools.amounts.food = 0;
  run(noFood, 0.5);

  assert.ok(
    noO2.colonist.health < noFood.colonist.health,
    'losing oxygen must hurt more than losing food',
  );
});

test('the ice → water → oxygen chain actually produces oxygen', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  buildAndWait(sim, 'extractor');

  const waterBefore = sim.pools.amounts.water;
  run(sim, 3);
  assert.ok(
    sim.pools.amounts.water > waterBefore,
    `extractor should make water (${waterBefore.toFixed(1)} → ${sim.pools.amounts.water.toFixed(1)})`,
  );

  buildAndWait(sim, 'oxygenator');
  const o2Before = sim.pools.amounts.oxygen;
  run(sim, 4);
  assert.ok(
    sim.pools.amounts.oxygen > o2Before,
    `oxygenator should make O₂ (${o2Before.toFixed(1)} → ${sim.pools.amounts.oxygen.toFixed(1)})`,
  );
  assert.ok(!sim.gameOver, 'colony should still be alive');
});

test('a full colony survives 20 sols of live operation', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  for (const k of ['warehouse', 'solar', 'battery', 'extractor', 'oxygenator'] as BuildingKind[]) {
    buildAndWait(sim, k);
  }
  buildAndWait(sim, 'greenhouse', 30);
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  // Twenty sols of days, nights, storms, hauling and wear — with the asserts
  // kept to what live operation can promise: survival and health. Whether the
  // food loop itself closes is measured deterministically below, not sampled
  // from the middle of the logistics lottery.
  run(sim, 20);

  assert.ok(!sim.gameOver, 'the colony should survive');
  assert.ok(sim.colonist.health > 90, `colonist should be healthy, was ${sim.colonist.health}`);
  assert.ok(sim.pools.amounts.food > 0, 'the colony should not be starving');
});

test('the greenhouse closes the food loop under stable conditions', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  for (const k of ['warehouse', 'solar', 'battery', 'extractor', 'oxygenator'] as BuildingKind[]) {
    buildAndWait(sim, k);
  }
  buildAndWait(sim, 'greenhouse', 30);
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');

  // Freeze the logistics layer: charged, idle rovers with no standing orders
  // draw no charge power, so the grid holds steady instead of swinging with
  // the recharge cycle. Calm skies keep the arrays healthy and unstormed.
  // Three sols needs ~100 kg of ice, well within the stockpiled buffer.
  for (const rv of sim.rovers) {
    rv.battery = ROVERS[rv.kind].maxBatteryKWh;
    sim.stopRover(rv.id);
    sim.setRoverRule(rv.id, 'autoHaul', false);
    sim.setRoverRule(rv.id, 'stormShelter', false);
  }
  const wx = sim.weather as unknown as {
    active: unknown;
    scheduled: unknown;
    stormIntensity: number;
    storm: string;
  };
  wx.active = null;
  wx.scheduled = null;
  wx.stormIntensity = 0;
  wx.storm = 'calm';
  sim.weather.debugSuppressRolls();
  // Hauling is another suite's subject; this one needs ice on hand, so stock
  // the silo directly (three sols burn ~100 kg).
  sim.storage.ice = 500;

  run(sim, 3);

  assert.ok(!sim.gameOver, 'the colony should survive');
  for (const f of ['water', 'oxygen', 'food'] as const) {
    assert.ok(
      sim.netRatePerSol(f) > 0,
      `the loop should gain ${f}, net ${sim.netRatePerSol(f).toFixed(2)} kg/sol`,
    );
  }
});

test('a greenhouse slows down at night and speeds up by day', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  for (const k of ['warehouse', 'solar', 'battery', 'extractor'] as BuildingKind[]) {
    buildAndWait(sim, k);
  }
  const g = buildAndWait(sim, 'greenhouse', 30);

  // Sample throughput at noon and at midnight.
  const at = (frac: number) => {
    sim.clock.frac = frac;
    sim.step(1 / 20);
    return sim.buildingById(g.id)!.throughput;
  };
  const noon = at(0.5);
  const night = at(0.0);
  assert.ok(noon > night, `crops should grow faster in daylight (${noon} vs ${night})`);
});

// ================================================== integration: economy ====
group('Construction & logistics');

test('materials flow into a site without a rover parked on it', () => {
  const sim = new Simulation({ seed: 3, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = 300;
  const b = build(sim, 'warehouse');
  sim.step(1 / 20);
  const site = sim.buildingById(b.id)!;
  let remaining = 0;
  for (const r of ALL_RESOURCES) remaining += site.remainingCost[r];
  assert.equal(remaining, 0, 'a stocked site should absorb its materials immediately');
});

test('a warehouse can be built and increases storage capacity', () => {
  const sim = new Simulation({ seed: 3, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = 300;
  const baseCap = sim.storageCapacity();
  buildAndWait(sim, 'warehouse');
  assert.ok(sim.storageCapacity() > baseCap, 'storage capacity did not grow');
});

test('cancelling a site refunds the materials already delivered', () => {
  const sim = new Simulation({ seed: 4, nearDeposits: 0.18 });
  for (const r of ALL_RESOURCES) sim.storage[r] = sim.storageCapacity();
  const before = sim.storageTotal();
  const b = build(sim, 'warehouse');
  sim.step(1 / 20); // materials get committed
  assert.ok(sim.storageTotal() < before, 'materials should have left storage');
  sim.demolish(b.id);
  assert.ok(
    Math.abs(sim.storageTotal() - before) < 1,
    'cancelling should return the delivered materials',
  );
});

test('rovers automatically fetch what the build queue is short of', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  build(sim, 'warehouse');
  run(sim, 2);
  assert.ok(
    sim.storage.regolith > 0 || sim.storage.iron > 0,
    'idle rovers should have hauled something toward the site',
  );
});

test('mining extracts ore into colony storage', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.18 });
  const dep = nearDeposit(sim, 'iron')!;
  sim.issueMine(sim.rovers[0].id, dep.id);
  const before = dep.amount;
  run(sim, 2);
  assert.ok(dep.amount < before, 'the deposit should have been worked');
  assert.ok(sim.storage.iron > 0, 'iron should have reached storage');
});

test('storage is bounded per resource, and one full silo does not block others', () => {
  const sim = new Simulation({ seed: 5, nearDeposits: 0.18 });
  sim.storage.regolith = 1e9;
  sim.recomputeCapacities();
  assert.equal(sim.storageRoom('regolith'), 0, 'regolith silo should be full');
  assert.ok(sim.storageRoom('iron') > 0, 'a full regolith silo must not block iron');
  assert.ok(!sim.storageFull(), 'the colony is not full while any silo has room');
});

// ========================================================== power in situ ====
group('Grid behaviour in a live colony');

test('solar output tracks the sun across a sol', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  const s = buildAndWait(sim, 'solar');

  sim.clock.frac = 0.5;
  sim.step(1 / 20);
  const noon = sim.buildingById(s.id)!.genKw;

  sim.clock.frac = 0.0;
  sim.step(1 / 20);
  const midnight = sim.buildingById(s.id)!.genKw;

  assert.ok(noon > 10, `solar should produce at noon, got ${noon.toFixed(1)} kW`);
  assert.equal(midnight, 0, 'solar must produce nothing at midnight');
});

test('batteries charge by day and discharge by night', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  buildAndWait(sim, 'extractor');

  sim.storage.ice = 500; // keep the extractor genuinely loaded

  // Daylight: with solar up, the pack should gain charge.
  sim.storedKWh = sim.batteryCapacity() * 0.5;
  sim.clock.frac = 0.45;
  const dayStart = sim.storedKWh;
  run(sim, 0.05);
  const dayEnd = sim.storedKWh;
  assert.ok(
    dayEnd > dayStart,
    `batteries should charge in daylight (${dayStart.toFixed(0)} → ${dayEnd.toFixed(0)})`,
  );

  // Darkness: solar is zero, so the same loads must come out of storage.
  sim.storedKWh = sim.batteryCapacity() * 0.5;
  sim.clock.frac = 0.95;
  const nightStart = sim.storedKWh;
  run(sim, 0.05);
  assert.ok(
    sim.storedKWh < nightStart,
    `batteries should drain after dark (${nightStart.toFixed(0)} → ${sim.storedKWh.toFixed(0)})`,
  );
});

test('a rover charging at noon leaves surplus for the batteries', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');

  // Freeze the sky: clear any storm in progress and roll no new ones, so the
  // measurement below is about the grid, not the weather.
  const wx = sim.weather as any;
  wx.active = null;
  wx.scheduled = null;
  sim.weather.debugSuppressRolls();
  sim.weather.dust = 0.08;

  // One rover on the charger with a flat pack; the other parked out of it.
  const charger = sim.rovers[0];
  charger.x = 2;
  charger.z = 2;
  charger.battery = 5;
  charger.recharge = true;
  charger.command = { type: 'idle' };
  charger.pending = [];
  sim.issueWait(sim.rovers[1].id, 100000);

  sim.storedKWh = sim.batteryCapacity() * 0.5;
  sim.clock.frac = 0.45;
  const before = sim.storedKWh;
  run(sim, 0.02);
  assert.ok(
    sim.storedKWh > before,
    `daytime charging must not eat the whole surplus (${before.toFixed(0)} → ${sim.storedKWh.toFixed(0)} kWh)`,
  );
  assert.equal(sim.power.brownout, false, 'nothing should shed while the sun is up');
});

test('switching a building off removes its load from the grid', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  const ext = buildAndWait(sim, 'extractor');
  sim.storage.ice = 200;
  sim.clock.frac = 0.5;
  sim.step(1 / 20);
  const loaded = sim.power.demandKw;
  sim.setBuildingEnabled(ext.id, false);
  sim.step(1 / 20);
  assert.ok(sim.power.demandKw < loaded, 'demand should drop when a building is switched off');
});

test('the pod alone keeps the colonist breathing on Sol 1', () => {
  const sim = new Simulation({ seed: 21 });
  run(sim, 2);
  assert.ok(!sim.gameOver, 'the landing pod should sustain the crew initially');
  assert.ok(sim.power.generationKw > 0, 'the pod RTG always generates');
  assert.equal(sim.power.brownout, false, 'the pod should cover its own life support');
});

// ============================================================= colonist ====
group('The colonist');

test('an EVA beyond suit range is refused rather than fatal', () => {
  const sim = new Simulation({ seed: 30 });
  sim.orderColonist({ type: 'moveTo', x: 300, z: 300 });
  assert.equal(sim.colonist.order.type, 'shelter', 'a suicidal EVA should be refused');
});

test('walking outside burns suit oxygen; returning inside refills it', () => {
  const sim = new Simulation({ seed: 31 });
  sim.orderColonist({ type: 'moveTo', x: 26, z: 26 });
  run(sim, 0.05);
  assert.ok(!sim.colonist.inside, 'colonist should be on EVA');
  assert.ok(sim.colonist.suitO2 < SUIT_O2_CAPACITY, 'suit reserve should be depleting');

  sim.orderColonist({ type: 'shelter' });
  run(sim, 3);
  assert.ok(sim.colonist.inside, 'colonist should have returned to shelter');
  assert.ok(sim.colonist.suitO2 > SUIT_O2_CAPACITY * 0.9, 'suit should refill indoors');
});

test('a critically low suit aborts the EVA automatically', () => {
  const sim = new Simulation({ seed: 32 });
  sim.orderColonist({ type: 'moveTo', x: 26, z: 26 });
  run(sim, 0.05);
  sim.colonist.suitO2 = SUIT_O2_CAPACITY * 0.1;
  sim.step(1 / 20);
  assert.equal(sim.colonist.order.type, 'shelter', 'the sim should abort the EVA');
});

// ============================================================== alerts ====
group('Alerts');

test('a condition raises once and clears once, without spamming the log', () => {
  const sim = new Simulation({ seed: 41 });
  sim.pools.amounts.oxygen = 0.01;
  run(sim, 0.3);
  const raised = sim.alerts.list().filter((a) => a.key === 'oxygen-low');
  assert.equal(raised.length, 1, 'exactly one active oxygen alert');
  const lines = sim.alerts.history().filter((l) => l.text.includes('Oxygen'));
  assert.ok(lines.length <= 3, `log should not spam, got ${lines.length} lines`);
});

test('alerts clear when the condition resolves', () => {
  const sim = new Simulation({ seed: 42 });
  sim.pools.amounts.water = 0.01;
  run(sim, 0.2);
  assert.ok(sim.alerts.isActive('water-low'));
  sim.pools.amounts.water = sim.pools.capacity.water;
  run(sim, 0.2);
  assert.ok(!sim.alerts.isActive('water-low'), 'refilling should clear the alert');
});

// ============================================================= weather ====
group('Weather & storms');

test('clear-sky transmission is near 1 and falls as dust fills the air', () => {
  const wx = new Weather(7);
  const clear = new Weather(7);
  // Run both through calm weather.
  for (let i = 0; i < 20 * 60; i++) wx.tick(1 / 20, i / 20, 3);
  assert.ok(wx.solarTransmission > 0.9, `calm sol should transmit most light, got ${wx.solarTransmission.toFixed(2)}`);
  assert.ok(wx.visibility > 0.8, 'calm sol should be clearly visible');

  // Crank the dust up manually and watch the reading degrade.
  clear.dust = 0.8;
  // transmission recomputes on tick
  clear.tick(1 / 20, 0, 3);
  assert.ok(clear.solarTransmission < 0.6, 'heavy dust must cut solar transmission hard');
  assert.ok(clear.visibility < 0.25, 'heavy dust must kill visibility');
});

test('a storm is forecast before it arrives and follows its forecast schedule', () => {
  const sim = new Simulation({ seed: 5 });
  const t0 = sim.simTime;
  sim.weather.debugScheduleStorm('regional', t0, 60);
  // Mid-forecast: announced, but not yet blowing.
  sim.step(1 / 20);
  assert.ok(sim.weather.forecast(), 'the storm should be on the forecast board');
  assert.ok(sim.alerts.isActive('storm-inbound'), 'forecast should raise an alert');
  assert.equal(sim.weather.stormIntensity, 0, 'no wind before arrival');

  run(sim, 60 / SOL_SECONDS + 0.1);
  assert.ok(!sim.weather.forecast(), 'forecast clears on arrival');
  assert.ok(sim.weather.current(), 'the storm should now be active');
  assert.ok(sim.weather.stormIntensity > 0, 'winds picked up');
  // The envelope is finite: the storm fully passes.
  run(sim, 350 / SOL_SECONDS);
  assert.ok(!sim.weather.current(), 'the storm should pass');
  assert.equal(sim.weather.stormIntensity, 0);
});

test('a storm cuts solar output at the same time of sol', () => {
  const clear = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const dusty = new Simulation({ seed: 11, nearDeposits: 0.2 });
  for (const s of [clear, dusty]) buildAndWait(s, 'solar');
  for (const s of [clear, dusty]) {
    s.clock.frac = 0.5; // local noon in both worlds
    s.step(1 / 20);
  }
  const clearGen = clear.buildings.find((b) => b.kind === 'solar')!.genKw;
  // Drop the same world into a storm and re-measure at the same sun position.
  dusty.weather.debugScheduleStorm('regional', dusty.simTime, 0);
  run(dusty, 0.5);
  dusty.clock.frac = 0.5;
  dusty.step(1 / 20);
  const dustyGen = dusty.buildings.find((b) => b.kind === 'solar')!.genKw;
  assert.ok(
    dustyGen < clearGen * 0.75,
    `storm should slash solar (${dustyGen.toFixed(1)} kW vs ${clearGen.toFixed(1)} kW clear)`,
  );
});

test('dust buries panels over a storm, and a rover scrubbing them restores output', () => {
  const sim = new Simulation({ seed: 13, nearDeposits: 0.2 });
  const panel = buildAndWait(sim, 'solar');
  assert.ok(panel.cleanliness > 0.9, 'a fresh array should be nearly clean');
  // Only the forced storm may interfere — this tests the storm/repair loop,
  // not seed 13's particular storm calendar.
  sim.weather.debugSuppressRolls();

  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  run(sim, 170 / SOL_SECONDS); // mid-storm: dust thick, crews sheltering
  const dirtyLevel = panel.cleanliness;
  assert.ok(dirtyLevel < 0.9, `a storm should dirty the array (${dirtyLevel.toFixed(2)})`);

  // Ride out the storm, then dispatch a clean; a rover scrubs it back.
  run(sim, 180 / SOL_SECONDS);
  const rover = sim.rovers[0];
  assert.ok(sim.issueClean(rover.id, panel.id), 'clean should be dispatchable after the storm');
  // Watch for the scrub to land (then ambient dust starts re-dirtying, so
  // sample for the peak rather than reading one late instant).
  let peak = panel.cleanliness;
  for (let i = 0; i < 12; i++) {
    run(sim, 0.5 / 12);
    peak = Math.max(peak, panel.cleanliness);
    if (peak > 0.995) break;
  }
  assert.ok(
    peak > 0.995 && peak > dirtyLevel + 0.15,
    `the rover should have scrubbed the array back (${dirtyLevel.toFixed(2)} → peak ${peak.toFixed(3)})`,
  );
});

test('idle rovers clean badly dusted arrays on their own', () => {
  const sim = new Simulation({ seed: 17, nearDeposits: 0.2 });
  const panel = buildAndWait(sim, 'solar');
  panel.cleanliness = 0.4;
  run(sim, 1);
  assert.ok(panel.cleanliness > 0.9, `auto-clean should have visited the array (${panel.cleanliness.toFixed(2)})`);
});

test('storm damage bruises exposed structures and trips the most battered offline', () => {
  const sim = new Simulation({ seed: 19, nearDeposits: 0.2 });
  const panel = buildAndWait(sim, 'solar');
  const habitat = buildAndWait(sim, 'habitat');
  sim.weather.debugSuppressRolls();

  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  // Ride the storm out in slices, remembering the worst of it: rovers start
  // repairing during the storm's dying tail, so a single late sample misses.
  let minPanel = 100;
  let minHabitat = 100;
  let tripped = false;
  for (let i = 0; i < 20; i++) {
    run(sim, 430 / SOL_SECONDS / 20);
    minPanel = Math.min(minPanel, panel.health);
    minHabitat = Math.min(minHabitat, habitat.health);
    tripped = tripped || panel.damaged;
  }
  assert.ok(minPanel < 45, `a severe storm must batter an exposed array (worst health ${minPanel.toFixed(1)})`);
  assert.ok(
    tripped,
    'a severe storm should trip the exposed array below the health floor',
  );
  assert.ok(
    minHabitat > minPanel + 5,
    `the hardened habitat must fare better than the exposed array (${minHabitat.toFixed(1)} vs ${minPanel.toFixed(1)})`,
  );
  assert.ok(minHabitat < 100, 'even the habitat should feel a severe storm');

  // And the colony heals itself: its own rovers repair without being asked.
  run(sim, 3);
  assert.ok(!panel.damaged && !habitat.damaged, 'damaged structures should be repaired');
  assert.ok(panel.health > 90, `repair should have restored the array (${panel.health.toFixed(1)})`);
});

test('rovers run for shelter in a storm and resume their job after it passes', () => {
  const sim = new Simulation({ seed: 23, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const rover = sim.rovers[0];
  const dep = nearDeposit(sim, 'regolith')!;
  sim.issueMine(rover.id, dep.id);
  run(sim, 0.2); // get it out of the landing zone
  assert.ok(Math.hypot(rover.x, rover.z) > 15, 'rover should be out in the field');

  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.ok(sim.weather.shelterRovers(), 'the storm should be past the shelter threshold');
  assert.ok(rover.sheltered, 'the rover should be sheltering');
  assert.ok(
    rover.goal === 'toCharge' || rover.goal === 'charge',
    `the rover should head for shelter (${rover.goal})`,
  );
  const stillMining = rover.command.type === 'mine';
  assert.ok(stillMining, 'the original order must be preserved underneath the recall');

  run(sim, 350 / SOL_SECONDS); // let the storm die
  assert.ok(!rover.sheltered, 'the rover should be released after the storm');
  assert.equal(rover.command.type, 'mine', 'and it should resume what it was doing');
});

test('a storm refuses new EVAs and recalls anyone already outside', () => {
  const sim = new Simulation({ seed: 29 });
  sim.weather.debugSuppressRolls();
  sim.orderColonist({ type: 'moveTo', x: 26, z: 26 });
  run(sim, 0.05);
  assert.ok(!sim.colonist.inside, 'colonist should be outside first');

  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.equal(sim.colonist.order.type, 'shelter', 'the colonist must be recalled');

  // And while it blows, no new EVA is granted.
  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 60 / SOL_SECONDS);
  const before = sim.colonist.order;
  sim.orderColonist({ type: 'moveTo', x: 30, z: 30 });
  assert.equal(sim.colonist.order, before, 'EVA orders must be refused mid-storm');
});

test('weather is deterministic for a given seed', () => {
  const a = new Simulation({ seed: 31 });
  const b = new Simulation({ seed: 31 });
  a.weather.debugScheduleStorm('regional', 10, 5);
  b.weather.debugScheduleStorm('regional', 10, 5);
  run(a, 3);
  run(b, 3);
  assert.equal(
    JSON.stringify(a.weather.snapshot()),
    JSON.stringify(b.weather.snapshot()),
    'weather diverged between identical runs',
  );
});

test('the storm survives a save / restore round-trip and continues identically', () => {
  const sim = new Simulation({ seed: 37, nearDeposits: 0.2 });
  const panel = buildAndWait(sim, 'solar');
  sim.weather.debugScheduleStorm('regional', sim.simTime + 30, 30);
  run(sim, 1);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(snap),
    'restored weather state differs',
  );

  // Rovers deliberately resume *at rest* after a load (their in-flight goal
  // state is re-derived, not saved), so whole-colony equality is not the
  // contract here. The weather and the structures it acts on are: they must
  // replay the same storm beat for beat.
  run(sim, 2);
  run(copy, 2);
  assert.equal(
    JSON.stringify(copy.weather.snapshot()),
    JSON.stringify(sim.weather.snapshot()),
    'the restored colony must live through identical weather',
  );
  const pSim = sim.buildings.find((b) => b.kind === 'solar')!;
  const pCopy = copy.buildings.find((b) => b.kind === 'solar')!;
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert.ok(close(pSim.health, pCopy.health) && close(pSim.cleanliness, pCopy.cleanliness), 'the storm must chew on both arrays identically');
  assert.ok(!copy.gameOver && !sim.gameOver, 'both colonies should ride it out');
});

test('the full cascading failure: storm → solar collapse → battery drain → recovery', () => {
  const sim = new Simulation({ seed: 41, nearDeposits: 0.2 });
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  buildAndWait(sim, 'extractor');
  sim.storage.ice = 300;
  sim.clock.frac = 0.5;
  sim.step(1 / 20);
  const healthyGen = sim.power.generationKw;
  const panel = sim.buildings.find((b) => b.kind === 'solar')!;
  const healthyPanelKw = panel.genKw;
  assert.ok(healthyGen > 20, `colony should generate healthily at noon (${healthyGen.toFixed(1)} kW)`);

  // The storm hits: generation collapses and the grid leans on the battery.
  sim.weather.debugSuppressRolls();
  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 200 / SOL_SECONDS); // mid-storm, dust thick, winds near peak
  sim.clock.frac = 0.5; // measure against the same sun angle as the baseline
  sim.step(1 / 20);
  assert.ok(
    panel.genKw < healthyPanelKw * 0.4,
    `storm must collapse the array (${panel.genKw.toFixed(1)} kW vs ${healthyPanelKw.toFixed(1)} kW clear)`,
  );
  assert.ok(
    sim.power.generationKw < healthyGen * 0.7,
    `grid total must crater too (${sim.power.generationKw.toFixed(1)} kW vs ${healthyGen.toFixed(1)} kW clear)`,
  );
  assert.ok(!sim.gameOver, 'a prepared colony survives the storm');

  // Recovery: dust settles, rovers clean and repair, output returns.
  run(sim, 4);
  assert.ok(panel.cleanliness > 0.65, `the rovers should have re-cleaned the array (${panel.cleanliness.toFixed(2)})`);
  assert.ok(
    panel.genKw > healthyPanelKw * 0.5,
    `generation should substantially recover (${panel.genKw.toFixed(1)} kW vs ${healthyPanelKw.toFixed(1)} kW clear)`,
  );
  assert.ok(sim.storedKWh > sim.power.capacityKWh * 0.3, 'batteries should refill afterwards');
});

// =========================================================== determinism ====
group('Determinism & persistence');

test('same seed and same commands produce identical state', () => {
  const a = new Simulation({ seed: 42, nearDeposits: 0.18 });
  const b = new Simulation({ seed: 42, nearDeposits: 0.18 });
  a.issueMine(a.rovers[0].id, nearDeposit(a, 'regolith')!.id);
  b.issueMine(b.rovers[0].id, nearDeposit(b, 'regolith')!.id);
  run(a, 5);
  run(b, 5);
  assert.equal(
    JSON.stringify(a.snapshot()),
    JSON.stringify(b.snapshot()),
    'state diverged between two identical runs',
  );
});

test('the same total time produces the same state at any frame rate', () => {
  const steady = new Simulation({ seed: 77, nearDeposits: 0.18 });
  const jittery = new Simulation({ seed: 77, nearDeposits: 0.18 });
  for (let i = 0; i < 1200; i++) steady.step(1 / 20);
  // Same 60 s of sim time, delivered in uneven chunks like a real browser.
  let delivered = 0;
  const chunks = [1 / 30, 1 / 15, 1 / 60, 1 / 20, 0.1];
  let i = 0;
  while (delivered < 60 - 1e-9) {
    const dt = Math.min(chunks[i++ % chunks.length], 60 - delivered);
    jittery.step(dt);
    delivered += dt;
  }
  assert.equal(
    JSON.stringify(steady.snapshot()),
    JSON.stringify(jittery.snapshot()),
    'variable frame pacing must not change the simulation',
  );
});

test('snapshot / restore round-trips exactly', () => {
  const sim = new Simulation({ seed: 99, nearDeposits: 0.18 });
  sim.issueMove(sim.rovers[0].id, 30, -20);
  run(sim, 2);
  const snap = sim.snapshot();
  const copy = new Simulation({ seed: 1 });
  copy.restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(JSON.stringify(copy.snapshot()), JSON.stringify(snap), 'restored state differs');
});

test('a restored colony keeps simulating identically', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  run(sim, 1);

  const copy = new Simulation({ seed: 1 });
  copy.restore(JSON.parse(JSON.stringify(sim.snapshot())));
  run(sim, 2);
  run(copy, 2);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(sim.snapshot()),
    'a reloaded save must continue the same way',
  );
});

test('a save from an unsupported version is rejected, not silently loaded', () => {
  const sim = new Simulation({ seed: 1 });
  assert.throws(() => sim.restore({ version: 0, seed: 1 }), /unsupported save version/);
});

test('restore tolerates missing optional fields', () => {
  const sim = new Simulation({ seed: 8, nearDeposits: 0.18 });
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  delete snap.alerts;
  delete snap.colonist;
  delete snap.fluids;
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.ok(copy.colonist, 'a colonist should still exist');
});

// ======================================================= prototype 4 =====
group('Prototype 4 — rover logistics');

test('a queued task runs after the current one; a plain order replaces the queue', () => {
  const sim = new Simulation({ seed: 61, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  sim.issueMove(rv.id, 60, 0); // starts immediately
  sim.issueMove(rv.id, -60, 0, true); // queued behind it
  sim.issueWait(rv.id, 5, true); // queued behind that
  assert.equal(rv.pending.length, 2, 'two tasks should sit in the queue');
  assert.equal(rv.command.type, 'moveTo');

  // A non-queued order is a change of plans: the queue goes.
  sim.issueMove(rv.id, 0, 60);
  assert.equal(rv.pending.length, 0, 'a plain order must clear the queue');
  assert.equal(rv.command.type, 'moveTo');

  // Queued orders on an idle rover start immediately instead.
  sim.stopRover(rv.id);
  sim.issueMove(rv.id, 60, 0, true);
  assert.equal(rv.command.type, 'moveTo', 'a queued order to an idle rover starts now');
  assert.equal(rv.pending.length, 0);
});

test('a WAIT task holds position and finishes on schedule', () => {
  const sim = new Simulation({ seed: 61, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  sim.issueWait(rv.id, 3);
  assert.equal(rv.command.type, 'wait');
  assert.equal(rv.phase, 'idle', 'waiting is holding position, not working');
  run(sim, SOL_SECONDS * 0.1); // 24 game-seconds — comfortably past 3 s
  assert.equal(rv.command.type, 'idle', 'the wait should be over');
});

test('a repeat haul route parks when the silo is full and resumes when there is room', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  // Fill the ice silo so a haul route has nowhere to deliver.
  sim.storage.ice += sim.storageRoom('ice');
  sim.recomputeCapacities();
  assert.equal(sim.storageRoom('ice'), 0, 'precondition: ice silo is full');

  const dep = nearDeposit(sim, 'ice');
  const rv = sim.rovers[0];
  // Isolate the route logic from whatever the build phase left behind: a full
  // battery (no recharge detour) and an empty hold (no half-load to finish).
  rv.battery = ROVERS[rv.kind].maxBatteryKWh;
  for (const r of ALL_RESOURCES) rv.cargo[r] = 0;
  sim.issueMine(rv.id, dep.id);
  sim.setRepeatRoute(rv.id, true);
  run(sim, 0.1);
  assert.equal(rv.routePaused, true, 'the route should park at the depot');
  assert.equal(rv.command.type, 'mine', 'the route task survives the pause');
  assert.ok(rv.command.type === 'mine' && rv.command.repeat, 'and keeps its repeat flag');

  // Consumption frees silo space → the route sets out again.
  sim.storage.ice = 0;
  sim.recomputeCapacities();
  run(sim, 0.05);
  assert.equal(rv.routePaused, false, 'the route should resume');
  assert.notEqual(rv.phase, 'idle', 'and the rover should be moving or mining');
});

test('mining orders claim seams, and reservations follow the player', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  const [a, b] = sim.rovers;
  const dep = nearDeposit(sim, 'ice');
  sim.issueMine(a.id, dep.id);
  assert.equal(dep.reservedBy, a.id, 'a player order claims the seam');
  // A second player order may share the seam (people can coordinate);
  // the reservation follows the latest claim.
  sim.issueMine(b.id, dep.id);
  assert.equal(dep.reservedBy, b.id, 'the latest claimant holds the reservation');
});

test('auto-haul spreads the fleet without idling anyone over a reservation', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  // A build site creates genuine demand with empty storage.
  build(sim, 'warehouse');
  run(sim, 0.1);
  for (const rv of sim.rovers) {
    assert.equal(
      rv.command.type,
      'mine',
      `${rv.label} should have been auto-dispatched, got ${rv.command.type}`,
    );
  }
  // The reservation contract: each seam being worked is claimed by exactly
  // one rover — unless it is rich enough that sharing wastes nothing.
  for (const rv of sim.rovers) {
    if (rv.command.type !== 'mine') continue;
    const dep = sim.world.deposits.find((d) => d.id === rv.command.depositId)!;
    const holder = dep.reservedBy;
    const rich = 2.5 * ROVERS[rv.kind].capacityKg;
    assert.ok(
      holder === rv.id || dep.amount > rich,
      `seam ${dep.id} (${dep.amount.toFixed(0)} kg) worked by ${rv.label} should be claimed (by ${holder}) or rich`,
    );
  }
});

test('a flat rover strands, and another rover can jump-start it', () => {
  const sim = new Simulation({ seed: 63, nearDeposits: 0.2 });
  const [rescuer, victim] = sim.rovers;
  // Send the victim into the field and run its battery flat there — the
  // low-power recall cannot make it home from that far out.
  victim.x = 150;
  victim.z = 150;
  victim.battery = 3;
  assert.equal(
    sim.issueRecover(rescuer.id, victim.id),
    false,
    'a running rover needs no rescue',
  );
  sim.issueMove(victim.id, 200, 200);
  let sols = 0;
  while (victim.phase !== 'disabled' && sols < 5) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.equal(victim.phase, 'disabled', 'the victim should be stranded');

  const ok = sim.issueRecover(rescuer.id, victim.id);
  assert.ok(ok, 'the rescue dispatch should be accepted');
  sols = 0;
  while (victim.phase === 'disabled' && sols < 6) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.notEqual(victim.phase, 'disabled', 'the victim should be running again');
  assert.ok(victim.battery > 0, 'the jump-start should have left charge in the battery');
  assert.ok(rescuer.battery < ROVERS[rescuer.kind].maxBatteryKWh, 'the rescuer paid for it');
});

test('tool work wears the drivetrain, and worn rovers work slower', () => {
  const sim = new Simulation({ seed: 64, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'iron');
  sim.issueMine(rv.id, dep.id);
  const before = dep.amount;
  run(sim, 1);
  assert.ok(dep.amount < before, 'the rover should be mining');
  assert.ok(
    rv.condition < 100,
    `a sol of digging should wear the drivetrain, got ${rv.condition.toFixed(1)}%`,
  );

  // Same dig, half-worn drivetrain: materially less rock moves.
  const sim2 = new Simulation({ seed: 64, nearDeposits: 0.2 });
  const rv2 = sim2.rovers[0];
  rv2.condition = 20;
  const dep2 = sim2.world.deposits.find((d) => d.id === dep.id)!;
  sim2.issueMine(rv2.id, dep2.id);
  run(sim2, 1);
  assert.ok(
    before - dep2.amount < before - dep.amount - 5,
    `a worn rover should mine slower (${(before - dep.amount).toFixed(0)} kg vs ${(before - dep2.amount).toFixed(0)} kg)`,
  );
});

test('a garage services drivetrains, fast-charges, and assembles rovers', () => {
  const sim = new Simulation({ seed: 65, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  buildAndWait(sim, 'solar');
  const garage = buildAndWait(sim, 'garage');

  // --- assembly: the line builds a cargo rover from stockpiled parts ---
  sim.storage.iron = 300;
  sim.storage.aluminum = 200;
  sim.storage.silicon = 200;
  sim.recomputeCapacities();
  assert.ok(sim.assembleRover(garage.id, 'cargo'), 'assembly should start');
  assert.ok(!sim.assembleRover(garage.id, 'utility'), 'the line takes one job at a time');
  const nBefore = sim.rovers.length;
  let sols = 0;
  while (sim.rovers.length === nBefore && sols < 2) {
    run(sim, 0.05);
    sols += 0.05;
  }
  assert.equal(sim.rovers.length, nBefore + 1, 'a new rover should roll out');
  const fresh = sim.rovers[sim.rovers.length - 1];
  assert.equal(fresh.kind, 'cargo');
  assert.ok(
    fresh.battery >= ROVERS.cargo.maxBatteryKWh - 0.01,
    'fresh off the line, fully charged',
  );
  assert.equal(garage.assembly, null, 'the line should be free again');

  // --- service: parking a worn rover in the bay restores condition ---
  const worn = sim.rovers[0];
  worn.condition = 40;
  worn.x = garage.x;
  worn.z = garage.z;
  run(sim, 0.2);
  assert.ok(
    worn.condition > 40,
    `the bay should service the drivetrain, got ${worn.condition.toFixed(1)}%`,
  );

  // --- fast charge: 32 kW in the bay vs the pod's 16 kW ---
  const bayRv = sim.rovers[1];
  bayRv.x = garage.x + 2;
  bayRv.z = garage.z;
  bayRv.battery = 10;
  const bayBefore = bayRv.battery;
  run(sim, 1 / (SOL_SECONDS * 20)); // exactly one tick
  const bayGain = bayRv.battery - bayBefore;
  const podRv = sim.rovers[2]; // the fresh cargo rover
  podRv.x = 2; // next to the lander pod, away from any garage
  podRv.z = 2;
  podRv.battery = 10;
  podRv.recharge = true;
  const podBefore = podRv.battery;
  run(sim, 1 / (SOL_SECONDS * 20));
  const podGain = podRv.battery - podBefore;
  assert.ok(
    bayGain >= podGain * 1.5,
    `garage charging should dwarf pod charging (${bayGain.toFixed(3)} vs ${podGain.toFixed(3)} kWh/tick)`,
  );
});

test('rover automation rules are per-rover levers', () => {
  const sim = new Simulation({ seed: 66, nearDeposits: 0.2 });
  const [mining, utility] = sim.rovers;

  // Charge floor clamps to the UI's 10–60% range.
  sim.setChargeFloor(mining.id, 95);
  assert.equal(mining.rules.chargeFloorPct, 60, 'floor clamps high');
  sim.setChargeFloor(mining.id, 2);
  assert.equal(mining.rules.chargeFloorPct, 10, 'floor clamps low');
  sim.setChargeFloor(mining.id, 45);
  assert.equal(mining.rules.chargeFloorPct, 45, 'sane values pass through');

  // A high floor recalls the rover even with plenty of battery left.
  utility.battery = 20; // 50% of its 40 kWh pack
  sim.setChargeFloor(utility.id, 60); // 24 kWh floor — above its charge
  sim.step(1 / 20);
  assert.ok(utility.recharge, 'the rover should be heading in to charge');

  // Auto-haul off stops the scheduler from using that rover.
  sim.setRoverRule(utility.id, 'autoHaul', false);
  sim.setRoverRule(mining.id, 'autoHaul', false);
  sim.storage.ice = 0;
  sim.recomputeCapacities();
  run(sim, 0.1);
  for (const rv of [mining, utility]) {
    assert.equal(
      rv.command.type,
      'idle',
      `auto-haul-off ${rv.label} must not be dispatched, got ${rv.command.type}`,
    );
  }
});

test('v3 saves migrate to v4: queues, condition, rules and assembly slots appear', () => {
  const sim = new Simulation({ seed: 67, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  // Hand-craft a v3 save: single command, no queue/condition/rules, no slots.
  const v3 = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  v3.version = 3;
  v3.rovers = v3.rovers.map((r: any, i: number) => {
    const { pending, condition, rules, autoTask, recharge, lowBatteryNotified, blockNotified, ...rest } = r;
    return { ...rest, autoHaul: i === 1 ? false : true };
  });
  v3.buildings = v3.buildings.map((b: any) => {
    const { assembly, ...rest } = b;
    return rest;
  });

  const copy = new Simulation({ seed: 1 });
  copy.restore(v3);
  assert.equal(copy.rovers.length, sim.rovers.length, 'all rovers survive the migration');
  for (const r of copy.rovers) {
    assert.deepEqual(r.pending, [], 'migrated rovers start with an empty queue');
    assert.equal(r.condition, 100, 'migrated drivetrains start fresh');
    assert.ok(r.rules, 'migrated rovers get a rules block');
  }
  assert.equal(copy.rovers[1].rules.autoHaul, false, 'the old autoHaul flag carries over');
  assert.equal(copy.rovers[0].rules.autoHaul, true, 'default autoHaul was already true');
  for (const b of copy.buildings) {
    assert.equal(b.assembly, null, 'buildings gain an empty assembly slot');
  }
});

test('a P4-heavy state round-trips through save and restore', () => {
  const sim = new Simulation({ seed: 68, nearDeposits: 0.2 });
  buildAndWait(sim, 'warehouse');
  const [a, b] = sim.rovers;

  // Queue with every task shape, a repeat route, custom rules, a reservation.
  sim.issueMove(a.id, 60, 0);
  sim.issueMine(a.id, nearDeposit(sim, 'ice').id, true);
  sim.issueWait(a.id, 10, true);
  const ironDep = nearDeposit(sim, 'iron');
  sim.issueMine(b.id, ironDep.id);
  sim.setRepeatRoute(b.id, true);
  sim.setChargeFloor(b.id, 45);
  sim.setRoverRule(b.id, 'stormShelter', false);
  sim.setRoverRule(b.id, 'autoRescue', false);
  assert.equal(ironDep.reservedBy, b.id, 'precondition: b holds a reservation');

  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(snap),
    'restore must reproduce the state exactly',
  );

  // And it keeps simulating identically afterwards.
  run(sim, 0.5);
  run(copy, 0.5);
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(sim.snapshot()),
    'a reloaded save must continue the same way',
  );
});

// ================================================= recharge logistics ====
group('Recharge logistics');

test("a rover with cargo empties its hold while recharging when silos have room", () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2; // parked at the pod depot
  rv.cargo.ice = 200;
  rv.battery = 5; // flat enough to trigger the return-to-charge rule
  const before = sim.storage.ice;
  run(sim, 0.02);
  assert.ok(
    rv.cargo.ice < 1,
    `the hold should be empty, still has ${rv.cargo.ice.toFixed(0)} kg`,
  );
  assert.ok(sim.storage.ice > before, 'the cargo should have reached storage');
});

test('a recharging rover keeps cargo the silos have no room for', () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  sim.storage.ice = sim.storageCapacity(); // a full silo takes nothing
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2;
  rv.cargo.ice = 200;
  rv.battery = 5;
  run(sim, 0.05);
  assert.ok(
    rv.cargo.ice > 199,
    `cargo should stay aboard, has ${rv.cargo.ice.toFixed(0)} kg`,
  );
  assert.equal(sim.storage.ice, sim.storageCapacity(), 'a full silo must not overfill');
});

test('after charging, the rover rolls back out to its mining job', () => {
  const sim = new Simulation({ seed: 70, nearDeposits: 0.2 });
  const rv = sim.rovers[0];
  const dep = nearDeposit(sim, 'ice')!;
  sim.issueMine(rv.id, dep.id);
  rv.x = 2;
  rv.z = 2;
  rv.cargo.ice = 200;
  rv.battery = 5;
  run(sim, 0.4); // plenty of time to charge and drive back out
  assert.equal(rv.command.type, 'mine', 'the mining order survives the charge cycle');
  assert.equal(rv.recharge, false, 'the rover should be off the charger');
  assert.ok(
    Math.hypot(rv.x, rv.z) > 15,
    `the rover should be back in the field, is at (${rv.x.toFixed(0)}, ${rv.z.toFixed(0)})`,
  );
});

// ================================================== rover unload order ====
group('Rover unload order');

test('an unload order pours the hold into storage', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  r.cargo.ice = 200;
  sim.issueUnload(r.id);
  sim.step(1 / 20); // a single tick: both starters spawn within depot reach
  assert.equal(r.command.type, 'idle', 'the task completes once the hold is empty');
  assert.ok(r.cargo.ice < 0.01, 'the hold should be empty');
  assert.equal(sim.storage.ice, 200, 'everything poured into storage');
});

test('unload with an empty hold says so and issues nothing', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  sim.drainEvents();
  sim.issueUnload(r.id);
  assert.equal(r.command.type, 'idle', 'no task should be issued');
  const evs = sim.drainEvents();
  assert.ok(
    evs.some((e) => e.text.includes('already empty')),
    'the player should get a log line, not silence',
  );
});

test('unload queues behind other orders and chains forward', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  for (const o of sim.rovers) o.rules.autoHaul = false; // the scheduler stays out of the queue
  const r = sim.rovers[0];
  const x0 = r.x;
  r.cargo.iron = 50;
  sim.issueUnload(r.id);
  sim.issueMove(r.id, r.x + 60, r.z, true);
  assert.equal(r.pending.length, 1, 'the move should queue behind the unload');
  run(sim, 0.05); // 12 game seconds
  assert.equal(sim.storage.iron, 50, 'the hold poured out first');
  assert.equal(r.pending.length, 0, 'the queued move promoted');
  assert.ok(Math.abs(r.x - x0) > 5, '…and the rover drove on afterwards');
});

test('an unload task survives a save round-trip', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  r.cargo.iron = 50;
  r.x += 200; // far from any depot, so the task is still travelling
  sim.issueUnload(r.id);
  const data = JSON.parse(JSON.stringify(sim.snapshot()));
  const sim2 = new Simulation({ seed: 999 });
  sim2.restore(data);
  const r2 = sim2.roverById(r.id)!;
  assert.equal(r2.command.type, 'unload', 'the task type must restore');
  assert.equal(r2.cargo.iron, 50, 'the cargo must restore with it');
});

// =================================================== idle rover query ====
group('Idle rover query');

test('idleRovers finds rovers with nothing to do', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  assert.equal(sim.idleRovers().length, 2);
  sim.issueMove(sim.rovers[0].id, 50, 50);
  assert.deepEqual(
    sim.idleRovers().map((r) => r.id),
    [sim.rovers[1].id],
    'a rover with a task is not idle',
  );
});

test('idleRovers skips the stranded, the charging and the storm-bound', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  const [a, b] = sim.rovers;
  a.phase = 'disabled';
  b.recharge = true;
  assert.equal(sim.idleRovers().length, 0, 'neither stranded nor charging counts');
  b.recharge = false;
  b.sheltered = true;
  assert.equal(sim.idleRovers().length, 0, 'storm shelter is not idle time');
  b.sheltered = false;
  assert.equal(sim.idleRovers().length, 1, 'releasing it makes it idle again');
});

// ============================================================== summary ====
console.log(
  `\n${pass} simulation checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`,
);
if (failures.length) {
  for (const f of failures) console.log(`  ✘ ${f}`);
  process.exit(1);
}
