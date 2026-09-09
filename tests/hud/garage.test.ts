/**
 * @suite hud/garage
 * @group hud
 * @covers src/ui/HUD.ts src/sim/defs.ts
 * @desc The assembly line in the inspector: one button per rover kind, and progress
 * in place of the buttons while the line is busy.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim, place } = await mountHud();

const garage = place('garage');
garage.state = 'online';

group('The garage in the HUD');

test('a garage shows its assembly line with one button per rover kind', () => {
  hud.showBuilding(garage, sim);
  const garageBlock = doc.getElementById('b-garage')!;
  assert.equal(garageBlock.style.display, '', 'the assembly block should be visible');
  for (const kind of ['utility', 'mining', 'cargo']) {
    const btn = doc.getElementById(`asm-${kind}`) as any;
    assert.ok(btn, `assembly button for ${kind} should exist`);
    const pretty = kind === 'utility' ? 'Utility' : kind === 'mining' ? 'Mining' : 'Cargo';
    assert.match(btn.textContent, new RegExp(pretty));
  }
  calls.length = 0;
  doc
    .getElementById('asm-cargo')!
    .dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:assemble:cargo'), `got ${JSON.stringify(calls)}`);
});

test('a busy assembly line hides the buttons and shows progress', () => {
  const b = sim.buildings.find((x) => x.kind === 'garage');
  assert.ok(b, 'this suite placed a garage');
  (b as any).assembly = { kind: 'mining', progress: 0.4 };
  hud.showBuilding(b!, sim);
  assert.equal(
    (doc.getElementById('b-asm-btns') as any).style.display,
    'none',
    'buttons should hide while building',
  );
  assert.match(doc.getElementById('b-asm-label')!.textContent!, /Mining Rover — 40%/);
});

await finish('hud/garage');
