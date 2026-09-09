/**
 * @suite sim/life-support
 * @group integration
 * @covers src/sim/lifesupport.ts src/sim/config.ts src/sim/defs.ts
 * @desc The human at the centre of it: pool draw, the needs ladder, suit oxygen and
 * the EVA that has to come back for more, and the pod that holds alone until the
 * colony grows.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { SUIT_O2_CAPACITY } from '../../src/sim/config';
import { run, build } from '../fixtures/sim';
import { group, test, finish } from '../harness';

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

group('Grid behaviour in a live colony');

test('the pod alone keeps the colonist breathing on Sol 1', () => {
  const sim = new Simulation({ seed: 21 });
  run(sim, 2);
  assert.ok(!sim.gameOver, 'the landing pod should sustain the crew initially');
  assert.ok(sim.power.generationKw > 0, 'the pod RTG always generates');
  assert.equal(sim.power.brownout, false, 'the pod should cover its own life support');
});

await finish('sim/life-support');
