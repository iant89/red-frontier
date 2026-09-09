/**
 * @suite sim/clock
 * @group unit
 * @covers src/sim/clock.ts src/sim/config.ts
 * @desc The sol clock and the sun model: day and night, the shape of irradiance
 * across a sol, and rollover into the next one.
 */

import assert from 'node:assert/strict';
import { sunFor, SolClock } from '../../src/sim/clock';
import { SOL_SECONDS } from '../../src/sim/config';
import { group, test, finish } from '../harness';

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

await finish('sim/clock');
