/**
 * @suite hud/panels
 * @group hud
 * @covers src/ui/HUD.ts
 * @desc The mobile-ready HUD: panels are movable windows (drag by the header),
 * resizable from the corner grip, resettable by double-tap, and the whole
 * chrome can be cleared off the screen with one tap on the peek button.
 */

import assert from 'node:assert/strict';
import { mountHud, loadDefs } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, hud, sim, calls } = await mountHud();
const { BUILDINGS } = await loadDefs();

/** Pointer event with real coordinates (jsdom's bare Event has none). */
function ptr(type: string, x: number, y: number, id = 1): Event {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true }) as any;
  ev.clientX = x;
  ev.clientY = y;
  ev.pointerId = id;
  return ev;
}

/** localStorage may be unavailable (opaque origin) — read it safely. */
function stored(key: string): string | null {
  try {
    return dom.window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

group('Panel window manager');

test('every info panel carries a drag handle and a resize grip', () => {
  assert.ok(doc.querySelector('#vitals .vitals-head.hud-drag'), 'vitals header is a handle');
  assert.ok(doc.querySelector('#inspector .i-bar.hud-drag'), 'inspector bar is a handle');
  assert.ok(doc.querySelector('#log .lg-title.hud-drag'), 'log title is a handle');
  for (const id of ['vitals', 'inspector', 'log']) {
    assert.ok(doc.querySelector(`#${id} .panel-grip`), `#${id} has a resize grip`);
  }
});

test('dragging a header moves the panel and releases its dock anchor', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  handle.dispatchEvent(ptr('pointerdown', 100, 100));
  dom.window.dispatchEvent(ptr('pointermove', 190, 150));
  dom.window.dispatchEvent(ptr('pointerup', 190, 150));
  assert.ok(panel.style.left, 'the panel is now explicitly positioned');
  assert.equal(panel.style.right, 'auto', 'right anchor released');
  assert.notEqual(panel.style.top, '', 'vertical position set too');
});

test('a drag persists geometry when storage is available', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  handle.dispatchEvent(ptr('pointerdown', 200, 160));
  dom.window.dispatchEvent(ptr('pointermove', 260, 220));
  dom.window.dispatchEvent(ptr('pointerup', 260, 220));
  const raw = stored('rf-panel-vitals');
  if (raw === null) return; // opaque origin: persistence is a nicety here
  const g = JSON.parse(raw);
  assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y), 'stored as coordinates');
  assert.ok(Number.isFinite(g.w) && Number.isFinite(g.h), 'and dimensions');
});

test('dragging a button inside a header does not move the panel', () => {
  const panel = doc.getElementById('inspector')!;
  const before = panel.style.left;
  const btn = doc.getElementById('i-collapse');
  if (!btn) return; // empty-inspector variant
  btn.dispatchEvent(ptr('pointerdown', 100, 100));
  dom.window.dispatchEvent(ptr('pointermove', 260, 240));
  dom.window.dispatchEvent(ptr('pointerup', 260, 240));
  assert.equal(panel.style.left, before, 'collapse taps never turn into drags');
});

test('the corner grip resizes the panel within sane bounds', () => {
  const panel = doc.getElementById('vitals')!;
  const grip = doc.querySelector('#vitals .panel-grip')!;
  grip.dispatchEvent(ptr('pointerdown', 300, 400));
  dom.window.dispatchEvent(ptr('pointermove', 420, 520));
  dom.window.dispatchEvent(ptr('pointerup', 420, 520));
  const w = parseFloat(panel.style.width);
  const h = parseFloat(panel.style.height);
  assert.ok(Number.isFinite(w) && w >= 190, `width set and above the floor (${w})`);
  assert.ok(Number.isFinite(h) && h >= 110, `height set and above the floor (${h})`);
});

test('a double-tap on the header snaps the panel back to its dock', () => {
  const panel = doc.getElementById('vitals')!;
  const handle = doc.querySelector('#vitals .vitals-head')!;
  // First get it adrift.
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointermove', 200, 190));
  dom.window.dispatchEvent(ptr('pointerup', 200, 190));
  assert.ok(panel.style.left, 'precondition: the panel is adrift');
  // Two quick taps on the handle.
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointerup', 120, 120));
  handle.dispatchEvent(ptr('pointerdown', 120, 120));
  dom.window.dispatchEvent(ptr('pointerup', 120, 120));
  assert.equal(panel.style.left, '', 'inline position cleared');
  assert.equal(panel.style.width, '', 'inline size cleared');
});

test('the peek button clears every panel, and a second tap brings them back', () => {
  const peek = doc.getElementById('hud-peek')!;
  const hudRoot = doc.querySelector('.hud')!;
  assert.ok(peek, 'the peek button exists');
  peek.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(hudRoot.classList.contains('hud-hidden'), 'one tap hides all panels');
  peek.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!hudRoot.classList.contains('hud-hidden'), 'a second tap restores them');
});

group('Project pip (Phase 2)');

test('the vitals header carries the current project and its count', () => {
  hud.updateVitals(sim as any);
  const pip = doc.getElementById('proj-pip') as HTMLElement;
  assert.ok(pip, 'the pip exists');
  assert.notEqual(pip.style.display, 'none', 'and shows from sol 1');
  assert.match(pip.textContent ?? '', /^Establish Survival 0\/5$/);
  assert.ok(pip.classList.contains('idle'), 'nothing done yet reads as idle');
  assert.match(pip.title, /next: Oxygen generator online/);
  const chip = doc.getElementById('auto-chip') as HTMLElement;
  assert.match(chip.textContent ?? '', /^Autonomy \d+\.\d sols · OPERATOR$/, 'the autonomy headline sits beside it');
  assert.ok(chip.classList.contains('operator'));
});

test('the projects panel carries the Standing Orders card and turns its inputs into policy commands', async () => {
  const { ProjectsPanel } = await import('../../src/ui/ProjectsPanel');
  const { grantUnlock } = await import('../../src/sim/unlocks');
  const sent: Array<Record<string, unknown>> = [];
  const panel = new ProjectsPanel({ onPolicy: (cmd) => sent.push(cmd) });
  panel.update(sim as any);
  const root = doc.getElementById('projects-panel')!;
  assert.ok(root.querySelector('.pol-card.locked'), 'a fresh colony has not earned standing orders');

  grantUnlock(sim.state.unlocks, 'advancedAutomation', 'test', sim.clock.sol, sim.state.ticksRun);
  panel.update(sim as any);
  const row = root.querySelector('.pol-row[data-policy="stockpile"]') as HTMLElement;
  assert.ok(row && !root.querySelector('.pol-card.locked'));
  const toggle = row.querySelector('[data-pol-on]') as HTMLInputElement;
  const num = row.querySelector('[data-pol-num="minKg"]') as HTMLInputElement;
  toggle.checked = true;
  num.value = '350';
  num.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(sent.at(-1), { type: 'policy/stockpile', on: true, resource: 'ice', minKg: 350 });

  const shelter = root.querySelector('.pol-row[data-policy="stormShelter"] [data-pol-on]') as HTMLInputElement;
  shelter.checked = true;
  shelter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(sent.at(-1), { type: 'policy/stormShelter', on: true });
});

test('a locked blueprint is marked on the bar and a click explains rather than arms', () => {
  const saved = BUILDINGS.repairBay.requiresUnlock;
  BUILDINGS.repairBay.requiresUnlock = 'stableOperations';
  try {
    hud.updateAffordability(sim as any);
    const btn = doc.querySelector('.build-btn.locked') as HTMLElement;
    assert.ok(btn, 'the sealed blueprint is marked');
    assert.match(btn.querySelector('.lock')?.textContent ?? '', /Stable Operations/);
    const before = calls.length;
    btn.dispatchEvent(ptr('pointerdown', 10, 10));
    assert.equal(calls.slice(before).filter((c) => c.startsWith('build:')).length, 0, 'no build was armed');
    const hint = doc.getElementById('hintbar') as HTMLElement;
    assert.match(hint.textContent ?? '', /Stable Operations/, 'the hintbar says why');
  } finally {
    BUILDINGS.repairBay.requiresUnlock = saved;
    hud.updateAffordability(sim as any);
    assert.equal(doc.querySelector('.build-btn.locked'), null, 'and it unseals when the gate is lifted');
  }
});

await finish('hud/panels');
