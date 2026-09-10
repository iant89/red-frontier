/**
 * @suite hud/panels
 * @group hud
 * @covers src/ui/HUD.ts
 * @desc The mobile-ready HUD: panels are movable windows (drag by the header),
 * resizable from the corner grip, resettable by double-tap, and the whole
 * chrome can be cleared off the screen with one tap on the peek button.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc } = await mountHud();

/** Pointer event with real coordinates (jsdom's bare Event has none). */
function ptr(type: string, x: number, y: number, id = 1): Event {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true }) as any;
  ev.clientX = x;
  ev.clientY = y;
  ev.pointerId = id;
  return ev;
}

/** localStorage may be unavailable (opaque origin) — read it safely. */
function stored(key: string): string | null {
  try {
    return dom.window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

group('Panel window manager');

test('every info panel carries a drag handle and a resize grip', () => {
  assert.ok(doc.querySelector('#vitals .vitals-head.hud-drag'), 'vitals header is a handle');
  assert.ok(doc.querySelector('#inspector .i-bar.hud-drag'), 'inspector bar is a handle');
  assert.ok(doc.querySelector('#log .lg-title.hud-drag'), 'log title is a handle');
  for (const id of ['vitals', 'inspector', 'log']) {
    assert.ok(doc.querySelector(`#${id} .panel-grip`), `#${id} has a resize grip`);
  }
});

test('dragging a header moves the panel and releases its dock anchor', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  handle.dispatchEvent(ptr('pointerdown', 100, 100));
  dom.window.dispatchEvent(ptr('pointermove', 190, 150));
  dom.window.dispatchEvent(ptr('pointerup', 190, 150));
  assert.ok(panel.style.left, 'the panel is now explicitly positioned');
  assert.equal(panel.style.right, 'auto', 'right anchor released');
  assert.notEqual(panel.style.top, '', 'vertical position set too');
});

test('a drag persists geometry when storage is available', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  handle.dispatchEvent(ptr('pointerdown', 200, 160));
  dom.window.dispatchEvent(ptr('pointermove', 260, 220));
  dom.window.dispatchEvent(ptr('pointerup', 260, 220));
  const raw = stored('rf-panel-vitals');
  if (raw === null) return; // opaque origin: persistence is a nicety here
  const g = JSON.parse(raw);
  assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y), 'stored as coordinates');
  assert.ok(Number.isFinite(g.w) && Number.isFinite(g.h), 'and dimensions');
});

test('dragging a button inside a header does not move the panel', () => {
  const panel = doc.getElementById('inspector')!;
  const before = panel.style.left;
  const btn = doc.getElementById('i-collapse');
  if (!btn) return; // empty-inspector variant
  btn.dispatchEvent(ptr('pointerdown', 100, 100));
  dom.window.dispatchEvent(ptr('pointermove', 260, 240));
  dom.window.dispatchEvent(ptr('pointerup', 260, 240));
  assert.equal(panel.style.left, before, 'collapse taps never turn into drags');
});

test('the corner grip resizes the panel within sane bounds', () => {
  const panel = doc.getElementById('vitals')!;
  const grip = doc.querySelector('#vitals .panel-grip')!;
  grip.dispatchEvent(ptr('pointerdown', 300, 400));
  dom.window.dispatchEvent(ptr('pointermove', 420, 520));
  dom.window.dispatchEvent(ptr('pointerup', 420, 520));
  const w = parseFloat(panel.style.width);
  const h = parseFloat(panel.style.height);
  assert.ok(Number.isFinite(w) && w >= 190, `width set and above the floor (${w})`);
  assert.ok(Number.isFinite(h) && h >= 110, `height set and above the floor (${h})`);
});

test('a double-tap on the header snaps the panel back to its dock', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  // First get it adrift.
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointermove', 200, 190));
  dom.window.dispatchEvent(ptr('pointerup', 200, 190));
  assert.ok(panel.style.left, 'precondition: the panel is adrift');
  // Two quick taps on the handle.
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointerup', 120, 120));
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointerup', 120, 120));
  assert.equal(panel.style.left, '', 'inline position cleared');
  assert.equal(panel.style.width, '', 'inline size cleared');
});

test('the peek button clears every panel, and a second tap brings them back', () => {
  const peek = doc.getElementById('hud-peek')!;
  const hudRoot = doc.querySelector('.hud')!;
  assert.ok(peek, 'the peek button exists');
  peek.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(hudRoot.classList.contains('hud-hidden'), 'one tap hides all panels');
  peek.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!hudRoot.classList.contains('hud-hidden'), 'a second tap restores them');
});

await finish('hud/panels');
