/**
 * @suite hud/controls
 * @group hud
 * @covers src/ui/HUD.ts src/sim/defs.ts
 * @desc The toolbar end of the HUD: build palette, speed, overlay cycling, the start
 * overlay, and affordability turning blueprints off.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim } = await mountHud();

group('Interaction');

test('build buttons fire onPickBuild', () => {
  calls.length = 0;
  const btn = doc.querySelectorAll('.build-btn')[0] as any;
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(
    calls.some((c) => c.startsWith('build:')),
    `expected a build callback, got ${JSON.stringify(calls)}`,
  );
});

test('speed buttons fire onSpeed and mark themselves active', () => {
  calls.length = 0;
  const btns = doc.querySelectorAll('.speed-btn');
  (btns[2] as any).dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('speed:2'), `got ${JSON.stringify(calls)}`);
  assert.ok((btns[2] as any).classList.contains('active'));
});

test('the start button reports the chosen seed', () => {
  calls.length = 0;
  (doc.getElementById('seed-input') as any).value = 'olympus';
  (doc.getElementById('start-btn') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(
    calls.some((c) => c.startsWith('start:olympus')),
    `got ${JSON.stringify(calls)}`,
  );
});

test('overlay cycling advances none → power → life → weather → none', () => {
  hud.setOverlay('none');
  assert.equal(hud.cycleOverlay(), 'power');
  assert.equal(hud.cycleOverlay(), 'life');
  assert.equal(hud.cycleOverlay(), 'weather');
  assert.equal(hud.cycleOverlay(), 'none');
});

test('unaffordable blueprints are visually disabled', () => {
  for (const r of Object.keys(sim.storage) as Array<keyof typeof sim.storage>) {
    sim.storage[r] = 0;
  }
  hud.updateAffordability(sim);
  assert.ok(
    doc.querySelectorAll('.build-btn.unaffordable').length > 0,
    'a broke colony should grey out the palette',
  );
});

await finish('hud/controls');
