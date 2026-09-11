/**
 * @suite hud/devpanel
 * @group hud
 * @covers src/dev/DevPanel.ts src/dev/DevMode.ts
 * @desc The developer panel: visibility and the unsaved badge, the environment
 * controls (sol/time/weather), the spawn flows, and the per-selection editors
 * for rovers, buildings and the colonist.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { DevMode } from '../../src/dev/DevMode';
import { LocalSimHost } from '../../src/sim/host';
import type { DevPanelCallbacks } from '../../src/dev/DevPanel';
import { DevPanel } from '../../src/dev/DevPanel';
import { ROVERS } from '../../src/sim/defs';
import { SUIT_O2_CAPACITY, DEV_UPGRADE_STEP } from '../../src/sim/config';
import { findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const { dom, doc, app, sim } = await mountHud();

type Sel = { type: 'rover' | 'building' | 'colonist'; id: number } | null;

const calls: string[] = [];
let selection: Sel = null;
let spawnPoint = { x: 55, z: -55 };

const dev = new DevMode((sev, text) => calls.push(`log:${sev}:${text}`));
dev.enabled = true;
// The panel edits through the host now, so the mode needs a colony to send
// commands to — the same attach Game.launch performs.
dev.attach(new LocalSimHost(sim));

const cb: DevPanelCallbacks = {
  getSim: () => sim,
  getSelection: () => selection,
  select: (sel) => {
    selection = sel;
    calls.push(`select:${sel?.type ?? 'none'}`);
  },
  getSpawnPoint: () => spawnPoint,
  armSpawn: (spec) => {
    dev.armedSpawn = spec; // what Game.setArmedSpawn does in production
    calls.push(`arm:${spec?.type ?? 'null'}`);
  },
  setHint: (t) => calls.push(`hint:${t ?? ''}`),
  onClose: () => calls.push('close'),
};

const panel = new DevPanel(dev, cb);
panel.setVisible(true);
panel.update();

function q<T extends HTMLElement>(id: string): T {
  return doc.getElementById(id) as unknown as T;
}

function fire(id: string, type: string): HTMLElement {
  const el = q<HTMLElement>(id);
  el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  return el;
}

group('Developer panel — chrome');

test('the panel mounts into #app with its unsaved badge and toggles visibility', () => {
  const root = doc.getElementById('dev-panel');
  assert.ok(root, 'panel is in the DOM');
  assert.ok(app.contains(root), 'and it lives under #app');
  assert.match(root!.textContent!, /unsaved/, 'the persistence contract is on the tin');
  panel.setVisible(false);
  assert.equal(root!.style.display, 'none');
  panel.setVisible(true);
  assert.equal(root!.style.display, 'flex');
});

test('the close button reports through onClose', () => {
  const before = calls.filter((c) => c === 'close').length;
  fire('dv-close', 'pointerdown');
  assert.equal(calls.filter((c) => c === 'close').length, before + 1);
});

group('Developer panel — environment');

test('environment readouts patch from the sim', () => {
  panel.update();
  assert.match(q('dv-clock').textContent!, /^Sol \d+ · \d\d:\d\d$/);
  assert.match(q('dv-sun').textContent!, /% · /);
  assert.match(q('dv-wx').textContent!, /Clear|storm|inbound/i);
});

test('the Jump button moves the calendar to the chosen sol and time', () => {
  const input = q<HTMLInputElement>('dv-sol');
  input.value = '4';
  const tod = q<HTMLInputElement>('dv-tod');
  tod.value = '48'; // halfway through the sol ≈ local noon
  fire('dv-jump', 'click');
  assert.equal(sim.clock.sol, 3, 'Sol 4 on the dial is clock.sol 3');
  assert.ok(sim.clock.sun.isDay, 'midday lands in daylight');
  assert.ok(calls.some((c) => c.startsWith('log:info:⏱')), 'the jump is logged');
});

test('the time-of-day slider applies live while dragged', () => {
  const tod = q<HTMLInputElement>('dv-tod');
  tod.value = '12'; // ~3 am
  fire('dv-tod', 'input');
  assert.ok(!sim.clock.sun.isDay, '3 am is night');
  assert.match(q('dv-todv').textContent!, /^\d\d:\d\d$/, 'the readout shows the clock time');
});

test('storm buttons conjure, dust slides, and Clear dismisses', () => {
  const btn = doc.querySelector('[data-storm="severe"]') as HTMLElement;
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(sim.weather.forecast(), 'a severe storm is on the board');
  // Dust edits land directly on the weather model.
  const dust = q<HTMLInputElement>('dv-dust');
  dust.value = '60';
  fire('dv-dust', 'input');
  assert.ok(sim.weather.dust >= 0.59, 'dust slider pushes the reading');
  fire('dv-wx-clear', 'click');
  assert.ok(!sim.weather.forecast(), 'Clear empties the forecast board');
  assert.equal(sim.weather.storm, 'calm');
});

test('the scheduler checkbox suspends and resumes storm rolls', () => {
  const box = q<HTMLInputElement>('dv-storms-on');
  box.checked = false;
  fire('dv-storms-on', 'change');
  assert.ok(sim.weather.rollsSuppressed, 'suspending stops the rolls');
  box.checked = true;
  fire('dv-storms-on', 'change');
  assert.ok(!sim.weather.rollsSuppressed, 'resuming starts them again');
});

group('Developer panel — spawning');

test('spawn-at-camera fabricates a rover and selects it', () => {
  const before = sim.rovers.length;
  (q<HTMLSelectElement>('dv-spawn-rover')).value = 'cargo';
  fire('dv-now-rover', 'click');
  assert.equal(sim.rovers.length, before + 1, 'one more rover exists');
  assert.ok(selection && selection.type === 'rover', 'the new rover is selected');
  assert.equal(sim.roverById(selection!.id)?.kind, 'cargo');
  assert.ok(calls.includes('select:rover'));
});

test('spawn-at-camera fabricates an online building and selects it', () => {
  (q<HTMLSelectElement>('dv-spawn-bld')).value = 'solar';
  // Walk a ring for a spot that passes the honest siting checks.
  const spot = findSpot(sim, 'solar');
  spawnPoint = { x: spot.x, z: spot.z };
  const before = sim.buildings.length;
  fire('dv-now-bld', 'click');
  assert.equal(sim.buildings.length, before + 1, 'one more structure exists');
  assert.ok(selection && selection.type === 'building', 'it is selected');
  assert.equal(sim.buildingById(selection!.id)?.state, 'online', 'fabricated online');
});

test('spawn-at-camera surveys in a deposit of the chosen size', () => {
  (q<HTMLSelectElement>('dv-spawn-dep')).value = 'ice';
  (q<HTMLInputElement>('dv-dep-kg')).value = '1800';
  spawnPoint = { x: -70, z: 66 };
  const before = sim.world.deposits.length;
  fire('dv-now-dep', 'click');
  assert.equal(sim.world.deposits.length, before + 1);
  const d = sim.world.deposits[sim.world.deposits.length - 1];
  assert.equal(d.resource, 'ice');
  assert.equal(d.amount, 1800);
});

test('the place… button arms and disarms click-to-place', () => {
  calls.length = 0;
  fire('dv-arm-rover', 'click');
  assert.ok(calls.includes('arm:rover'), 'first click arms it');
  assert.equal(dev.armedSpawn?.type, 'rover');
  fire('dv-arm-rover', 'click');
  assert.ok(calls.includes('arm:null'), 'second click disarms it');
});

group('Developer panel — selection editors');

test('the rover editor sets battery, pins keep-full and loads ore', () => {
  const r = sim.rovers[sim.rovers.length - 1]; // the cargo rover spawned earlier
  selection = { type: 'rover', id: r.id };
  panel.update(); // rebuild the selection editor
  const def = ROVERS[r.kind];

  // Battery slider writes the pack fraction straight into the sim.
  const bat = q<HTMLInputElement>('dvs-bat');
  assert.ok(bat, 'battery slider exists for a rover selection');
  bat.value = '25';
  fire('dvs-bat', 'input');
  const live = sim.roverById(r.id)!;
  assert.ok(
    Math.abs(live.battery - def.maxBatteryKWh * 0.25) < 0.5,
    `battery should be ~25% (${live.battery.toFixed(1)} / ${def.maxBatteryKWh})`,
  );

  // Keep-full checkbox pins it through the frame hook.
  const keep = q<HTMLInputElement>('dvs-keep');
  keep.checked = true;
  fire('dvs-keep', 'change');
  assert.ok(dev.isKeepBatteryFull(r.id));
  live.battery = 10;
  dev.applyTo(sim);
  assert.equal(live.battery, def.maxBatteryKWh, 'the pin restores full charge');

  // Cargo: pick ice, ask for 600 kg (hopper takes what fits).
  (q<HTMLSelectElement>('dvs-res')).value = 'ice';
  (q<HTMLInputElement>('dvs-kg')).value = '600';
  fire('dvs-cargo-set', 'click');
  assert.ok(live.cargo.ice > 0, 'ice was loaded');
  assert.ok(live.cargo.ice <= def.capacityKg, 'and clamped to the hopper');
  fire('dvs-cargo-clear', 'click');
  assert.equal(live.cargo.ice, 0, 'the bay clears');
  // Leave the sim tidy for the editors that follow.
  keep.checked = false;
  fire('dvs-keep', 'change');
});

test('the building editor covers state, health, damage and upgrades', () => {
  const b = sim.buildings.find((x) => x.kind === 'solar')!;
  selection = { type: 'building', id: b.id };
  panel.update();

  // Health slider, with the damage threshold logic riding along.
  const hp = q<HTMLInputElement>('dvs-hp');
  assert.ok(hp, 'health slider exists for a building selection');
  hp.value = '34';
  fire('dvs-hp', 'input');
  assert.equal(Math.round(b.health), 34);
  panel.update(); // labels patch on the frame cadence, like production
  assert.match(q('dvs-hpv').textContent!, /34%/);

  // Damage checkbox.
  const dmg = q<HTMLInputElement>('dvs-damaged');
  dmg.checked = true;
  fire('dvs-damaged', 'change');
  assert.ok(b.damaged, 'flagging damage trips it offline');
  dmg.checked = false;
  fire('dvs-damaged', 'change');
  assert.ok(!b.damaged, 'clearing it re-commissions');

  // Enabled checkbox drives the ordinary enable switch.
  const en = q<HTMLInputElement>('dvs-enabled');
  en.checked = false;
  fire('dvs-enabled', 'change');
  assert.ok(!b.enabled, 'switched off');
  en.checked = true;
  fire('dvs-enabled', 'change');
  assert.ok(b.enabled, 'switched back on');

  // Panel cleanliness slider exists on solar.
  const clean = q<HTMLInputElement>('dvs-clean');
  clean.value = '47';
  fire('dvs-clean', 'input');
  assert.ok(Math.abs(b.cleanliness - 0.47) < 1e-9);

  // Upgrade buttons walk the level up and down.
  fire('dvs-mk-up', 'click');
  assert.equal(b.level, 2, 'one click upgrades');
  panel.update();
  assert.match(q('dvs-mk').textContent!, /Mk 2/);
  assert.match(q('dvs-mk').textContent!, /×1\.35/, 'the multiplier shows');
  assert.ok(Math.abs(DEV_UPGRADE_STEP - 0.35) < 1e-9, 'and matches the tuning constant');
  fire('dvs-mk-down', 'click');
  assert.equal(b.level, 1, 'and downgrades again');
});

test('a construction site gets an Instant complete button', () => {
  const spot = findSpot(sim, 'battery');
  const b = sim.placeBuilding('battery', spot.x, spot.z)!;
  selection = { type: 'building', id: b.id };
  panel.update();
  assert.equal(b.state, 'site');
  const btn = doc.getElementById('dvs-complete');
  assert.ok(btn, 'the button is there for an unfinished site');
  fire('dvs-complete', 'click');
  assert.equal(sim.buildingById(b.id)!.state, 'online', 'completed instantly');
});

test('the colonist editor sets health and refills the suit', () => {
  selection = { type: 'colonist', id: sim.colonist.id };
  panel.update();
  const chp = q<HTMLInputElement>('dvs-chp');
  assert.ok(chp, 'health slider exists for the colonist');
  chp.value = '61';
  fire('dvs-chp', 'input');
  assert.equal(Math.round(sim.colonist.health), 61);

  sim.colonist.suitO2 = 0.05;
  fire('dvs-suit', 'click');
  assert.ok(
    Math.abs(sim.colonist.suitO2 - SUIT_O2_CAPACITY) < 1e-9,
    'suit refilled to capacity',
  );
});

test('clearing the selection empties the editor on the next update', () => {
  selection = null;
  panel.update();
  assert.match(q('dv-sel-body').textContent!, /Select a rover/);
});

await finish('hud/devpanel');
