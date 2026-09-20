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

test('live power and weather updates patch cards without remounting or disturbing focus', () => {
  const power = { key: 'power-deficit', severity: 'warn' as const, title: 'Power deficit', detail: '10 kW', since: 0, lastSeen: 0 };
  const weather = { ...power, key: 'weather', title: 'Dust storm', detail: 'Arriving in 20 s' };
  hud.updateAlerts([power, weather]);
  const cards = [...doc.querySelectorAll('#alerts .alert')];
  const button = cards[0].querySelector('button')!;
  button.focus();
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(doc.getElementById('alerts')!, { childList: true });
  hud.updateAlerts([{ ...power, detail: '11 kW' }, { ...weather, detail: 'Arriving in 19 s' }]);
  assert.equal(observer.takeRecords().length, 0, 'no card insertions/removals on a text update');
  observer.disconnect();
  assert.deepEqual([...doc.querySelectorAll('#alerts .alert')], cards);
  assert.equal(doc.activeElement, button);
  assert.match(cards[0].textContent!, /11 kW/);
  assert.match(cards[1].textContent!, /19 s/);
  // Title and focus target can change independently of the detail text.
  hud.updateAlerts([{ ...power, title: 'Grid brownout', severity: 'crit', entityId: 42 }, weather]);
  assert.equal(doc.querySelector('#alerts .alert'), cards[0]);
  assert.match(cards[0].textContent!, /Grid brownout/);
  assert.ok(cards[0].classList.contains('crit'));
  calls.length = 0;
  cards[0].dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:focus:42'), 'the retained listener reads the latest focus target');
  assert.equal(doc.querySelector('#alerts .alert'), cards[1], 'dismissing power leaves weather mounted');
  doc.querySelector('#alerts .alerts-restore')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 2);
  assert.equal(doc.querySelectorAll('#alerts .alert')[1], cards[1]);
  calls.length = 0;
  cards[1].querySelector('button')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(calls.length, 0, 'dismiss button does not focus');
  hud.updateAlerts([]);
});

test('alerts retain keyed identity when reordered and respect the six-card limit', () => {
  const alerts = Array.from({ length: 7 }, (_, i) => ({
    key: `limit-${i}`, severity: 'warn' as const, title: `Alert ${i}`, detail: 'test', since: 0, lastSeen: 0,
  }));
  hud.updateAlerts(alerts);
  const cards = [...doc.querySelectorAll('#alerts .alert')];
  assert.equal(cards.length, 6);
  hud.updateAlerts([alerts[1], alerts[0], ...alerts.slice(2)]);
  assert.equal(doc.querySelectorAll('#alerts .alert')[0], cards[1]);
  assert.equal(doc.querySelectorAll('#alerts .alert')[1], cards[0]);
  hud.updateAlerts(alerts.slice(1));
  assert.equal(doc.querySelectorAll('#alerts .alert').length, 6);
  assert.equal(doc.querySelectorAll('#alerts .alert')[0], cards[1]);
  assert.equal(doc.querySelectorAll('#alerts .alert')[5].getAttribute('data-key'), 'limit-6');
  hud.updateAlerts([]);
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
