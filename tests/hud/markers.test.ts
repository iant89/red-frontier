/**
 * @suite hud/markers
 * @group hud
 * @covers src/ui/HUD.ts src/sim/Simulation.ts src/sim/pois.ts
 * @desc Off-screen markers: the edge chevrons for stranded rovers, damaged
 * structures and supply drops with a deadline; the mirroring that keeps
 * behind-the-camera ones honest; and the site inspector.
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

test('a live supply drop gets an edge marker with its deadline, and a buried one does not', () => {
  const drop = sim.world.addPoi({
    kind: 'supplyDrop',
    x: 320,
    z: 120,
    salvage: { iron: 640, silicon: 210 },
    energyKWh: 0,
    discovered: true,
    solsToBury: 2.4,
    buried: false,
    manifest: 'Replacement parts',
  });
  hud.updateMarkers(sim, () => ({ x: 5000, y: 300, behind: false }));
  const marker = [...doc.querySelectorAll('#markers .marker')].find((n) =>
    (n as HTMLElement).textContent!.includes('Drop'),
  ) as HTMLElement | undefined;
  assert.ok(marker, 'a drop over the horizon should be marked');
  assert.ok(marker!.textContent!.includes('2.4 sols'), `marker says: ${marker!.textContent}`);
  assert.ok(marker!.className.includes('warn'), 'comfortable deadline reads as a warning');

  // Inside its last sol the marker escalates — that is the point of showing it.
  drop.solsToBury = 0.6;
  hud.updateMarkers(sim, () => ({ x: 5000, y: 300, behind: false }));
  assert.ok(marker!.className.includes('crit'), 'the last sol should read as critical');

  // A site is not an entity, so the marker must not claim to focus one.
  calls.length = 0;
  marker!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(
    calls.filter((c) => c.startsWith('action:focus')).length,
    0,
    `a drop marker should not focus an entity, saw ${calls}`,
  );

  // Buried, it is history rather than a deadline.
  drop.buried = true;
  hud.updateMarkers(sim, () => ({ x: 5000, y: 300, behind: false }));
  assert.equal(
    [...doc.querySelectorAll('#markers .marker')].filter((n) =>
      (n as HTMLElement).textContent!.includes('Drop'),
    ).length,
    0,
    'a buried drop stops being marked',
  );
  sim.world.pois.splice(sim.world.pois.indexOf(drop), 1);
  hud.updateMarkers(sim, () => ({ x: 512, y: 384, behind: false }));
});

test('the site inspector shows what is out there, and how long a drop has left', () => {
  const drop = sim.world.addPoi({
    kind: 'supplyDrop',
    x: 260,
    z: -40,
    salvage: { iron: 700, aluminum: 260 },
    energyKWh: 45,
    discovered: true,
    solsToBury: 1.75,
    buried: false,
    manifest: 'Replacement parts',
  });
  hud.showPoi(drop, sim);
  const insp = doc.querySelector('#inspector') as HTMLElement;
  const text = insp.textContent!;
  assert.ok(text.includes('Supply Drop'), `panel names the site: ${text.slice(0, 120)}`);
  assert.ok(text.includes('Replacement parts'), 'the manifest Earth sent is shown');
  assert.ok(text.includes('Iron Ore') && text.includes('700'), 'bulk salvage is listed');
  assert.ok(text.includes('45 kWh'), 'surviving cells are listed');
  assert.ok(text.includes('1.8 sols'), `the deadline is shown, got: ${text.slice(0, 200)}`);

  // A stripped, buried container reads as lost rather than as an empty list.
  drop.salvage = {};
  drop.energyKWh = 0;
  drop.buried = true;
  hud.showPoi(drop, sim, true);
  const after = (doc.querySelector('#inspector') as HTMLElement).textContent!;
  assert.ok(after.includes('Buried'), 'a buried site says so');
  assert.ok(!after.includes('1.8 sols'), 'a buried site has no deadline left');
  sim.world.pois.splice(sim.world.pois.indexOf(drop), 1);
});

await finish('hud/markers');
