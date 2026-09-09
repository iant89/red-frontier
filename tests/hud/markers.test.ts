/**
 * @suite hud/markers
 * @group hud
 * @covers src/ui/HUD.ts src/sim/Simulation.ts
 * @desc Off-screen markers: the edge chevrons for stranded rovers and damaged
 * structures, and the mirroring that keeps behind-the-camera ones honest.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim } = await mountHud();

group('Off-screen markers');

test('a stranded rover off-screen grows an edge marker that focuses on tap', () => {
  const r = sim.rovers[0];
  r.phase = 'disabled';
  hud.updateMarkers(sim, () => ({ x: 5000, y: 300, behind: false }));
  const marker = doc.querySelector('#markers .marker') as any;
  assert.ok(marker, 'expected a marker for the stranded rover');
  assert.ok(marker.textContent.includes('stranded'), `marker says: ${marker.textContent}`);
  assert.equal(marker.style.display, 'flex', 'off-screen: visible');
  const left = parseFloat(marker.style.left);
  assert.ok(left <= 1024 - 46 + 1, `clamped to the right edge, at ${left}`);
  calls.length = 0;
  marker.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes(`action:focus:${r.id}`), `expected focus, saw ${calls}`);
  // …but no marker while the camera can already see the trouble.
  hud.updateMarkers(sim, () => ({ x: 512, y: 384, behind: false }));
  assert.equal(marker.style.display, 'none', 'on-screen: hidden');
  r.phase = 'idle';
  hud.updateMarkers(sim, () => ({ x: 512, y: 384, behind: false }));
  assert.equal(doc.querySelectorAll('#markers .marker').length, 0, 'rescued: marker removed');
});

test('a damaged structure behind the camera lands on the correct edge', () => {
  let spot: { x: number; z: number } | null = null;
  for (let rad = 40; rad <= 120 && !spot; rad += 5) {
    for (let a = 0; a < 360 && !spot; a += 15) {
      const x = Math.cos((a * Math.PI) / 180) * rad;
      const z = Math.sin((a * Math.PI) / 180) * rad;
      if (sim.canPlace('solar', x, z) === null) spot = { x, z };
    }
  }
  assert.ok(spot, 'a legal spot for a sacrificial array');
  const b = sim.placeBuilding('solar', spot!.x, spot!.z)!;
  b.state = 'online';
  b.damaged = true;
  // Top-left projection, but behind the camera: the mirror must land it
  // bottom-right instead of trusting the flipped coordinates.
  hud.updateMarkers(sim, () => ({ x: 100, y: 100, behind: true }));
  const marker = doc.querySelector('#markers .marker') as any;
  assert.ok(marker, 'expected a marker for the damaged array');
  assert.equal(marker.style.display, 'flex', 'behind the camera still counts as off-screen');
  assert.ok(marker.textContent.includes('damaged'));
  assert.equal(parseFloat(marker.style.left), 1024 - 100, 'mirrored horizontally');
  assert.equal(parseFloat(marker.style.top), 768 - 100, 'mirrored vertically');
  sim.buildings.splice(sim.buildings.indexOf(b), 1);
  hud.updateMarkers(sim, () => ({ x: 512, y: 384, behind: false }));
  assert.equal(doc.querySelectorAll('#markers .marker').length, 0, 'repaired: marker removed');
});

await finish('hud/markers');
