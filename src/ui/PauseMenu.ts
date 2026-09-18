/**
 * The in-game pause menu: the ☰ button's destination.
 *
 * Three tabs over the live (frozen) colony —
 *   Actions     resume, save, return to the main menu
 *   Settings    game / graphical / interface options
 *   Expedition  live statistics about the colony
 *
 * Like every menu here it is pure DOM and one-way: it renders state it is
 * handed and fires callbacks; it never touches the sim or the storage itself.
 * The colony keeps rendering behind the frost — the pause is the *sim's*
 * speed going to zero, not the picture going away.
 */

import {
  AUTO_SAVE_INTERVALS,
  RENDER_RESOLUTIONS,
  type RenderResolution,
} from './Settings';

// ------------------------------------------------------------------ stats --

/**
 * A plain-data portrait of the colony for the Expedition tab. `Game` builds it
 * from the host view; the menu only formats it, so this file stays
 * sim-agnostic and jsdom-testable.
 */
export interface ColonyStats {
  name: string;
  clockText: string;
  difficulty: string;
  worldSize: string;
  region: string;
  seedText: string;
  /** Sols of mission time elapsed (the sim's compressed sol is 240 s). */
  solsPlayed: number;
  power: { genKw: number; loadKw: number; batteryPct: number; curtailKw: number };
  resources: Array<{ label: string; amount: number; capacity: number }>;
  fluids: Array<{ label: string; amount: number; capacity: number; netPerSol: number }>;
  crew: { name: string; status: string; healthPct: number; suitPct: number; inside: boolean };
  fleet: {
    total: number;
    working: number;
    idle: number;
    stranded: number;
    avgBatteryPct: number;
    avgConditionPct: number;
  };
  structures: { total: number; online: number; building: number; damaged: number };
  weather: { storm: string; wind: number; dustPct: number; visibilityPct: number };
  alerts: { crit: number; warn: number; opportunity: number };
  lastSave: { at: number | null; ok: boolean | null };
  gameOver: { active: boolean; reason: string };
}

// --------------------------------------------------------------- settings --

/**
 * The settings screen's two-way contract: current values to render, callbacks
 * that persist and (where something is live — the autopause flag, the
 * renderer, the HUD) apply them.
 */
export interface PauseMenuSettings {
  autopauseOnCrit: boolean;
  saveOnTabHide: boolean;
  autosaveIntervalSec: number;
  renderResolution: RenderResolution;
  shadows: boolean;
  weatherFx: boolean;
  hudPanelsHidden: boolean;
  onAutopause(on: boolean): void;
  onSaveOnTabHide(on: boolean): void;
  onAutosaveInterval(sec: number): void;
  onRenderResolution(r: RenderResolution): void;
  onShadows(on: boolean): void;
  onWeatherFx(on: boolean): void;
  onHudPanelsHidden(on: boolean): void;
  onResetPanelLayout(): void;
}

export interface PauseMenuOptions {
  /** Fresh colony portrait, or null while no colony runs. */
  getStats: () => ColonyStats | null;
  settings: PauseMenuSettings;
  onResume: () => void;
  /** Manual save — the save progress dialog covers this menu while it runs. */
  onSave: () => void;
  /** Save (with the progress dialog) and hand back to the main menu. */
  onReturnToMenu: () => void;
}

// ----------------------------------------------------------------- helpers --

const fmtKg = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)} t` : `${Math.round(n)} kg`);

/** "2.4 sols", "9.3 h", "48 min" — whichever reads best at this magnitude. */
function fmtSols(sols: number): string {
  if (!Number.isFinite(sols) || sols < 0) sols = 0;
  if (sols >= 2) return `${sols.toFixed(1)} sols`;
  const hours = sols * 24.66;
  if (hours >= 2) return `${hours.toFixed(1)} h`;
  return `${Math.max(0, Math.round(hours * 60))} min`;
}

function toggleRow(
  id: string,
  name: string,
  desc: string,
  on: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rf-set-row';
  const text = document.createElement('div');
  text.className = 'rf-set-text';
  const n = document.createElement('div');
  n.className = 'rf-set-name';
  n.textContent = name;
  const d = document.createElement('div');
  d.className = 'rf-set-desc';
  d.textContent = desc;
  text.append(n, d);
  const btn = document.createElement('button');
  btn.className = 'rf-toggle';
  btn.id = id;
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', String(on));
  btn.setAttribute('aria-label', name);
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  row.append(text, btn);
  return row;
}

function selectRow(
  name: string,
  desc: string,
  options: Array<{ value: string; label: string }>,
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rf-set-row rf-set-row-select';
  const text = document.createElement('div');
  text.className = 'rf-set-text';
  const n = document.createElement('div');
  n.className = 'rf-set-name';
  n.textContent = name;
  const d = document.createElement('div');
  d.className = 'rf-set-desc';
  d.textContent = desc;
  text.append(n, d);
  const sel = document.createElement('select');
  sel.className = 'rf-select rf-set-select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(text, sel);
  return row;
}

function section(title: string, ...rows: HTMLElement[]): HTMLElement {
  const s = document.createElement('div');
  s.className = 'rf-set-section';
  const h = document.createElement('div');
  h.className = 'rf-set-section-h';
  h.textContent = title;
  s.append(h, ...rows);
  return s;
}

// ------------------------------------------------------------------- menu --

export class PauseMenu {
  readonly root: HTMLElement;
  private opts: PauseMenuOptions;
  private tabBodies: Map<string, HTMLElement>;
  private statsBody: HTMLElement;

  constructor(opts: PauseMenuOptions) {
    this.opts = opts;
    const root = document.createElement('div');
    root.className = 'rf-overlay rf-pause';
    root.innerHTML = `
      <div class="rf-bg frost" aria-hidden="true"></div>
      <div class="rf-card rf-pause-card">
        <div class="rf-pause-head">
          <div class="grow">
            <div class="rf-kicker">Ares Expeditionary Command · colony paused</div>
            <h2 class="rf-h2">MISSION PAUSED</h2>
          </div>
          <button class="rf-icon-btn rf-btn" data-act="resume" title="Resume (Esc)" aria-label="Resume">✕</button>
        </div>
        <div class="rf-pause-clock" data-part="clock">Sol 1 · 08:00</div>
        <div class="rf-tabs" role="tablist">
          <button class="rf-tab active" role="tab" data-tab="actions">Actions</button>
          <button class="rf-tab" role="tab" data-tab="settings">Settings</button>
          <button class="rf-tab" role="tab" data-tab="expedition">Expedition</button>
        </div>
        <div class="rf-tab-body" data-body="actions"></div>
        <div class="rf-tab-body" data-body="settings" style="display:none"></div>
        <div class="rf-tab-body" data-body="expedition" style="display:none"></div>
      </div>`;
    this.root = root;

    (root.querySelector('[data-act="resume"]') as HTMLButtonElement).addEventListener('click', opts.onResume);
    root.querySelectorAll<HTMLButtonElement>('.rf-tab').forEach((t) =>
      t.addEventListener('click', () => this.showTab(t.dataset.tab ?? 'actions')),
    );

    const actions = root.querySelector('[data-body="actions"]') as HTMLElement;
    actions.innerHTML = `
      <button class="rf-btn rf-btn-primary rf-pause-resume" data-act="resume2">
        <span class="mi" aria-hidden="true">▶</span>
        <span class="rf-btn-label">Resume<small>Back to the colony — Esc</small></span>
      </button>
      <button class="rf-btn" data-act="save">
        <span class="mi" aria-hidden="true">▤</span>
        <span class="rf-btn-label">Save game<small>Write the colony to its save slot — Ctrl+S</small></span>
      </button>
      <button class="rf-btn rf-btn-danger" data-act="quit">
        <span class="mi" aria-hidden="true">⏏</span>
        <span class="rf-btn-label">Return to main menu<small>Saves first, then hands back</small></span>
      </button>`;
    (actions.querySelector('[data-act="resume2"]') as HTMLButtonElement).addEventListener('click', opts.onResume);
    (actions.querySelector('[data-act="save"]') as HTMLButtonElement).addEventListener('click', opts.onSave);
    (actions.querySelector('[data-act="quit"]') as HTMLButtonElement).addEventListener('click', opts.onReturnToMenu);

    this.buildSettings(root.querySelector('[data-body="settings"]') as HTMLElement);
    this.statsBody = root.querySelector('[data-body="expedition"]') as HTMLElement;
    this.tabBodies = new Map(
      [...root.querySelectorAll<HTMLElement>('.rf-tab-body')].map((b) => [b.dataset.body ?? '', b]),
    );
    this.refreshStats();
  }

  private buildSettings(body: HTMLElement): void {
    const s = this.opts.settings;
    body.innerHTML = '';
    body.appendChild(
      section(
        'Game',
        toggleRow(
          'pm-set-autopause',
          'Auto-pause on critical alert',
          'Freeze the moment a new critical alert appears, so nothing burns while you decide.',
          s.autopauseOnCrit,
          (on) => s.onAutopause(on),
        ),
        toggleRow(
          'pm-set-savehide',
          'Save when the tab is hidden',
          'Persist the colony automatically when you switch tabs or minimise the window.',
          s.saveOnTabHide,
          (on) => s.onSaveOnTabHide(on),
        ),
        selectRow(
          'Autosave',
          'How often the colony writes itself to storage in the background.',
          AUTO_SAVE_INTERVALS.map((o) => ({ value: String(o.sec), label: o.label })),
          String(s.autosaveIntervalSec),
          (v) => s.onAutosaveInterval(Number(v)),
        ),
      ),
    );
    body.appendChild(
      section(
        'Graphical',
        selectRow(
          'Render resolution',
          'How many pixels the world draws at. Lower is much cheaper on weak GPUs.',
          RENDER_RESOLUTIONS.map((o) => ({ value: o.id, label: o.label })),
          s.renderResolution,
          (v) => s.onRenderResolution(v as RenderResolution),
        ),
        toggleRow(
          'pm-set-shadows',
          'Shadows',
          'Directional sun shadows across the colony. The single heaviest effect.',
          s.shadows,
          (on) => s.onShadows(on),
        ),
        toggleRow(
          'pm-set-fx',
          'Weather particles',
          'Wind, storm grit, dust devils and rover dust trails.',
          s.weatherFx,
          (on) => s.onWeatherFx(on),
        ),
      ),
    );
    const iface = section(
      'Interface',
      toggleRow(
        'pm-set-hud',
        'Hide HUD panels',
        'Clear the screen for a full-bleed view of the world. The 👁 button does this too.',
        s.hudPanelsHidden,
        (on) => s.onHudPanelsHidden(on),
      ),
    );
    const reset = document.createElement('div');
    reset.className = 'rf-set-row rf-set-row-btn';
    const rtext = document.createElement('div');
    rtext.className = 'rf-set-text';
    const rn = document.createElement('div');
    rn.className = 'rf-set-name';
    rn.textContent = 'Panel layout';
    const rd = document.createElement('div');
    rd.className = 'rf-set-desc';
    rd.textContent = 'Forget every dragged position and fold, and re-dock the panels.';
    rtext.append(rn, rd);
    const rbtn = document.createElement('button');
    rbtn.className = 'rf-btn rf-set-reset';
    rbtn.type = 'button';
    rbtn.textContent = 'Restore defaults';
    rbtn.addEventListener('click', () => s.onResetPanelLayout());
    reset.append(rtext, rbtn);
    iface.appendChild(reset);
    body.appendChild(iface);
  }

  // ---------------------------------------------------------------- tabs --

  private showTab(name: string): void {
    for (const [id, btn] of this.tabButtons()) btn.classList.toggle('active', id === name);
    for (const [id, body] of this.tabBodies) body.style.display = id === name ? '' : 'none';
    if (name === 'expedition') this.refreshStats();
  }

  private *tabButtons(): Generator<[string, HTMLButtonElement]> {
    for (const t of this.root.querySelectorAll<HTMLButtonElement>('.rf-tab')) {
      yield [t.dataset.tab ?? '', t];
    }
  }

  /** (Re)render the Expedition tab from a fresh stats pull. */
  refreshStats(): void {
    const stats = this.opts.getStats();
    const body = this.statsBody;
    body.innerHTML = '';
    if (!stats) {
      const empty = document.createElement('div');
      empty.className = 'rf-empty';
      empty.textContent = 'No colony is running.';
      body.appendChild(empty);
      this.setClock('');
      return;
    }
    this.setClock(stats.clockText);
    const grid = document.createElement('div');
    grid.className = 'rf-stat-grid';
    body.appendChild(grid);
    grid.appendChild(this.card('Expedition', [
      ['Name', stats.name],
      ['Difficulty', stats.difficulty],
      ['Claim', stats.worldSize],
      ['Landing zone', stats.region],
      ['World seed', stats.seedText || '—'],
      ['Time on Mars', fmtSols(stats.solsPlayed)],
    ]));
    grid.appendChild(this.card('Power', [
      ['Generation', `${stats.power.genKw.toFixed(1)} kW`],
      ['Load', `${stats.power.loadKw.toFixed(1)} kW`],
      ['Battery', `${Math.round(stats.power.batteryPct)}%`],
      [
        'Curtailed',
        stats.power.curtailKw > 0.05 ? `${stats.power.curtailKw.toFixed(1)} kW (brownout)` : 'none',
      ],
    ]));
    grid.appendChild(this.card('Cargo stores', [
      ...stats.resources.map(
        (r): [string, string] => [r.label, `${fmtKg(r.amount)} / ${fmtKg(r.capacity)}`],
      ),
    ]));
    grid.appendChild(this.card('Life support', [
      ...stats.fluids.map(
        (f): [string, string] => [
          `${f.label} · ${f.netPerSol > 0.005 ? '+' : f.netPerSol < -0.005 ? '−' : '±'}${Math.abs(
            f.netPerSol,
          ).toFixed(1)} kg/sol`,
          `${f.amount.toFixed(1)} / ${Math.round(f.capacity)} kg`,
        ],
      ),
    ]));
    grid.appendChild(this.card('Crew', [
      ['Commander', stats.crew.name],
      ['Status', stats.crew.status],
      ['Health', `${Math.round(stats.crew.healthPct)}%`],
      ['Suit O₂', stats.crew.inside ? 'docked' : `${Math.round(stats.crew.suitPct)}%`],
    ]));
    grid.appendChild(this.card('Fleet', [
      ['Rovers', `${stats.fleet.total}`],
      ['Working / idle', `${stats.fleet.working} / ${stats.fleet.idle}`],
      ['Stranded', String(stats.fleet.stranded)],
      ['Avg battery', `${Math.round(stats.fleet.avgBatteryPct)}%`],
      ['Avg condition', `${Math.round(stats.fleet.avgConditionPct)}%`],
    ]));
    grid.appendChild(this.card('Structures', [
      ['Total', String(stats.structures.total)],
      ['Online', String(stats.structures.online)],
      ['Under construction', String(stats.structures.building)],
      ['Damaged', String(stats.structures.damaged)],
    ]));
    grid.appendChild(this.card('Weather', [
      ['Sky', stats.weather.storm],
      ['Wind', `${Math.round(stats.weather.wind)} m/s`],
      ['Airborne dust', `${Math.round(stats.weather.dustPct)}%`],
      ['Visibility', `${Math.round(stats.weather.visibilityPct)}%`],
    ]));
    grid.appendChild(this.card('Colony status', [
      ['Alerts', `⛔ ${stats.alerts.crit} · ⚠ ${stats.alerts.warn} · ✦ ${stats.alerts.opportunity}`],
      [
        'Last save',
        stats.lastSave.at === null
          ? 'never'
          : stats.lastSave.ok
            ? `successful · ${timeAgo(stats.lastSave.at)}`
            : `failed · ${timeAgo(stats.lastSave.at)}`,
      ],
      ['Mission', stats.gameOver.active ? `LOST — ${stats.gameOver.reason}` : 'ongoing'],
    ]));
  }

  private card(title: string, rows: Array<[string, string]>): HTMLElement {
    const c = document.createElement('div');
    c.className = 'rf-stat-card';
    const h = document.createElement('div');
    h.className = 'rf-stat-card-h';
    h.textContent = title;
    c.appendChild(h);
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'rf-summary-row';
      const kk = document.createElement('span');
      kk.className = 'k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'v';
      vv.textContent = v;
      r.append(kk, vv);
      c.appendChild(r);
    }
    return c;
  }

  private setClock(text: string): void {
    const el = this.root.querySelector('[data-part="clock"]') as HTMLElement;
    el.textContent = text || 'Sol 1 · 08:00';
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }
}

/** "2h ago" for the last-save line. */
function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
