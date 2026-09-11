/**
 * @suite hud/chrome
 * @group hud
 * @covers src/ui/HUD.ts
 * @desc Every panel the HUD patches exists in the DOM, the topbar reads live
 * values, and the speed selector cannot hand the frame loop an undefined
 * multiplier.
 */

import assert from 'node:assert/strict';
import { mountHud, loadDefs } from '../fixtures/hud';
import { SPEEDS } from '../../src/sim/config';
import { group, test, finish } from '../harness';

const { doc, hud, sim } = await mountHud();
const { BUILDING_ORDER } = await loadDefs();

group('HUD construction');

test('every panel the HUD patches actually exists in the DOM', () => {
  for (const id of [
    'topbar',
    'vitals',
    'alerts',
    'inspector',
    'buildbar',
    'log',
    'clock-line',
    'pw-gen',
    'pw-load',
    'pw-bat',
    'pw-batbar',
    'pw-flow',
    'tiers',
    'life-block',
    'crew-name',
    'crew-hp-bar',
    'crew-suit-bar',
    'start-overlay',
    'end-overlay',
    'wx-block',
    'wx-badge',
    'wx-wind',
    'wx-arrow',
    'wx-dust-bar',
    'wx-vis-bar',
    'wx-status',
  ]) {
    assert.ok(doc.getElementById(id), `#${id} is missing`);
  }
});

test('the build palette renders every blueprint', () => {
  const btns = doc.querySelectorAll('.build-btn');
  assert.equal(btns.length, BUILDING_ORDER.length, 'one button per blueprint');
});

test('vitals update without throwing and show live values', () => {
  hud.updateVitals(sim);
  const clock = doc.getElementById('clock-line')!.textContent!;
  assert.match(clock, /^Sol \d+ · \d\d:\d\d$/, `clock format was "${clock}"`);
  assert.match(doc.getElementById('pw-gen')!.textContent!, /kW/);
  assert.match(doc.getElementById('pw-bat')!.textContent!, /%/);
});

test('vitals track the simulation as it advances', () => {
  const before = doc.getElementById('clock-line')!.textContent;
  for (let i = 0; i < 20 * 120; i++) sim.step(1 / 20);
  hud.updateVitals(sim);
  assert.notEqual(doc.getElementById('clock-line')!.textContent, before, 'clock should advance');
});

test('life-support rows reflect the pools', () => {
  hud.updateVitals(sim);
  const rows = doc.querySelectorAll('#life-block .life-row');
  assert.equal(rows.length, 3, 'water, oxygen and food');
  const text = doc.getElementById('life-block')!.textContent!;
  assert.match(text, /Water/);
  assert.match(text, /Oxygen/);
  assert.match(text, /Food/);
});

test('power tier rows render one per priority tier', () => {
  const rows = doc.querySelectorAll('#tiers .tier-row');
  assert.equal(rows.length, 4);
});

group('Speed selection');

/**
 * An index outside `SPEEDS` used to be stored verbatim, and the frame loop reads
 * `SPEEDS[speedIdx]` — `undefined`, which fails `speed > 0`, which pauses the
 * colony *while the 4× button stayed lit*. A game that stops without saying so is
 * the one failure mode a setter must not make available, so the clamp is the
 * feature, and the highlighted button has to follow it.
 */
test('a speed index outside the table clamps instead of freezing the world', () => {
  hud.setSpeed(SPEEDS.length - 1);
  assert.equal(hud.speedIdx, SPEEDS.length - 1, 'the top speed is reachable');
  hud.setSpeed(99);
  assert.equal(hud.speedIdx, SPEEDS.length - 1, 'an index above the table lands on the top speed');
  assert.ok(SPEEDS[hud.speedIdx] > 0, 'and the frame loop still gets a multiplier');
  assert.equal(
    [...doc.querySelectorAll('.speed-btn')].findIndex((b) => b.classList.contains('active')),
    SPEEDS.length - 1,
    'the highlighted button is the one actually in force',
  );
  hud.setSpeed(-2);
  assert.equal(hud.speedIdx, 0, 'a negative index lands on paused, which is what 0 means');
  hud.setSpeed(Number.NaN);
  assert.equal(hud.speedIdx, 0, 'and a non-number does too, rather than poisoning the clock');
  hud.setSpeed(1);
  assert.equal(hud.speedIdx, 1, 'normal selection is untouched');
});

await finish('hud/chrome');
