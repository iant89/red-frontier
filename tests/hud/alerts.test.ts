/**
 * @suite hud/alerts
 * @group hud
 * @covers src/ui/HUD.ts src/sim/alerts.ts
 * @desc Alerts and the log, the autopause promise, and the history modal.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim, HUD } = await mountHud();

group('Alerts & log');

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

group('Autopause on critical');

test('autopause defaults off and toggles with persistence', () => {
  const btn = doc.querySelector('#autopause-btn') as any;
  assert.ok(btn, 'expected an autopause toggle in the speed toolbar');
  assert.equal(btn.getAttribute('aria-pressed'), 'false', 'opt-in: off unless enabled');
  calls.length = 0;
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(hud.autopauseOnCrit, true);
  // A memory-backed localStorage proves the preference persists to a new HUD.
  const store = new Map<string, string>([['rf-autopause', '1']]);
  const mem = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const w = dom.window as any;
  const real = Object.getOwnPropertyDescriptor(w, 'localStorage');
  Object.defineProperty(w, 'localStorage', { value: mem, configurable: true });
  try {
    const hud2 = new HUD({
      onSpeed: () => {},
      onPickBuild: () => {},
      onAction: () => {},
      onStart: () => {},
      onOverlay: () => {},
    });
    assert.equal(hud2.autopauseOnCrit, true, 'a fresh HUD reads the stored preference');
    // Tear its DOM back out: duplicate panel IDs would confuse later queries.
    const roots = doc.querySelectorAll('#app > .hud');
    roots[roots.length - 1]?.remove();
  } finally {
    if (real) Object.defineProperty(w, 'localStorage', real);
    else delete w.localStorage;
  }
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(hud.autopauseOnCrit, false, 'toggle back off for the tests below');
});

test('a new critical alert pauses the game only when opted in', () => {
  hud.setSpeed(1);
  hud.updateAlerts([]); // baseline: nothing critical
  hud.setAutopause(false);
  hud.updateAlerts([
    { key: 'oxygen-low', severity: 'crit', title: 'O2 critical', detail: 'dying', since: 0, lastSeen: 0 },
  ]);
  assert.equal(hud.speedIdx, 1, 'opted out: the game keeps running');
  hud.setSpeed(1);
  hud.updateAlerts([]); // the condition clears…
  hud.setAutopause(true);
  calls.length = 0;
  hud.updateAlerts([
    { key: 'oxygen-low', severity: 'crit', title: 'O2 critical', detail: 'dying', since: 0, lastSeen: 0 },
  ]);
  assert.equal(hud.speedIdx, 0, 'opted in: a fresh critical pauses');
  assert.ok(calls.includes('speed:0'), `expected onSpeed(0), saw ${calls}`);
  hud.setAutopause(false);
});

test('a repeating critical never re-pauses after the player resumes', () => {
  hud.setAutopause(true);
  hud.setSpeed(1);
  hud.updateAlerts([
    { key: 'oxygen-low', severity: 'crit', title: 'O2 critical', detail: 'dying', since: 0, lastSeen: 0 },
  ]);
  assert.equal(hud.speedIdx, 1, 'already-seen key: no pause');
  hud.updateAlerts([
    { key: 'oxygen-low', severity: 'crit', title: 'O2 critical', detail: 'still dying', since: 0, lastSeen: 0 },
    { key: 'grid-down', severity: 'crit', title: 'Grid brownout', detail: 'dark', since: 0, lastSeen: 0 },
  ]);
  assert.equal(hud.speedIdx, 0, 'a second, genuinely new critical pauses');
  hud.setSpeed(1); // the player resumes into the crisis…
  hud.updateAlerts([
    { key: 'oxygen-low', severity: 'crit', title: 'O2 critical', detail: 'still dying', since: 0, lastSeen: 0 },
    { key: 'grid-down', severity: 'crit', title: 'Grid brownout', detail: 'dark', since: 0, lastSeen: 0 },
  ]);
  assert.equal(hud.speedIdx, 1, 'repeats after resume do not re-pause');
  hud.updateAlerts([]);
  hud.setAutopause(false);
  hud.setSpeed(1);
});

group('Alert history');

test('the history modal lists past events, newest first', () => {
  sim.alerts.reset();
  sim.alerts.event('info', 'first thing', 1, 'Sol 1 · 08:00');
  sim.alerts.event('crit', 'bad thing', 2, 'Sol 1 · 09:00');
  sim.alerts.event('warn', 'worrying thing', 3, 'Sol 1 · 10:00');
  hud.updateAlerts(sim.alerts.list(), sim.alerts);
  (doc.querySelector('#history-btn') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  const ov = doc.querySelector('#history-overlay') as any;
  assert.equal(ov.style.display, 'flex', 'the modal should open');
  const items = doc.querySelectorAll('#hist-list .hist-item');
  assert.equal(items.length, 3);
  assert.ok(items[0].textContent.includes('worrying thing'), 'newest first');
  assert.ok(items[2].textContent.includes('first thing'), 'oldest last');
  assert.ok((doc.querySelector('#hist-count') as any).textContent.includes('3 events'));
});

test('severity chips filter the history', () => {
  const chip = (sev: string) => doc.querySelector(`#hist-chips [data-sev="${sev}"]`) as any;
  chip('crit').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  let items = doc.querySelectorAll('#hist-list .hist-item');
  assert.equal(items.length, 1, 'only the crit survives the filter');
  assert.ok(items[0].textContent.includes('bad thing'));
  assert.ok(chip('crit').classList.contains('active'), 'the active chip reads as active');
  chip('ok').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  items = doc.querySelectorAll('#hist-list .hist-item');
  assert.equal(items.length, 0, 'nothing ok happened');
  assert.ok(doc.querySelector('#hist-list .hist-empty'), 'an empty filter says so');
  chip('all').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(doc.querySelectorAll('#hist-list .hist-item').length, 3);
});

test('the history modal closes via × and reports its state for Esc', () => {
  assert.equal(hud.closeAlertHistory(), true, 'open → closes and reports true');
  assert.equal((doc.querySelector('#history-overlay') as any).style.display, 'none');
  assert.equal(hud.closeAlertHistory(), false, 'already closed → false, so Esc falls through');
  (doc.querySelector('#history-btn') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  (doc.querySelector('#hist-close') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.equal((doc.querySelector('#history-overlay') as any).style.display, 'none');
  sim.alerts.reset();
});

await finish('hud/alerts');
