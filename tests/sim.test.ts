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
import { BUILDINGS, ALL_RESOURCES } from '../src/sim/defs';
import { resolvePower } from '../src/sim/power';
import { sunFor, SolClock } from '../src/sim/clock';
import { Weather } from '../src/sim/weather';
import { SOL_SECONDS, SUIT_O2_CAPACITY, POD_BATTERY_KWH } from '../src/sim/config';

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

test('a full colony reaches a sustainable steady state', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  for (const k of ['warehouse', 'solar', 'battery', 'extractor', 'oxygenator'] as BuildingKind[]) {
    buildAndWait(sim, k);
  }
  buildAndWait(sim, 'greenhouse', 30);
  buildAndWait(sim, 'solar');
  buildAndWait(sim, 'battery');
  run(sim, 20);
  // This asserts the food loop closes, not storm survival (weather has its own
  // suite) — so wait out any storm in progress before sampling the trailing sol.
  for (let i = 0; i < 8 && sim.weather.stormIntensity > 0.01; i++) run(sim, 0.5);
  run(sim, 1);

  assert.ok(!sim.gameOver, 'the colony should survive');
  assert.ok(sim.colonist.health > 95, `colonist should be healthy, was ${sim.colonist.health}`);
  assert.ok(
    sim.netRatePerSol('food') > 0,
    `greenhouse should close the food loop, net ${sim.netRatePerSol('food').toFixed(2)} kg/sol`,
  );
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

// ============================================================== summary ====
console.log(
  `\n${pass} simulation checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`,
);
if (failures.length) {
  for (const f of failures) console.log(`  ✘ ${f}`);
  process.exit(1);
}
