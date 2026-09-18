/**
 * @suite hud/pause-menu
 * @group hud
 * @covers src/ui/PauseMenu.ts
 * @covers src/ui/HUD.ts
 * @desc The in-game pause menu renders its three tabs and fires its callbacks,
 * its settings controls report through their contract, and the HUD's save
 * progress overlay + save-failed prompt stage, phrase and recover correctly.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { PauseMenu, type ColonyStats, type PauseMenuSettings } from '../../src/ui/PauseMenu';
import { group, test, finish } from '../harness';

const { hud, dom } = await mountHud();
const win = dom.window as any;

// ------------------------------------------------------------------ helpers --

function stats(over: Partial<ColonyStats> = {}): ColonyStats {
  return {
    name: 'Ares Expedition',
    clockText: 'Sol 3 · 14:32',
    difficulty: 'Pioneer',
    worldSize: 'Territory',
    region: 'Hellas Basin',
    seedText: 'mars2066',
    solsPlayed: 3.4,
    power: { genKw: 12.5, loadKw: 8.1, batteryPct: 63, curtailKw: 0 },
    resources: [
      { label: 'Iron', amount: 1200, capacity: 4000 },
      { label: 'Titanium', amount: 80, capacity: 4000 },
    ],
    fluids: [
      { label: 'Water', amount: 42.5, capacity: 120, netPerSol: 12.4 },
      { label: 'Oxygen', amount: 30, capacity: 100, netPerSol: -1.2 },
      { label: 'Food', amount: 55, capacity: 80, netPerSol: 0.1 },
    ],
    crew: { name: 'Cmdr. Vega', status: 'Sheltered', healthPct: 98, suitPct: 100, inside: true },
    fleet: { total: 2, working: 1, idle: 1, stranded: 0, avgBatteryPct: 71, avgConditionPct: 92 },
    structures: { total: 6, online: 5, building: 1, damaged: 0 },
    weather: { storm: 'Clear', wind: 12, dustPct: 18, visibilityPct: 96 },
    alerts: { crit: 0, warn: 1, opportunity: 2 },
    lastSave: { at: Date.now() - 1000, ok: true },
    gameOver: { active: false, reason: '' },
    ...over,
  };
}

type SpySettings = PauseMenuSettings & { calls: string[] };

function settingsView(over: Partial<PauseMenuSettings> = {}): SpySettings {
  const calls: string[] = [];
  const base: PauseMenuSettings = {
    autopauseOnCrit: false,
    saveOnTabHide: true,
    autosaveIntervalSec: 45,
    renderResolution: 'ultra',
    shadows: true,
    weatherFx: true,
    hudPanelsHidden: false,
    onAutopause: (on) => calls.push(`autopause:${on}`),
    onSaveOnTabHide: (on) => calls.push(`savehide:${on}`),
    onAutosaveInterval: (s) => calls.push(`autosave:${s}`),
    onRenderResolution: (r) => calls.push(`res:${r}`),
    onShadows: (on) => calls.push(`shadows:${on}`),
    onWeatherFx: (on) => calls.push(`fx:${on}`),
    onHudPanelsHidden: (on) => calls.push(`hud:${on}`),
    onResetPanelLayout: () => calls.push('reset'),
    ...over,
  };
  return { ...base, calls } as PauseMenuSettings & { calls: string[] };
}

function makeMenu(opts: {
  getStats?: () => ColonyStats | null;
  settings?: SpySettings;
}): {
  menu: PauseMenu;
  calls: string[];
  s: SpySettings;
} {
  const s = opts.settings ?? settingsView();
  const calls = s.calls;
  const menu = new PauseMenu({
    getStats: opts.getStats ?? (() => stats()),
    settings: s as PauseMenuSettings,
    onResume: () => calls.push('resume'),
    onSave: () => calls.push('save'),
    onReturnToMenu: () => calls.push('quit'),
  });
  return { menu, calls, s };
}

const click = (el: Element | null): void => {
  if (!el) throw new Error('element missing');
  el.dispatchEvent(new win.Event('click', { bubbles: true }));
};

/** The HUD wires its buttons to pointerdown, not click. */
const press = (el: Element | null): void => {
  if (!el) throw new Error('element missing');
  el.dispatchEvent(new win.Event('pointerdown', { bubbles: true, cancelable: true }));
};

const change = (el: Element | null): void => {
  if (!el) throw new Error('element missing');
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};

// ------------------------------------------------------------- construction --

group('Construction');

test('the pause menu mounts its three tabs and the action buttons', () => {
  const { menu } = makeMenu({});
  const root = menu.root;
  assert.ok(root.classList.contains('rf-pause'), 'themed overlay');
  assert.ok(root.querySelector('.rf-bg.frost'), 'the frost veil over the live colony');
  const tabs = [...root.querySelectorAll<HTMLElement>('.rf-tab')].map((t) => t.dataset.tab);
  assert.deepEqual(tabs, ['actions', 'settings', 'expedition']);
  assert.ok(root.querySelector('[data-act="resume2"]'), 'resume button');
  assert.ok(root.querySelector('[data-act="save"]'), 'save button');
  assert.ok(root.querySelector('[data-act="quit"]'), 'return-to-menu button');
});

test('the colony clock renders from the stats pull', () => {
  const { menu } = makeMenu({ getStats: () => stats({ clockText: 'Sol 9 · 04:12' }) });
  const clock = menu.root.querySelector('[data-part="clock"]') as HTMLElement;
  assert.equal(clock.textContent, 'Sol 9 · 04:12');
});

group('Actions tab');

test('resume, save and quit each fire their own callback', () => {
  const { menu, calls } = makeMenu({});
  menu.mount();
  click(menu.root.querySelector('[data-act="resume"]'));
  click(menu.root.querySelector('[data-act="resume2"]'));
  click(menu.root.querySelector('[data-act="save"]'));
  click(menu.root.querySelector('[data-act="quit"]'));
  assert.deepEqual(calls, ['resume', 'resume', 'save', 'quit']);
  menu.unmount();
});

test('tab switching shows exactly one body', () => {
  const { menu } = makeMenu({});
  const body = (id: string) => menu.root.querySelector(`[data-body="${id}"]`) as HTMLElement;
  assert.equal(body('actions').style.display, '', 'actions visible by default');
  assert.equal(body('settings').style.display, 'none');
  click(menu.root.querySelector('[data-tab="settings"]'));
  assert.equal(body('settings').style.display, '');
  assert.equal(body('actions').style.display, 'none');
  click(menu.root.querySelector('[data-tab="expedition"]'));
  assert.equal(body('expedition').style.display, '');
  assert.equal(body('settings').style.display, 'none');
});

group('Settings tab');

test('toggles flip their state and report through the contract', () => {
  const { menu, calls } = makeMenu({});
  const toggle = (id: string) => menu.root.querySelector(`#${id}`) as HTMLElement;
  assert.equal(toggle('pm-set-autopause').getAttribute('aria-checked'), 'false');
  assert.equal(toggle('pm-set-savehide').getAttribute('aria-checked'), 'true');
  click(toggle('pm-set-autopause'));
  assert.equal(toggle('pm-set-autopause').getAttribute('aria-checked'), 'true', 'state flipped');
  click(toggle('pm-set-autopause'));
  assert.equal(toggle('pm-set-autopause').getAttribute('aria-checked'), 'false', 'and back');
  click(toggle('pm-set-shadows'));
  assert.deepEqual(calls, ['autopause:true', 'autopause:false', 'shadows:false']);
});

test('the autosave and resolution selects report their values', () => {
  const { menu, calls } = makeMenu({});
  const sels = [...menu.root.querySelectorAll('select.rf-set-select')] as HTMLSelectElement[];
  assert.ok(sels.length >= 2, 'autosave + render resolution at minimum');
  const autosave = sels.find((s) => s.value === '45')!;
  assert.ok(autosave, 'the 45 s default is selected');
  autosave.value = '120';
  change(autosave);
  const res = sels.find((s) => s.value === 'ultra')!;
  res.value = 'performance';
  change(res);
  assert.deepEqual(calls, ['autosave:120', 'res:performance']);
});

test('the interface section exposes the panel-layout reset', () => {
  const { menu, calls } = makeMenu({});
  const btn = menu.root.querySelector('.rf-set-reset') as HTMLElement;
  assert.ok(btn, 'restore defaults button');
  click(btn);
  assert.deepEqual(calls, ['reset']);
});

group('Expedition tab');

test('the expedition tab renders the full colony portrait', () => {
  const { menu } = makeMenu({
    getStats: () =>
      stats({
        lastSave: { at: null, ok: null },
        gameOver: { active: true, reason: 'The colonist died of suffocation' },
      }),
  });
  const text = menu.root.textContent ?? '';
  for (const needle of [
    'Ares Expedition',
    'Pioneer',
    'Territory',
    'Hellas Basin',
    'mars2066',
    '12.5 kW',
    '8.1 kW',
    '63%',
    'Iron',
    'Water',
    'Cmdr. Vega',
    'Sheltered',
    '98%',
    'Working / idle',
    'Under construction',
    'Clear',
    '12 m/s',
    'never',
    'LOST — The colonist died of suffocation',
  ]) {
    assert.ok(text.includes(needle), `missing "${needle}"`);
  }
});

test('a successful save reads as one on the status card', () => {
  const { menu } = makeMenu({ getStats: () => stats() });
  const text = menu.root.textContent ?? '';
  assert.match(text, /successful · just now/, 'last save line');
});

test('the expedition tab survives a missing colony', () => {
  const { menu } = makeMenu({ getStats: () => null });
  const text = menu.root.textContent ?? '';
  assert.ok(text.includes('No colony is running.'), 'honest empty state');
});

// ------------------------------------------------------- save progress HUD --

group('Save progress overlay');

test('the progress overlay stages through its steps and lifts on success', async () => {
  const doc = (globalThis as any).document as Document;
  assert.equal(hud.isSaveProgressOpen(), false, 'closed at rest');
  hud.saveProgressStart('Saving colony');
  assert.equal(hud.isSaveProgressOpen(), true);
  const overlay = doc.getElementById('save-progress')!;
  assert.equal(overlay.style.display, 'flex', 'the frost is up');
  assert.equal(doc.getElementById('sp-title')!.textContent, 'Saving colony');
  const step = (i: number) => doc.getElementById(`sp-step-${i}`)!;
  assert.ok(step(0).classList.contains('active'), 'step 1 active at start');
  assert.ok(!step(0).classList.contains('done'));
  hud.saveProgressStage(2);
  assert.ok(step(0).classList.contains('done'), 'steps before the stage are done');
  assert.ok(step(1).classList.contains('done'));
  assert.ok(step(2).classList.contains('active'), 'the writing step is active');
  hud.saveProgressEnd(true);
  assert.equal(hud.isSaveProgressOpen(), false, 'state cleared immediately');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(overlay.style.display, 'none', 'the frost lifts after the fade');
  assert.ok(step(2).classList.contains('done'), 'every step checked off');
});

test('a failed save clears the overlay without a success fade', () => {
  hud.saveProgressStart('Returning to main menu');
  assert.equal(doc0().getElementById('sp-title')!.textContent, 'Returning to main menu');
  hud.saveProgressEnd(false);
  assert.equal(hud.isSaveProgressOpen(), false);
});

function doc0(): Document {
  return (globalThis as any).document;
}

// ---------------------------------------------------------- save error HUD --

group('Save-failed prompt');

test('the prompt phrases the two failure kinds and hides abandon by default', () => {
  const doc = (globalThis as any).document as Document;
  hud.showSaveError('storage', false);
  const ov = doc.getElementById('save-error')!;
  assert.equal(ov.style.display, 'flex');
  const reason = doc.getElementById('se-reason')!.textContent!;
  assert.match(reason, /storage|quota/i, 'storage wording');
  assert.equal(doc.getElementById('se-abandon')!.style.display, 'none', 'no abandon for a plain save');
  assert.ok(hud.isSaveErrorOpen());
  assert.equal(hud.hideSaveError(), true);
  assert.equal(hud.hideSaveError(), false, 'a second hide is a no-op');
  hud.showSaveError('read', true);
  const reason2 = doc.getElementById('se-reason')!.textContent!;
  assert.match(reason2, /could not be read/i, 'read wording');
  assert.equal(doc.getElementById('se-abandon')!.style.display, '', 'abandon appears in the menu context');
  hud.hideSaveError();
});

test('the prompt buttons fire the save-recovery callbacks', async () => {
  const f = await mountHud();
  f.app.innerHTML = ''; // drop the fixture's chrome so element ids stay unique
  const calls: string[] = [];
  const hud2 = new f.HUD({
    onSpeed: () => calls.push('speed'),
    onPickBuild: () => calls.push('build'),
    onAction: () => calls.push('action'),
    onStart: () => calls.push('start'),
    onOverlay: () => calls.push('overlay'),
    onSaveRetry: () => calls.push('retry'),
    onSaveAsNew: () => calls.push('new'),
    onSaveDismiss: () => calls.push('dismiss'),
    onSaveAbandon: () => calls.push('abandon'),
  });
  const doc = f.dom.window.document as unknown as Document;
  hud2.showSaveError('read', true);
  press(doc.getElementById('se-retry')!);
  press(doc.getElementById('se-new')!);
  press(doc.getElementById('se-dismiss')!);
  press(doc.getElementById('se-abandon')!);
  assert.deepEqual(calls, ['retry', 'new', 'dismiss', 'abandon']);
});

test('the menu button opens the pause menu through onMenu', async () => {
  const f = await mountHud();
  f.app.innerHTML = ''; // drop the fixture's chrome so element ids stay unique
  const calls: string[] = [];
  new f.HUD({
    onSpeed: () => calls.push('speed'),
    onPickBuild: () => calls.push('build'),
    onAction: () => calls.push('action'),
    onStart: () => calls.push('start'),
    onOverlay: () => calls.push('overlay'),
    onMenu: () => calls.push('menu'),
  });
  const doc = f.dom.window.document as unknown as Document;
  const btn = doc.getElementById('menu-btn') as HTMLElement;
  assert.ok(btn, 'the ☰ button still exists');
  btn.dispatchEvent(new (f.dom.window as any).Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.deepEqual(calls, ['menu'], 'the button reports to onMenu');
});

await finish('hud/pause-menu');
