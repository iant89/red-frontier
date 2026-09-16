/**
 * @suite hud/worldmap
 * @group hud
 * @covers src/ui/WorldMap.ts
 * @covers src/ui/HUD.ts
 * @covers tests/fixtures/hud.ts
 * @desc The world map is chrome, not a dependency of the colony: its canvas
 * paints when a 2D backend exists, and degrades to an empty card when one does
 * not — the HUD still mounts, and open/fit/close still work. This also pins the
 * jsdom canvas stub itself, because a `() => null` `getContext` silently
 * deletes every paint path in `ui/` from all HUD suites.
 */

import assert from 'node:assert/strict';
import { mountHud, paints, setCanvasBackend } from '../fixtures/hud';
import { WorldMapOverlay } from '../../src/ui/WorldMap';
import { group, test, finish } from '../harness';

const { doc, hud, sim } = await mountHud();

group('world map painting');

const drawn = (id: string) => paints.byCanvas[id] ?? 0;

test('the three HUD canvases are all live under the stub backend', () => {
  // A regression pin for the fixture: `getContext` answering null used to make
  // these paths untestable rather than failing, so check the harness is real.
  hud.openWorldMap();
  hud.updateMinimap(sim, { x: 0, z: 0 }, null);
  hud.updateVitals(sim);
  for (const id of ['worldmap-canvas', 'minimap-canvas', 'pw-graph']) {
    assert.ok(drawn(id) > 0, `#${id} was never drawn into`);
  }
  hud.closeWorldMap();
});

test('an open map repaints as the view moves, a closed one does not', () => {
  hud.openWorldMap();
  const openStart = drawn('worldmap-canvas');
  hud.updateMinimap(sim, { x: 40, z: -30 }, null);
  hud.updateMinimap(sim, { x: 80, z: -60 }, null);
  const openPaints = drawn('worldmap-canvas') - openStart;
  assert.ok(openPaints > 20, `two live frames drew ${openPaints} ops; expected a real frame each`);

  hud.closeWorldMap();
  const closedStart = drawn('worldmap-canvas');
  const minimapStart = drawn('minimap-canvas');
  hud.updateMinimap(sim, { x: 120, z: -90 }, null);
  assert.equal(drawn('worldmap-canvas') - closedStart, 0, 'a closed world map paints nothing: its loop is stopped');
  assert.ok(drawn('minimap-canvas') > minimapStart, 'while the minimap keeps drawing, so the counter is live');
});

test('the map button in the topbar toggles the overlay', () => {
  const btn = doc.getElementById('map-btn')!;
  assert.equal(hud.isWorldMapOpen(), false, 'starts closed');
  for (const type of ['pointerdown', 'click']) btn.dispatchEvent(new doc.defaultView!.Event(type, { bubbles: true }));
  assert.equal(hud.isWorldMapOpen(), true, 'the first press opens it');
  btn.dispatchEvent(new doc.defaultView!.Event('pointerdown', { bubbles: true }));
  assert.equal(hud.isWorldMapOpen(), false, 'the next press closes it');
});

group('degrading without a 2D context');

test('a canvas with no 2D context opens, fits and closes without throwing', () => {
  // This is the state `tests/fixtures/hud.ts` used to hand every suite, and it
  // used to be fatal: the overlay threw out of `HUD.buildChrome` and took the
  // whole HUD down. A refused context must cost the paint, never the chrome.
  const overlays = () => doc.querySelectorAll('#worldmap-overlay').length;
  const before = overlays();
  const beforePaints = paints.calls;
  const mapPaints = drawn('worldmap-canvas');
  setCanvasBackend('none');
  try {
    const bare = new WorldMapOverlay({});
    try {
      bare.open();
      assert.equal(bare.isVisible(), true, 'the overlay still reports itself open');
      bare.setView(sim as any, { x: 0, z: 0 }, null);
      bare.close();
      assert.equal(paints.calls - beforePaints, 0, 'and it drew nothing, because there was nothing to draw into');
      assert.equal(drawn('worldmap-canvas'), mapPaints, 'the shared map canvas was not touched either');
    } finally {
      // Leave the document holding exactly the one overlay the mounted HUD owns.
      doc.querySelectorAll('#worldmap-overlay')[before]?.remove();
    }
  } finally {
    setCanvasBackend('stub');
  }
  assert.equal(overlays(), before, 'the degraded overlay left the DOM as it found it');
});

test('the shared HUD map still paints after the backend comes back', () => {
  const before = drawn('worldmap-canvas');
  hud.openWorldMap();
  hud.updateMinimap(sim, { x: -20, z: 20 }, null);
  assert.ok(drawn('worldmap-canvas') > before, 'the knob is per-mount, not a broken global');
  hud.closeWorldMap();
});

await finish('hud/worldmap');
