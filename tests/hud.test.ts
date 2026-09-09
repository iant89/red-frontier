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
    'wx-block',
    'wx-badge',
    'wx-wind',
    'wx-arrow',
    'wx-dust-bar',
    'wx-vis-bar',
    'wx-status',
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

console.log('\nWeather');

test('the weather panel reflects the sim state', () => {
  sim.weather.dust = 0.5;
  sim.weather.visibility = 0.4;
  sim.weather.windSpeed = 33;
  hud.updateVitals(sim);
  assert.match(doc.getElementById('wx-wind')!.textContent!, /33 m\/s/);
  assert.equal(doc.getElementById('wx-dust-bar')!.style.width, '50%');
  assert.equal(doc.getElementById('wx-vis-bar')!.style.width, '40%');
  assert.match(doc.getElementById('wx-status')!.textContent!, /sunlight through the dust/);
  assert.match(doc.getElementById('wx-badge')!.textContent!, /Clear/);
});

test('an active storm names itself in the badge and status line', () => {
  const wx: any = sim.weather;
  wx.debugScheduleStorm('regional', sim.simTime, 0);
  for (let i = 0; i < 20 * 20; i++) sim.step(1 / 20); // 20 s: storm ramped up
  hud.updateVitals(sim);
  assert.match(doc.getElementById('wx-badge')!.textContent!, /Regional dust storm/);
  assert.match(doc.getElementById('wx-status')!.textContent!, /passing in/);
  // clean up so later tests run in calm weather
  (wx as any).active = null;
  wx.stormIntensity = 0;
  wx.storm = 'calm';
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

test('a dirty solar array shows its dust and a dispatch button that fires', () => {
  const b = sim.buildings.find((x) => x.kind === 'solar');
  assert.ok(b, 'the earlier tests placed a solar array');
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

console.log('\nPrototype 4 HUD');

test('the rover inspector shows the task queue and a queued WAIT label', () => {
  const rv = sim.rovers[0];
  hud.showRover(rv, sim);
  sim.issueMove(rv.id, 40, 0);
  sim.issueWait(rv.id, 30, true);
  hud.showRover(rv, sim);
  const items = doc.querySelectorAll('#i-route .route-item');
  assert.ok(items.length >= 2, `queue should list tasks, got ${items.length}`);
  assert.match(items[0]!.textContent!, /Move/);
  assert.match(items[1]!.textContent!, /Wait/);
});

test('a mining rover offers the repeat-haul toggle, and it fires', () => {
  const rv = sim.rovers[0];
  sim.stopRover(rv.id);
  const ice = sim.world.deposits.find((d) => d.resource === 'ice')!;
  sim.issueMine(rv.id, ice.id);
  hud.showRover(rv, sim);
  const rep = doc.getElementById('i-repeat') as any;
  assert.ok(rep, 'the repeat button should exist for a mining rover');
  assert.equal(rep.style.display, '', 'and be visible');
  calls.length = 0;
  rep.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:repeathaul:'), `got ${JSON.stringify(calls)}`);
});

test('rule checkboxes and the charge slider fire actions', () => {
  const rv = sim.rovers[1];
  hud.showRover(rv, sim);
  const haul = doc.getElementById('r-haul') as any;
  assert.equal(haul.checked, true, 'auto-haul is on by default');
  haul.checked = false;
  calls.length = 0;
  haul.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(calls.includes('action:rule-haul:0'), `got ${JSON.stringify(calls)}`);

  const slider = doc.getElementById('r-charge') as any;
  slider.value = '45';
  calls.length = 0;
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(calls.includes('action:rule-charge:45'), `got ${JSON.stringify(calls)}`);
});

test('the wait button queues a hold via the wait action', () => {
  const rv = sim.rovers[1];
  hud.showRover(rv, sim);
  const btn = doc.querySelector('[data-act="wait"]') as any;
  assert.ok(btn, 'the wait button should exist');
  calls.length = 0;
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:wait:60'), `got ${JSON.stringify(calls)}`);
});

test('a garage shows its assembly line with one button per rover kind', () => {
  const b = sim.placeBuilding('garage', -60, -60) ?? sim.placeBuilding('garage', 60, -60);
  assert.ok(b, 'needed a placeable spot for the garage');
  (b as any).state = 'online';
  hud.showBuilding(b!, sim);
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
  assert.ok(b, 'the earlier test placed a garage');
  (b as any).assembly = { kind: 'mining', progress: 0.4 };
  hud.showBuilding(b!, sim);
  assert.equal(
    (doc.getElementById('b-asm-btns') as any).style.display,
    'none',
    'buttons should hide while building',
  );
  assert.match(doc.getElementById('b-asm-label')!.textContent!, /Mining Rover — 40%/);
});test('clearing the inspector restores the hint text', () => {
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

console.log('\nMobile HUD: collapse & dismiss');

test('the vitals panel collapses to its header and back', () => {
  const panel = doc.getElementById('vitals')!;
  const btn = doc.getElementById('vitals-toggle') as any;
  assert.ok(btn, 'the vitals toggle should exist');
  assert.ok(!panel.classList.contains('collapsed'), 'starts expanded on desktop widths');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(panel.classList.contains('collapsed'), 'collapses on toggle');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!panel.classList.contains('collapsed'), 'expands again');
});

test('the build bar folds down to its toggle and back', () => {
  const bar = doc.getElementById('buildbar')!;
  const toggle = doc.getElementById('build-toggle') as any;
  assert.ok(toggle, 'the build toggle should exist');
  assert.ok(!bar.classList.contains('bar-hidden'), 'starts expanded');
  toggle.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(bar.classList.contains('bar-hidden'), 'folds on toggle');
  toggle.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!bar.classList.contains('bar-hidden'), 'unfolds again');
});

test('the inspector collapses, re-opens on a fresh selection, and deselects via ×', () => {
  hud.showRover(sim.rovers[0], sim);
  const panel = doc.getElementById('inspector')!;
  assert.ok(!panel.classList.contains('collapsed'), 'a fresh selection opens the panel');
  (doc.getElementById('i-collapse') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(panel.classList.contains('collapsed'), 'collapses on toggle');
  // Selecting something else re-opens it.
  hud.showBuilding(sim.buildings[0], sim);
  assert.ok(!panel.classList.contains('collapsed'), 'a new selection re-opens the panel');
  calls.length = 0;
  (doc.getElementById('i-close') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:deselect:'), `got ${JSON.stringify(calls)}`);
});

test('tapping an alert dismisses it, leaving a restore chip', () => {
  const a = {
    key: 'k-tap',
    severity: 'warn' as const,
    title: 'Test warning',
    detail: 'tap me',
    since: 0,
    lastSeen: 0,
  };
  hud.updateAlerts([a]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  calls.length = 0;
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(
    doc.querySelectorAll('#alerts .alert').length,
    0,
    'the tapped alert should disappear',
  );
  assert.ok(doc.querySelector('#alerts .alerts-restore'), 'a restore chip should remain');
  assert.equal(calls.length, 0, 'a plain alert fires no action');
  // The same condition staying live stays hidden…
  hud.updateAlerts([a]);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  // …until the chip brings it back.
  (doc.querySelector('#alerts .alerts-restore') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  hud.updateAlerts([]);
});

test('tapping a focusable alert focuses and dismisses; × dismisses silently', () => {
  const a = {
    key: 'k-focus',
    severity: 'crit' as const,
    title: 'Stranded',
    detail: 'go',
    since: 0,
    lastSeen: 0,
    entityId: 1001,
  };
  hud.updateAlerts([a]);
  calls.length = 0;
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:focus:1001'), `got ${JSON.stringify(calls)}`);
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);

  hud.updateAlerts([a]); // still dismissed…
  (doc.querySelector('#alerts .alerts-restore') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  calls.length = 0;
  (doc.querySelector('#alerts .a-x') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(calls.length, 0, '× must not move the camera');
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  hud.updateAlerts([]);
});

test('a dismissed alert returns if its condition clears and re-raises', () => {
  const a = {
    key: 'k-back',
    severity: 'warn' as const,
    title: 'Comeback',
    detail: 'x',
    since: 0,
    lastSeen: 0,
  };
  hud.updateAlerts([a]);
  (doc.querySelector('#alerts .alert') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 0);
  hud.updateAlerts([]); // condition resolves — the dismissal is forgotten
  hud.updateAlerts([a]); // …so a re-raise is seen again
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 1);
  hud.updateAlerts([]);
});

console.log(`\n${pass} HUD checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`);
if (failures.length) process.exit(1);
