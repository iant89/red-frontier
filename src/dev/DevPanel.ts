/**
 * The developer-mode panel (DOM).
 *
 * A sibling of the HUD, not a child: it builds its own chrome under #app and
 * talks to the Game through narrow callbacks, exactly like the HUD does. The
 * sim stays the single source of truth — every edit lands as an ordinary
 * state mutation through {@link DevMode}, and the panel merely reflects what
 * the sim reports back on the next update pass.
 *
 * Persistence contract: the panel's state lives in DevMode (outside the sim)
 * so nothing here can reach the save file; upgrade levels are runtime-only
 * by sim design; fabricated entities are ordinary world objects afterwards.
 */

import type { Rover, Building, Colonist } from '../sim/Simulation';
import type { SimView } from '../sim/host';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import {
  BUILDING_ORDER,
  BUILDINGS,
  ROVERS,
  ALL_RESOURCES,
  RESOURCES,
} from '../sim/defs';
import type { StormKindReal } from '../sim/weather';
import { stormLabel } from '../sim/weather';
import { DEV_MAX_BUILDING_LEVEL, DEV_UPGRADE_STEP } from '../sim/config';
import { DevMode, type SpawnSpec } from './DevMode';

export type DevSelection =
  | { type: 'rover' | 'building' | 'colonist'; id: number }
  | null;

export interface DevPanelCallbacks {
  /** The colony, as the host's read model — the panel draws it and edits it by command. */
  getSim(): SimView | null;
  getSelection(): DevSelection;
  /** Adopt a selection (spawn panels select what they fabricate). */
  select(sel: DevSelection): void;
  /** Where a "spawn at camera" should materialise, in world units. */
  getSpawnPoint(): { x: number; z: number };
  /** Hand a click-to-place spawn order to the Game (null to disarm). */
  armSpawn(spec: SpawnSpec | null): void;
  /** Transient guidance line (the HUD's hintbar) while a spawn is armed. */
  setHint(text: string | null): void;
  onClose(): void;
}

const ROVER_KINDS = Object.keys(ROVERS) as RoverKind[];
const STORM_BUTTONS: Array<{ kind: StormKindReal; label: string }> = [
  { kind: 'devil', label: 'Devil' },
  { kind: 'regional', label: 'Regional' },
  { kind: 'severe', label: 'Severe' },
  { kind: 'planetary', label: 'Planet' },
];
const TOD_PRESETS: Array<{ label: string; frac: number }> = [
  { label: 'Dawn', frac: 0.28 },
  { label: 'Noon', frac: 0.5 },
  { label: 'Dusk', frac: 0.72 },
  { label: 'Midnight', frac: 0.95 },
];
/** The time-of-day slider`s granularity: 96 quarter-Mars-hours in a sol. */
const TOD_STEPS = 96;

function fracToClock(frac: number): string {
  const hours = frac * 24.6597;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export class DevPanel {
  private dev: DevMode;
  private cb: DevPanelCallbacks;
  private root: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private visible = false;
  /** Signature of the selection section's current build, like HUD's inspectorKey. */
  private selKey = '';
  private statusTimer: number | null = null;

  constructor(dev: DevMode, cb: DevPanelCallbacks) {
    this.dev = dev;
    this.cb = cb;
    this.root = document.createElement('div');
    this.root.className = 'panel dev-panel';
    this.root.id = 'dev-panel';
    this.root.style.display = 'none';
    this.build();
    (document.getElementById('app') ?? document.body).appendChild(this.root);
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? 'flex' : 'none';
    if (on) {
      this.selKey = ''; // force a full rebuild against live state
      this.update();
    }
  }

  /** Reflect the Game un-arming (or arming) a click-to-place spawn. */
  setArmed(spec: SpawnSpec | null): void {
    for (const [id, el] of this.els) {
      if (!id.startsWith('dv-arm-')) continue;
      el.classList.remove('active');
    }
    if (!spec) return;
    this.el(`dv-arm-${spec.type}`)?.classList.add('active');
  }

  /** One-line transient status at the top of the panel. */
  setStatus(text: string): void {
    const el = this.el('dv-status');
    el.textContent = text;
    el.style.display = '';
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      el.style.display = 'none';
    }, 3200);
  }

  private el(id: string): HTMLElement {
    let e = this.els.get(id);
    if (!e) {
      e = this.root.querySelector<HTMLElement>('#' + id)!;
      this.els.set(id, e);
    }
    return e;
  }

  /** True while the pointer is on this control — don't fight the user's drag. */
  private focused(el: HTMLElement | null): boolean {
    return !!el && el.ownerDocument.activeElement === el;
  }

  // ------------------------------------------------------------ chrome ----

  private build(): void {
    this.root.innerHTML = `
      <div class="dev-head">
        <span class="dev-ic">🛠</span><b>Developer mode</b>
        <span class="dev-badge">unsaved</span>
        <span class="i-spacer"></span>
        <button class="mini-btn" id="dv-close" title="Close developer mode (\`)">×</button>
      </div>
      <div class="dev-note">Live edits to the running colony — the mode and its
        upgrade levels are never written to the save file.</div>
      <div class="dev-status" id="dv-status" style="display:none"></div>

      <details class="dev-sec" open>
        <summary>🌗 Environment</summary>
        <div class="dev-grid">
          <div class="stat"><span class="k">Clock</span><span class="v" id="dv-clock">—</span></div>
          <div class="stat"><span class="k">Sun</span><span class="v" id="dv-sun">—</span></div>
          <label class="slider-row">Time of day <b id="dv-todv">—</b>
            <input type="range" id="dv-tod" min="0" max="${TOD_STEPS - 1}" step="1" /></label>
          <div class="dev-row">
            <label class="dev-num">Sol <input type="number" id="dv-sol" min="1" step="1" value="1" /></label>
            <button class="btn" id="dv-jump" title="Jump the calendar to this sol and time">⏱ Jump</button>
          </div>
          <div class="dev-row">
            ${TOD_PRESETS.map(
              (p) => `<button class="btn" data-tod="${p.frac}">${p.label}</button>`,
            ).join('')}
          </div>
          <div class="stat"><span class="k">Weather</span><span class="v" id="dv-wx">—</span></div>
          <div class="dev-row">
            <button class="btn" id="dv-wx-clear" title="Dismiss every storm and forecast">Clear</button>
            ${STORM_BUTTONS.map(
              (s) =>
                `<button class="btn" data-storm="${s.kind}" title="Conjure a ${s.label.toLowerCase()} — winds arrive in seconds">${s.label}</button>`,
            ).join('')}
          </div>
          <label class="slider-row">Airborne dust <b id="dv-dustv">—</b>
            <input type="range" id="dv-dust" min="0" max="100" step="1" /></label>
          <label class="toggle"><input type="checkbox" id="dv-storms-on" checked />
            <span>Storm scheduler (auto weather)</span></label>
        </div>
      </details>

      <details class="dev-sec" open>
        <summary>➕ Spawn</summary>
        <div class="dev-grid">
          <label class="dev-lab">Rover
            <select id="dv-spawn-rover">
              ${ROVER_KINDS.map((k) => `<option value="${k}">${ROVERS[k].label}</option>`).join('')}
            </select></label>
          <div class="dev-row">
            <button class="btn" id="dv-now-rover" title="Fabricate at the camera target">＋ at camera</button>
            <button class="btn" id="dv-arm-rover" title="Then click the terrain to drop it (Shift = keep placing)">🎯 place…</button>
          </div>
          <label class="dev-lab">Building
            <select id="dv-spawn-bld">
              ${BUILDING_ORDER.map((k) => `<option value="${k}">${BUILDINGS[k].label}</option>`).join('')}
            </select></label>
          <div class="dev-row">
            <button class="btn" id="dv-now-bld" title="Fabricate complete at the camera target">＋ at camera</button>
            <button class="btn" id="dv-arm-building" title="Then click the terrain to drop it (Shift = keep placing)">🎯 place…</button>
          </div>
          <label class="dev-lab">Deposit
            <select id="dv-spawn-dep">
              ${ALL_RESOURCES.map((r) => `<option value="${r}">${RESOURCES[r].label}</option>`).join('')}
            </select></label>
          <div class="dev-row">
            <label class="dev-num" title="Deposit size">kg <input type="number" id="dv-dep-kg" min="10" step="100" value="2500" /></label>
            <button class="btn" id="dv-now-dep" title="Survey in at the camera target">＋ at camera</button>
            <button class="btn" id="dv-arm-deposit" title="Then click the terrain to drop it (Shift = keep placing)">🎯 place…</button>
          </div>
          <div class="note dim">Spawns are ordinary world objects the moment they land —
            they behave, and save, exactly like earned ones.</div>
        </div>
      </details>

      <details class="dev-sec" open>
        <summary id="dv-sel-title">🎯 Selection</summary>
        <div class="dev-grid" id="dv-sel-body">
          <div class="empty">Select a rover, a building, or your colonist to edit it.</div>
        </div>
      </details>
    `;

    this.el('dv-close').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onClose();
    });

    // ---- environment wiring ------------------------------------------------
    this.el('dv-jump').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const sol = Math.max(1, Math.round(Number(this.numValue('dv-sol', 1)) || 1));
      const frac = this.todFrac();
      this.dev.setTime(sol, frac);
      this.setStatus(`Calendar jumped to Sol ${sol} · ${fracToClock(frac)}`);
    });
    this.root.querySelectorAll('[data-tod]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sim = this.cb.getSim();
        if (!sim) return;
        const frac = Number((btn as HTMLElement).dataset.tod);
        this.setTodSlider(frac);
        this.dev.setTime(sim.clock.sol + 1, frac);
        this.setStatus(`Time set to ${fracToClock(frac)}`);
      });
    });
    const tod = this.el('dv-tod') as HTMLInputElement;
    tod.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      (this.el('dv-todv') as HTMLElement).textContent = fracToClock(this.todFrac());
      this.dev.setTime(sim.clock.sol + 1, this.todFrac());
    });
    const dust = this.el('dv-dust') as HTMLInputElement;
    dust.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const v = Number(dust.value) / 100;
      (this.el('dv-dustv') as HTMLElement).textContent = `${dust.value}%`;
      this.dev.setDust(v);
    });
    this.root.querySelectorAll('[data-storm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sim = this.cb.getSim();
        if (!sim) return;
        const kind = (btn as HTMLElement).dataset.storm as StormKindReal;
        this.dev.forceStorm(kind);
        this.setStatus(`Storm conjured — ${kind}`);
      });
    });
    this.el('dv-wx-clear').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.clearStorms();
      this.setStatus('Skies cleared');
    });
    this.el('dv-storms-on').addEventListener('change', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const on = (this.el('dv-storms-on') as HTMLInputElement).checked;
      this.dev.setStormScheduler(on);
      this.setStatus(on ? 'Storm scheduler resumed' : 'Storm scheduler suspended');
    });

    // ---- spawn wiring -------------------------------------------------------
    this.el('dv-now-rover').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const kind = this.selValue('dv-spawn-rover') as RoverKind;
      const pt = this.cb.getSpawnPoint();
      const id = this.dev.spawnRover(kind, pt.x, pt.z);
      this.cb.select({ type: 'rover', id });
      this.setStatus(`${ROVERS[kind].label} #${id} fabricated`);
    });
    this.el('dv-arm-rover').addEventListener('click', () => {
      const kind = this.selValue('dv-spawn-rover') as RoverKind;
      this.toggleArm({ type: 'rover', kind });
    });
    this.el('dv-now-bld').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const kind = this.selValue('dv-spawn-bld') as BuildingKind;
      this.spawnBuildingNow(kind, this.cb.getSpawnPoint());
    });
    this.el('dv-arm-building').addEventListener('click', () => {
      const kind = this.selValue('dv-spawn-bld') as BuildingKind;
      this.toggleArm({ type: 'building', kind });
    });
    this.el('dv-now-dep').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const res = this.selValue('dv-spawn-dep') as ResourceId;
      const kg = Math.max(10, this.numValue('dv-dep-kg', 2500));
      const pt = this.cb.getSpawnPoint();
      this.dev.spawnDeposit(res, pt.x, pt.z, kg);
      this.setStatus(`${RESOURCES[res].label} deposit surveyed in — ${Math.round(kg)} kg`);
    });
    this.el('dv-arm-deposit').addEventListener('click', () => {
      const res = this.selValue('dv-spawn-dep') as ResourceId;
      const kg = Math.max(10, this.numValue('dv-dep-kg', 2500));
      this.toggleArm({ type: 'deposit', kind: res, amountKg: kg });
    });
  }

  private toggleArm(spec: SpawnSpec): void {
    const armed =
      this.dev.armedSpawn &&
      this.dev.armedSpawn.type === spec.type &&
      this.dev.armedSpawn.kind === spec.kind;
    this.cb.armSpawn(armed ? null : spec);
  }

  private spawnBuildingNow(kind: BuildingKind, pt: { x: number; z: number }): void {
    const sim = this.cb.getSim();
    if (!sim) return;
    const id = this.dev.spawnBuilding(kind, pt.x, pt.z);
    if (id === null) {
      this.setStatus(`Cannot fabricate a ${BUILDINGS[kind].label} there — see the colony log`);
      return;
    }
    this.cb.select({ type: 'building', id });
    this.setStatus(`${BUILDINGS[kind].label} #${id} fabricated online`);
  }

  private selValue(id: string): string {
    return (this.el(id) as HTMLSelectElement).value;
  }

  private numValue(id: string, fallback: number): number {
    const v = Number((this.el(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : fallback;
  }

  private todFrac(): number {
    const v = Number((this.el('dv-tod') as HTMLInputElement).value);
    return Math.min(0.9999, Math.max(0, v / TOD_STEPS));
  }

  private setTodSlider(frac: number): void {
    (this.el('dv-tod') as HTMLInputElement).value = String(
      Math.round(frac * TOD_STEPS),
    );
    this.el('dv-todv').textContent = fracToClock(frac);
  }

  // ------------------------------------------------------------ updates ----

  /** Patch live values; the Game calls this on its HUD cadence. */
  update(): void {
    if (!this.visible) return;
    const sim = this.cb.getSim();
    if (!sim) return;

    // ---- environment readouts ---------------------------------------------
    this.el('dv-clock').textContent = sim.clock.format();
    const irr = sim.sun.irradiance;
    this.el('dv-sun').textContent = `${Math.round(irr * 100)}% · ${sim.clock.phase()}`;
    const wx = sim.weather;
    const fc = wx.forecast();
    this.el('dv-wx').textContent =
      wx.storm !== 'calm'
        ? `${stormLabel(wx.storm)} · dust ${Math.round(wx.dust * 100)}%`
        : fc
          ? `Clear · ${fc.label} inbound`
          : `Clear · dust ${Math.round(wx.dust * 100)}%`;
    const tod = this.el('dv-tod') as HTMLInputElement;
    if (!this.focused(tod)) {
      tod.value = String(Math.round(sim.clock.frac * TOD_STEPS) % TOD_STEPS);
      this.el('dv-todv').textContent = fracToClock(sim.clock.frac);
    }
    const dustEl = this.el('dv-dust') as HTMLInputElement;
    if (!this.focused(dustEl)) {
      dustEl.value = String(Math.round(sim.weather.dust * 100));
      this.el('dv-dustv').textContent = `${Math.round(sim.weather.dust * 100)}%`;
    }
    const solIn = this.el('dv-sol') as HTMLInputElement;
    if (!this.focused(solIn)) solIn.value = String(sim.clock.sol + 1);
    const sched = this.el('dv-storms-on') as HTMLInputElement;
    if (!this.focused(sched)) sched.checked = !sim.weather.rollsSuppressed;

    // ---- selection -----------------------------------------------------------
    const sel = this.cb.getSelection();
    const key = sel ? `${sel.type}:${sel.id}` : 'none';
    if (key !== this.selKey) {
      this.selKey = key;
      this.rebuildSelection(sim, sel);
    }
    this.patchSelection(sim, sel);
  }

  private rebuildSelection(sim: SimView, sel: DevSelection): void {
    const body = this.el('dv-sel-body');
    const title = this.el('dv-sel-title');
    // New nodes mean the id cache for selection controls is stale.
    for (const [k] of this.els) {
      if (k.startsWith('dvs-')) this.els.delete(k);
    }
    if (!sel) {
      title.textContent = '🎯 Selection';
      body.innerHTML = '<div class="empty">Select a rover, a building, or your colonist to edit it.</div>';
      return;
    }
    if (sel.type === 'rover') {
      const r = sim.roverById(sel.id);
      if (!r) {
        this.selKey = 'none';
        body.innerHTML = '<div class="empty">That rover is gone.</div>';
        return;
      }
      title.textContent = `🎯 Rover #${r.id}`;
      body.innerHTML = this.roverEditorHtml(r);
      this.wireRoverEditor(body);
      return;
    }
    if (sel.type === 'building') {
      const b = sim.buildingById(sel.id);
      if (!b) {
        this.selKey = 'none';
        body.innerHTML = '<div class="empty">That structure is gone.</div>';
        return;
      }
      title.textContent = `🎯 ${BUILDINGS[b.kind].label} #${b.id}`;
      body.innerHTML = this.buildingEditorHtml(b);
      this.wireBuildingEditor(body);
      return;
    }
    title.textContent = '🎯 Colonist';
    body.innerHTML = this.colonistEditorHtml();
    this.wireColonistEditor(body);
  }

  // ------------------------------------------------------------- rover ----

  private roverEditorHtml(r: Rover): string {
    const def = ROVERS[r.kind];
    return `
      <div class="sub">${def.label} · ${def.role}</div>
      <div class="stat"><span class="k">Battery</span><span class="v" id="dvs-batv">—</span></div>
      <label class="slider-row">Battery charge %
        <input type="range" id="dvs-bat" min="0" max="100" step="1" /></label>
      <label class="toggle"><input type="checkbox" id="dvs-keep" />
        <span>Keep battery full (while dev mode is on)</span></label>
      <div class="stat"><span class="k">Drivetrain</span><span class="v" id="dvs-condv">—</span></div>
      <label class="slider-row">Condition %
        <input type="range" id="dvs-cond" min="0" max="100" step="1" /></label>
      <div class="sub sm">Cargo bay <span class="dim">(${def.capacityKg} kg hopper)</span></div>
      <div class="stat"><span class="k">Load</span><span class="v" id="dvs-cargov">—</span></div>
      <div class="dev-row">
        <select id="dvs-res">
          ${ALL_RESOURCES.map((res) => `<option value="${res}">${RESOURCES[res].label}</option>`).join('')}
        </select>
        <label class="dev-num">kg <input type="number" id="dvs-kg" min="0" step="50" value="500" /></label>
      </div>
      <div class="dev-row">
        <button class="btn" id="dvs-cargo-set" title="Set the chosen ore load (clamped to the hopper)">Set load</button>
        <button class="btn" id="dvs-cargo-clear" title="Empty the bay">Clear bay</button>
      </div>`;
  }

  private wireRoverEditor(body: HTMLElement): void {
    const sel = this.cb.getSelection();
    if (!sel || sel.type !== 'rover') return;
    const id = sel.id;
    const q = <T extends HTMLElement>(sid: string) =>
      body.querySelector('#' + sid) as T;

    const bat = q<HTMLInputElement>('dvs-bat');
    bat.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setBatteryFrac(id, Number(bat.value) / 100);
      // Dragging the battery by hand means the pin should follow suit visually.
      const keep = q<HTMLInputElement>('dvs-keep');
      keep.checked = this.dev.isKeepBatteryFull(id);
    });
    const keep = q<HTMLInputElement>('dvs-keep');
    keep.checked = this.dev.isKeepBatteryFull(id);
    keep.addEventListener('change', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setKeepBatteryFull(id, keep.checked);
      this.setStatus(keep.checked ? 'Battery pinned at 100%' : 'Battery pin released');
    });
    const cond = q<HTMLInputElement>('dvs-cond');
    cond.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setCondition(id, Number(cond.value));
    });
    q<HTMLButtonElement>('dvs-cargo-set').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      const res = q<HTMLSelectElement>('dvs-res').value as ResourceId;
      const kg = Math.max(0, Number(q<HTMLInputElement>('dvs-kg').value) || 0);
      const landed = this.dev.setCargo(sim, id, res, kg);
      this.setStatus(`${RESOURCES[res].label} load set to ${Math.round(landed)} kg`);
    });
    q<HTMLButtonElement>('dvs-cargo-clear').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.clearCargo(sim, id);
      this.setStatus('Cargo bay emptied');
    });
  }

  private patchRover(r: Rover): void {
    const def = ROVERS[r.kind];
    const bat = this.root.querySelector('#dvs-bat') as HTMLInputElement | null;
    if (!bat) return;
    const pct = Math.round((r.battery / def.maxBatteryKWh) * 100);
    if (!this.focused(bat)) bat.value = String(pct);
    this.el('dvs-batv').textContent = `${r.battery.toFixed(1)} / ${def.maxBatteryKWh} kWh`;
    const keep = this.els.get('dvs-keep') as HTMLInputElement | undefined;
    if (keep && !this.focused(keep)) keep.checked = this.dev.isKeepBatteryFull(r.id);
    const cond = this.els.get('dvs-cond') as HTMLInputElement | undefined;
    if (cond && !this.focused(cond)) cond.value = String(Math.round(r.condition));
    this.el('dvs-condv').textContent = `${Math.round(r.condition)}%`;
    let mass = 0;
    const parts: string[] = [];
    for (const res of ALL_RESOURCES) {
      mass += r.cargo[res];
      if (r.cargo[res] > 0.5) parts.push(`${RESOURCES[res].short} ${Math.round(r.cargo[res])}`);
    }
    this.el('dvs-cargov').textContent =
      mass > 0.5 ? `${Math.round(mass)} kg · ${parts.join(', ')}` : 'empty';
  }

  // ---------------------------------------------------------- building ----

  private buildingEditorHtml(b: Building): string {
    const def = BUILDINGS[b.kind];
    const pct = Math.round(DEV_UPGRADE_STEP * 100);
    return `
      <div class="sub">${def.label} · <span id="dvs-bstate">—</span></div>
      ${
        b.state !== 'online'
          ? `<button class="btn wide" id="dvs-complete" title="Deliver remaining materials for free and finish assembly now">⚡ Instant complete (free)</button>`
          : ''
      }
      <div class="stat"><span class="k">Health</span><span class="v" id="dvs-hpv">—</span></div>
      <label class="slider-row">Structure health %
        <input type="range" id="dvs-hp" min="0" max="100" step="1" /></label>
      <label class="toggle"><input type="checkbox" id="dvs-damaged" />
        <span>Damaged — tripped offline</span></label>
      ${
        def.generation === 'solar'
          ? `<div class="stat"><span class="k">Panels</span><span class="v" id="dvs-cleanv">—</span></div>
             <label class="slider-row">Panel cleanliness %
               <input type="range" id="dvs-clean" min="0" max="100" step="1" /></label>`
          : ''
      }
      <label class="toggle"><input type="checkbox" id="dvs-enabled" />
        <span>Powered on (ordinary enable switch)</span></label>
      <div class="sub sm">Upgrade <span class="dim">(+${pct}% output per Mk · runtime only, max Mk ${DEV_MAX_BUILDING_LEVEL})</span></div>
      <div class="dev-row dev-mkrow">
        <button class="btn" id="dvs-mk-down" title="Downgrade one level">−</button>
        <span class="dev-mk" id="dvs-mk">—</span>
        <button class="btn" id="dvs-mk-up" title="Upgrade one level">＋</button>
      </div>
      <div class="note dim" id="dvs-mknote"></div>`;
  }

  private wireBuildingEditor(body: HTMLElement): void {
    const sel = this.cb.getSelection();
    if (!sel || sel.type !== 'building') return;
    const id = sel.id;
    const q = <T extends HTMLElement>(sid: string) =>
      body.querySelector('#' + sid) as T;

    body.querySelector('#dvs-complete')?.addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.completeBuilding(id);
      this.setStatus('Structure completed instantly');
      this.selKey = ''; // the panel swaps the button out on rebuild
    });
    const hp = q<HTMLInputElement>('dvs-hp');
    hp.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setHealth(id, Number(hp.value));
    });
    const dmg = q<HTMLInputElement>('dvs-damaged');
    dmg.addEventListener('change', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setDamaged(id, dmg.checked);
    });
    const en = q<HTMLInputElement>('dvs-enabled');
    en.addEventListener('change', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      // Not a dev backdoor — the power switch is the player's own toggle, so it
      // goes through the same command the HUD's button sends.
      this.dev.setBuildingEnabled(id, en.checked);
    });
    body.querySelector('#dvs-clean')?.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setCleanliness(
                id,
        Number((body.querySelector('#dvs-clean') as HTMLInputElement).value) / 100,
      );
    });
    q<HTMLButtonElement>('dvs-mk-up').addEventListener('click', () => {
      const sim = this.cb.getSim();
      const b = sim?.buildingById(id);
      if (!sim || !b) return;
      const landed = this.dev.setUpgradeLevel(id, b.level + 1);
      this.setStatus(`Upgraded to Mk ${landed}`);
    });
    q<HTMLButtonElement>('dvs-mk-down').addEventListener('click', () => {
      const sim = this.cb.getSim();
      const b = sim?.buildingById(id);
      if (!sim || !b) return;
      const landed = this.dev.setUpgradeLevel(id, b.level - 1);
      this.setStatus(`Set to Mk ${landed}`);
    });
  }

  private patchBuilding(b: Building): void {
    const stateEl = this.root.querySelector('#dvs-bstate') as HTMLElement | null;
    if (!stateEl) return;
    stateEl.textContent =
      b.state === 'online'
        ? b.enabled
          ? 'online'
          : 'switched off'
        : b.state === 'building'
          ? `assembling ${Math.round(b.progress * 100)}%`
          : 'site';
    const hp = this.els.get('dvs-hp') as HTMLInputElement | undefined;
    if (hp && !this.focused(hp)) hp.value = String(Math.round(b.health));
    this.el('dvs-hpv').textContent = `${Math.round(b.health)}%${b.health < 100 ? '' : ' (max)'}`;
    const dmg = this.els.get('dvs-damaged') as HTMLInputElement | undefined;
    if (dmg && !this.focused(dmg)) dmg.checked = b.damaged;
    const clean = this.els.get('dvs-clean') as HTMLInputElement | undefined;
    if (clean && !this.focused(clean)) clean.value = String(Math.round(b.cleanliness * 100));
    const cleanv = this.els.get('dvs-cleanv');
    if (cleanv) cleanv.textContent = `${Math.round(b.cleanliness * 100)}%`;
    const en = this.els.get('dvs-enabled') as HTMLInputElement | undefined;
    if (en && !this.focused(en)) en.checked = b.enabled;

    const mulPct = Math.round(DEV_UPGRADE_STEP * 100 * (b.level - 1));
    // Recompute honestly from the sim helper so the note is the live figure.
    const mul = 1 + DEV_UPGRADE_STEP * (b.level - 1);
    this.el('dvs-mk').textContent = `Mk ${b.level} · ×${mul.toFixed(2)} output`;
    const note = this.els.get('dvs-mknote');
    if (note) {
      note.textContent =
        b.level > 1
          ? `Developer boost: generation, process rate, silo & tank capacity all run +${mulPct}%. Reverts when a save is loaded.`
          : 'Base configuration.';
    }
    const up = this.els.get('dvs-mk-up') as HTMLButtonElement | undefined;
    if (up) up.disabled = b.level >= DEV_MAX_BUILDING_LEVEL;
    const down = this.els.get('dvs-mk-down') as HTMLButtonElement | undefined;
    if (down) down.disabled = b.level <= 1;
  }

  // ----------------------------------------------------------- colonist ----

  private colonistEditorHtml(): string {
    return `
      <div class="sub">The crew. Handle with care — or don't, you're the developer.</div>
      <div class="stat"><span class="k">Health</span><span class="v" id="dvs-chpv">—</span></div>
      <label class="slider-row">Health %
        <input type="range" id="dvs-chp" min="0" max="100" step="1" /></label>
      <div class="stat"><span class="k">Suit O₂</span><span class="v" id="dvs-suitv">—</span></div>
      <button class="btn wide" id="dvs-suit" title="Top the EVA suit up to full">🫧 Refill suit O₂</button>`;
  }

  private wireColonistEditor(body: HTMLElement): void {
    const q = <T extends HTMLElement>(sid: string) =>
      body.querySelector('#' + sid) as T;
    const chp = q<HTMLInputElement>('dvs-chp');
    chp.addEventListener('input', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.setColonistHealth(Number(chp.value));
    });
    q<HTMLButtonElement>('dvs-suit').addEventListener('click', () => {
      const sim = this.cb.getSim();
      if (!sim) return;
      this.dev.refillSuit();
      this.setStatus('Suit oxygen refilled');
    });
  }

  private patchColonist(c: Colonist): void {
    const chp = this.root.querySelector('#dvs-chp') as HTMLInputElement | null;
    if (!chp) return;
    if (!this.focused(chp)) chp.value = String(Math.round(c.health));
    this.el('dvs-chpv').textContent = c.dead ? 'deceased' : `${Math.round(c.health)}%`;
    const suit = this.els.get('dvs-suitv');
    if (suit) suit.textContent = c.inside ? 'docked (refilling)' : `${c.suitO2.toFixed(2)} kg`;
  }

  private patchSelection(sim: SimView, sel: DevSelection): void {
    if (!sel) return;
    if (sel.type === 'rover') {
      const r = sim.roverById(sel.id);
      if (r) this.patchRover(r);
      else {
        this.selKey = '';
      }
    } else if (sel.type === 'building') {
      const b = sim.buildingById(sel.id);
      if (b) this.patchBuilding(b);
      else this.selKey = '';
    } else {
      this.patchColonist(sim.colonist);
    }
  }
}
