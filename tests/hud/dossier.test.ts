/**
 * @suite hud/dossier
 * @group hud
 * @covers src/ui/HUD.ts src/sim/defs.ts
 * @desc The touch-only build dossier: hold to open, tap to arm, drift or lift to cancel.
 */

import assert from 'node:assert/strict';
import { mountHud, withFakeTimers, press } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud } = await mountHud();

group('Build dossier (touch hold)');

test('holding a blueprint opens its dossier and disarms the tap', () => {
  withFakeTimers((timers) => {
    calls.length = 0;
    hud.setBuild(null);
    const btn = doc.querySelectorAll('#buildbar .build-btn')[1] as any; // Solar Array
    press(btn, 'pointerdown');
    assert.ok(calls.includes('build:solar'), `the tap arms the blueprint first: ${calls}`);
    assert.ok(timers.pending(), 'a hold timer should be armed for touch');
    timers.fire(); // the hold elapses
    assert.ok(calls.includes('build:null'), `the hold disarms the tap: ${calls}`);
    const card = doc.querySelector('#build-info') as any;
    assert.equal(card.style.display, 'block', 'the dossier should open');
    assert.ok((doc.querySelector('#bi-name') as any).textContent.includes('Solar'));
    assert.ok((doc.querySelector('#bi-power') as any).textContent.includes('kW'));
    (doc.querySelector('#bi-close') as any).dispatchEvent(
      new dom.window.Event('pointerdown', { bubbles: true }),
    );
    assert.equal(card.style.display, 'none', '× closes the dossier');
  });
});

test('a mouse press never arms a dossier hold', () => {
  withFakeTimers((timers) => {
    const btn = doc.querySelectorAll('#buildbar .build-btn')[1] as any;
    const ev = new dom.window.Event('pointerdown', { bubbles: true }) as any;
    ev.pointerType = 'mouse';
    btn.dispatchEvent(ev);
    assert.equal(timers.pending(), false, 'desktop keeps hover; no hold timer');
    hud.setBuild(null);
  });
});

test('lifting the finger or drifting cancels the hold', () => {
  withFakeTimers((timers) => {
    const btn = doc.querySelectorAll('#buildbar .build-btn')[2] as any;
    press(btn, 'pointerdown', 100, 100);
    assert.ok(timers.pending());
    press(btn, 'pointerup', 100, 100);
    assert.equal(timers.pending(), false, 'a tap (up in time) cancels the hold');
    press(btn, 'pointerdown', 100, 100);
    press(btn, 'pointermove', 160, 100);
    assert.equal(timers.pending(), false, 'a swipe (drift) cancels the hold');
    assert.equal(
      (doc.querySelector('#build-info') as any).style.display,
      'none',
      'no dossier from a cancelled hold',
    );
    hud.setBuild(null);
  });
});

test('closeBuildInfo reports its state for Esc chaining', () => {
  hud.showBuildInfo('greenhouse');
  assert.equal((doc.querySelector('#build-info') as any).style.display, 'block');
  assert.ok((doc.querySelector('#bi-process') as any).textContent.length > 0);
  assert.equal(hud.closeBuildInfo(), true);
  assert.equal(hud.closeBuildInfo(), false);
});

await finish('hud/dossier');
