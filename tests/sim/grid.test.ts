/**
 * @suite sim/grid
 * @group integration
 * @covers src/sim/power.ts src/sim/clock.ts src/sim/Simulation.ts
 * @desc The grid inside a live colony: solar following the sun, the pack charging by
 * day and discharging by night, demand dropping when a building is switched off.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Grid behaviour in a live colony');

test('solar output tracks the sun across a sol', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  buildOnline(sim, 'warehouse');
  const s = buildOnline(sim, 'solar');

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
  buildOnline(sim, 'warehouse');
  buildOnline(sim, 'solar');
  buildOnline(sim, 'battery');
  buildOnline(sim, 'extractor');

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
  buildOnline(sim, 'warehouse');
  buildOnline(sim, 'solar');
  buildOnline(sim, 'battery');

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
  buildOnline(sim, 'warehouse');
  buildOnline(sim, 'solar');
  buildOnline(sim, 'battery');
  const ext = buildOnline(sim, 'extractor');
  sim.storage.ice = 200;
  sim.clock.frac = 0.5;
  sim.step(1 / 20);
  const loaded = sim.power.demandKw;
  sim.setBuildingEnabled(ext.id, false);
  sim.step(1 / 20);
  assert.ok(sim.power.demandKw < loaded, 'demand should drop when a building is switched off');
});

await finish('sim/grid');
