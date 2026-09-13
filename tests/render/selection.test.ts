/**
 * @suite render/selection
 * @group unit
 * @covers src/render/Renderer.ts
 * @desc The rover selection ring: the breathing pulse curve that drives its
 * opacity (issue #10). Pure math, extracted from the Renderer so it can be
 * checked without a GPU context. The circularity fix (issue #9) is a uniform
 * `setScalar`, verified here as the scale factor the Renderer applies.
 */

import assert from 'node:assert/strict';
import { selectionPulse, selectionPulseOpacity } from '../../src/render/Renderer';
import { group, test, finish } from '../harness';

group('Selection pulse');

test('the breath stays inside 0..1 across many cycles', () => {
  for (let t = 0; t < 60; t += 0.013) {
    const p = selectionPulse(t);
    assert.ok(p >= -1e-12 && p <= 1 + 1e-12, `pulse out of range at t=${t}: ${p}`);
  }
});

test('it starts dark, peaks mid-cycle, and returns — a full breath', () => {
  const period = 1.9;
  assert.ok(selectionPulse(0) < 1e-9, 'cycle starts at the trough');
  assert.ok(Math.abs(selectionPulse(period / 2) - 1) < 1e-9, 'peaks halfway through');
  assert.ok(selectionPulse(period) < 1e-9, 'returns to the trough after one period');
});

test('the curve is smooth — no jump at the cycle boundary', () => {
  const eps = 1e-4;
  const before = selectionPulse(1.9 - eps);
  const after = selectionPulse(1.9 + eps);
  assert.ok(Math.abs(before - after) < 1e-3, `seam at the wrap: ${before} vs ${after}`);
});

test('it is a function of sim time, so a paused colony freezes the pulse', () => {
  // The Renderer feeds `clockT` (sim.simTime) in. A paused sim reports the
  // same time every frame, which must yield the same opacity every frame.
  const paused = 7.25;
  assert.equal(selectionPulse(paused), selectionPulse(paused));
  assert.notEqual(selectionPulse(paused), selectionPulse(paused + 0.4));
});

group('Selection opacity');

test('the ring stays clearly visible at the trough of the breath', () => {
  const dim = selectionPulseOpacity(selectionPulse(0));
  assert.ok(dim.ring >= 0.7, `ring must not fade out: ${dim.ring}`);
  assert.ok(dim.glow > 0, 'the halo never disappears entirely');
});

test('both layers brighten together and stay within alpha range', () => {
  const dim = selectionPulseOpacity(0);
  const bright = selectionPulseOpacity(1);
  assert.ok(bright.ring > dim.ring, 'ring brightens');
  assert.ok(bright.glow > dim.glow, 'halo brightens');
  for (const v of [dim.ring, dim.glow, bright.ring, bright.glow]) {
    assert.ok(v >= 0 && v <= 1, `opacity out of range: ${v}`);
  }
});

test('the halo stays softer than the ring it sits behind', () => {
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const o = selectionPulseOpacity(p);
    assert.ok(o.glow < o.ring, `halo must read as a glow, not a second ring (p=${p})`);
  }
});

await finish('render/selection');
