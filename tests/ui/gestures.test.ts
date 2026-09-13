/**
 * @suite ui/gestures
 * @group unit
 * @covers src/app/gestures.ts
 * @desc The camera gesture map (issue #1): one finger pans on touch, two
 * fingers look around when one is resting, pinch always zooms, and the desktop
 * mouse map is left alone. Pure functions — no DOM, no real touch events.
 */

import assert from 'node:assert/strict';
import {
  singlePointerGesture,
  twoPointerGesture,
  isResting,
  STILL_EPS,
  REST_TRAVEL_PX,
} from '../../src/app/gestures';
import { group, test, finish } from '../harness';

const d = (dx: number, dy: number, travel = Math.hypot(dx, dy)) => ({ dx, dy, travel });

group('One finger');

test('a single touch drag pans — the bug this issue is about', () => {
  const g = singlePointerGesture({ touch: true, panModifier: false, dx: 40, dy: -12 });
  assert.equal(g.kind, 'pan');
  assert.deepEqual(g.kind === 'pan' && [g.dx, g.dy], [40, -12]);
});

test('pan is 1:1 — the delta is passed through untouched, no damping', () => {
  for (const [dx, dy] of [
    [3, 4],
    [-120, 60],
    [0, 250],
  ]) {
    const g = singlePointerGesture({ touch: true, panModifier: false, dx, dy });
    assert.ok(g.kind === 'pan' && g.dx === dx && g.dy === dy, `${dx},${dy} passed through`);
  }
});

test('a resting finger does not jitter the camera', () => {
  const g = singlePointerGesture({
    touch: true,
    panModifier: false,
    dx: STILL_EPS / 2,
    dy: -STILL_EPS / 2,
  });
  assert.equal(g.kind, 'none');
});

test('desktop mouse still orbits on a plain drag', () => {
  const g = singlePointerGesture({ touch: false, panModifier: false, dx: 30, dy: 10 });
  assert.equal(g.kind, 'orbit');
});

test('shift-drag and middle-drag still pan on desktop', () => {
  const g = singlePointerGesture({ touch: false, panModifier: true, dx: 30, dy: 10 });
  assert.equal(g.kind, 'pan');
});

group('Resting finger detection');

test('a planted finger reads as resting even with capacitive jitter', () => {
  assert.ok(isResting(d(0.4, 0.3, REST_TRAVEL_PX - 1), d(20, 0, 120)));
});

test('an anchor that slides a little is still an anchor', () => {
  // 20px of slide against 200px of travel is clearly the anchor.
  assert.ok(isResting(d(1, 0, 20), d(10, 0, 200)));
});

test('two fingers both travelling far is not a look gesture', () => {
  assert.ok(!isResting(d(10, 0, 140), d(10, 0, 150)));
});

group('Two fingers');

test('one finger resting, the other dragging, orbits — and never zooms', () => {
  const rest = d(0, 0, 2);
  const mover = d(25, -8, 140);
  const g = twoPointerGesture(rest, mover, 200, 202, 200);
  assert.ok(g.orbit, 'should orbit');
  assert.deepEqual([g.orbit!.dx, g.orbit!.dy], [25, -8]);
  assert.equal(g.dolly, 1, 'a look must not also zoom the camera');
});

test('the travelling finger drives the orbit regardless of pointer order', () => {
  const rest = d(0, 0, 2);
  const mover = d(25, -8, 140);
  const a = twoPointerGesture(rest, mover, 200, 202, 200);
  const b = twoPointerGesture(mover, rest, 200, 202, 200);
  assert.deepEqual(a.orbit, b.orbit, 'argument order must not matter');
  assert.equal(a.dolly, 1);
  assert.equal(b.dolly, 1);
});

test('a long tangential look holds its zoom: span drift is second-order', () => {
  // One finger planted, the other dragged 90px straight up from a 100px span:
  // the span drifted ~35px purely by geometry. That drift must not zoom.
  const rest = d(0, 0, 1);
  const mover = d(0, -11, 90);
  const g = twoPointerGesture(rest, mover, 131, 134.5, 100);
  assert.ok(g.orbit, 'the look continues');
  assert.equal(g.dolly, 1, 'tangential span drift must not zoom the camera');
});

test('pinching apart zooms and does not sneak in an orbit', () => {
  // One-sided pinch: the mover dragged 90px radially, so the span drifted ~90.
  const g = twoPointerGesture(d(0, 0, 2), d(11, 0, 90), 185, 190, 100);
  assert.ok(g.dolly < 1, `separating fingers zoom in: ${g.dolly}`);
  assert.equal(g.orbit, null, 'a straight pinch must not also swing the camera');
});

test('pinching together zooms the other way', () => {
  const g = twoPointerGesture(d(0, 0, 2), d(-11, 0, 90), 105, 100, 190);
  assert.ok(g.dolly > 1, `converging fingers zoom out: ${g.dolly}`);
  assert.equal(g.orbit, null);
});

test('a symmetric pinch zooms: both fingers travel, the span doubles it', () => {
  const g = twoPointerGesture(d(-9, 0, 45), d(9, 0, 45), 185, 190, 100);
  assert.ok(g.dolly < 1, `separating fingers zoom in: ${g.dolly}`);
  assert.equal(g.orbit, null, 'neither finger is an anchor');
});

test('a slow pinch still zooms — no per-event floor on the dolly', () => {
  // A quarter-pixel frame at a high event rate: accumulated drift still
  // dominates accumulated travel, so the dolly applies.
  const g = twoPointerGesture(d(0, 0, 1), d(0.3, 0, 12), 189.3, 189, 200);
  assert.ok(g.dolly !== 1, 'a slow span change still dollies');
  assert.equal(g.orbit, null);
});

test('anchor wobble during a look zooms nothing and orbits nothing', () => {
  // Only the anchor moved this frame (sub-pixel breathing against the glass).
  const g = twoPointerGesture(d(0.4, 0.2, 3), d(0, 0, 60), 201.4, 201, 200);
  assert.equal(g.dolly, 1, 'wobble under the pinch floor must not zoom');
  assert.equal(g.orbit, null, 'the mover did not move this frame');
});

test('two resting fingers do nothing at all', () => {
  const g = twoPointerGesture(d(0, 0, 1), d(0.2, 0.1, 1), 150, 150, 150);
  assert.equal(g.orbit, null);
  assert.equal(g.dolly, 1, 'no span change means no zoom');
});

test('there is no midpoint pan on two fingers any more', () => {
  // Both fingers sweeping together used to pan *and* dolly, which fought each
  // other and made panning feel broken. Now it is not a pan at all.
  const g = twoPointerGesture(d(30, 0, 150), d(30, 0, 150), 120, 120, 120);
  assert.equal(g.dolly, 1, 'a rigid translation changes no span');
  assert.equal(g.orbit, null, 'and neither finger is an anchor');
});

await finish('ui/gestures');
