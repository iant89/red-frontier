/**
 * @suite hud/mobile
 * @group hud
 * @covers src/ui/HUD.ts
 * @desc Small-screen behaviour: folding panels away, and dismissing alerts by tap.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim, place } = await mountHud();
// The inspector collapse case selects a structure, so give it one.
const array = place('solar');

group('Mobile HUD: collapse & dismiss');

test('the vitals panel collapses to its header and back', () => {
  const panel = doc.getElementById('vitals')!;
  const btn = doc.getElementById('vitals-toggle') as any;
  assert.ok(btn, 'the vitals toggle should exist');
  assert.ok(!panel.classList.contains('collapsed'), 'starts expanded on desktop widths');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(panel.classList.contains('collapsed'), 'collapses on toggle');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!panel.classList.contains('collapsed'), 'expands again');
});

test('the build bar folds down to its toggle and back', () => {
  const bar = doc.getElementById('buildbar')!;
  const toggle = doc.getElementById('build-toggle') as any;
  assert.ok(toggle, 'the build toggle should exist');
  assert.ok(!bar.classList.contains('bar-hidden'), 'starts expanded');
  toggle.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(bar.classList.contains('bar-hidden'), 'folds on toggle');
  toggle.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!bar.classList.contains('bar-hidden'), 'unfolds again');
});

test('the inspector collapses, re-opens on a fresh selection, and deselects via ×', () => {
  hud.showRover(sim.rovers[0], sim);
  const panel = doc.getElementById('inspector')!;
  assert.ok(!panel.classList.contains('collapsed'), 'a fresh selection opens the panel');
  (doc.getElementById('i-collapse') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(panel.classList.contains('collapsed'), 'collapses on toggle');
  // Selecting something else re-opens it.
  hud.showBuilding(array, sim);
  assert.ok(!panel.classList.contains('collapsed'), 'a new selection re-opens the panel');
  calls.length = 0;
  (doc.getElementById('i-close') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:deselect:'), `got ${JSON.stringify(calls)}`);
});

test('tapping an alert dismisses it, leaving a restore chip', () => {
  const a = {
    key: 'k-tap',
    severity: 'warn' as const,
    title: 'Test warning',
    detail: 'tap me',
    since: 0,
    lastSeen: 0,
  };
  hud.updateAlerts([a]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  calls.length = 0;
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(
    doc.querySelectorAll('#alerts .alert').length,
    0,
    'the tapped alert should disappear',
  );
  assert.ok(doc.querySelector('#alerts .alerts-restore'), 'a restore chip should remain');
  assert.equal(calls.length, 0, 'a plain alert fires no action');
  // The same condition staying live stays hidden…
  hud.updateAlerts([a]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  // …until the chip brings it back.
  (doc.querySelector('#alerts .alerts-restore') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  hud.updateAlerts([]);
});

test('tapping a focusable alert focuses and dismisses; × dismisses silently', () => {
  const a = {
    key: 'k-focus',
    severity: 'crit' as const,
    title: 'Stranded',
    detail: 'go',
    since: 0,
    lastSeen: 0,
    entityId: 1001,
  };
  hud.updateAlerts([a]);
  calls.length = 0;
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:focus:1001'), `got ${JSON.stringify(calls)}`);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);

  hud.updateAlerts([a]); // still dismissed…
  (doc.querySelector('#alerts .alerts-restore') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  calls.length = 0;
  (doc.querySelector('#alerts .a-x') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(calls.length, 0, '× must not move the camera');
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  hud.updateAlerts([]);
});

test('a dismissed alert returns if its condition clears and re-raises', () => {
  const a = {
    key: 'k-back',
    severity: 'warn' as const,
    title: 'Comeback',
    detail: 'x',
    since: 0,
    lastSeen: 0,
  };
  hud.updateAlerts([a]);
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  hud.updateAlerts([]); // condition resolves — the dismissal is forgotten
  hud.updateAlerts([a]); // …so a re-raise is seen again
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  hud.updateAlerts([]);
});

await finish('hud/mobile');
