/**
 * @suite hud/chrome
 * @group hud
 * @covers src/ui/HUD.ts
 * @desc Every panel the HUD patches exists in the DOM, and the topbar reads live values.
 */

import assert from 'node:assert/strict';
import { mountHud, loadDefs } from '../fixtures/hud';
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

await finish('hud/chrome');
