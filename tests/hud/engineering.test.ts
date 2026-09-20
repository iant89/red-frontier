/**
 * @suite hud/engineering
 * @group hud
 * @covers src/ui/EngineeringPanel.ts src/ui/ItemIcons.ts src/app/EngineeringController.ts src/app/SelectionController.ts
 * @desc Engineering interaction, pause ownership, icon prices, role-specific
 * options, manufacturing, paint previews and keyboard isolation.
 */
import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { EngineeringPanel } from '../../src/ui/EngineeringPanel';
import { EngineeringController } from '../../src/app/EngineeringController';
import { SelectionController } from '../../src/app/SelectionController';
import { ALL_RESOURCES, ALL_COMPONENTS } from '../../src/sim/defs';
import { test, finish } from '../harness';
const { doc, dom, hud, sim, place } = await mountHud();
const garage = place('garage');
sim.devCompleteBuilding(garage.id);
const shop = place('workshop');
sim.devCompleteBuilding(shop.id);
const r = sim.rovers[0];
sim.stopRover(r.id);
r.x = garage.x + 10;
r.z = garage.z;
r.recharge = false;
for (const k of ALL_RESOURCES) sim.storage[k] = 1000;
for (const k of ALL_COMPONENTS) sim.components[k] = 24;
const target = { entity: 'rover' as const, id: r.id };
const commands: any[] = [],
  paints: any[] = [];
let closed = 0;
const panel = new EngineeringPanel(target, {
  close: () => closed++,
  command: (c) => commands.push(c),
  action: () => {},
  previewPaint: (c) => paints.push(c),
  garage: () => {},
});
panel.mount();
panel.update(sim);
const click = (selector: string) => {
  (panel.root.querySelector(selector) as HTMLElement).click();
};

test('upgrade screen shows actual aluminum ore and motor icons, prices and before/after stats', () => {
  assert.match(panel.root.textContent!, /Drivetrain/);
  assert.match(panel.root.textContent!, /Miner teeth/);
  assert.ok(panel.root.querySelector('svg[aria-label="Aluminum Ore"]'));
  assert.ok(panel.root.querySelector('svg[aria-label="Drive Motor"]'));
  assert.match(
    panel.root.querySelector('[data-upgrade-card="cargo"]')!.textContent!,
    /100 kg/,
  );
  const stock = sim.storage.steel;
  click('[data-upgrade="cargo"]');
  assert.deepEqual(commands.at(-1), {
    type: 'engineering/upgrade',
    ...target,
    upgrade: 'cargo',
  });
  assert.equal(sim.storage.steel, stock);
});
test('shortages disable upgrades and survive updates without rebuilding a stationary panel', () => {
  sim.components.motor = 0;
  panel.update(sim);
  assert.equal(
    (
      panel.root.querySelector(
        '[data-upgrade="drivetrain"]',
      ) as HTMLButtonElement
    ).disabled,
    true,
  );
  const card = panel.root.querySelector('[data-upgrade-card="cargo"]');
  panel.update(sim);
  assert.equal(panel.root.querySelector('[data-upgrade-card="cargo"]'), card);
  sim.components.motor = 24;
});
test('paint previews are local until Apply, and escape cannot leak a world hotkey', () => {
  click('[data-tab="appearance"]');
  click('[data-paint="#d67635"]');
  assert.equal(paints.at(-1), '#d67635');
  assert.equal(r.paint, undefined);
  click('.engineering-apply');
  assert.deepEqual(commands.at(-1), {
    type: 'engineering/paint',
    ...target,
    paint: '#d67635',
  });
  doc.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(closed, 1);
  panel.dispose();
});
test('all six Workshop lines are available with ingredient/output pictograms', () => {
  const p = new EngineeringPanel(
    { entity: 'building', id: shop.id },
    {
      close: () => {},
      command: (c) => commands.push(c),
      action: () => {},
      previewPaint: () => {},
      garage: () => {},
    },
  );
  p.mount();
  p.update(sim);
  (p.root.querySelector('[data-tab="actions"]') as HTMLElement).click();
  assert.equal(p.root.querySelectorAll('[data-recipe]').length, 6);
  assert.match(p.root.textContent!, /Battery Packs/);
  assert.ok(p.root.querySelector('svg[aria-label="Drill Teeth"]'));
  (p.root.querySelector('[data-recipe="5"]') as HTMLElement).click();
  assert.equal(commands.at(-1).recipe, 5);
  p.dispose();
});
test('engineering controller pauses and restores exactly the previous speed, including already paused', () => {
  const host = { send: () => {} } as any;
  const controller = new EngineeringController({
    getHost: () => host,
    getSim: () => sim,
    getRenderer: () => ({ previewEntity: () => null }) as any,
    hud,
    blocked: () => false,
    action: () => {},
  });
  hud.setSpeed(3);
  controller.open(target);
  assert.equal(hud.speedIdx, 0);
  assert.ok(controller.isOpen);
  controller.close();
  assert.equal(hud.speedIdx, 3);
  assert.equal(controller.close(), false);
  hud.setSpeed(0);
  controller.open(target);
  controller.close();
  assert.equal(hud.speedIdx, 0);
});
test('context-clicking an entity opens engineering before any terrain move; empty ground still moves', () => {
  let hit: any = { type: 'rover', id: r.id };
  const opened: any[] = [],
    sent: any[] = [];
  const selection = new SelectionController({
    getRenderer: () => ({
      pickTargetAt: () => hit,
      raycastTerrain: () => ({ x: 70, z: 80 }),
    }),
    getSim: () => sim,
    getHost: () => ({ send: (c: any) => sent.push(c) }),
    uiCoversPoint: () => false,
    getPendingBuild: () => null,
    isShiftHeld: () => false,
    audio: { command: () => {} },
    syncUI: () => {},
    openEngineering: (t: any) => opened.push(t),
  } as any);
  selection.contextTap(20, 30);
  assert.deepEqual(opened, [target]);
  assert.equal(sent.length, 0);
  hit = { type: 'building', id: shop.id };
  selection.contextTap(20, 30);
  assert.equal(opened.at(-1)!.entity, 'building');
  selection.selected = { type: 'rover', id: r.id };
  hit = null;
  selection.contextTap(20, 30);
  assert.equal(sent.at(-1).type, 'rover/move');
});
await finish('hud/engineering');
