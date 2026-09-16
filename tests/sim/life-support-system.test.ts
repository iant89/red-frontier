/**
 * @suite sim/life-support-system
 * @group unit
 * @covers src/sim/systems/LifeSupportSystem.ts src/sim/lifesupport.ts
 * @desc LifeSupportSystem extraction (Phase 7): the input → resolver → output
 * pipeline around the pure needs function — normal consumption, depleted
 * oxygen / water / food, brownout (power is an input the fluid draw ignores),
 * weather/EVA refusal and recall, recovery, game-over via the host-hooks
 * seam, shelter occupancy, restore clamping, and deterministic replay.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  LifeSupportSystem,
  type LifeSupportHostHooks,
} from '../../src/sim/systems/LifeSupportSystem';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import {
  SIM_TICK,
  SOLS_PER_SEC,
  SOL_SECONDS,
  COLONIST_O2_PER_SOL,
  COLONIST_WATER_PER_SOL,
  COLONIST_FOOD_PER_SOL,
  SUIT_O2_CAPACITY,
  WATER_RECLAIM_FRACTION,
  HEALTH_REGEN,
  SPAWN_X,
  SPAWN_Z,
} from '../../src/sim/config';
import { emptyAmounts } from '../../src/sim/defs';
import { run, buildOnline, findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const SOLS = SIM_TICK * SOLS_PER_SEC;

function silentHooks(): LifeSupportHostHooks {
  return { endMission: () => {}, completeBuilding: () => {} };
}

function recordingHooks(): {
  hooks: LifeSupportHostHooks;
  missions: string[];
  completed: number[];
} {
  const missions: string[] = [];
  const completed: number[] = [];
  return {
    missions,
    completed,
    hooks: {
      endMission: (reason) => missions.push(reason),
      completeBuilding: (b) => completed.push(b.id),
    },
  };
}

group('LifeSupportSystem.tick — normal consumption');

test('one tick draws oxygen, water and food at the authored per-sol rates', () => {
  const sim = new Simulation({ seed: 91 });
  const before = { ...sim.pools.amounts };
  LifeSupportSystem.tick(sim.state, silentHooks());

  const o2 = COLONIST_O2_PER_SOL * SOLS * sim.consumptionMul;
  const water = COLONIST_WATER_PER_SOL * SOLS * sim.consumptionMul;
  const food = COLONIST_FOOD_PER_SOL * SOLS * sim.consumptionMul;
  assert.ok(Math.abs(before.oxygen - sim.pools.amounts.oxygen - o2) < 1e-9, 'oxygen draw');
  assert.ok(Math.abs(before.water - sim.pools.amounts.water - water) < 1e-9, 'water draw');
  assert.ok(Math.abs(before.food - sim.pools.amounts.food - food) < 1e-9, 'food draw');
  assert.equal(sim.colonist.health, 100, 'a supplied colonist stays healthy');
  assert.equal(sim.colonist.inside, true, 'spawned inside the pod');
  assert.equal(sim.colonist.shelterId, 0, 'the pod is shelter 0');
  assert.ok(Math.abs(sim.flows.oxygen.consumed - o2) < 1e-9, 'oxygen flow accounted');
  assert.ok(Math.abs(sim.flows.water.consumed - water) < 1e-9, 'water flow accounted');
  assert.ok(Math.abs(sim.flows.food.consumed - food) < 1e-9, 'food flow accounted');
  assert.equal(sim.flows.water.produced, 0, 'the pod does not reclaim water');
});

test('a Survivor crew burns stores faster by the difficulty multiplier', () => {
  const pioneer = new Simulation({ seed: 92, difficulty: 'pioneer' });
  const survivor = new Simulation({ seed: 92, difficulty: 'survivor' });
  assert.ok(survivor.consumptionMul > pioneer.consumptionMul, 'precondition: survivor is hungrier');
  const pO2 = pioneer.pools.amounts.oxygen;
  const sO2 = survivor.pools.amounts.oxygen;
  LifeSupportSystem.tick(pioneer.state, silentHooks());
  LifeSupportSystem.tick(survivor.state, silentHooks());
  const pDraw = pO2 - pioneer.pools.amounts.oxygen;
  const sDraw = sO2 - survivor.pools.amounts.oxygen;
  assert.ok(
    Math.abs(sDraw / pDraw - survivor.consumptionMul / pioneer.consumptionMul) < 1e-9,
    `draw scales with consumptionMul (${sDraw.toFixed(6)} vs ${pDraw.toFixed(6)})`,
  );
});

group('LifeSupportSystem.tick — depleted stores');

test('depleted oxygen hurts far faster than depleted water or food', () => {
  const noO2 = new Simulation({ seed: 93 });
  noO2.pools.amounts.oxygen = 0;
  noO2.colonist.suitO2 = 0;
  LifeSupportSystem.tick(noO2.state, silentHooks());

  const noWater = new Simulation({ seed: 93 });
  noWater.pools.amounts.water = 0;
  LifeSupportSystem.tick(noWater.state, silentHooks());

  const noFood = new Simulation({ seed: 93 });
  noFood.pools.amounts.food = 0;
  LifeSupportSystem.tick(noFood.state, silentHooks());

  assert.ok(noO2.colonist.starved.oxygen, 'oxygen starvation flagged');
  assert.ok(noWater.colonist.starved.water, 'water starvation flagged');
  assert.ok(noFood.colonist.starved.food, 'food starvation flagged');
  assert.ok(
    noO2.colonist.health < noWater.colonist.health,
    'oxygen kills faster than thirst',
  );
  assert.ok(
    noWater.colonist.health < noFood.colonist.health,
    'thirst kills faster than hunger',
  );
  assert.ok(noO2.colonist.health < 100 && noFood.colonist.health < 100);
});

test('an EVA burns the suit, not the colony tanks', () => {
  const sim = new Simulation({ seed: 94 });
  sim.colonist.inside = false;
  sim.colonist.x = 26;
  sim.colonist.z = 26;
  const tank = sim.pools.amounts.oxygen;
  const suit = sim.colonist.suitO2;
  LifeSupportSystem.tick(sim.state, silentHooks());
  assert.equal(sim.colonist.inside, false, 'still outside after one tick');
  assert.equal(sim.pools.amounts.oxygen, tank, 'colony oxygen is untouched on EVA');
  assert.ok(sim.colonist.suitO2 < suit, 'the suit pays');
  const want = COLONIST_O2_PER_SOL * SOLS * sim.consumptionMul;
  assert.ok(Math.abs(suit - sim.colonist.suitO2 - want) < 1e-9, 'suit draw matches the rate');
});

group('LifeSupportSystem.tick — power loss');

test('a brownout does not stop the fluid draw — power is an input, not a gate', () => {
  const sim = new Simulation({ seed: 95 });
  sim.devSetTime(0, 0.95); // midnight
  sim.state.storedKWh = 0;
  const before = { ...sim.pools.amounts };
  // Drive the whole tick so the grid actually browns out, then confirm the
  // human still ate — LifeSupportSystem does not consult state.power.
  sim.step(1 / 20);
  assert.ok(sim.pools.amounts.oxygen < before.oxygen, 'oxygen still drawn');
  assert.ok(sim.pools.amounts.water < before.water, 'water still drawn');
  assert.ok(sim.pools.amounts.food < before.food, 'food still drawn');
  assert.equal(sim.colonist.health, 100, 'the crew does not notice the brownout');
  assert.equal(sim.colonist.dead, false);
});

group('LifeSupportSystem.tick — recovery');

test('a supplied colonist regenerates health at HEALTH_REGEN per sol', () => {
  const sim = new Simulation({ seed: 96 });
  sim.colonist.health = 70;
  LifeSupportSystem.tick(sim.state, silentHooks());
  const expected = 70 + HEALTH_REGEN * SOLS * sim.consumptionMul;
  assert.ok(
    Math.abs(sim.colonist.health - expected) < 1e-9,
    `regen is HEALTH_REGEN × sols (got ${sim.colonist.health.toFixed(6)})`,
  );
  assert.deepEqual(sim.colonist.starved, { oxygen: false, water: false, food: false });
});

test('an online habitat reclaims a fraction of the water the crew drank', () => {
  const sim = new Simulation({ seed: 97 });
  const hab = buildOnline(sim, 'habitat');
  // Sit the colonist inside the habitat so the tick sees recycles=true.
  sim.colonist.x = hab.x;
  sim.colonist.z = hab.z;
  sim.colonist.y = sim.world.heightAt(hab.x, hab.z);
  const before = sim.pools.amounts.water;
  LifeSupportSystem.tick(sim.state, silentHooks());
  assert.equal(sim.colonist.inside, true);
  assert.equal(sim.colonist.shelterId, hab.id, 'occupying the habitat, not the pod');
  const drank = COLONIST_WATER_PER_SOL * SOLS * sim.consumptionMul;
  const reclaimed = drank * WATER_RECLAIM_FRACTION;
  assert.ok(
    Math.abs(before - sim.pools.amounts.water - (drank - reclaimed)) < 1e-9,
    `net water is drink minus reclaim (got ${(before - sim.pools.amounts.water).toFixed(6)})`,
  );
  assert.ok(Math.abs(sim.flows.water.produced - reclaimed) < 1e-9, 'reclaim is produced flow');
});

group('LifeSupportSystem — weather and EVA');

test('an EVA beyond suit range is refused rather than fatal', () => {
  const sim = new Simulation({ seed: 98 });
  LifeSupportSystem.order(sim.state, { type: 'moveTo', x: 300, z: 300 });
  assert.equal(sim.colonist.order.type, 'shelter', 'a suicidal EVA is refused');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('Too far for an EVA')),
    'the refusal is logged',
  );
});

test('a storm refuses a new EVA and recalls a crew already outside', () => {
  const sim = new Simulation({ seed: 99 });
  sim.weather.debugSuppressRolls();
  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.ok(sim.weather.blocksEVAAt(sim.colonist.x, sim.colonist.z), 'precondition: EVA blocked');

  LifeSupportSystem.order(sim.state, { type: 'moveTo', x: 26, z: 26 });
  assert.equal(sim.colonist.order.type, 'shelter', 'a storm EVA is refused');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('EVA refused')),
    'the weather refusal is logged',
  );

  // Recall: let the storm arrive while they are still indoors, then put them
  // outside on a walk so the motion tick (not 120 s of EVA) is what we test.
  const sim2 = new Simulation({ seed: 100 });
  sim2.weather.debugSuppressRolls();
  sim2.weather.debugScheduleStorm('severe', sim2.simTime, 0);
  run(sim2, 120 / SOL_SECONDS);
  assert.ok(sim2.weather.blocksEVAAt(26, 26), 'precondition: the walk is inside the storm');
  sim2.colonist.inside = false;
  sim2.colonist.x = 26;
  sim2.colonist.z = 26;
  sim2.colonist.order = { type: 'moveTo', x: 40, z: 40 };
  LifeSupportSystem.tickColonist(sim2.state, silentHooks());
  assert.equal(sim2.colonist.order.type, 'shelter', 'the storm recalls them');
  assert.ok(
    sim2.alerts.history().some((e) => e.text.includes('recalled')),
    'the recall is logged',
  );
});

test('a critically low suit aborts the EVA and a walk outside drains it', () => {
  const sim = new Simulation({ seed: 101 });
  LifeSupportSystem.order(sim.state, { type: 'moveTo', x: 26, z: 26 });
  run(sim, 0.05);
  assert.ok(!sim.colonist.inside, 'precondition: on EVA');
  assert.ok(sim.colonist.suitO2 < SUIT_O2_CAPACITY, 'suit is draining');

  sim.colonist.suitO2 = SUIT_O2_CAPACITY * 0.1;
  LifeSupportSystem.tickColonist(sim.state, silentHooks());
  assert.equal(sim.colonist.order.type, 'shelter', 'critical suit aborts the walk');
});

group('LifeSupportSystem — game-over via host hooks');

test('death ends the mission through the hooks seam, not by writing gameOver itself', () => {
  const sim = new Simulation({ seed: 102 });
  sim.pools.amounts.oxygen = 0;
  sim.pools.amounts.water = 0;
  sim.pools.amounts.food = 0;
  sim.colonist.suitO2 = 0;
  sim.colonist.health = 0.01;
  const rec = recordingHooks();
  LifeSupportSystem.tick(sim.state, rec.hooks);
  assert.ok(sim.colonist.dead, 'the colonist died');
  assert.equal(rec.missions.length, 1, 'endMission fired once');
  assert.ok(rec.missions[0].includes('did not survive'));
  assert.equal(sim.gameOver, null, 'the system does not latch gameOver itself');

  // Through the real wiring, Simulation latches the mission.
  const live = new Simulation({ seed: 103 });
  live.pools.amounts.oxygen = 0;
  live.pools.amounts.water = 0;
  live.pools.amounts.food = 0;
  live.colonist.suitO2 = 0;
  live.colonist.health = 0.01;
  live.step(1 / 20);
  assert.ok(live.colonist.dead);
  assert.ok(live.gameOver, 'Simulation.endMission latched the loss');
  assert.ok(live.gameOver!.reason.includes('did not survive'));
});

test('assisting construction completes a building through the hooks seam', () => {
  const sim = new Simulation({ seed: 104 });
  const site = sim.placeBuilding('habitat', ...(() => {
    const s = { x: 0, z: 0 };
    for (let r = 34; r <= 80; r += 3) {
      for (let a = 0; a < 360; a += 7) {
        const x = Math.cos((a * Math.PI) / 180) * r;
        const z = Math.sin((a * Math.PI) / 180) * r;
        if (sim.canPlace('habitat', x, z) === null) return [x, z] as const;
      }
    }
    throw new Error('no habitat spot');
  })())!;
  site.state = 'building';
  site.remainingCost = emptyAmounts();
  site.progress = 0.9999;
  sim.colonist.x = site.x;
  sim.colonist.z = site.z;
  sim.colonist.order = { type: 'assist', buildingId: site.id };

  const rec = recordingHooks();
  LifeSupportSystem.tickColonist(sim.state, rec.hooks);
  assert.equal(sim.colonist.activity, 'assisting');
  assert.ok(site.progress >= 1, 'the colonist pushed the last of the work');
  assert.deepEqual(rec.completed, [site.id], 'completeBuilding crossed the seam');
  assert.notEqual(site.state, 'online', 'the system does not flip the building itself');
});

group('LifeSupportSystem — lifecycle');

test('restore clamps fluids into capacity and rebuilds the colonist', () => {
  const sim = new Simulation({ seed: 105 });
  const cap = { ...sim.pools.capacity };
  LifeSupportSystem.restore(
    sim.state,
    { oxygen: 1e9, water: -4, food: 3.5, mystery: 9 },
    {
      id: 7,
      name: 'Cmdr. Hale',
      x: 12,
      z: -8,
      heading: 1.2,
      health: 55,
      suitO2: 0.1,
      inside: false,
      shelterId: -1,
      order: { type: 'moveTo', x: 12, z: -8 },
      dead: false,
    },
  );
  assert.equal(sim.pools.amounts.oxygen, cap.oxygen, 'overfill clamps to capacity');
  assert.equal(sim.pools.amounts.water, 0, 'negative water clamps to zero');
  assert.equal(sim.pools.amounts.food, 3.5, 'an in-range value survives');
  assert.equal(sim.colonist.id, 7);
  assert.equal(sim.colonist.name, 'Cmdr. Hale');
  assert.equal(sim.colonist.x, 12);
  assert.equal(sim.colonist.z, -8);
  assert.equal(sim.colonist.health, 55);
  assert.equal(sim.colonist.suitO2, 0.1);
  assert.equal(sim.colonist.inside, false);
  assert.equal(sim.colonist.order.type, 'moveTo');
  assert.equal(sim.colonist.y, sim.world.heightAt(12, -8), 'height is rebuilt from the world');

  LifeSupportSystem.restore(sim.state, undefined, undefined);
  assert.equal(sim.colonist.id, 1, 'missing colonist falls back to Cmdr. Vega');
  assert.equal(sim.colonist.x, SPAWN_X);
  assert.equal(sim.colonist.z, SPAWN_Z);
  assert.equal(sim.colonist.suitO2, SUIT_O2_CAPACITY);
  assert.equal(sim.colonist.inside, true);
});

test('a save/restore round trip preserves fluids and the colonist through the real wiring', () => {
  const sim = new Simulation({ seed: 106 });
  sim.orderColonist({ type: 'moveTo', x: 22, z: 18 });
  run(sim, 0.04);
  const copy = new Simulation({ seed: 1 });
  copy.restore(structuredClone(sim.snapshot()));
  assert.ok(Math.abs(copy.pools.amounts.oxygen - sim.pools.amounts.oxygen) < 1e-9);
  assert.ok(Math.abs(copy.colonist.health - sim.colonist.health) < 1e-9);
  assert.ok(Math.abs(copy.colonist.suitO2 - sim.colonist.suitO2) < 1e-9);
  assert.equal(copy.colonist.inside, sim.colonist.inside);
  assert.equal(copy.colonist.order.type, sim.colonist.order.type);
});

group('LifeSupportSystem — determinism');

test('same seed, same orders: two colonies consume and walk identically', () => {
  const view = (sim: Simulation) => ({
    fluids: { ...sim.pools.amounts },
    colonist: {
      x: sim.colonist.x,
      z: sim.colonist.z,
      heading: sim.colonist.heading,
      health: sim.colonist.health,
      suitO2: sim.colonist.suitO2,
      inside: sim.colonist.inside,
      shelterId: sim.colonist.shelterId,
      activity: sim.colonist.activity,
      order: sim.colonist.order,
      starved: { ...sim.colonist.starved },
      dead: sim.colonist.dead,
    },
    gameOver: sim.gameOver,
  });
  const a = new Simulation({ seed: 107 });
  const b = new Simulation({ seed: 107 });
  for (const s of [a, b]) s.orderColonist({ type: 'moveTo', x: 26, z: 26 });
  run(a, 0.08);
  run(b, 0.08);
  assert.deepEqual(view(a), view(b), 'the EVA replayed');
  assert.equal(hashSimulation(a), hashSimulation(b), 'the colony replayed');
  for (const s of [a, b]) s.orderColonist({ type: 'shelter' });
  run(a, 0.12);
  run(b, 0.12);
  assert.deepEqual(view(a), view(b), 'the walk home replayed');
  assert.ok(a.colonist.inside, 'precondition: they actually came home');
});

await finish('sim/life-support-system');
