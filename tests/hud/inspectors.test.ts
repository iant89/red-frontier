/**
 * @suite hud/inspectors
 * @group hud
 * @covers src/ui/HUD.ts src/sim/Simulation.ts
 * @desc Selection and the inspector: rendering each entity kind, patching values in
 * place instead of rebuilding the panel, and the service dispatch button.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim, place } = await mountHud();
// Each suite sets up its own world; the monolith leaned on buildings that
// earlier cases had happened to place.
const solar = place('solar');

group('Inspectors');

test('the rover inspector renders and rebinds on selection change', () => {
  hud.showRover(sim.rovers[0], sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Mining Rover/);
  hud.showRover(sim.rovers[1], sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Utility Rover/);
});

test('the rover inspector patches values without rebuilding', () => {
  hud.showRover(sim.rovers[0], sim);
  const node = doc.querySelector('#i-bat');
  hud.showRover(sim.rovers[0], sim);
  assert.equal(doc.querySelector('#i-bat'), node, 'the same node should be reused');
});

test('the building inspector renders a placed site', () => {
  hud.showBuilding(solar, sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Solar Array/);
});

test('a dirty solar array shows its dust and a dispatch button that fires', () => {
  const b = sim.buildings.find((x) => x.kind === 'solar');
  assert.ok(b, 'this suite placed a solar array to inspect');
  (b as any).state = 'online';
  (b as any).cleanliness = 0.5;
  hud.showBuilding(b!, sim);
  const text = doc.getElementById('inspector')!.textContent!;
  assert.match(text, /Panel dust/);
  assert.match(text, /50% clean/);
  const svc = doc.getElementById('b-service') as any;
  assert.ok(svc, 'the dispatch button should exist');
  assert.equal(svc.style.display, '', 'the dispatch button should be visible');
  assert.match(svc.textContent, /Clean panels/);
  calls.length = 0;
  svc.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:service:'), `got ${JSON.stringify(calls)}`);
});

test('the colonist inspector renders', () => {
  hud.showColonist(sim.colonist, sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Vega/);
});

test('clearing the inspector restores the hint text', () => {
  hud.clearInspector();
  assert.match(doc.getElementById('inspector')!.textContent!, /Select a/);
});

await finish('hud/inspectors');
