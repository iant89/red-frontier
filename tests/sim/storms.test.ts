/**
 * @suite sim/storms
 * @group integration
 * @covers src/sim/weather.ts src/sim/config.ts src/sim/defs.ts
 * @desc What a storm does to a colony: solar collapse, dust burial, structural damage,
 * sheltering crews, refused EVAs — and the recovery afterwards.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { Weather } from '../../src/sim/weather';
import { SOL_SECONDS } from '../../src/sim/config';
import { nearDeposit, run, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Storm impacts');

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

await finish('sim/storms');
