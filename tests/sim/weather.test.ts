/**
 * @suite sim/weather
 * @group unit
 * @covers src/sim/weather.ts src/sim/clock.ts
 * @desc The weather model on its own: dust against transmission and visibility, the
 * forecast envelope, and the seeded streams that give two colonies the same sky.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { Weather } from '../../src/sim/weather';
import { SOL_SECONDS } from '../../src/sim/config';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

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

await finish('sim/weather');
