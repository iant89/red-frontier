/**
 * @suite hud/maintenance
 * @group hud
 * @covers src/ui/HUD.ts src/sim/defs.ts
 * @desc Repair Bay discovery, installed part health, costs and live replacement
 * progress. Presentation only reads the host view; it never spends inventory.
 */
import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { test, finish } from '../harness';

const { doc, hud, sim, place } = await mountHud();
const bay = place('repairBay');
bay.state = 'online';
const r = sim.rovers[0];

test('the palette includes the Repair Bay and its refined construction cost', () => {
  const btn = [...doc.querySelectorAll('.build-btn')].find((b) => b.textContent?.includes('Repair Bay'));
  assert.ok(btn, 'the bay is buildable, not a hidden developer-only structure');
  assert.match(btn.textContent!, /20/);
});

test('rover health bars distinguish installed parts from routine condition', () => {
  r.condition = 100;
  r.parts.motor = 25;
  r.parts.circuitBoard = 65;
  hud.showRover(r, sim);
  assert.equal(doc.getElementById('i-cond')!.textContent, '100%');
  assert.equal(doc.getElementById('i-part-motor')!.textContent, '25%');
  assert.equal(doc.getElementById('i-part-circuitBoard')!.textContent, '65%');
  assert.equal(doc.getElementById('i-partbar-motor')!.style.width, '25%');
  assert.ok(doc.getElementById('i-partbar-motor')!.classList.contains('red'));
  assert.match(doc.getElementById('i-parts-note')!.textContent!, /Repair Bay/);
  assert.match(doc.getElementById('i-parts-note')!.textContent!, /1 matching spare/);
  const bar = doc.getElementById('i-partbar-motor');
  r.parts.motor = 100;
  hud.showRover(r, sim);
  assert.equal(doc.getElementById('i-partbar-motor'), bar, 'live updates keep the same controls');
  assert.equal(bar!.style.width, '100%');
});

test('the bay shows work, spare counts and missing-stock/brownout reasons in place', () => {
  bay.maintenance = { roverId: r.id, component: 'circuitBoard', progress: 0.4 };
  bay.idleReason = 'Needs 1 × Circuit Board from the Workshop';
  sim.components.motor = 2;
  sim.components.circuitBoard = 0;
  hud.showBuilding(bay, sim);
  assert.equal(doc.getElementById('b-maintenance')!.style.display, '');
  assert.match(doc.getElementById('b-maint-rover')!.textContent!, new RegExp(`#${r.id}`));
  assert.match(doc.getElementById('b-maint-part')!.textContent!, /Circuit Board · 40%/);
  assert.equal(doc.getElementById('b-maint-bar')!.style.width, '40%');
  assert.match(doc.getElementById('b-maint-stock')!.textContent!, /2 motors \/ 0 boards/);
  assert.match(doc.getElementById('b-maint-status')!.textContent!, /Needs 1/);
  const bar = doc.getElementById('b-maint-bar');
  bay.idleReason = 'No power — replacement paused';
  hud.showBuilding(bay, sim);
  assert.equal(doc.getElementById('b-maint-bar'), bar);
  assert.match(doc.getElementById('b-maint-status')!.textContent!, /No power/);
  assert.equal(sim.components.motor, 2, 'rendering cannot spend spares');
  bay.enabled = false;
  hud.showBuilding(bay, sim);
  assert.match(doc.getElementById('b-maint-status')!.textContent!, /Switched off/);
  bay.enabled = true;
  bay.damaged = true;
  hud.showBuilding(bay, sim);
  assert.match(doc.getElementById('b-maint-status')!.textContent!, /structural repair/);
  bay.damaged = false;
});

test('a rover being serviced points back to its bay and the progress', () => {
  bay.idleReason = 'Replacing Circuit Board — 40%';
  hud.showRover(r, sim);
  assert.match(doc.getElementById('i-parts-note')!.textContent!, /Replacing Circuit Board — 40%/);
  assert.match(doc.getElementById('i-parts-note')!.textContent!, new RegExp(`#${bay.id}`));
  bay.maintenance = null;
});

await finish('hud/maintenance');
