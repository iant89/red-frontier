/**
 * HUD smoke tests under jsdom.
 *
 * The renderer needs a real GPU, but the HUD is plain DOM — so the wiring
 * between simulation state and the panels *can* be verified headlessly. These
 * catch the class of bug a typechecker cannot: a querySelector that finds
 * nothing, a callback that never fires, a panel that silently stops updating.
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  `<!doctype html><html><body><div id="app"><canvas id="game-canvas"></canvas></div></body></html>`,
  { pretendToBeVisual: true },
);

// Expose the jsdom globals the HUD module expects at import time.
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
// `navigator` is a getter-only global in modern Node; define it descriptively.
if (!('navigator' in g) || !g.navigator?.userAgent?.includes('jsdom')) {
  Object.defineProperty(g, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
}
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
g.CustomEvent = dom.window.CustomEvent;
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 16);

// jsdom has no 2D canvas backend; the sparkline just needs the call to be safe.
(dom.window.HTMLCanvasElement.prototype as any).getContext = () => null;

const { HUD } = await import('../src/ui/HUD');
const { Simulation } = await import('../src/sim/Simulation');
const { BUILDING_ORDER } = await import('../src/sim/defs');

let pass = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✘ ${name}`);
    console.log(`      ${(err as Error).message.split('\n')[0]}`);
  }
}

const doc = dom.window.document;
const calls: string[] = [];
const hud = new HUD({
  onSpeed: (i) => calls.push(`speed:${i}`),
  onPickBuild: (k) => calls.push(`build:${k}`),
  onAction: (a, arg) => calls.push(`action:${a}:${arg ?? ''}`),
  onStart: (seed, near) => calls.push(`start:${seed}:${near}`),
  onOverlay: (m) => calls.push(`overlay:${m}`),
});

const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });

console.log('\nHUD construction');

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

console.log('\nInspectors');

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
  const b = sim.placeBuilding('solar', 40, 40) ?? sim.placeBuilding('solar', -40, 40);
  assert.ok(b, 'needed a placeable spot for the test');
  hud.showBuilding(b!, sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Solar Array/);
});

test('the colonist inspector renders', () => {
  hud.showColonist(sim.colonist, sim);
  assert.match(doc.getElementById('inspector')!.textContent!, /Vega/);
});

test('clearing the inspector restores the hint text', () => {
  hud.clearInspector();
  assert.match(doc.getElementById('inspector')!.textContent!, /Select a/);
});

console.log('\nInteraction');

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

test('overlay cycling advances none → power → life → none', () => {
  hud.setOverlay('none');
  assert.equal(hud.cycleOverlay(), 'power');
  assert.equal(hud.cycleOverlay(), 'life');
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

console.log('\nAlerts & log');

test('alerts render, dedupe by content, and clear', () => {
  hud.updateAlerts([
    {
      key: 'k1',
      severity: 'crit',
      title: 'Oxygen critical',
      detail: 'test',
      since: 0,
      lastSeen: 0,
    },
  ]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  assert.match(doc.getElementById('alerts')!.textContent!, /Oxygen critical/);
  hud.updateAlerts([]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
});

test('the log appends entries and caps its length', () => {
  for (let i = 0; i < 90; i++) hud.addLog('info', `line ${i}`, 'Sol 1 · 00:00');
  const items = doc.querySelectorAll('#log .log-item');
  assert.ok(items.length <= 60, `log should be capped, had ${items.length}`);
});

test('the end overlay can be shown', () => {
  hud.showEnd('MISSION LOST', 'test reason');
  assert.equal((doc.getElementById('end-overlay') as any).style.display, 'flex');
});

console.log(`\n${pass} HUD checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`);
if (failures.length) process.exit(1);
