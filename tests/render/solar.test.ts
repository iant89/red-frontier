/**
 * @suite render/solar
 * @group unit
 * @covers src/render/Renderer.ts
 * @desc The first solar array's met-mast vane anemometer: the cup wheel's
 * spin rate tracks the sim's wind speed (with a storm clamp so it can't
 * strobe), and the vane's yaw always hunts the wind direction the short way
 * around. Pure math, exported from the Renderer so it can be checked without
 * a GPU context.
 */

import assert from 'node:assert/strict';
import { anemometerSpinRate, shortestAngleDelta } from '../../src/render/Renderer';
import { group, test, finish } from '../harness';

group('Anemometer spin rate');

test('still air means a still rotor', () => {
  assert.equal(anemometerSpinRate(0), 0);
  assert.equal(anemometerSpinRate(-3), 0, 'negative wind is nonsense — stop');
  assert.equal(anemometerSpinRate(Number.NaN), 0);
  assert.equal(anemometerSpinRate(Number.POSITIVE_INFINITY), 0);
});

test('it scales with the wind a real cup rotor would', () => {
  // Ambient Mars breeze is 8 m/s: at λ·v/r with λ≈0.35, r=0.3 m that's a
  // brisk ~1.5 rev/s, and doubling the wind doubles the spin.
  const calm = anemometerSpinRate(8);
  assert.ok(calm > 8 && calm < 11, `8 m/s should read alive, not lazy: ${calm}`);
  assert.ok(
    Math.abs(anemometerSpinRate(16) - calm * 2) < 1e-9,
    'linear while below the clamp',
  );
});

test('storm winds clamp the blur instead of wrapping backwards', () => {
  const severe = anemometerSpinRate(58); // the worst global-storm peak
  const insane = anemometerSpinRate(200);
  assert.equal(insane, severe, 'clamped at the cap');
  assert.ok(severe <= 28, `cap: ${severe}`);
  assert.ok(severe > anemometerSpinRate(8), 'a storm still reads angrier than a breeze');
});

group('Vane yaw deltas');

test('flat deltas pass through untouched', () => {
  assert.equal(shortestAngleDelta(0.25, 2), 1.75);
  assert.equal(shortestAngleDelta(2, 0.25), -1.75);
});

test('it never takes the long way around the circle', () => {
  assert.ok(Math.abs(shortestAngleDelta(0, (3 * Math.PI) / 2) + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(shortestAngleDelta(0, (-3 * Math.PI) / 2) - Math.PI / 2) < 1e-9);
  // Just past the wrap the answer flips sign, it doesn't lap the compass.
  const eps = 1e-3;
  assert.ok(
    Math.abs(shortestAngleDelta(0, Math.PI + eps) - (-Math.PI + eps)) < 1e-6,
    'past ±π must wrap, not lap',
  );
});

test('equivalent directions cancel out', () => {
  for (const turns of [-2, 0, 3]) {
    const d = shortestAngleDelta(0.4, 0.4 + turns * Math.PI * 2);
    assert.ok(Math.abs(d) < 1e-9, `same bearing, ${turns} turns apart: ${d}`);
  }
});

await finish('render/solar');
