/**
 * @suite hud/water
 * @group hud
 * @covers src/ui/WaterPanel.ts src/ui/HUD.ts src/app/SelectionController.ts src/sim/defs.ts
 * @desc Stable pipe destination controls, costs, commissioning, live buffers,
 * overlay discovery, and player-intent routing without view mutation.
 */
import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { SelectionController } from '../../src/app/SelectionController';
import { test, finish } from '../harness';
const { doc, dom, hud, sim, place, calls } = await mountHud();
const pump = place('pumpStation');
sim.devCompleteBuilding(pump.id);
const extractor = place('extractor');
sim.devCompleteBuilding(extractor.id);
const shop = place('workshop');
sim.devCompleteBuilding(shop.id);
sim.components.pipe = 30;
const el = (name: string) =>
  doc.querySelector(`[data-water="${name}"]`) as HTMLElement;

test('pump/tank blueprints, pipe recipe and dedicated overlay are discoverable', () => {
  const palette = [...doc.querySelectorAll('.build-btn')]
    .map((b) => b.textContent)
    .join(' ');
  assert.match(palette, /Pump Station/);
  assert.match(palette, /Water Tank/);
  hud.showBuilding(shop, sim);
  assert.match(doc.getElementById('b-recipe')!.textContent!, /Water Pipes/);
  const overlay = doc.querySelector('button[title^="Water network"]')!;
  overlay.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('overlay:water'));
});

test('pipe controls preserve focus/selection and only emit intents', () => {
  hud.showBuilding(pump, sim);
  const target = el('target') as HTMLSelectElement;
  assert.ok(
    [...target.options].some((o) => o.value === '0'),
    'pod can be connected without world-picking',
  );
  target.value = String(extractor.id);
  target.dispatchEvent(new dom.window.Event('change'));
  target.focus();
  const stock = sim.components.pipe;
  el('connect').dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes(`action:water-connect:${extractor.id}`));
  assert.equal(sim.components.pipe, stock);
  assert.equal(sim.state.water.links.length, 0);
  hud.showBuilding(pump, sim, true);
  assert.equal(el('target'), target);
  assert.equal(doc.activeElement, target);
  assert.equal(target.value, String(extractor.id));
  assert.match(el('mode').textContent!, /Temporary shared plumbing/);
  assert.equal((el('commission') as HTMLButtonElement).disabled, true);
});

test('connect/disconnect and commissioning availability update in place', () => {
  sim.connectWater(0, pump.id);
  sim.connectWater(pump.id, extractor.id);
  pump.loadKw = 6;
  pump.powerSat = 1;
  hud.showBuilding(pump, sim, true);
  assert.equal((el('connect') as HTMLButtonElement).disabled, true);
  assert.equal((el('disconnect') as HTMLButtonElement).disabled, false);
  assert.equal((el('commission') as HTMLButtonElement).disabled, false);
  el('commission').dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:water-commission:'));
  assert.equal(sim.state.water.active, false, 'button did not mutate sim');
  assert.ok(sim.commissionWater());
  hud.showBuilding(pump, sim, true);
  assert.match(el('buffer').textContent!, /Local buffer:/);
  assert.equal(el('commission').style.display, 'none');
  sim.disconnectWater(pump.id, extractor.id);
  hud.showBuilding(extractor, sim);
  assert.equal(el('status').textContent, 'Not connected');
  assert.match(el('buffer').textContent!, /remains usable/);
});

test('SelectionController maps pod ID zero and commission to host commands', () => {
  const commands: unknown[] = [];
  const selection = new SelectionController({
    getSim: () => sim,
    getHost: () => ({ send: (c: unknown) => commands.push(c) }),
    audio: { command: () => {} },
    syncUI: () => {},
  } as any);
  selection.selected = { type: 'building', id: pump.id };
  selection.handleAction('water-connect', '0');
  selection.handleAction('water-disconnect', '0');
  selection.handleAction('water-commission');
  selection.handleAction('water-connect', 'NaN');
  assert.deepEqual(commands, [
    { type: 'water/connect', a: pump.id, b: 0 },
    { type: 'water/disconnect', a: pump.id, b: 0 },
    { type: 'water/commission' },
  ]);
});
await finish('hud/water');
