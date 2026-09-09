/**
 * @suite sim/colony
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/defs.ts src/sim/lifesupport.ts
 * @desc The production chains: ice → water → oxygen, and the greenhouse closing the
 * food loop with the logistics layer deliberately frozen.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import type { BuildingKind } from '../../src/sim/defs';
import { ROVERS } from '../../src/sim/defs';
import { run, buildAndWait } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Life support chain');

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

await finish('sim/colony');
