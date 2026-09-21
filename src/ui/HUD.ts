/**
 * The DOM HUD.
 *
 * TDD §18: DOM/CSS for menus and info-heavy panels. This layer only ever
 * *reads* the simulation — every mutation goes back through a callback so the
 * sim stays the single source of truth.
 *
 * Performance note: rebuilding innerHTML every frame at 60 fps is what makes
 * browser HUDs feel sluggish. Panels here are built once and then patched
 * field-by-field through cached element references.
 */

import { itemIcon } from './ItemIcons';
import { effectiveBuildingDef, UPGRADES } from '../sim/engineering/upgrades';
import { effectiveRoverDef } from '../sim/engineering/upgrades';
import { updateWaterPanel } from './WaterPanel';

import type { BuildingKind, ComponentId, ResourceId, FluidId } from '../sim/defs';
import { UNLOCKS, blueprintLock, blueprintLockReason } from '../sim/unlocks';
import { projectPip, autonomyChip } from './ProjectsPanel';
import type { ProjectsPanelModel } from './ProjectsPanel';
import {
  BUILDINGS,
  BUILDING_ORDER,
  RESOURCES,
  ALL_RESOURCES,
  ALL_FLUIDS,
  ALL_COMPONENTS,
  COMPONENTS,
  FLUIDS,
  ROVERS,
  ROVER_PARTS,
  activeSummary,
  hasProcess,
  hasRecipes,
  recipesFor,
} from '../sim/defs';
import type { BuildingView, RoverView, ColonistView, AlertView, AlertsView, SimView } from '../sim/host';
import type { RoverTask } from '../sim/Simulation';
import { roverStatusText, colonistStatusText } from '../sim/Simulation';
import { stormLabel } from '../sim/weather';
import { shortSha } from './BuildStatus';
import {
  POWER_TIER_LABELS,
  SUIT_O2_CAPACITY,
  SOL_SECONDS,
  SPEEDS,
  BUILDING_MAX_HEALTH,
  PART_REPLACE_THRESHOLD,
  PART_REPLACE_SECONDS,
  ROVER_CONDITION_SLOW,
  devLevelMul,
} from '../sim/config';
import type { PowerTier } from '../sim/config';
import type { Severity } from '../sim/alerts';
import { isPickedClean, POI_KINDS, salvageTotalKg } from '../sim/pois';
import type { Poi } from '../sim/pois';
import { MapRenderer, WorldMapOverlay, fitTransform, stormOverlayKey, type MapTransform } from './WorldMap';
import { SETTINGS_KEYS } from './Settings';

export type OverlayMode = 'none' | 'power' | 'life' | 'weather' | 'water';

/**
 * Why a save failed. `read` = the snapshot could not be produced (the colony
 * could not be serialised); `storage` = the snapshot was fine but the browser
 * refused to write it (quota). The error dialog phrases each one differently.
 */
export type SaveErrorKind = 'read' | 'storage';

export interface HUDCallbacks {
  onSpeed: (idx: number) => void;
  onPickBuild: (kind: BuildingKind | null) => void;
  onAction: (action: string, arg?: number | string) => void;
  onStart: (seedText: string, near: number) => void;
  onOverlay: (mode: OverlayMode) => void;
  /** Open the in-game pause menu (the topbar ☰ button). */
  onMenu?: () => void;
  /** Toggle the developer-mode panel. */
  onDev?: () => void;
  /** The project pip on the vitals header — toggles the projects card. */
  onProjectPip?: () => void;
  /** World map selection. */
  onMapSelect?: (type: 'rover' | 'building' | 'colonist' | 'poi', id: number) => void;
  /** World map empty click — optional camera focus. */
  onMapFocus?: (x: number, z: number) => void;
  /** Save progress visibility, including its exit fade; saved is true only on success. */
  onSaveProgress?: (open: boolean, saved: boolean) => void;
  /** "Retry" on the save-failed dialog — re-run the failed save. */
  onSaveRetry?: () => void;
  /** "Save as new file" on the save-failed dialog. */
  onSaveAsNew?: () => void;
  /** "Keep playing" on the save-failed dialog — just close it. */
  onSaveDismiss?: () => void;
  /** "Return without saving" on the save-failed dialog (menu hand-off only). */
  onSaveAbandon?: () => void;
  /** "Save colony" on the in-play update card (TDD §23). */
  onUpdateSave?: () => void;
  /** "Reload now" on the update card — offered only after a successful save. */
  onUpdateReload?: () => void;
  /** "Later" on the update card — keep playing this build. */
  onUpdateLater?: () => void;
}

const fmtKg = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(1)} t` : `${Math.round(n)} kg`;

/** How long a touch must rest on a blueprint before its dossier opens. */
const BUILD_INFO_HOLD_MS = 450;
/** Drift beyond this (px) turns a hold into a swipe — no dossier. */
const BUILD_INFO_DRIFT_PX = 12;

/** One line describing a queued rover task (route list + tooltips). */
function taskLabel(sim: SimView, t: RoverTask): string {
  switch (t.type) {
    case 'moveTo':
      return `Move to ${Math.round(t.x)}, ${Math.round(t.z)}`;
    case 'mine': {
      const d = sim.world.deposits.find((dp) => dp.id === t.depositId);
      const name = d && d.amount > 0 ? RESOURCES[d.resource].label : 'a worked-out seam';
      return `Mine ${name}${t.repeat ? ' — route ⟳' : ''}`;
    }
    case 'construct': {
      const b = sim.buildingById(t.buildingId);
      return `Build ${b ? BUILDINGS[b.kind].label : 'a site'}`;
    }
    case 'clean':
      return 'Clean solar array';
    case 'repair':
      return 'Repair structure';
    case 'recover': {
      const s = sim.roverById(t.roverId);
      return `Jump-start ${s ? s.label : 'a stranded rover'}`;
    }
    case 'salvage': {
      const site = sim.poiById(t.poiId);
      const name = site ? POI_KINDS[site.kind].label : 'a site';
      return site && site.kind === 'supplyDrop' ? `Recover ${name}` : `Salvage ${name}`;
    }
    case 'unload':
      return 'Unload cargo at depot';
    case 'wait':
      return `Wait ${Math.max(0, Math.ceil(t.seconds))} s`;
    default:
      return 'Idle';
  }
}

/** "1.4 sols", "12 h", "42 min" — whichever reads best at this magnitude. */
function fmtDuration(sols: number): string {
  if (!Number.isFinite(sols)) return 'stable';
  if (sols >= 2) return `${sols.toFixed(1)} sols`;
  const hours = sols * 24.66;
  if (hours >= 2) return `${hours.toFixed(1)} h`;
  return `${Math.max(0, Math.round(hours * 60))} min`;
}

function fmtRate(n: number): string {
  const sign = n > 0.001 ? '+' : '';
  if (Math.abs(n) < 0.005) return '±0';
  return `${sign}${n.toFixed(2)}`;
}

function severityIcon(s: Severity): string {
  switch (s) {
    case 'crit':
      return '⛔';
    case 'warn':
      return '⚠';
    case 'opportunity':
      return '✦';
    case 'ok':
      return '✓';
    default:
      return 'ⓘ';
  }
}

/**
 * Compass bearing → "N", "NE", … The sim's bearing convention is atan2(x, z):
 * 0 = north (+Z), turning east (+X) with positive angle.
 */
function compassPoint(bearingRad: number): string {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const deg = ((bearingRad * 180) / Math.PI + 360) % 360;
  return pts[Math.round(deg / 45) % 8];
}

export class HUD {
  private root: HTMLElement;
  /** This instance's own chrome root — lookups never leak into another HUD. */
  private hudRoot!: HTMLElement;
  cb: HUDCallbacks;
  speedIdx = 1;
  activeBuild: BuildingKind | null = null;
  overlay: OverlayMode = 'none';

  // cached element references — built once, patched thereafter
  private els: Record<string, HTMLElement> = {};
  private speedBtns: HTMLElement[] = [];
  private buildBtns = new Map<BuildingKind, HTMLElement>();
  private overlayBtns = new Map<OverlayMode, HTMLElement>();
  private resChips = new Map<ResourceId, { val: HTMLElement; bar: HTMLElement; wrap: HTMLElement }>();
  /** P5: the component rack reads as counts against rack space, not kg. */
  private compChips = new Map<ComponentId, { val: HTMLElement; bar: HTMLElement; wrap: HTMLElement }>();
  private fluidRows = new Map<
    FluidId,
    { val: HTMLElement; bar: HTMLElement; rate: HTMLElement; eta: HTMLElement; row: HTMLElement }
  >();
  private tierRows = new Map<PowerTier, { bar: HTMLElement; val: HTMLElement; row: HTMLElement }>();

  /** Signature of the last inspector render, so we only rebuild on real change. */
  private inspectorKey = '';
  private alertKey = '';
  private alertNodes = new Map<string, HTMLElement>();

  /** Alert keys the player has snoozed (cleared when the condition resolves). */
  private dismissed = new Set<string>();
  private lastAlerts: ReadonlyArray<AlertView> = [];

  /** Opt-in: pause the sim the moment a *new* critical alert appears. */
  autopauseOnCrit = false;
  private autopauseBtn: HTMLElement | null = null;
  /** Critical keys already seen — only arrivals pause, never repeats. */
  private seenCritKeys = new Set<string>();
  private autopauseArmed = false;

  /** The sim's event bus (handed over each frame) — feeds the history modal. */
  private alertBus: AlertsView | null = null;
  private histFilter: Severity | 'all' = 'all';

  /** Pending touch-hold on a blueprint (dossier), if any. */
  private buildInfoTimer: number | null = null;
  private buildInfoAt: { x: number; y: number } | null = null;

  /**
   * Off-screen marker nodes, keyed by `kind-id`. The prefix is load-bearing:
   * rovers, structures and sites each have their own id space, so a bare id
   * would let a stranded rover and a supply drop fight over one node.
   */
  private markerNodes = new Map<string, HTMLElement>();

  // --- minimap + world map (issue #18) ---
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapTr: MapTransform | null = null;
  private worldMap: WorldMapOverlay | null = null;
  private minimapCamera: { x: number; z: number } | null = null;
  private minimapSelected: { type: string; id: number } | null = null;
  private minimapView: SimView | null = null;
  private minimapCollapsed = false;
  private lastMinimapKey = '';

  private vitalsCollapsed = false;
  private projectPipKey = '';
  private autonomyKey = '';
  private inspectorCollapsed = false;
  private buildCollapsed = false;

  /** Panel window manager state (drag / resize / geometry persistence). */
  private dragState: {
    id: string;
    mode: 'move' | 'resize';
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null = null;
  private panelsHidden = false;
  private lastTapOnHandle = { at: 0, id: '' };

  constructor(cb: HUDCallbacks) {
    this.cb = cb;
    this.root = document.getElementById('app')!;
    this.buildChrome();
    this.buildPalette();
    this.setSpeed(1);
    this.initCollapseDefaults();
  }

  // ------------------------------------------------- collapse helpers ----
  private storeGet(key: string): string | null {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null; // private mode, opaque origin, or no DOM storage at all
    }
  }

  private storeSet(key: string, val: string): void {
    try {
      window.localStorage?.setItem(key, val);
    } catch {
      /* collapse state is a nicety, not a promise */
    }
  }

  private isNarrowViewport(): boolean {
    try {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 760px)').matches
      );
    } catch {
      return false;
    }
  }

  /** Stored preference wins; otherwise phones start with the side panels folded. */
  private initCollapseDefaults(): void {
    const narrow = this.isNarrowViewport();
    const read = (key: string, fallback: boolean): boolean => {
      const v = this.storeGet(key);
      if (v === '1') return true;
      if (v === '0') return false;
      return fallback;
    };
    this.setVitalsCollapsed(read('rf-collapse-vitals', narrow));
    this.setBuildCollapsed(read('rf-collapse-build', false));
    // The inspector starts empty; a fresh selection re-opens it (see showRover
    // et al), so folding it on phones costs nothing.
    this.inspectorCollapsed = read('rf-collapse-inspector', narrow);
    this.applyInspectorCollapse();
  }

  setVitalsCollapsed(on: boolean): void {
    this.vitalsCollapsed = on;
    this.el('vitals').classList.toggle('collapsed', on);
    const btn = this.el('vitals-toggle');
    btn.textContent = on ? '▸' : '▾';
    btn.setAttribute('aria-expanded', String(!on));
    btn.setAttribute('title', on ? 'Expand panel' : 'Collapse panel');
    this.storeSet('rf-collapse-vitals', on ? '1' : '0');
  }

  setBuildCollapsed(on: boolean): void {
    this.buildCollapsed = on;
    this.el('buildbar').classList.toggle('bar-hidden', on);
    const btn = this.el('build-toggle');
    btn.textContent = on ? '🏗' : '▾';
    btn.setAttribute('aria-expanded', String(!on));
    btn.setAttribute('title', on ? 'Show build menu' : 'Hide build menu');
    this.storeSet('rf-collapse-build', on ? '1' : '0');
  }

  setInspectorCollapsed(on: boolean): void {
    this.inspectorCollapsed = on;
    this.applyInspectorCollapse();
    this.storeSet('rf-collapse-inspector', on ? '1' : '0');
  }

  private applyInspectorCollapse(): void {
    this.el('inspector').classList.toggle('collapsed', this.inspectorCollapsed);
    const btn = this.el('inspector').querySelector('#i-collapse');
    if (btn) {
      btn.textContent = this.inspectorCollapsed ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!this.inspectorCollapsed));
      btn.setAttribute(
        'title',
        this.inspectorCollapsed ? 'Expand panel' : 'Collapse panel',
      );
    }
  }

  /** Wire the inspector's own bar after each rebuild (its buttons are re-created). */
  private wireInspectorBar(insp: HTMLElement): void {
    insp
      .querySelector('#i-collapse')
      ?.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setInspectorCollapsed(!this.inspectorCollapsed);
      });
    // The rebuild wipes the panel's children — re-arm the window chrome.
    insp.querySelector('.i-bar')?.classList.add('hud-drag');
    this.ensureGrip(insp);
    this.applyInspectorCollapse();
  }

  /** Update an icon+label button, touching the DOM only when it changes. */
  private setIconButton(btn: HTMLElement, icon: string, label: string): void {
    if (btn.dataset.label === label && btn.dataset.icon === icon) return;
    btn.dataset.label = label;
    btn.dataset.icon = icon;
    btn.innerHTML = `${icon} <span class="btn-t">${label}</span>`;
  }

  private el(id: string): HTMLElement {
    let e = this.els[id];
    if (!e) {
      // Scoped to this HUD's own root: a second instance (tests, embeds)
      // must wire its own buttons, never another HUD's.
      e = this.hudRoot.querySelector<HTMLElement>('#' + id)!;
      this.els[id] = e;
    }
    return e;
  }

  // ------------------------------------------------------------ chrome ----
  private buildChrome(): void {
    const d = document.createElement('div');
    d.className = 'hud';
    d.innerHTML = `
      <div class="panel" id="topbar">
        <div class="brand">
          <b>RED FRONTIER</b>
          <span id="clock-line">Sol 1 · 08:00</span>
        </div>
        <div class="sunwrap" id="sunwrap" title="Solar irradiance across the sol">
          <div class="sundial"><div class="sun-dot" id="sun-dot"></div></div>
          <div class="sun-meta"><span id="phase-label">Morning</span><span id="irr-label">0%</span></div>
        </div>
        <div class="resources" id="resources"></div>
        <div class="resources comp-rack" id="components" style="display:none"></div>
        <button class="btn idle-btn" id="idle-btn" title="Select the next idle rover (.)">😴 <span class="btn-t">Idle</span> <span class="idle-n" id="idle-n">0</span></button>
        <button class="btn" id="map-btn" class="btn" title="World map (M)">🗺</button>
        <button class="btn" id="dev-btn" title="Developer mode — world editor (~ backtick)">🛠</button>
        <button class="btn" id="history-btn" title="Alert history (H)">📜</button>
        <button class="btn" id="menu-btn" title="Pause menu — save, settings, expedition info">☰</button>
        <div class="toolbar" id="speeds"></div>
      </div>

      <!-- In-play update notice (TDD §23): a newer build is live. A frosted
           card, not a toast — it tells the player what is new and that they
           must save and reload themselves to continue. Nothing happens
           automatically: both the save and the reload are the player's click. -->
      <div class="update-overlay" id="update-banner" style="display:none" role="alertdialog" aria-modal="true" aria-labelledby="update-title">
        <div class="sp-card ub-card">
          <div class="sp-kicker">Update</div>
          <div class="sp-title" id="update-title">A new version is live</div>
          <div class="ub-builds" id="update-builds"></div>
          <div class="ub-what" id="ub-what" style="display:none">
            <div class="ub-what-title">What's new</div>
            <ul id="update-notes"></ul>
          </div>
          <div class="ub-text" id="update-text"></div>
          <div class="se-actions">
            <button class="btn primary" id="ub-save" title="Save your colony before switching builds">💾 <span class="btn-t">Save colony</span></button>
            <button class="btn" id="ub-reload" style="display:none" title="Reload the page onto the new build">⟳ <span class="btn-t">Reload now</span></button>
            <button class="btn" id="ub-later" title="Keep playing this build for now">Later</button>
          </div>
        </div>
      </div>

      <div class="panel" id="vitals">
        <div class="vitals-head hud-drag">
          <span class="vh-title">Colony vitals</span>
          <span class="vh-sub" id="vitals-sub"></span>
          <button class="mini-btn" id="vitals-toggle" title="Collapse panel" aria-expanded="true">▾</button>
        </div>
        <button class="proj-pip" id="proj-pip" style="display:none" title="Engineering project"></button>
        <div class="auto-chip" id="auto-chip" style="display:none" title="Autonomy"></div>
        <div class="vitals-body" id="vitals-body">
        <div id="power-block">
          <div class="pw-top">
            <div class="pw-num"><span class="pw-k">Generation</span><span class="pw-v" id="pw-gen">0 kW</span></div>
            <div class="pw-num"><span class="pw-k">Load</span><span class="pw-v" id="pw-load">0 kW</span></div>
            <div class="pw-num"><span class="pw-k">Battery</span><span class="pw-v" id="pw-bat">0%</span></div>
          </div>
          <div class="bar-wrap tall"><div class="bar-fill amber" id="pw-batbar" style="width:0%"></div></div>
          <div class="pw-flow" id="pw-flow">—</div>
          <canvas id="pw-graph" class="graph" width="260" height="42"></canvas>
          <div class="tiers" id="tiers"></div>
        </div>
        <div class="vdivide"></div>
        <div id="wx-block">
          <div class="wx-head">
            <span class="vh-title">Weather</span>
            <span class="wx-badge" id="wx-badge">Clear</span>
          </div>
          <div class="wx-grid">
            <div class="wx-cell" title="Wind speed and bearing. Storm winds damage exposed structures.">
              <span class="k">Wind</span>
              <span class="wx-wind"><i class="wx-arrow" id="wx-arrow"></i><span class="v" id="wx-wind">—</span></span>
            </div>
            <div class="wx-cell" title="Airborne dust. Dims the sun for panels and crops alike.">
              <span class="k">Dust</span>
              <span class="wx-bar"><i id="wx-dust-bar" style="width:0%"></i></span>
            </div>
            <div class="wx-cell" title="Visibility. Storm haze closes the world in.">
              <span class="k">Visibility</span>
              <span class="wx-bar"><i id="wx-vis-bar" style="width:100%"></i></span>
            </div>
          </div>
          <canvas id="wx-radar-map" class="wx-radar-map" width="260" height="82" aria-label="Weather radar map"></canvas>
          <div class="wx-radar-status" id="wx-radar-status">Radar offline · build a Weather Radar Station.</div>
          <div class="wx-status" id="wx-status">Clear skies.</div>
        </div>
        <div class="vdivide"></div>
        <div id="life-block"></div>
        <div class="vdivide"></div>
        <div id="crew-block">
          <div class="crew-head"><span id="crew-name">Cmdr. Vega</span><span id="crew-status">Sheltered</span></div>
          <div class="stat"><span class="k">Health</span><span class="v" id="crew-health">100%</span></div>
          <div class="bar-wrap"><div class="bar-fill green" id="crew-hp-bar" style="width:100%"></div></div>
          <div class="stat"><span class="k">Suit O₂</span><span class="v" id="crew-suit">100%</span></div>
          <div class="bar-wrap"><div class="bar-fill cyan" id="crew-suit-bar" style="width:100%"></div></div>
        </div>
        </div>
      </div>

      <div class="panel" id="alerts"></div>
      <div id="markers"></div>
      <div class="panel" id="minimap">
        <div class="minimap-head hud-drag">
          <span class="vh-title">Map</span>
          <span class="vh-sub" id="minimap-sub"></span>
          <span class="i-spacer"></span>
          <button class="mini-btn" id="minimap-toggle" title="Collapse minimap">⛶</button>
        </div>
        <canvas id="minimap-canvas" width="160" height="160" title="Click to open world map"></canvas>
      </div>
      <div class="panel" id="inspector"><div class="empty">Select a rover, a building, or your colonist.</div></div>
      <div class="panel" id="buildbar"></div>
      <div class="build-info" id="build-info" style="display:none">
        <div class="bi-head"><span id="bi-icon"></span><b id="bi-name"></b><span class="i-spacer"></span><button class="mini-btn" id="bi-close" title="Close">×</button></div>
        <div class="bi-desc" id="bi-desc"></div>
        <div class="bi-cost" id="bi-cost"></div>
        <div class="bi-power" id="bi-power"></div>
        <div class="bi-process" id="bi-process"></div>
        <div class="bi-process" id="bi-radar" style="display:none"></div>
      </div>
      <div class="panel" id="hintbar" style="display:none"></div>
      <div class="panel" id="log"><span class="lg-title hud-drag">Colony log</span><div class="log-body" id="log-body"></div></div>

      <div class="hist-overlay" id="history-overlay" style="display:none">
        <div class="hist-card">
          <div class="hist-head"><b>Alert history</b><span class="hist-count" id="hist-count"></span><span class="i-spacer"></span><button class="mini-btn" id="hist-close" title="Close (Esc)">×</button></div>
          <div class="hist-chips" id="hist-chips"></div>
          <div class="hist-list" id="hist-list"></div>
        </div>
      </div>

      <div class="overlay" id="start-overlay">
        <h1>RED FRONTIER</h1>
        <div class="tag">
          One human. A handful of machines. An entire planet that doesn’t want you there.<br/>
          <b>Prototype 4</b> — the rover slice: task queues and repeating haul routes, the Rover Garage
          (fast charge, field service, new rovers off the assembly line), drivetrain wear, and
          jump-start rescue for stranded machines — on top of the full survival, power and weather sim.
        </div>
        <div class="actions">
          <label>World seed
            <input id="seed-input" type="text" value="mars2066" /></label>
          <label>Starter deposits nearby
            <select id="near-select">
              <option value="0.2">Standard</option>
              <option value="0.34">Plentiful</option>
              <option value="0.08">Scarce</option>
            </select></label>
          <button class="btn primary" id="start-btn">Begin Mission</button>
        </div>
        <div class="briefing">
          <b>Sol 1 briefing.</b> Your descent stage carries an RTG, a few sols of air, water and rations, and
          two rovers. Everything after that you build. The chain is
          <span class="chain">ice → <span class="c-w">water</span> → <span class="c-o">oxygen</span></span>, and
          a greenhouse to close the food loop. Solar dies every night — batteries are what get you to morning.
        </div>
      </div>

      <div class="overlay" id="end-overlay" style="display:none">
        <h1 id="end-title">MISSION LOST</h1>
        <div class="tag" id="end-text"></div>
        <div class="actions"><button class="btn primary" id="end-restart">Return to start</button></div>
      </div>

      <!-- Save in flight: blurs the live colony and reports each stage. The
           world keeps ticking behind it — this is a status board, not a pause. -->
      <div class="save-overlay" id="save-progress" style="display:none" aria-live="polite">
        <div class="sp-card">
          <div class="sp-kicker">Colony records</div>
          <div class="sp-title" id="sp-title">Saving colony</div>
          <div class="sp-steps">
            <div class="sp-step" id="sp-step-0"><span class="sp-ic" aria-hidden="true">·</span><span>Reading colony state</span></div>
            <div class="sp-step" id="sp-step-1"><span class="sp-ic" aria-hidden="true">·</span><span>Compressing data</span></div>
            <div class="sp-step" id="sp-step-2"><span class="sp-ic" aria-hidden="true">·</span><span>Writing to storage</span></div>
          </div>
          <div class="sp-track"><div class="sp-fill" id="sp-fill"></div></div>
          <div class="sp-meta" id="sp-meta">The sol clock keeps running while this finishes.</div>
        </div>
      </div>

      <!-- A save failed: explain why and let the player choose the recovery. -->
      <div class="save-overlay" id="save-error" style="display:none" role="alertdialog" aria-modal="true" aria-labelledby="se-title">
        <div class="sp-card sp-card-err">
          <div class="sp-kicker sp-kicker-err">Save fault</div>
          <div class="sp-title sp-title-err" id="se-title">Save failed</div>
          <div class="sp-reason" id="se-reason"></div>
          <div class="se-actions">
            <button class="btn primary" id="se-retry" title="Try writing the save again">↻ <span class="btn-t">Retry save</span></button>
            <button class="btn" id="se-new" title="Start a fresh save file for this colony">▤ <span class="btn-t">Save as new file</span></button>
            <button class="btn" id="se-dismiss" title="Close this and keep playing">✕ <span class="btn-t">Keep playing</span></button>
            <button class="btn danger" id="se-abandon" style="display:none" title="Go back to the main menu; progress since the last save is lost">⏏ <span class="btn-t">Return to menu without saving</span></button>
          </div>
        </div>
      </div>

      <div id="save-flash"></div>
    `;
    this.hudRoot = d;
    this.root.appendChild(d);

    this.el('idle-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onAction('cycle-idle');
    });
    this.el('dev-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onDev?.();
    });
    this.el('history-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.openAlertHistory();
    });
    this.el('menu-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onMenu?.();
    });
    this.el('se-retry').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onSaveRetry?.();
    });
    this.el('se-new').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onSaveAsNew?.();
    });
    this.el('se-dismiss').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onSaveDismiss?.();
    });
    this.el('se-abandon').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onSaveAbandon?.();
    });
    this.el('ub-save').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onUpdateSave?.();
    });
    this.el('ub-reload').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onUpdateReload?.();
    });
    this.el('ub-later').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onUpdateLater?.();
    });
    this.el('hist-close').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.closeAlertHistory();
    });
    this.el('bi-close').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.closeBuildInfo();
    });
    this.buildHistoryChips();

    this.autopauseOnCrit = this.storeGet(SETTINGS_KEYS.autopause) === '1';
    this.buildResourceChips();
    this.buildComponentChips();
    this.buildLifeBlock();
    this.buildTierRows();
    this.buildSpeeds();
    this.buildOverlayToggles();
    this.syncAutopauseBtn();

    this.el('start-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const seed = (this.el('seed-input') as HTMLInputElement).value;
      const near = parseFloat((this.el('near-select') as HTMLSelectElement).value) || 0.2;
      this.cb.onStart(seed, near);
    });
    this.el('end-restart').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      window.location.reload();
    });

    this.el('proj-pip').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.cb.onProjectPip?.();
    });
    this.el('vitals-toggle').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.setVitalsCollapsed(!this.vitalsCollapsed);
    });
    // Normalise the inspector to the bar + body structure every render path
    // below assumes.
    this.clearInspector();

    // Panel window management: drag by the header, resize by the corner grip,
    // geometry persisted — plus the one-tap "clear the screen" peek button.
    this.enablePanelWindows();
    this.buildPeekButton();
    this.buildMinimap();
    this.buildWorldMap();
  }

  // ------------------------------------------------ minimap / world map ----
  private buildMinimap(): void {
    const canvas = this.el('minimap')?.querySelector('#minimap-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this.minimapCanvas = canvas;
    const ctx = canvas.getContext('2d');
    if (ctx) this.minimapCtx = ctx;

    // click / tap opens world map
    const open = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      this.openWorldMap();
    };
    canvas.addEventListener('pointerdown', open);
    canvas.addEventListener('click', open);

    // header button collapses minimap
    try {
      this.el('minimap-toggle').addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setMinimapCollapsed(!this.minimapCollapsed);
      });
    } catch {}

    // map button in topbar
    try {
      this.el('map-btn').addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (this.worldMap?.isVisible()) this.closeWorldMap();
        else this.openWorldMap();
      });
    } catch {}

    // drag handle for minimap
    this.el('minimap').querySelector('.minimap-head')?.classList.add('hud-drag');
    this.ensureGrip(this.el('minimap'));

    const collapsed = this.storeGet('rf-collapse-minimap') === '1';
    this.setMinimapCollapsed(collapsed);
  }

  private buildWorldMap(): void {
    this.worldMap = new WorldMapOverlay({
      onSelect: (type, id) => {
        // select in HUD + Game
        this.cb.onMapSelect?.(type, id);
        // also trigger normal focus/selection path for compatibility
        if (type !== 'poi') this.cb.onAction('focus', id);
        this.minimapSelected = { type, id };
      },
      onFocus: (x, z) => {
        this.cb.onMapFocus?.(x, z);
      },
      onClose: () => {
        // no sim change
      },
    });
  }

  setMinimapCollapsed(on: boolean): void {
    this.minimapCollapsed = on;
    try {
      this.el('minimap').classList.toggle('collapsed', on);
      const btn = this.el('minimap').querySelector('#minimap-toggle') as HTMLElement | null;
      if (btn) {
        btn.textContent = on ? '▸' : '▾';
        btn.title = on ? 'Expand minimap' : 'Collapse minimap';
      }
    } catch {}
    this.storeSet('rf-collapse-minimap', on ? '1' : '0');
  }

  openWorldMap(): boolean {
    if (!this.worldMap) return false;
    this.worldMap.open();
    return true;
  }

  closeWorldMap(): boolean {
    if (!this.worldMap) return false;
    if (!this.worldMap.isVisible()) return false;
    this.worldMap.close();
    return true;
  }

  isWorldMapOpen(): boolean {
    return !!this.worldMap?.isVisible();
  }

  /** Called every HUD tick from Game.syncUI — updates both canvases. */
  updateMinimap(sim: SimView, camera: { x: number; z: number } | null, selected: { type: string; id: number } | null): void {
    this.minimapView = sim;
    this.minimapCamera = camera;
    this.minimapSelected = selected;

    // push to world map overlay if open
    if (this.worldMap?.isVisible()) {
      this.worldMap.setView(sim, camera, selected);
    }

    // minimap render throttled by simple key
    const canvas = this.minimapCanvas;
    const ctx = this.minimapCtx;
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    // cheap change detection: rovers/buildings/pois counts + camera rounded +
    // storm cells, so a travelling front actually animates on the minimap.
    const key = `${sim.world.half}|${sim.rovers.length}|${sim.buildings.length}|${sim.world.pois.length}|${Math.round((camera?.x ?? 0)/5)}|${Math.round((camera?.z ?? 0)/5)}|${selected?.type ?? ''}${selected?.id ?? ''}|${Math.round(sim.colonist.x/3)}|${Math.round(sim.colonist.z/3)}|${stormOverlayKey(sim.weather)}`;
    if (key === this.lastMinimapKey) return;
    this.lastMinimapKey = key;

    const tr = fitTransform(w, h, sim.world.half, 0.12);
    this.minimapTr = tr;
    try {
      this.el('minimap-sub').textContent = `${sim.world.half * 2} m`;
    } catch {}

    MapRenderer.render(ctx, w, h, sim, tr, {
      showGrid: true,
      showDeposits: false,
      showCamera: camera,
      highlightId: selected as any,
      time: performance.now(),
    });
  }

  // ------------------------------------------- panel window management ----

  private static readonly PANEL_MIN: Record<string, { w: number; h: number }> = {
    vitals: { w: 190, h: 110 },
    inspector: { w: 190, h: 120 },
    log: { w: 180, h: 70 },
    minimap: { w: 140, h: 140 },
  };

  private ensureGrip(panel: HTMLElement): void {
    if (panel.querySelector(':scope > .panel-grip')) return;
    const grip = document.createElement('div');
    grip.className = 'panel-grip';
    grip.setAttribute('aria-hidden', 'true');
    panel.appendChild(grip);
  }

  /**
   * Mark the drag handles, add resize grips, restore stored geometry, and
   * wire one delegated pointer pipeline for every panel window. Delegation
   * matters: the inspector rebuilds its entire body on every selection, so a
   * directly-bound handle would keep getting orphaned.
   */
  private enablePanelWindows(): void {
    this.el('vitals').querySelector('.vitals-head')?.classList.add('hud-drag');
    this.el('log').querySelector('.lg-title')?.classList.add('hud-drag');
    try { this.el('minimap').querySelector('.minimap-head')?.classList.add('hud-drag'); } catch {}
    for (const id of ['vitals', 'inspector', 'log', 'minimap']) {
      try { this.ensureGrip(this.el(id)); } catch {}
    }
    this.applyStoredGeometry();

    this.hudRoot.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || this.dragState) return;

      // ---- resize grip -----------------------------------------------------
      const grip = t.closest<HTMLElement>('.panel-grip');
      if (grip) {
        const panel = grip.parentElement as HTMLElement | null;
        if (!panel?.id) return;
        e.preventDefault();
        e.stopPropagation();
        this.beginPanelDrag(panel, 'resize', e);
        return;
      }

      // ---- drag handle -----------------------------------------------------
      const handle = t.closest<HTMLElement>('.hud-drag');
      if (!handle) return;
      // Interactive children keep their taps — a collapse button is not a drag.
      if (t.closest('button, input, select, textarea, label, a')) return;
      const panel = this.panelWindowOf(handle);
      if (!panel) return;
      e.preventDefault();
      e.stopPropagation();
      // A double-tap snaps the panel home; it must not also start a new drag.
      if (this.doubleTapReset(panel)) return;
      this.beginPanelDrag(panel, 'move', e);
    });
  }

  private panelWindowOf(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el;
    while (node && node !== this.hudRoot) {
      if (node.id === 'vitals' || node.id === 'inspector' || node.id === 'log' || node.id === 'minimap') return node;
      node = node.parentElement;
    }
    return null;
  }

  private beginPanelDrag(panel: HTMLElement, mode: 'move' | 'resize', e: PointerEvent): void {
    const rect = panel.getBoundingClientRect();
    // Normalise the panel to explicit left/top/width/height so dragging works
    // identically for right-anchored panels (the inspector).
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = `${rect.width}px`;
    panel.style.maxWidth = 'none';
    panel.style.height = `${Math.min(rect.height, window.innerHeight)}px`;
    panel.style.maxHeight = 'none';

    this.dragState = {
      id: panel.id,
      mode,
      pointerId: e.pointerId ?? 0,
      startX: Number.isFinite(e.clientX) ? e.clientX : 0,
      startY: Number.isFinite(e.clientY) ? e.clientY : 0,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    panel.classList.add('panel-dragging');
    try {
      panel.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / odd environments: the window listeners below still track */
    }

    const onMove = (ev: Event): void => {
      const p = ev as PointerEvent;
      if (!this.dragState || (p.pointerId ?? 0) !== this.dragState.pointerId) return;
      if (!Number.isFinite(p.clientX) || !Number.isFinite(p.clientY)) return;
      const st = this.dragState;
      const panelEl = this.el(st.id);
      const dx = p.clientX - st.startX;
      const dy = p.clientY - st.startY;
      if (st.mode === 'move') {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x = Math.max(-st.width + 48, Math.min(vw - 48, st.left + dx));
        const y = Math.max(0, Math.min(vh - 34, st.top + dy));
        panelEl.style.left = `${x}px`;
        panelEl.style.top = `${y}px`;
      } else {
        const min = HUD.PANEL_MIN[st.id] ?? { w: 160, h: 80 };
        const w = Math.max(min.w, Math.min(window.innerWidth, st.width + dx));
        const h = Math.max(min.h, Math.min(window.innerHeight, st.height + dy));
        panelEl.style.width = `${w}px`;
        panelEl.style.height = `${h}px`;
      }
    };
    const onUp = (ev: Event): void => {
      const p = ev as PointerEvent;
      if (!this.dragState || (p.pointerId ?? 0) !== this.dragState.pointerId) return;
      const st = this.dragState;
      this.dragState = null;
      panel.classList.remove('panel-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const travel = Number.isFinite(p.clientX)
        ? Math.hypot(p.clientX - st.startX, p.clientY - st.startY)
        : 0;
      if (st.mode === 'move' && travel < 6) {
        this.lastTapOnHandle = { at: performance.now(), id: panel.id };
        return;
      }
      if (st.mode === 'move') {
        const r = panel.getBoundingClientRect();
        const s = this.snapPanel(panel, r.left, r.top, r.width, r.height);
        panel.style.left = `${s.x}px`;
        panel.style.top = `${s.y}px`;
      }
      this.storePanelGeometry(panel);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /**
   * A quick double-tap on the header snaps the panel back to its dock.
   * Taps are recorded by the drag pipeline's pointer-up (presses that never
   * moved), so an actual drag can never be mistaken for half of a double-tap.
   */
  private doubleTapReset(panel: HTMLElement): boolean {
    const now = performance.now();
    if (this.lastTapOnHandle.id === panel.id && now - this.lastTapOnHandle.at < 350) {
      this.resetPanelGeometry(panel);
      this.lastTapOnHandle = { at: 0, id: '' };
      return true;
    }
    return false;
  }

  private isCoarsePointer(): boolean {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    } catch { return false; }
  }

  private snapPanel(panel: HTMLElement, x: number, y: number, w: number, h: number): { x: number; y: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const thr = this.isCoarsePointer() ? 20 : 12;
    const M = 8;
    let nx = x;
    let ny = y;

    // Horizontal: snap to viewport edges (with 8px dock margin)
    if (Math.abs(x - M) < thr) nx = M;
    if (Math.abs(vw - (x + w) - M) < thr) nx = vw - w - M;
    // Also snap to 0 if really at edge, but keep 8px dock as final
    if (Math.abs(x) < thr) nx = M;
    if (Math.abs(vw - (x + w)) < thr) nx = vw - w - M;

    // Vertical: snap to viewport + topbar / buildbar / hintbar
    try {
      const topbar = this.el('topbar');
      const tb = topbar.getBoundingClientRect();
      const belowTop = tb.bottom + M;
      if (Math.abs(y - belowTop) < thr) ny = belowTop;
    } catch {}
    try {
      const hint = this.el('hintbar');
      if (hint.style.display !== 'none') {
        const hb = hint.getBoundingClientRect();
        const aboveHint = hb.top - h - M;
        if (Math.abs(y - aboveHint) < thr) ny = aboveHint;
      }
    } catch {}
    try {
      const build = this.el('buildbar');
      const bb = build.getBoundingClientRect();
      const aboveBuild = bb.top - h - M;
      if (Math.abs(y - aboveBuild) < thr) ny = aboveBuild;
    } catch {}

    if (Math.abs(y - M) < thr) ny = M;
    if (Math.abs(vh - (y + h) - M) < thr) ny = vh - h - M;
    if (Math.abs(y) < thr) ny = M;
    if (Math.abs(vh - (y + h)) < thr) ny = vh - h - M;

    // Clamp so snap never pushes partially off-screen
    nx = Math.max(-w + 48, Math.min(vw - 48, nx));
    ny = Math.max(0, Math.min(vh - 34, ny));
    return { x: Math.round(nx), y: Math.round(ny) };
  }

  private storePanelGeometry(panel: HTMLElement): void {
    // Snap on move, not on resize
    const rect = panel.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    if (this.dragState?.mode !== 'resize' && this.dragState?.id === panel.id) {
      // called from drag end – already snapped there, keep
    } else if (panel.dataset.snap !== 'no') {
      const s = this.snapPanel(panel, rect.left, rect.top, rect.width, rect.height);
      x = s.x; y = s.y;
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    }
    this.storeSet(
      `rf-panel-${panel.id}`,
      JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }),
    );
  }

  resetPanelGeometry(panel: HTMLElement): void {
    this.storeSet(`rf-panel-${panel.id}`, '');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.maxWidth = '';
    panel.style.maxHeight = '';
  }

  /**
   * "Restore default layout" (pause menu → interface settings): forgets every
   * remembered panel geometry, snap and fold state, and re-docks the panels
   * the way a fresh profile would.
   */
  resetPanelLayout(): void {
    for (const id of ['vitals', 'inspector', 'log', 'minimap']) {
      try {
        this.resetPanelGeometry(this.el(id));
      } catch {
        /* panel absent — its stored geometry is cleared anyway */
      }
    }
    this.storeSet('rf-collapse-vitals', '');
    this.storeSet('rf-collapse-build', '');
    this.storeSet('rf-collapse-inspector', '');
    this.storeSet('rf-collapse-minimap', '');
    this.setVitalsCollapsed(false);
    this.setBuildCollapsed(false);
    this.setInspectorCollapsed(false);
    try {
      this.setMinimapCollapsed(false);
    } catch {
      /* minimap optional in odd documents */
    }
    this.hint('<b>Panel layout restored</b> — panels are back at their docks.');
  }

  private applyStoredGeometry(): void {
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    for (const id of ['vitals', 'inspector', 'log', 'minimap']) {
      const raw = this.storeGet(`rf-panel-${id}`);
      if (!raw) continue;
      try {
        const g = JSON.parse(raw) as { x?: number; y?: number; w?: number; h?: number };
        if (![g.x, g.y, g.w, g.h].every((n) => Number.isFinite(n))) continue;
        const panel = this.el(id);
        const w = Math.max(140, Math.min(vw, g.w!));
        const h = Math.max(60, Math.min(vh, g.h!));
        const x = Math.max(-w + 48, Math.min(vw - 48, g.x!));
        const y = Math.max(0, Math.min(vh - 34, g.y!));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = `${w}px`;
        panel.style.height = `${h}px`;
        panel.style.maxWidth = 'none';
        panel.style.maxHeight = 'none';
      } catch {
        /* malformed geometry — the CSS dock is the fallback */
      }
    }
  }

  /** The one-tap "get the HUD out of my way" button. */
  private buildPeekButton(): void {
    const b = document.createElement('button');
    b.id = 'hud-peek';
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.setPanelsHidden(!this.panelsHidden);
    });
    this.hudRoot.appendChild(b);
    this.setPanelsHidden(this.storeGet(SETTINGS_KEYS.hudHidden) === '1', false);
  }

  /** Whether the "clear the screen" mode is on (the pause menu reads this). */
  get panelsHiddenState(): boolean {
    return this.panelsHidden;
  }

  setPanelsHidden(on: boolean, persist = true): void {
    this.panelsHidden = on;
    this.hudRoot.classList.toggle('hud-hidden', on);
    const b = this.hudRoot.querySelector<HTMLElement>('#hud-peek');
    if (b) {
      b.textContent = on ? '👁' : '🗂';
      b.title = on ? 'Show HUD panels' : 'Hide HUD panels (clears the screen)';
    }
    if (persist) this.storeSet(SETTINGS_KEYS.hudHidden, on ? '1' : '0');
  }

  private buildResourceChips(): void {
    const wrap = this.el('resources');
    wrap.innerHTML = '';
    for (const r of ALL_RESOURCES) {
      const info = RESOURCES[r];
      const chip = document.createElement('div');
      chip.className = 'res-chip';
      chip.title = `${info.label} — ${info.description}`;
      chip.innerHTML = `
        ${itemIcon(info.id)}
        <span class="rc-body">
          <span class="n">0</span>
          <span class="mini-bar"><i style="width:0%"></i></span>
        </span>`;
      wrap.appendChild(chip);
      this.resChips.set(r, {
        val: chip.querySelector('.n') as HTMLElement,
        bar: chip.querySelector('.mini-bar i') as HTMLElement,
        wrap: chip,
      });
    }
  }

  /**
   * P5: the component rack chips. They look like the resource chips on purpose
   * — same glance, same bar — but read as `4/24` units of rack space, because a
   * motor is counted, not weighed. The whole row stays hidden until a workshop
   * gives the colony a rack: the landing pod has none, and two chips that can
   * never move are just noise on the topbar.
   */
  private buildComponentChips(): void {
    const wrap = this.el('components');
    wrap.innerHTML = '';
    for (const c of ALL_COMPONENTS) {
      const info = COMPONENTS[c];
      const chip = document.createElement('div');
      chip.className = 'res-chip comp';
      chip.title = `${info.label} — ${info.description}`;
      chip.innerHTML = `
        ${itemIcon(info.id)}
        <span class="rc-body">
          <span class="n">0</span>
          <span class="mini-bar"><i style="width:0%"></i></span>
        </span>`;
      wrap.appendChild(chip);
      this.compChips.set(c, {
        val: chip.querySelector('.n') as HTMLElement,
        bar: chip.querySelector('.mini-bar i') as HTMLElement,
        wrap: chip,
      });
    }
  }

  private buildLifeBlock(): void {
    const block = this.el('life-block');
    block.innerHTML = '';
    for (const f of ALL_FLUIDS) {
      const info = FLUIDS[f];
      const row = document.createElement('div');
      row.className = 'life-row';
      row.title = info.description;
      row.innerHTML = `
        <div class="lr-head">
          <span class="lr-name"><i class="dot" style="background:${info.cssColor}"></i>${info.label}</span>
          <span class="lr-val">0</span>
        </div>
        <div class="bar-wrap"><div class="bar-fill" style="background:${info.cssColor};width:0%"></div></div>
        <div class="lr-foot"><span class="lr-rate">±0 kg/sol</span><span class="lr-eta"></span></div>`;
      block.appendChild(row);
      this.fluidRows.set(f, {
        val: row.querySelector('.lr-val') as HTMLElement,
        bar: row.querySelector('.bar-fill') as HTMLElement,
        rate: row.querySelector('.lr-rate') as HTMLElement,
        eta: row.querySelector('.lr-eta') as HTMLElement,
        row,
      });
    }
  }

  private buildTierRows(): void {
    const wrap = this.el('tiers');
    wrap.innerHTML = '';
    for (const tier of [0, 1, 2, 3] as PowerTier[]) {
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.title = `Priority ${tier} — ${POWER_TIER_LABELS[tier]}. Higher tiers are shed first.`;
      row.innerHTML = `
        <span class="t-name">${POWER_TIER_LABELS[tier]}</span>
        <span class="t-bar"><i style="width:100%"></i></span>
        <span class="t-val">—</span>`;
      wrap.appendChild(row);
      this.tierRows.set(tier, {
        bar: row.querySelector('.t-bar i') as HTMLElement,
        val: row.querySelector('.t-val') as HTMLElement,
        row,
      });
    }
  }

  private buildSpeeds(): void {
    const speeds = document.createElement('div');
    speeds.className = 'toolbar';
    const labels = ['❚❚', '1×', '2×', '4×'];
    const tips = ['Pause (Space)', '1× speed', '2× speed', '4× speed'];
    labels.forEach((l, i) => {
      const b = document.createElement('button');
      b.className = 'btn speed-btn';
      b.textContent = l;
      b.title = tips[i];
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setSpeed(i);
        this.cb.onSpeed(i);
      });
      speeds.appendChild(b);
      this.speedBtns.push(b);
    });
    const ap = document.createElement('button');
    ap.className = 'btn speed-btn autopause-btn';
    ap.id = 'autopause-btn';
    ap.textContent = '⏸!';
    ap.title = 'Auto-pause when a critical alert appears (off)';
    ap.setAttribute('aria-pressed', 'false');
    ap.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.setAutopause(!this.autopauseOnCrit);
    });
    speeds.appendChild(ap);
    this.autopauseBtn = ap;
    this.el('speeds').replaceChildren(speeds);
  }

  setAutopause(on: boolean): void {
    this.autopauseOnCrit = on;
    this.storeSet(SETTINGS_KEYS.autopause, on ? '1' : '0');
    this.syncAutopauseBtn();
  }

  private syncAutopauseBtn(): void {
    const b = this.autopauseBtn;
    if (!b) return;
    b.classList.toggle('active', this.autopauseOnCrit);
    b.setAttribute('aria-pressed', String(this.autopauseOnCrit));
    b.title = `Auto-pause when a critical alert appears (${this.autopauseOnCrit ? 'on' : 'off'})`;
  }

  private buildOverlayToggles(): void {
    const wrap = document.createElement('div');
    wrap.className = 'overlay-toggles';
    const modes: Array<[OverlayMode, string, string]> = [
      ['none', '◻', 'No overlay (V)'],
      ['power', '⚡', 'Power overlay — generation, load and reach (V)'],
      ['life', '💧', 'Life-support overlay — fluid producers and consumers (V)'],
      ['water', '🚰', 'Water network — pipes, pumped flow and disconnected ports (V)'],
      ['weather', '🌪', 'Weather overlay — array cleanliness and storm damage (V)'],
    ];
    for (const [mode, icon, tip] of modes) {
      const b = document.createElement('button');
      b.className = 'btn ov-btn';
      b.textContent = icon;
      b.title = tip;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setOverlay(mode);
        this.cb.onOverlay(mode);
      });
      wrap.appendChild(b);
      this.overlayBtns.set(mode, b);
    }
    (this.el('vitals').querySelector('#vitals-body') ?? this.el('vitals')).appendChild(wrap);
    this.setOverlay('none');
  }

  setOverlay(mode: OverlayMode): void {
    this.overlay = mode;
    for (const [m, btn] of this.overlayBtns) btn.classList.toggle('active', m === mode);
  }

  cycleOverlay(): OverlayMode {
    const order: OverlayMode[] = ['none', 'power', 'life', 'weather', 'water'];
    const next = order[(order.indexOf(this.overlay) + 1) % order.length];
    this.setOverlay(next);
    return next;
  }

  // ----------------------------------------------------------- palette ----
  private buildPalette(): void {
    const bar = this.el('buildbar');
    const toggle = document.createElement('button');
    toggle.className = 'build-toggle';
    toggle.id = 'build-toggle';
    toggle.title = 'Hide build menu';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = '▾';
    toggle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.setBuildCollapsed(!this.buildCollapsed);
    });
    bar.appendChild(toggle);
    BUILDING_ORDER.forEach((k, i) => {
      const def = BUILDINGS[k];
      const btn = document.createElement('button');
      btn.className = 'build-btn';
      const costTxt = ALL_RESOURCES.filter((r) => def.cost[r] > 0)
        .map((r) => `${Math.round(def.cost[r])} ${RESOURCES[r].short}`)
        .join(' · ');
      const power =
        def.powerProduceKw > 0
          ? `+${def.powerProduceKw} kW`
          : def.powerDrawKw > 0
            ? `−${def.powerDrawKw} kW`
            : def.batteryKWh
              ? `${def.batteryKWh} kWh`
              : '';
      const radar = def.weatherRadarRangeKm
        ? `\nRadar: ${def.weatherRadarRangeKm} km${def.advancedForecast ? ' · advanced forecast' : ''}`
        : '';
      const lines = linesText(k);
      btn.title = `${def.label} — ${def.description}\n\nCost: ${costTxt}${power ? `\nPower: ${power}` : ''}${lines ? `\n${hasRecipes(k) ? 'Lines' : 'Process'}: ${lines}` : ''}${radar}`;
      btn.innerHTML = `
        <span class="ic">${iconFor(k)}</span>
        <span class="bl">${def.label}</span>
        <span class="cost">${ALL_RESOURCES.filter(r => def.cost[r] > 0).map(r => `<span class="price-item">${itemIcon(r)}${Math.round(def.cost[r])} ${RESOURCES[r].short}</span>`).join('')}</span>
        ${power ? `<span class="pw">${power}</span>` : ''}
        ${i < 9 ? `<span class="key">${i + 1}</span>` : ''}`;
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.closeBuildInfo();
        // A sealed blueprint explains itself instead of arming a ghost the sim
        // would refuse anyway (Phase 2 blueprint gating).
        if (btn.classList.contains('locked')) {
          const lock = btn.querySelector<HTMLElement>('.lock');
          this.hint(lock?.title ?? 'This blueprint has not been earned yet.');
          return;
        }
        const active = this.activeBuild === k;
        this.cb.onPickBuild(active ? null : k);
        // Touch has no hover: holding a blueprint peeks at its dossier instead
        // of arming it. A press that becomes a hold is disarmed as the card
        // opens, so peeking never leaves a blueprint armed by accident.
        if (e.pointerType === 'mouse') return;
        this.cancelBuildInfoTimer();
        this.buildInfoAt = { x: e.clientX, y: e.clientY };
        this.buildInfoTimer = window.setTimeout(() => {
          this.buildInfoTimer = null;
          this.buildInfoAt = null;
          if (!active) this.cb.onPickBuild(null);
          this.showBuildInfo(k);
        }, BUILD_INFO_HOLD_MS);
      });
      btn.addEventListener('pointermove', (e) => {
        const at = this.buildInfoAt;
        if (this.buildInfoTimer === null || !at) return;
        if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > BUILD_INFO_DRIFT_PX) {
          this.cancelBuildInfoTimer();
        }
      });
      btn.addEventListener('pointerup', () => this.cancelBuildInfoTimer());
      btn.addEventListener('pointercancel', () => this.cancelBuildInfoTimer());
      btn.addEventListener('pointerleave', () => this.cancelBuildInfoTimer());
      // Hold-to-peek must not summon the OS context menu mid-press.
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      bar.appendChild(btn);
      this.buildBtns.set(k, btn);
    });
  }

  setBuild(kind: BuildingKind | null): void {
    this.activeBuild = kind;
    for (const [k, btn] of this.buildBtns) btn.classList.toggle('active', kind === k);
  }

  /** Show a blueprint's full dossier (the touch equivalent of hover). */
  showBuildInfo(kind: BuildingKind): void {
    const def = BUILDINGS[kind];
    this.el('bi-icon').textContent = iconFor(kind);
    this.el('bi-name').textContent = def.label;
    this.el('bi-desc').textContent = def.description;
    const costTxt = ALL_RESOURCES.filter((r) => def.cost[r] > 0)
      .map((r) => `${Math.round(def.cost[r])} ${RESOURCES[r].short}`)
      .join(' · ');
    this.el('bi-cost').innerHTML = `<span class="k">Cost</span> ${ALL_RESOURCES.filter(r => def.cost[r] > 0).map(r => `${itemIcon(r)} ${Math.round(def.cost[r])} kg ${RESOURCES[r].short}`).join(' · ')}`;
    const power =
      def.powerProduceKw > 0
        ? `+${def.powerProduceKw} kW generation`
        : def.powerDrawKw > 0
          ? `−${def.powerDrawKw} kW draw (tier ${def.tier})`
          : def.batteryKWh
            ? `${def.batteryKWh} kWh grid storage`
            : '';
    const pw = this.el('bi-power');
    pw.style.display = power ? '' : 'none';
    if (power) pw.innerHTML = `<span class="k">Power</span> ${power}`;
    const pr = this.el('bi-process');
    const biLines = linesText(kind);
    pr.style.display = biLines ? '' : 'none';
    if (biLines) {
      pr.innerHTML = `<span class="k">${hasRecipes(kind) ? 'Lines' : 'Process'}</span> ${biLines}`;
    }
    const radar = this.el('bi-radar');
    radar.style.display = def.weatherRadarRangeKm ? '' : 'none';
    if (def.weatherRadarRangeKm) {
      radar.innerHTML = `<span class="k">Weather</span> ${def.weatherRadarRangeKm} km radar${def.advancedForecast ? ' · advanced forecasting' : ''}`;
    }
    this.el('build-info').style.display = 'block';
  }

  /** Hide the dossier. Returns true if it was open (for Esc chaining). */
  closeBuildInfo(): boolean {
    const card = this.el('build-info');
    if (card.style.display === 'none') return false;
    card.style.display = 'none';
    return true;
  }

  private cancelBuildInfoTimer(): void {
    if (this.buildInfoTimer !== null) {
      window.clearTimeout(this.buildInfoTimer);
      this.buildInfoTimer = null;
    }
    this.buildInfoAt = null;
  }

  /**
   * Grey out anything the colony cannot currently afford, and mark anything it
   * has not yet *earned* (Phase 2 blueprint gating). A locked blueprint stays
   * on the bar so the player can see what a project pays; its badge names the
   * missing unlock, and the sim refuses the placement regardless.
   */
  updateAffordability(sim: SimView): void {
    const earned = sim.objectives?.unlocks.map((u) => u.id) ?? [];
    for (const [k, btn] of this.buildBtns) {
      const def = BUILDINGS[k];
      let affordable = true;
      for (const r of ALL_RESOURCES) {
        if (def.cost[r] > 0 && sim.storage[r] < def.cost[r]) {
          affordable = false;
          break;
        }
      }
      btn.classList.toggle('unaffordable', !affordable);
      const missing = blueprintLock(earned, def.requiresUnlock);
      const wasLocked = btn.classList.contains('locked');
      if (!!missing !== wasLocked) {
        btn.classList.toggle('locked', !!missing);
        btn.setAttribute('aria-disabled', missing ? 'true' : 'false');
        let badge = btn.querySelector<HTMLElement>('.lock');
        if (missing) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'lock';
            btn.appendChild(badge);
          }
          badge.textContent = `🔒 ${UNLOCKS[missing].title}`;
          badge.title = blueprintLockReason(missing);
        } else if (badge) {
          badge.remove();
        }
      }
    }
  }

  /**
   * Select a speed by index into `SPEEDS`.
   *
   * Clamped, because the unclamped version turned an out-of-range index into a
   * frozen colony with no symptom at all: `SPEEDS[4]` is `undefined`, the frame
   * loop's `speed > 0` test is false for `undefined`, and the world quietly stops
   * ticking while every button still looks right. The HUD's own buttons cannot
   * produce that, but a caller in a test or a script can — and a game that stops
   * without saying so is the worst possible failure to leave available.
   */
  setSpeed(idx: number): void {
    const last = Math.max(0, SPEEDS.length - 1);
    this.speedIdx = Number.isFinite(idx) ? Math.min(Math.max(Math.round(idx), 0), last) : 0;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === this.speedIdx));
  }

  // ------------------------------------------------------------ vitals ----
  updateVitals(sim: SimView): void {
    // ---- clock & sun ----
    this.el('clock-line').textContent = sim.clock.format();
    this.el('phase-label').textContent = sim.clock.phase();
    const irr = sim.sun.irradiance;
    this.el('irr-label').textContent = `${Math.round(irr * 100)}% sun`;
    const dot = this.el('sun-dot');
    // Trace the sun along a half-dome: left at dawn, top at noon, right at dusk.
    const ang = Math.PI * (1 - sim.clock.frac * 2 + 0.5);
    dot.style.left = `${50 + Math.cos(ang) * 42}%`;
    dot.style.bottom = `${Math.max(2, Math.sin(ang) * 78)}%`;
    dot.classList.toggle('night', !sim.sun.isDay);

    // ---- resources ----
    const cap = sim.storageCapacity();
    for (const r of ALL_RESOURCES) {
      const ref = this.resChips.get(r)!;
      const v = sim.storage[r];
      ref.val.textContent = Math.round(v).toLocaleString();
      const pct = cap > 0 ? Math.min(100, (v / cap) * 100) : 0;
      ref.bar.style.width = `${pct}%`;
      ref.wrap.classList.toggle('full', pct >= 99.5);
    }

    // ---- component rack (P5) ----
    const rackCap = sim.componentCapacity();
    const rack = this.el('components');
    rack.style.display = rackCap > 0 ? '' : 'none';
    if (rackCap > 0) {
      for (const c of ALL_COMPONENTS) {
        const ref = this.compChips.get(c)!;
        const n = sim.components[c];
        ref.val.textContent = `${n}/${rackCap}`;
        const pct = Math.min(100, (n / rackCap) * 100);
        ref.bar.style.width = `${pct}%`;
        ref.wrap.classList.toggle('full', pct >= 99.5);
        ref.wrap.title = `${COMPONENTS[c].label} — ${n} of ${rackCap} rack slots. ${COMPONENTS[c].description}`;
      }
    }

    // ---- idle rovers ----
    const idleN = sim.idleRovers().length;
    this.el('idle-n').textContent = String(idleN);
    this.el('idle-btn').classList.toggle('none', idleN === 0);

    // ---- power ----
    const p = sim.power;
    this.el('pw-gen').textContent = `${p.generationKw.toFixed(1)} kW`;
    this.el('pw-load').textContent = `${p.servedKw.toFixed(1)} kW`;
    const batPct = p.capacityKWh > 0 ? (p.storedKWh / p.capacityKWh) * 100 : 0;
    this.el('pw-bat').textContent = `${Math.round(batPct)}%`;
    const bar = this.el('pw-batbar');
    bar.style.width = `${Math.max(0, Math.min(100, batPct))}%`;
    bar.className = `bar-fill ${batPct < 15 ? 'red' : batPct < 40 ? 'amber' : 'green'}`;

    const flow = this.el('pw-flow');
    if (p.batteryFlowKw > 0.05) {
      const full = p.capacityKWh - p.storedKWh;
      const hrs = full / p.batteryFlowKw;
      flow.textContent = `Charging ${p.batteryFlowKw.toFixed(1)} kW · full in ${fmtDuration(hrs / 24.66)}`;
      flow.className = 'pw-flow good';
    } else if (p.batteryFlowKw < -0.05) {
      const hrs = p.storedKWh / -p.batteryFlowKw;
      flow.textContent = `Draining ${(-p.batteryFlowKw).toFixed(1)} kW · empty in ${fmtDuration(hrs / 24.66)}`;
      flow.className = `pw-flow ${hrs < 3 ? 'bad' : 'warn'}`;
    } else if (p.curtailedKw > 0.05) {
      flow.textContent = `Batteries full · ${p.curtailedKw.toFixed(1)} kW curtailed`;
      flow.className = 'pw-flow dim';
    } else {
      flow.textContent = 'Grid balanced';
      flow.className = 'pw-flow dim';
    }

    for (const tier of [0, 1, 2, 3] as PowerTier[]) {
      const ref = this.tierRows.get(tier)!;
      const demand = p.tierDemand[tier];
      const sat = p.tierSatisfaction[tier];
      if (demand <= 0.001) {
        ref.bar.style.width = '0%';
        ref.val.textContent = '—';
        ref.row.className = 'tier-row idle';
      } else {
        ref.bar.style.width = `${sat * 100}%`;
        ref.val.textContent = `${(demand * sat).toFixed(1)}/${demand.toFixed(1)} kW`;
        ref.row.className = `tier-row ${sat < 0.995 ? (tier <= 1 ? 'crit' : 'shed') : 'ok'}`;
      }
    }

    this.drawPowerGraph(sim);

    // ---- weather ----
    const wx = sim.weather;
    const badge = this.el('wx-badge');
    badge.textContent = stormLabel(wx.storm);
    badge.className = `wx-badge ${
      wx.storm === 'calm' ? '' : wx.storm === 'severe' || wx.storm === 'planetary' ? 'crit' : 'warn'
    }`;
    this.el('wx-wind').textContent = `${Math.round(wx.windSpeed)} m/s`;
    // The arrow points the way the wind blows (world +Z reads as "up").
    this.el('wx-arrow').style.transform = `rotate(${(wx.windDirRad * 180) / Math.PI}deg)`;
    this.el('wx-dust-bar').style.width = `${Math.round(wx.dust * 100)}%`;
    this.el('wx-vis-bar').style.width = `${Math.round(wx.visibility * 100)}%`;
    this.drawWeatherRadar(sim);

    const wxStatus = this.el('wx-status');
    const fc = wx.forecast();
    const active = wx.current();
    const threat = wx.threat();
    if (active) {
      wxStatus.textContent = `${stormLabel(active.kind)} overhead — clearing in ${fmtDuration(
        wx.passesIn() / SOL_SECONDS,
      )}. Rovers are sheltering.`;
      wxStatus.className = 'wx-status bad';
    } else if (fc) {
      // Storms travel: report where the system is and which way it blows in.
      const where = threat
        ? ` ${Math.round(threat.distKm)} km ${compassPoint(threat.bearingRad)}, tracking in —`
        : '';
      const outlook = wx.radar.advancedForecast ? 'Advanced radar forecast' : `${fc.label} forecast`;
      wxStatus.textContent = `${outlook}${where} here in ~${fmtDuration(
        fc.arrivesIn / SOL_SECONDS,
      )}. Charge batteries, shelter the crews.`;
      wxStatus.className = 'wx-status warn';
    } else if (threat) {
      wxStatus.textContent = `${threat.label} on the map — ${Math.round(threat.distKm)} km ${compassPoint(
        threat.bearingRad,
      )}, arriving in ~${fmtDuration(threat.arrivesIn / SOL_SECONDS)}.`;
      wxStatus.className = 'wx-status warn';
    } else {
      wxStatus.textContent = `Clear skies · ${Math.round(wx.solarTransmission * 100)}% sunlight through the dust`;
      wxStatus.className = 'wx-status';
    }

    // ---- life support ----
    for (const f of ALL_FLUIDS) {
      const ref = this.fluidRows.get(f)!;
      const amount = sim.pools.amounts[f];
      const capacity = sim.pools.capacity[f];
      ref.val.textContent = `${amount.toFixed(1)} / ${Math.round(capacity)} kg`;
      const pct = capacity > 0 ? (amount / capacity) * 100 : 0;
      ref.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

      const rate = sim.netRatePerSol(f);
      ref.rate.textContent = `${fmtRate(rate)} kg/sol`;
      ref.rate.className = `lr-rate ${rate > 0.005 ? 'good' : rate < -0.005 ? 'bad' : 'dim'}`;

      const reserve = sim.reserveSols(f);
      if (!Number.isFinite(reserve)) {
        ref.eta.textContent = rate > 0.005 ? 'gaining' : 'stable';
        ref.eta.className = 'lr-eta dim';
      } else {
        ref.eta.textContent = `empty in ${fmtDuration(reserve)}`;
        ref.eta.className = `lr-eta ${reserve < 1 ? 'bad' : reserve < 3 ? 'warn' : 'dim'}`;
      }
      ref.row.classList.toggle('depleted', amount <= 0.01);
    }

    // ---- crew ----
    const c = sim.colonist;
    this.el('crew-name').textContent = c.name;
    this.el('crew-status').textContent = colonistStatusText(c);
    this.el('crew-health').textContent = `${Math.round(c.health)}%`;
    const hp = this.el('crew-hp-bar');
    hp.style.width = `${c.health}%`;
    hp.className = `bar-fill ${c.health < 35 ? 'red' : c.health < 70 ? 'amber' : 'green'}`;
    const suitPct = (c.suitO2 / SUIT_O2_CAPACITY) * 100;
    this.el('crew-suit').textContent = c.inside ? 'Docked · 100%' : `${Math.round(suitPct)}%`;
    const sb = this.el('crew-suit-bar');
    sb.style.width = `${Math.max(0, Math.min(100, suitPct))}%`;
    sb.className = `bar-fill ${suitPct < 30 ? 'red' : suitPct < 60 ? 'amber' : 'cyan'}`;

    const online = sim.buildings.filter((b) => b.state === 'online').length;
    const sites = sim.buildings.length - online;
    this.el('vitals-sub').textContent = `${online} online${sites ? ` · ${sites} building` : ''}`;

    // ---- autonomy headline (Phase 3) ----
    const auto = sim.autonomy;
    const chipEl = this.el('auto-chip');
    if (auto) {
      const chip = autonomyChip(auto);
      const key = `${chip.text}|${chip.title}`;
      if (key !== this.autonomyKey) {
        this.autonomyKey = key;
        chipEl.style.display = '';
        chipEl.textContent = chip.text;
        chipEl.title = chip.title;
        chipEl.className = `auto-chip ${chip.identity} rung-${chip.rung}`;
      }
    } else {
      chipEl.style.display = 'none';
    }

    // ---- project pip (Phase 2) ----
    const pip = sim.objectives ? projectPip(sim.objectives as ProjectsPanelModel) : null;
    const pipEl = this.el('proj-pip');
    const pipKey = pip ? `${pip.tone}|${pip.text}|${pip.title}` : '';
    if (pipKey !== this.projectPipKey) {
      this.projectPipKey = pipKey;
      pipEl.style.display = pip ? '' : 'none';
      if (pip) {
        pipEl.textContent = pip.text;
        pipEl.title = pip.title;
        pipEl.className = `proj-pip ${pip.tone}`;
      }
    }
  }

  /**
   * Draw the station's planetary radar display. The sim owns the storm cells;
   * this canvas only turns the projected returns into a compact scope, so the
   * worker and local transports render exactly the same map.
   */
  private drawWeatherRadar(sim: SimView): void {
    const canvas = this.el('wx-radar-map') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    const status = this.el('wx-radar-status');
    const radar = sim.weather.radar;
    if (!radar.available) {
      status.textContent = 'Radar offline · build a Weather Radar Station.';
    } else {
      const mode = radar.advancedForecast ? 'advanced forecast' : 'weather map';
      status.textContent = `Radar ${Math.round(radar.coverageKm)} km · ${radar.cells.length} contact${radar.cells.length === 1 ? '' : 's'} · ${mode}`;
    }
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.39;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = radar.available ? 'rgba(8, 31, 28, 0.92)' : 'rgba(26, 18, 16, 0.72)';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = radar.available ? 'rgba(111, 211, 180, 0.22)' : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (const scale of [1, 0.66, 0.33]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    if (!radar.available) {
      ctx.fillStyle = 'rgba(216, 176, 136, 0.7)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NO RADAR LOCK', cx, cy + 3);
      return;
    }

    const range = Math.max(1, radar.coverageKm);
    const toScope = (xKm: number, zKm: number) => ({
      x: cx + (xKm / range) * radius,
      y: cy - (zKm / range) * radius,
    });
    for (const cell of radar.cells) {
      const p = toScope(cell.xKm, cell.zKm);
      const r = Math.max(2, (cell.radiusKm / range) * radius);
      const color =
        cell.kind === 'planetary'
          ? '#f0907e'
          : cell.kind === 'severe'
            ? '#f0c078'
            : cell.kind === 'regional'
              ? '#9fd8ae'
              : '#8fb8d8';
      ctx.globalAlpha = cell.active ? 0.22 : 0.1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = cell.active ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.5, cell.active ? 3.5 : 2.5), 0, Math.PI * 2);
      ctx.fill();
      // Heading tick — the predicted track lives on the world map; this km
      // PPI only needs to say which way the cell is travelling.
      const tick = Math.max(6, r * 0.35);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.sin(cell.heading) * tick, p.y - Math.cos(cell.heading) * tick);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // A slow sweep makes the scope read as an instrument even between returns.
    const sweep = (sim.simTime * 0.55) % (Math.PI * 2);
    ctx.strokeStyle = 'rgba(159, 216, 174, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(sweep) * radius, cy - Math.cos(sweep) * radius);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Small generation/load sparkline. Canvas beats 120 DOM nodes here. */
  private drawPowerGraph(sim: SimView): void {
    const canvas = this.el('pw-graph') as unknown as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hist = sim.history;
    if (hist.length < 2) return;

    let max = 1;
    for (const s of hist) max = Math.max(max, s.genKw, s.loadKw);
    max *= 1.15;

    const xAt = (i: number) => (i / (hist.length - 1)) * w;
    const yAt = (v: number) => h - (v / max) * (h - 4) - 2;

    // battery level as a filled band behind the lines
    ctx.beginPath();
    ctx.moveTo(0, h);
    hist.forEach((s, i) => ctx.lineTo(xAt(i), h - s.storedFrac * (h - 4) - 2));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 190, 90, 0.13)';
    ctx.fill();

    const line = (pick: (s: (typeof hist)[number]) => number, color: string) => {
      ctx.beginPath();
      hist.forEach((s, i) => {
        const x = xAt(i);
        const y = yAt(pick(s));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    line((s) => s.genKw, '#ffd479');
    line((s) => s.loadKw, '#6fd3ff');
  }

  // ------------------------------------------------------------ alerts ----
  updateAlerts(alerts: ReadonlyArray<AlertView>, bus?: AlertsView): void {
    this.lastAlerts = alerts;
    if (bus) this.alertBus = bus;
    this.maybeAutopause(alerts);
    // A dismissal lasts until the condition itself clears — if it re-raises
    // later, it deserves attention again.
    if (this.dismissed.size > 0) {
      const live = new Set(alerts.map((a) => a.key));
      for (const k of [...this.dismissed]) {
        if (!live.has(k)) this.dismissed.delete(k);
      }
    }
    const visible = alerts.filter((a) => !this.dismissed.has(a.key));
    const key =
      JSON.stringify(visible.map((a) => [a.key, a.severity, a.title, a.detail, a.entityId])) +
      `#snoozed:${[...this.dismissed].sort().join(',')}`;
    if (key === this.alertKey) return;
    this.alertKey = key;

    const wrap = this.el('alerts');
    const shown = visible.slice(0, 6);
    const liveKeys = new Set(shown.map((a) => a.key));
    for (const [key, node] of this.alertNodes) {
      if (!liveKeys.has(key)) {
        node.remove();
        this.alertNodes.delete(key);
      }
    }
    wrap.style.display = shown.length || this.dismissed.size ? 'flex' : 'none';
    // Keep each card mounted across live text updates so its entrance
    // animation (and the player's focus/hover) does not restart every tick.
    shown.forEach((a, index) => {
      let node = this.alertNodes.get(a.key);
      if (!node) {
        node = document.createElement('div');
        node.dataset.key = a.key;
        node.innerHTML = `<span class="a-ic"></span>
          <span class="a-body"><b></b><span></span></span>
          <button class="a-x" title="Dismiss">×</button>`;
        const card = node;
        card.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (card.dataset.focus) this.cb.onAction('focus', Number(card.dataset.focus));
          this.dismissAlert(card.dataset.key!);
        });
        card.querySelector('.a-x')!.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.dismissAlert(card.dataset.key!);
        });
        this.alertNodes.set(a.key, card);
      }
      const cls = `alert ${a.severity}`;
      if (node.className !== cls) node.className = cls;
      if (a.entityId != null) node.dataset.focus = String(a.entityId);
      else delete node.dataset.focus;
      node.title = a.entityId != null ? 'Tap to focus & dismiss' : 'Tap to dismiss';
      for (const [selector, text] of [
        ['.a-ic', severityIcon(a.severity)],
        ['.a-body b', a.title],
        ['.a-body span', a.detail],
      ]) {
        const part = node.querySelector(selector)!;
        if (part.textContent !== text) part.textContent = text;
      }
      // Do not even reinsert unchanged siblings: that can restart animations.
      if (wrap.children[index] !== node) wrap.insertBefore(node, wrap.children[index] ?? null);
    });
    let restore = wrap.querySelector<HTMLElement>('.alerts-restore');
    if (this.dismissed.size > 0) {
      if (!restore) {
        restore = document.createElement('div');
        restore.className = 'alerts-restore';
        restore.title = 'Show snoozed alerts';
        restore.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.dismissed.clear();
          this.alertKey = '';
          this.updateAlerts(this.lastAlerts);
        });
        wrap.appendChild(restore);
      }
      restore.textContent = `⚠ ${this.dismissed.size} snoozed — tap to show`;
    } else {
      restore?.remove();
    }
  }

  /**
   * Pause on a *new* critical alert when the player opted in. The first call
   * only records the baseline (restoring into a crisis shouldn't freeze the
   * game before the first frame); afterwards any arrival pauses, while a
   * repeat of an already-seen key never re-pauses after the player resumes.
   */
  private maybeAutopause(alerts: ReadonlyArray<AlertView>): void {
    const live = new Set(alerts.filter((a) => a.severity === 'crit').map((a) => a.key));
    if (!this.autopauseArmed) {
      this.autopauseArmed = true;
      this.seenCritKeys = live;
      return;
    }
    let fresh = false;
    for (const k of live) {
      if (!this.seenCritKeys.has(k)) fresh = true;
    }
    this.seenCritKeys = live;
    if (fresh && this.autopauseOnCrit && this.speedIdx !== 0) {
      this.setSpeed(0);
      this.cb.onSpeed(0);
      this.flashSave('⏸ Auto-paused — critical alert');
    }
  }

  /** Show every retained log event, newest first, behind severity filters. */
  openAlertHistory(): void {
    this.histFilter = 'all';
    this.renderHistory();
    this.el('history-overlay').style.display = 'flex';
  }

  /** Hide the history modal. Returns true if it was open (for Esc chaining). */
  closeAlertHistory(): boolean {
    const ov = this.el('history-overlay');
    if (ov.style.display === 'none') return false;
    ov.style.display = 'none';
    return true;
  }

  private buildHistoryChips(): void {
    const wrap = this.el('hist-chips');
    wrap.innerHTML = '';
    const opts: Array<{ id: Severity | 'all'; label: string }> = [
      { id: 'all', label: 'All' },
      { id: 'crit', label: '⛔ Crit' },
      { id: 'warn', label: '⚠ Warn' },
      { id: 'info', label: 'ⓘ Info' },
      { id: 'ok', label: '✓ OK' },
    ];
    for (const o of opts) {
      const b = document.createElement('button');
      b.className = 'btn hist-chip';
      b.dataset.sev = o.id;
      b.textContent = o.label;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.histFilter = o.id;
        this.renderHistory();
      });
      wrap.appendChild(b);
    }
  }

  private renderHistory(): void {
    const all = this.alertBus?.history() ?? [];
    const items = all
      .filter(
        (e) =>
          this.histFilter === 'all' ||
          e.severity === this.histFilter ||
          // Good-news rarities read as info, not their own tribe.
          (this.histFilter === 'info' && e.severity === 'opportunity'),
      )
      .slice(-120)
      .reverse();
    this.el('hist-chips')
      .querySelectorAll('.hist-chip')
      .forEach((n) =>
        (n as HTMLElement).classList.toggle(
          'active',
          (n as HTMLElement).dataset.sev === this.histFilter,
        ),
      );
    this.el('hist-count').textContent =
      this.histFilter === 'all'
        ? all.length + ' events'
        : items.length + ' of ' + all.length;
    this.el('hist-list').innerHTML = items.length
      ? items
          .map(
            (e) => `
        <div class="hist-item ${e.severity}">
          <span class="a-ic">${severityIcon(e.severity)}</span>
          <span class="hist-body"><span>${e.text}</span><span class="ts">${e.stamp}</span></span>
        </div>`,
          )
          .join('')
      : '<div class="hist-empty">No events recorded yet.</div>';
  }

  /**
   * Edge markers for trouble the camera can't see: stranded rovers and
   * storm-damaged structures. On-screen entities need no marker (the world
   * shows them); off-screen ones clamp to the viewport edge, and tapping one
   * focuses it like an alert would. Runs every frame — node churn is avoided
   * by reusing one button per entity and only rewriting changed labels.
   */
  updateMarkers(
    sim: SimView,
    project: (x: number, z: number) => { x: number; y: number; behind: boolean },
  ): void {
    const wrap = this.el('markers');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 46; // edge margin: markers live inside the chrome, not under it
    const seen = new Set<string>();

    const cands: Array<{
      key: string;
      x: number;
      z: number;
      icon: string;
      label: string;
      cls: string;
      focus: number | null;
    }> = [];
    for (const r of sim.rovers) {
      if (r.phase === 'disabled') {
        cands.push({
          key: `rover-${r.id}`,
          x: r.x,
          z: r.z,
          icon: '🛻',
          label: `${r.label} stranded`,
          cls: 'crit',
          focus: r.id,
        });
      }
    }
    for (const b of sim.buildings) {
      if (b.damaged) {
        cands.push({
          key: `building-${b.id}`,
          x: b.x,
          z: b.z,
          icon: '🏚',
          label: `${BUILDINGS[b.kind].label} damaged`,
          cls: 'warn',
          focus: b.id,
        });
      }
    }
    // A supply drop with cargo still in it is the one opportunity worth an edge
    // marker (GDD §11: "Supply drop detected" is an Opportunity alert): it is
    // known from the transponder, it is usually over the horizon, and it has a
    // deadline. Buried and stripped ones are history, not a marker.
    for (const site of sim.world.pois) {
      if (site.kind !== 'supplyDrop' || site.buried || isPickedClean(site)) continue;
      cands.push({
        key: `poi-${site.id}`,
        x: site.x,
        z: site.z,
        icon: '📦',
        label: `Drop — ${site.solsToBury.toFixed(1)} sols`,
        cls: site.solsToBury < 1 ? 'crit' : 'warn',
        focus: null, // sites are not entities; the alert focuses them instead
      });
    }

    for (const c of cands) {
      seen.add(c.key);
      const p = project(c.x, c.z);
      // Behind the camera the projection comes out mirrored — flip it around
      // the centre so the clamp below lands on the correct edge.
      let sx = p.behind ? vw - p.x : p.x;
      let sy = p.behind ? vh - p.y : p.y;
      const onScreen = !p.behind && sx > M && sx < vw - M && sy > M && sy < vh - M;
      sx = Math.max(M, Math.min(vw - M, sx));
      sy = Math.max(M, Math.min(vh - M, sy));

      let node = this.markerNodes.get(c.key);
      if (!node) {
        node = document.createElement('button');
        node.className = `marker ${c.cls}`;
        node.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (c.focus !== null) this.cb.onAction('focus', c.focus);
        });
        wrap.appendChild(node);
        this.markerNodes.set(c.key, node);
      }
      const html = `${c.icon} <span>${c.label}</span>`;
      if (node.dataset.html !== html) {
        node.dataset.html = html;
        node.innerHTML = html;
      }
      const cls = `marker ${c.cls}`;
      if (node.className !== cls) node.className = cls;
      node.title = `${c.label} — tap to focus`;
      node.style.display = onScreen ? 'none' : 'flex';
      node.style.left = `${sx}px`;
      node.style.top = `${sy}px`;
    }
    for (const [key, node] of this.markerNodes) {
      if (!seen.has(key)) {
        node.remove();
        this.markerNodes.delete(key);
      }
    }
  }

  private dismissAlert(key: string): void {
    this.dismissed.add(key);
    this.alertKey = '';
    this.updateAlerts(this.lastAlerts);
  }

  // --------------------------------------------------------- inspector ----
  clearInspector(): void {
    if (this.inspectorKey === 'empty') return;
    this.inspectorKey = 'empty';
    const insp = this.el('inspector');
    insp.innerHTML = `
      <div class="i-bar"><span class="i-bar-kind">Selection</span><span class="i-spacer"></span><button class="mini-btn" id="i-collapse" title="Collapse panel">▾</button></div>
      <div class="i-body">
      <div class="empty">
        Select a <b>rover</b>, a <b>building</b>, or your <b>colonist</b>.<br/><br/>
        With a rover selected, tap a deposit to mine it or the ground to move —
        <b>Shift</b>+tap queues the order, and any mine order can become a
        repeating haul route. Tap a stranded rover to send yours out with
        jumper cables. Idle rovers work for the colony on their own.<br/><br/>
        Tap the selected object again, press <b>Esc</b>, or hit <b>×</b> to deselect.
      </div>
      </div>`;
    this.wireInspectorBar(insp);
  }

  /**
   * Render a rover selection. HUD callers use the default selection semantics;
   * the game loop passes `true` because it calls this method every tick and a
   * collapsed panel must not be reopened by a routine value refresh.
   */
  showRover(r: RoverView, sim: SimView, preserveCollapse = false): void {
    const def = effectiveRoverDef(r);
    if (!preserveCollapse) this.setInspectorCollapsed(false);
    const mass = ALL_RESOURCES.reduce((s, k) => s + r.cargo[k], 0);
    const key = `rover:${r.id}`;
    const insp = this.el('inspector');

    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-bar"><span class="i-bar-kind">Rover</span><span class="i-spacer"></span><button class="mini-btn" id="i-collapse" title="Collapse panel">▾</button><button class="mini-btn" id="i-close" data-act="deselect" title="Deselect (Esc)">×</button></div>
        <div class="i-body">
        <div class="i-head"><h3>${r.label}</h3><span class="i-id">#${r.id}</span></div>
        <div class="sub">${def.role}</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="i-status">—</span></div>
        <div class="stat"><span class="k">Battery</span><span class="v" id="i-bat">—</span></div>
        <div class="bar-wrap"><div class="bar-fill cyan" id="i-batbar"></div></div>
        <div class="stat"><span class="k">Condition</span><span class="v" id="i-cond">—</span></div>
        <div class="bar-wrap"><div class="bar-fill green" id="i-condbar"></div></div>
        <div class="sub sm">Installed parts</div>
        ${ROVER_PARTS.map((c) => `<div class="stat"><span class="k">${COMPONENTS[c].label}</span><span class="v" id="i-part-${c}">—</span></div>
          <div class="bar-wrap"><div class="bar-fill green" id="i-partbar-${c}"></div></div>`).join('')}
        <div class="note dim" id="i-parts-note"></div>
        <div class="stat"><span class="k">Cargo</span><span class="v" id="i-cargo">—</span></div>
        <div class="bar-wrap"><div class="bar-fill green" id="i-cargobar"></div></div>
        <div class="chips" id="i-chips"></div>
        <div class="sub sm">Route <span class="dim">(Shift+order to queue)</span></div>
        <div class="route-list" id="i-route"></div>
        <button class="btn wide" id="i-repeat" data-act="repeathaul" style="display:none">⟳ Repeat haul route</button>
        <div class="sub sm">Automation</div>
        <label class="toggle"><input type="checkbox" id="r-haul" /> <span>Auto-haul when idle</span></label>
        <label class="toggle"><input type="checkbox" id="r-svc" /> <span>Auto maintenance (repair & clean)</span></label>
        <label class="toggle"><input type="checkbox" id="r-storm" /> <span>Shelter in storms</span></label>
        <label class="toggle"><input type="checkbox" id="r-rescue" /> <span>Auto-rescue stranded rovers</span></label>
        <label class="slider-row">Charge below <b id="r-chargev">20%</b>
          <input type="range" id="r-charge" min="10" max="60" step="5" /></label>
        <div class="sub sm">Lights</div>
        <label class="toggle"><input type="checkbox" id="r-lights" /> <span>Position lights &amp; headlights</span></label>
        <div class="stat"><span class="k">Lights</span><span class="v" id="i-lights">—</span></div>
        <div class="action-grid">
          <button class="btn" data-act="stop" title="Stop and clear the queue">⏹ <span class="btn-t">Stop</span></button>
          <button class="btn" data-act="unload" id="i-unload" title="Drive to the nearest depot and unload — Shift+click queues it after the current job.">📦 <span class="btn-t">Unload</span></button>
          <button class="btn" data-act="wait" data-arg="60" title="Hold position for a minute — usually queued between jobs.">⏳ <span class="btn-t">Wait 1m</span></button>
          <button class="btn" data-act="recenter" title="Center the camera here (F)">🎯 <span class="btn-t">Focus</span></button>
        </div>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((b) =>
        b.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const el = b as HTMLElement;
          this.cb.onAction(el.dataset.act!, el.dataset.arg);
        }),
      );
      const rule = (id: string, action: string) => {
        const box = insp.querySelector(`#${id}`) as HTMLInputElement;
        box.addEventListener('change', () => this.cb.onAction(action, box.checked ? 1 : 0));
      };
      rule('r-haul', 'rule-haul');
      rule('r-svc', 'rule-svc');
      rule('r-storm', 'rule-storm');
      rule('r-rescue', 'rule-rescue');
      rule('r-lights', 'rule-lights');
      const slider = insp.querySelector('#r-charge') as HTMLInputElement;
      slider.addEventListener('input', () =>
        this.cb.onAction('rule-charge', Number(slider.value)),
      );
      this.wireInspectorBar(insp);
      // A fresh selection always opens the panel — selecting means looking.
      this.setInspectorCollapsed(false);
    }

    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    q('i-status').textContent = r.upgradeJob ? `Refit: ${UPGRADES[r.upgradeJob.upgrade].label} · ${Math.floor(r.upgradeJob.progress * 100)}% · Garage #${r.upgradeJob.facilityId}` : roverStatusText(r) + (r.autoTask ? ' (auto)' : '');
    q('i-bat').textContent = `${r.battery.toFixed(1)} / ${def.maxBatteryKWh} kWh`;
    const bpct = (r.battery / def.maxBatteryKWh) * 100;
    const bb = q('i-batbar');
    bb.style.width = `${Math.max(0, Math.min(100, bpct))}%`;
    bb.className = `bar-fill ${bpct < 20 ? 'red' : bpct < 45 ? 'amber' : 'cyan'}`;
    q('i-cond').textContent = `${Math.round(r.condition)}%`;
    const cbar = q('i-condbar');
    cbar.style.width = `${Math.max(0, Math.min(100, r.condition))}%`;
    cbar.className = `bar-fill ${r.condition < 35 ? 'red' : r.condition < 70 ? 'amber' : 'green'}`;
    for (const c of ROVER_PARTS) {
      const pct = r.parts[c];
      q(`i-part-${c}`).textContent = `${Math.floor(pct)}%`;
      const bar = q(`i-partbar-${c}`);
      bar.style.width = `${pct}%`;
      bar.className = `bar-fill ${pct < 35 ? 'red' : pct <= PART_REPLACE_THRESHOLD ? 'amber' : 'green'}`;
    }
    const replacing = sim.buildings.find((b) => b.maintenance?.roverId === r.id);
    q('i-parts-note').textContent = replacing?.maintenance
      ? `${replacing.idleReason || 'Replacement paused'} · Repair Bay #${replacing.id}`
      : `Park beside a Repair Bay to replace parts at ${PART_REPLACE_THRESHOLD}% or below: 1 matching spare each. Below ${ROVER_CONDITION_SLOW}%, worn parts reduce performance (never strand a rover).`;
    q('i-cargo').textContent = `${Math.round(mass)} / ${def.capacityKg} kg`;
    q('i-cargobar').style.width = `${Math.min(100, (mass / def.capacityKg) * 100)}%`;
    q('i-chips').innerHTML =
      ALL_RESOURCES.filter((res) => r.cargo[res] > 0.5)
        .map(
          (res) =>
            `<span class="chip"><i style="background:#${RESOURCES[res].color.toString(16).padStart(6, '0')}"></i>${RESOURCES[res].short} ${Math.round(r.cargo[res])}</span>`,
        )
        .join('') || '<span class="dim">Cargo bay empty</span>';

    const unloadBtn = insp.querySelector('#i-unload') as HTMLButtonElement | null;
    if (unloadBtn) {
      // Pointless only when the hold is empty *and* nothing queued will fill it.
      const willHaul = [r.command, ...r.pending].some((t) => t.type === 'mine');
      unloadBtn.toggleAttribute('disabled', mass <= 0.01 && !willHaul);
    }

    // ---- the task queue ---------------------------------------------------
    const tasks: RoverTask[] = [r.command, ...r.pending].filter((t) => t.type !== 'idle');
    q('i-route').innerHTML = tasks.length
      ? tasks
          .slice(0, 5)
          .map(
            (t, i) =>
              `<div class="route-item${i === 0 ? ' active' : ''}"><span class="ri-n">${i + 1}</span><span class="ri-t">${taskLabel(sim, t)}</span></div>`,
          )
          .join('') +
          (tasks.length > 5
            ? `<div class="route-item dim">+${tasks.length - 5} more…</div>`
            : '')
      : '<div class="route-item dim">No tasks queued — idle rovers work for the colony.</div>';

    const rep = q('i-repeat') as HTMLButtonElement;
    if (r.command.type === 'mine') {
      rep.style.display = '';
      rep.textContent = r.command.repeat
        ? '⟳ Route on — tap to end after this trip'
        : '⟳ Set as repeating haul route';
      rep.classList.toggle('active', !!r.command.repeat);
    } else {
      rep.style.display = 'none';
    }

    // ---- the automation rules --------------------------------------------
    const sync = (id: string, on: boolean) => {
      const box = insp.querySelector(`#${id}`) as HTMLInputElement;
      if (box && box.checked !== on) box.checked = on;
    };
    sync('r-haul', r.rules.autoHaul);
    sync('r-svc', r.rules.autoService);
    sync('r-storm', r.rules.stormShelter);
    sync('r-rescue', r.rules.autoRescue);
    sync('r-lights', r.lightsOn);
    const slider = insp.querySelector('#r-charge') as HTMLInputElement;
    if (slider && Number(slider.value) !== r.rules.chargeFloorPct) {
      slider.value = String(r.rules.chargeFloorPct);
    }
    const cv = insp.querySelector('#r-chargev') as HTMLElement;
    if (cv) cv.textContent = `${r.rules.chargeFloorPct}%`;

    // Lights: dead rovers flash their reserve-powered yellow strobe; live
    // ones either burn the battery for light or wait for dark.
    const lv = q('i-lights');
    const draw = effectiveRoverDef(r).lightsPowerKw.toFixed(1);
    lv.textContent =
      r.phase === 'disabled'
        ? 'Emergency strobe — flashing yellow'
        : r.lightsActive
          ? `Lit — drawing ${draw} kW`
          : r.lightsOn
            ? 'Auto — off in good visibility'
            : 'Switched off';
    lv.className = `v ${r.lightsActive || r.phase === 'disabled' ? 'warn' : ''}`;
  }

  /** Render a building selection; see showRover for the refresh distinction. */
  showBuilding(b: BuildingView, sim: SimView, preserveCollapse = false): void {
    const def = effectiveBuildingDef(b);
    if (!preserveCollapse) this.setInspectorCollapsed(false);
    const key = `bld:${b.id}`;
    const insp = this.el('inspector');

    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-bar"><span class="i-bar-kind">Structure</span><span class="i-spacer"></span><button class="mini-btn" id="i-collapse" title="Collapse panel">▾</button><button class="mini-btn" id="i-close" data-act="deselect" title="Deselect (Esc)">×</button></div>
        <div class="i-body">
        <div class="i-head"><h3>${def.label}</h3><span class="i-id">#${b.id}</span></div><div class="note dim">Right-click / long-press the structure for engineering, upgrades and paint.</div>
        <div class="sub">${def.description}</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="b-state">—</span></div>
        <div id="b-progress-wrap" style="display:none">
          <div class="bar-wrap"><div class="bar-fill amber" id="b-progress"></div></div>
        </div>
        <div id="b-body"></div>
        ${recipeBlock(b.kind)}
        <div id="b-water"></div>
        <div id="b-garage" style="display:none">
          <div class="sub sm">Assembly line</div>
          <div class="stat"><span class="k">Building</span><span class="v" id="b-asm-label">—</span></div>
          <div class="bar-wrap" id="b-asm-wrap"><div class="bar-fill cyan" id="b-asm-bar" style="width:0%"></div></div>
          <div class="action-grid three" id="b-asm-btns">
            <button class="btn" data-act="assemble" data-arg="utility" id="asm-utility" title="Utility Rover — fast, agile, builds well.">Utility</button>
            <button class="btn" data-act="assemble" data-arg="mining" id="asm-mining" title="Mining Rover — heavy drill, 1.5 t hopper.">Mining</button>
            <button class="btn" data-act="assemble" data-arg="cargo" id="asm-cargo" title="Cargo Rover — 3 t, 120 kWh, built for the long haul.">Cargo</button>
          </div>
          <div class="note dim" id="b-asm-note"></div>
        </div>
        <div id="b-maintenance" style="display:none">
          <div class="sub sm">Component replacement</div>
          <div class="stat"><span class="k">On the lift</span><span class="v" id="b-maint-rover">—</span></div>
          <div class="stat"><span class="k">Part</span><span class="v" id="b-maint-part">—</span></div>
          <div class="bar-wrap"><div class="bar-fill cyan" id="b-maint-bar"></div></div>
          <div class="note" id="b-maint-status"></div>
          <div class="note dim" id="b-maint-stock"></div>
          <div class="note dim">Park beside the bay (within 12 m of its centre). One part per job, ${PART_REPLACE_SECONDS} s at full power; work pauses without power or stock. Leaving cancels unfinished work without spending a spare. Garages only restore routine condition.</div>
        </div>
        <div class="action-grid" id="b-actions">
          <button class="btn" data-act="service" id="b-service">✨ <span class="btn-t">Clean panels</span></button>
          <button class="btn" data-act="toggle" id="b-toggle">⏻ <span class="btn-t">Switch off</span></button>
          <button class="btn danger" data-act="demolish" title="Dismantle this structure">💥 <span class="btn-t">Dismantle</span></button>
        </div>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((n) =>
        n.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const el = n as HTMLElement;
          this.cb.onAction(el.dataset.act!, el.dataset.arg);
        }),
      );
      this.wireInspectorBar(insp);
      // A fresh selection always opens the panel — selecting means looking.
      this.setInspectorCollapsed(false);
    }

    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    const state =
      b.state === 'online'
        ? b.enabled
          ? 'Online'
          : 'Offline (switched off)'
        : b.state === 'building'
          ? `Assembling — ${Math.round(b.progress * 100)}%`
          : b.needsMaterials
            ? 'Awaiting materials'
            : 'Ready to assemble';
    updateWaterPanel(q('b-water'), b.id, sim, (action, arg) => this.cb.onAction(action, arg));
    q('b-state').textContent = b.upgradeJob ? `Refit: ${UPGRADES[b.upgradeJob.upgrade].label} · ${Math.floor(b.upgradeJob.progress * 100)}%` : state;
    q('b-state').className = `v ${b.state === 'online' && b.enabled ? 'good' : b.needsMaterials ? 'warn' : ''}`;

    const pw = q('b-progress-wrap');
    if (b.state !== 'online') {
      pw.style.display = 'block';
      q('b-progress').style.width = `${b.progress * 100}%`;
    } else {
      pw.style.display = 'none';
    }

    const rows: string[] = [];
    if (b.state !== 'online') {
      const need = ALL_RESOURCES.filter((r) => b.remainingCost[r] > 0.5);
      rows.push(
        `<div class="stat"><span class="k">Still needs</span><span class="v">${
          need.length
            ? need.map((r) => `${Math.ceil(b.remainingCost[r])} ${RESOURCES[r].short}`).join(', ')
            : '— fully stocked'
        }</span></div>`,
      );
    } else {
      if (b.level > 1) {
        rows.push(
          `<div class="stat"><span class="k">Developer upgrade</span><span class="v warn">Mk ${b.level} · ×${devLevelMul(b.level).toFixed(2)} output (unsaved)</span></div>`,
        );
      }
      if (def.powerProduceKw > 0) {
        const clean = def.generation === 'solar' ? b.cleanliness : 1;
        rows.push(
          `<div class="stat"><span class="k">Generating</span><span class="v ${b.genKw > 0.01 ? 'good' : 'warn'}">${b.genKw.toFixed(1)} / ${def.powerProduceKw} kW</span></div>`,
        );
        if (def.generation === 'solar') {
          const pct = Math.round(clean * 100);
          rows.push(
            `<div class="stat"><span class="k">Panel dust</span><span class="v ${pct < 55 ? 'bad' : pct < 80 ? 'warn' : ''}">${pct}% clean</span></div>`,
            `<div class="bar-wrap"><div class="bar-fill ${pct < 55 ? 'red' : pct < 80 ? 'amber' : 'cyan'}" style="width:${pct}%"></div></div>`,
          );
        }
      }
      if (b.health < BUILDING_MAX_HEALTH - 0.5) {
        const hp = Math.round(b.health);
        rows.push(
          `<div class="stat"><span class="k">Structure</span><span class="v ${b.damaged ? 'bad' : hp < 60 ? 'warn' : ''}">${b.damaged ? 'Damaged — offline' : `${hp}%`}</span></div>`,
          `<div class="bar-wrap"><div class="bar-fill ${b.damaged || hp < 40 ? 'red' : 'amber'}" style="width:${hp}%"></div></div>`,
        );
      }
      if (def.powerDrawKw > 0 || def.idlePowerKw > 0) {
        rows.push(
          `<div class="stat"><span class="k">Drawing</span><span class="v">${b.loadKw.toFixed(1)} kW <span class="dim">· tier ${def.tier}</span></span></div>`,
        );
      }
      if (def.weatherRadarRangeKm) {
        rows.push(
          `<div class="stat"><span class="k">Weather radar</span><span class="v good">${def.weatherRadarRangeKm} km · ${def.advancedForecast ? 'advanced forecast' : 'map returns'}</span></div>`,
          `<div class="note">${b.powerSat >= 0.5 && b.enabled && !b.damaged ? 'Live radar map is available in colony vitals.' : 'Radar offline until the station is enabled and powered.'}</div>`,
        );
      }
      if (hasProcess(b.kind)) {
        const pct = Math.round(b.throughput * 100);
        rows.push(
          `<div class="stat"><span class="k">Throughput</span><span class="v ${pct > 0 ? 'good' : 'warn'}">${pct}%</span></div>`,
          `<div class="bar-wrap"><div class="bar-fill ${pct > 0 ? 'green' : 'amber'}" style="width:${pct}%"></div></div>`,
          `<div class="note">${activeSummary(b.kind, b.recipe)}</div>`,
        );
        if (b.idleReason) rows.push(`<div class="note warn">⚠ ${b.idleReason}</div>`);
      }
      const slots = def.componentSlots ?? 0;
      if (slots > 0) {
        // The rack this building contributes — the reason components exist at
        // all, and the number the topbar chips are counting against.
        rows.push(
          `<div class="stat"><span class="k">Component rack</span><span class="v">${Math.floor(slots * devLevelMul(b.level))} slots</span></div>`,
        );
      }
      if (b.powerSat < 0.995) {
        rows.push(
          `<div class="note warn">⚠ Only receiving ${Math.round(b.powerSat * 100)}% of requested power.</div>`,
        );
      }
      if (def.batteryKWh) {
        rows.push(
          `<div class="stat"><span class="k">Grid storage</span><span class="v">+${def.batteryKWh} kWh</span></div>`,
        );
      }
      if (def.storagePerResourceKg) {
        rows.push(
          `<div class="stat"><span class="k">Silo capacity</span><span class="v">+${def.storagePerResourceKg} kg each</span></div>`,
        );
      }
      if (def.fluidCapacity) {
        const t = ALL_FLUIDS.filter((f) => def.fluidCapacity![f])
          .map((f) => `${def.fluidCapacity![f]} kg ${FLUIDS[f].label}`)
          .join(', ');
        if (t) rows.push(`<div class="stat"><span class="k">Tankage</span><span class="v">${t}</span></div>`);
      }
      if (def.pressurized) {
        rows.push(`<div class="note">Pressurised — your colonist can shelter here.</div>`);
      }
    }
    q('b-body').innerHTML = rows.join('');

    // ---- rover garage: the assembly line (P4) ------------------------------
    const garage = q('b-garage');
    if (b.kind === 'garage' && b.state === 'online' && b.enabled) {
      garage.style.display = '';
      const lbl = q('b-asm-label');
      const bar = q('b-asm-bar');
      const wrap = q('b-asm-wrap');
      const btns = q('b-asm-btns');
      if (b.assembly) {
        const rdef = ROVERS[b.assembly.kind];
        lbl.textContent = `${rdef.label} — ${Math.round(b.assembly.progress * 100)}%`;
        lbl.className = 'v good';
        bar.style.width = `${Math.min(100, b.assembly.progress * 100)}%`;
        wrap.style.display = '';
        btns.style.display = 'none';
        q('b-asm-note').innerHTML =
          'The line draws garage power — a brownout slows the build.';
      } else {
        lbl.textContent = 'Idle';
        lbl.className = 'v dim';
        wrap.style.display = 'none';
        btns.style.display = '';
        for (const kind of ['utility', 'mining', 'cargo'] as const) {
          const btn = q(`asm-${kind}`) as HTMLButtonElement;
          const rdef = ROVERS[kind];
          // P5: a rover costs metal *and* machines — both ledgers have to cover
          // it, and the button greys out until they do.
          const afford =
            ALL_RESOURCES.every((res) => sim.storage[res] >= rdef.cost[res]) &&
            ALL_COMPONENTS.every((c) => sim.components[c] >= rdef.componentCost[c]);
          btn.classList.toggle('unaffordable', !afford);
          const cost = [
            ...ALL_RESOURCES.filter((res) => rdef.cost[res] > 0).map(
              (res) => `${itemIcon(res)} ${Math.round(rdef.cost[res])} ${RESOURCES[res].short}`,
            ),
            ...ALL_COMPONENTS.filter((c) => rdef.componentCost[c] > 0).map(
              (c) => `${itemIcon(c)} ${rdef.componentCost[c]} ${COMPONENTS[c].short}`,
            ),
          ].join(' · ');
          btn.innerHTML = `${rdef.label.split(' ')[0]}<span class="cost">${cost}</span>`;
        }
        q('b-asm-note').innerHTML =
          'Also: 32 kW fast charge · routine condition restored to 100%. Worn motors and boards need a Repair Bay.';
      }
    } else {
      garage.style.display = 'none';
    }

    const maintenance = q('b-maintenance');
    maintenance.style.display = b.kind === 'repairBay' && b.state === 'online' ? '' : 'none';
    if (b.kind === 'repairBay') {
      const job = b.maintenance;
      const rover = job ? sim.rovers.find((r) => r.id === job.roverId) : null;
      q('b-maint-rover').textContent = rover ? `${rover.label} #${rover.id}` : 'Bay clear';
      q('b-maint-part').textContent = job ? `${COMPONENTS[job.component].label} · ${Math.floor(job.progress * 100)}%` : '—';
      q('b-maint-bar').style.width = `${(job?.progress ?? 0) * 100}%`;
      q('b-maint-status').textContent = b.damaged ? 'Damaged — dispatch structural repair' : !b.enabled ? 'Switched off — replacement paused' : b.idleReason || 'Waiting for a parked rover';
      q('b-maint-stock').textContent = `Cost: 1 matching spare per replacement · Rack: ${sim.components.motor} motors / ${sim.components.circuitBoard} boards`;
    }

    // ---- production line (P5): which recipe is running, and why not --------
    const rec = q('b-recipe');
    if (rec) {
      const recs = recipesFor(b.kind);
      recs.forEach((r, i) => {
        const btn = q(`rec-${i}`) as HTMLButtonElement | null;
        if (!btn) return;
        btn.classList.toggle('active', i === b.recipe);
        // Grey a line the colony could not run right now — no input stock, or
        // nowhere to rack the output. The sim would refuse it anyway; this says
        // so before the click instead of after.
        const p = r.process;
        const stocked = ALL_RESOURCES.every(
          (res) => (p.solidIn?.[res] ?? 0) <= 0 || sim.storage[res] > 0,
        );
        const room = ALL_COMPONENTS.every(
          (c) => (p.componentOut?.[c] ?? 0) <= 0 || sim.components[c] < sim.componentCapacity(),
        );
        btn.classList.toggle('unaffordable', !stocked || !room);
      });
      const note = q('b-recipe-note');
      if (note) {
        // Work in progress belongs to the bench, not to a line: switching
        // recipes keeps it, so the panel says what is half-made rather than
        // letting the player assume a changeover throws it away.
        const bench = ALL_COMPONENTS.filter((c) => b.craft[c] > 0.005)
          .map((c) => `${COMPONENTS[c].short} ${Math.round(b.craft[c] * 100)}%`)
          .join(' · ');
        note.innerHTML = `${activeSummary(b.kind, b.recipe)}${bench ? `<br>On the bench: ${bench}` : ''}`;
      }
    }

    const toggle = q('b-toggle') as HTMLButtonElement;
    toggle.style.display = b.state === 'online' ? '' : 'none';
    this.setIconButton(toggle, '⏻', b.enabled ? 'Switch off' : 'Switch on');

    const svc = q('b-service') as HTMLButtonElement;
    const needsRepair = b.state === 'online' && b.health < BUILDING_MAX_HEALTH - 0.5;
    const needsClean =
      b.state === 'online' &&
      BUILDINGS[b.kind].generation === 'solar' &&
      b.cleanliness < 0.995;
    svc.style.display = needsRepair || needsClean ? '' : 'none';
    this.setIconButton(
      svc,
      needsRepair ? '🔧' : '✨',
      needsRepair ? 'Dispatch repair' : 'Clean panels',
    );
  }

  /** Render the colonist selection; see showRover for the refresh distinction. */
  showColonist(c: ColonistView, sim: SimView, preserveCollapse = false): void {
    const key = `col:${c.id}`;
    if (!preserveCollapse) this.setInspectorCollapsed(false);
    const insp = this.el('inspector');
    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-bar"><span class="i-bar-kind">Crew</span><span class="i-spacer"></span><button class="mini-btn" id="i-collapse" title="Collapse panel">▾</button><button class="mini-btn" id="i-close" data-act="deselect" title="Deselect (Esc)">×</button></div>
        <div class="i-body">
        <div class="i-head"><h3>${c.name}</h3><span class="i-id">Crew</span></div>
        <div class="sub">The only human on the planet.</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="c-status">—</span></div>
        <div class="stat"><span class="k">Health</span><span class="v" id="c-hp">—</span></div>
        <div class="bar-wrap"><div class="bar-fill green" id="c-hpbar"></div></div>
        <div class="stat"><span class="k">Suit O₂</span><span class="v" id="c-suit">—</span></div>
        <div class="bar-wrap"><div class="bar-fill cyan" id="c-suitbar"></div></div>
        <div id="c-needs"></div>
        <div class="note">Right-click the ground to send them on an EVA — the suit carries a fixed
        reserve, so range is limited. They return to shelter automatically when it runs low.</div>
        <div class="action-grid">
          <button class="btn" data-act="shelter" title="Walk back to the nearest pressurised volume">🏠 <span class="btn-t">Return to shelter</span></button>
          <button class="btn" data-act="recenter" title="Center the camera here (F)">🎯 <span class="btn-t">Focus</span></button>
        </div>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((n) =>
        n.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.cb.onAction((n as HTMLElement).dataset.act!);
        }),
      );
      this.wireInspectorBar(insp);
      // A fresh selection always opens the panel — selecting means looking.
      this.setInspectorCollapsed(false);
    }
    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    q('c-status').textContent = colonistStatusText(c);
    q('c-hp').textContent = `${Math.round(c.health)}%`;
    const hb = q('c-hpbar');
    hb.style.width = `${c.health}%`;
    hb.className = `bar-fill ${c.health < 35 ? 'red' : c.health < 70 ? 'amber' : 'green'}`;
    const sp = (c.suitO2 / SUIT_O2_CAPACITY) * 100;
    q('c-suit').textContent = c.inside ? 'Docked (refilling)' : `${Math.round(sp)}%`;
    const sb = q('c-suitbar');
    sb.style.width = `${Math.max(0, Math.min(100, sp))}%`;
    sb.className = `bar-fill ${sp < 30 ? 'red' : sp < 60 ? 'amber' : 'cyan'}`;

    const unmet = ALL_FLUIDS.filter((f) => c.starved[f as keyof typeof c.starved]);
    q('c-needs').innerHTML = unmet.length
      ? `<div class="note bad">⛔ Unmet: ${unmet.map((f) => FLUIDS[f].label).join(', ')}</div>`
      : `<div class="note good">✓ All needs met.</div>`;
  }

  /**
   * Render a point of interest (GDD §06) or a landed supply drop (§10).
   *
   * The panel's job is the two questions the map cannot answer on its own: what
   * is still out there, and — for a drop — how long it has left. Everything else
   * is one line of flavour text, because the design's point is that these are
   * finds, not inventory screens.
   */
  showPoi(p: Poi, sim: SimView, preserveCollapse = false): void {
    const key = `poi:${p.id}`;
    if (!preserveCollapse) this.setInspectorCollapsed(false);
    const insp = this.el('inspector');
    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      const info = POI_KINDS[p.kind];
      insp.innerHTML = `
        <div class="i-bar"><span class="i-bar-kind">Site</span><span class="i-spacer"></span><button class="mini-btn" id="i-collapse" title="Collapse panel">▾</button><button class="mini-btn" id="i-close" data-act="deselect" title="Deselect (Esc)">×</button></div>
        <div class="i-body">
        <div class="i-head"><h3>${info.icon} ${info.label}</h3><span class="i-id">#${p.id}</span></div>
        <div class="sub" id="p-blurb">${info.blurb}</div>
        <div class="stat"><span class="k">Position</span><span class="v" id="p-pos">—</span></div>
        <div id="p-cargo"></div>
        <div id="p-clock"></div>
        <div class="note" id="p-note">Select a rover, then tap the site to send it out.</div>
        <div class="action-grid">
          <button class="btn" data-act="recenter" title="Center the camera here (F)">🎯 <span class="btn-t">Focus</span></button>
        </div>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((n) =>
        n.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.cb.onAction((n as HTMLElement).dataset.act!);
        }),
      );
      this.wireInspectorBar(insp);
      this.setInspectorCollapsed(false);
    }
    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    q('p-pos').textContent = `${Math.round(p.x)}, ${Math.round(p.z)}`;
    if (p.manifest) q('p-blurb').textContent = `${p.manifest}. ${POI_KINDS[p.kind].blurb}`;

    // What is still there: bulk salvage by resource, then surviving cells.
    const lines: string[] = [];
    for (const res of ALL_RESOURCES) {
      const kg = p.salvage[res] ?? 0;
      if (kg > 0.5) lines.push(`<div class="stat"><span class="k">${RESOURCES[res].label}</span><span class="v">${fmtKg(kg)}</span></div>`);
    }
    if (p.energyKWh > 0.5) {
      lines.push(`<div class="stat"><span class="k">Cells</span><span class="v">${Math.round(p.energyKWh)} kWh</span></div>`);
    }
    const totalKg = salvageTotalKg(p);
    q('p-cargo').innerHTML = lines.length
      ? `<div class="stat"><span class="k">Salvage aboard-able</span><span class="v">${fmtKg(totalKg)}</span></div>` +
        lines.join('')
      : `<div class="note">${p.kind === 'settlementSite' ? 'Nothing to haul — a place to build.' : 'Already picked clean.'}</div>`;

    const clock = q('p-clock');
    if (p.kind === 'supplyDrop' && !p.buried && !isPickedClean(p)) {
      const sols = p.solsToBury;
      clock.innerHTML = `<div class="stat"><span class="k">Buried in</span><span class="v">${sols.toFixed(1)} sols</span></div>
        <div class="bar-wrap"><div class="bar-fill ${sols < 1 ? 'red' : 'amber'}" style="width:${Math.max(0, Math.min(100, (sols / 3) * 100))}%"></div></div>`;
    } else if (p.buried) {
      clock.innerHTML = `<div class="note bad">⛔ Buried — the dust got there first.</div>`;
    } else {
      clock.innerHTML = '';
    }

    const idle = sim.idleRovers().length;
    q('p-note').textContent = p.buried || isPickedClean(p)
      ? 'Nothing left out here.'
      : idle > 0
        ? `${idle} rover${idle === 1 ? '' : 's'} idle — select one, then tap the site.`
        : 'No idle rovers: queue the order or wait for one to free up.';
  }

  // -------------------------------------------------------------- misc ----
  addLog(severity: string, text: string, stamp = '', max = 60): void {
    const body = this.hudRoot.querySelector<HTMLElement>('#log-body') ?? this.el('log');
    const item = document.createElement('div');
    item.className = `log-item ${severity}`;
    item.innerHTML = `${stamp ? `<span class="ts">${stamp}</span>` : ''}<span>${text}</span>`;
    body.appendChild(item);
    while (body.children.length > max) body.children[0]?.remove();
    body.scrollTop = body.scrollHeight;
  }

  hint(text: string | null): void {
    const h = this.el('hintbar');
    h.style.display = text ? 'flex' : 'none';
    if (text) h.innerHTML = text;
  }

  private updateNoticeOpen = false;

  /**
   * In-play update notice (TDD §23): a newer build is live. The card tells
   * the player what is new and that continuing means *they* save and *they*
   * reload — nothing happens automatically. The Game drives the status line
   * and the button set as the player acts (saving → saved → reload).
   */
  showUpdateNotice(found: { current: string | null; latest: string | null; notes: string[] }): void {
    this.el('update-title').textContent = 'A new version is live';
    this.el('update-builds').textContent = `build ${shortSha(found.current)} → build ${shortSha(found.latest)}`;
    const list = this.el('update-notes');
    list.replaceChildren(
      ...found.notes.map((n) => {
        const li = document.createElement('li');
        li.textContent = n;
        return li;
      }),
    );
    this.el('ub-what').style.display = found.notes.length > 0 ? '' : 'none';
    this.el('update-text').textContent =
      'Your colony is paused. To keep playing on the new version, save your colony and reload — nothing happens automatically.';
    const save = this.el('ub-save') as HTMLButtonElement;
    save.style.display = '';
    save.disabled = false;
    this.el('ub-reload').style.display = 'none';
    this.updateNoticeOpen = true;
    this.el('update-banner').style.display = 'flex';
  }

  /** The card's status line (the Game narrates the save as it progresses). */
  updateNoticeText(text: string): void {
    this.el('update-text').textContent = text;
  }

  /** The card's save is running: the save button goes quiet under the frost. */
  updateNoticeSaving(): void {
    this.el('update-text').textContent = 'Saving your colony…';
    (this.el('ub-save') as HTMLButtonElement).disabled = true;
  }

  /**
   * The save settled: the reload button is now the player's to press. The
   * page still does not reload on its own — the card only offers it.
   */
  updateNoticeSaved(stamp: string): void {
    this.el('update-text').textContent =
      `Colony saved · ${stamp}. Reload when you are ready to continue on the new version.`;
    this.el('ub-save').style.display = 'none';
    this.el('ub-reload').style.display = '';
  }

  /**
   * The save failed: the card carries the recovery. A save-failed prompt
   * would sit on top of the card the player is reading, so the update
   * context reports here instead (the Game routes it — TDD §23).
   */
  updateNoticeSaveFailed(kind: SaveErrorKind): void {
    this.el('update-text').textContent =
      kind === 'storage'
        ? 'The save failed — browser storage is full. Retry when it frees up, or keep playing this build.'
        : 'The save failed — the colony could not be read. Nothing was lost. Retry, or keep playing this build.';
    this.el('ub-reload').style.display = 'none';
    const save = this.el('ub-save') as HTMLButtonElement;
    save.style.display = '';
    save.disabled = false;
  }

  /** Whether the update card is on screen (the Game guards the pause menu on it). */
  isUpdateNoticeOpen(): boolean {
    return this.updateNoticeOpen;
  }

  hideUpdateNotice(): void {
    this.el('update-banner').style.display = 'none';
    this.updateNoticeOpen = false;
  }

  flashSave(txt = 'Saved'): void {
    const f = this.el('save-flash');
    f.textContent = txt;
    f.style.display = 'block';
    window.setTimeout(() => {
      f.style.display = 'none';
    }, 1800);
  }

  // ------------------------------------------------------- save progress ----
  /**
   * The save in flight: a full-screen frost over the live colony with a
   * centered progress card. `Game.save` drives it stage by stage — start,
   * one tick per pipeline stage, then end — so the player sees where a
   * colony-sized write is, instead of a blank flash.
   */
  saveProgressStart(title: string): void {
    window.clearTimeout(this.saveProgressTimer);
    const ov = this.el('save-progress');
    this.el('sp-title').textContent = title;
    for (let i = 0; i < 3; i++) this.setSaveProgressStep(i, 'pending');
    this.setSaveProgressStep(0, 'active');
    this.setSaveProgressFill(6);
    ov.classList.remove('leaving');
    ov.style.display = 'flex';
    this.saveProgressOpen = true;
    this.cb.onSaveProgress?.(true, false);
  }

  /** Mark steps before `stage` done, `stage` active (0..2). */
  saveProgressStage(stage: number): void {
    if (!this.saveProgressOpen) return;
    for (let i = 0; i < 3; i++) {
      this.setSaveProgressStep(i, i < stage ? 'done' : i === stage ? 'active' : 'pending');
    }
    this.setSaveProgressFill(18 + stage * 27);
  }

  /** Finish: on success every step checks off and the frost lifts on its own. */
  saveProgressEnd(ok: boolean): void {
    if (!this.saveProgressOpen) return;
    if (!ok) {
      this.hideSaveProgress();
      return;
    }
    for (let i = 0; i < 3; i++) this.setSaveProgressStep(i, 'done');
    this.setSaveProgressFill(100);
    const ov = this.el('save-progress');
    ov.classList.add('leaving');
    window.clearTimeout(this.saveProgressTimer);
    this.saveProgressTimer = window.setTimeout(() => this.hideSaveProgress(true), 420);
  }

  isSaveProgressOpen(): boolean {
    return this.saveProgressOpen;
  }

  /** Force the frost down (a save was abandoned or the world went away). */
  hideSaveProgress(saved = false): void {
    window.clearTimeout(this.saveProgressTimer);
    const wasOpen = this.saveProgressOpen;
    const ov = this.el('save-progress');
    if (ov.style.display !== 'none') ov.style.display = 'none';
    ov.classList.remove('leaving');
    this.saveProgressOpen = false;
    if (wasOpen) this.cb.onSaveProgress?.(false, saved);
  }

  private setSaveProgressStep(i: number, state: 'pending' | 'active' | 'done'): void {
    const step = this.el(`sp-step-${i}`);
    const ic = step.querySelector('.sp-ic') as HTMLElement;
    step.className = `sp-step ${state}`;
    ic.textContent = state === 'done' ? '✓' : state === 'active' ? '▸' : '·';
  }

  private setSaveProgressFill(pct: number): void {
    this.el('sp-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  private saveProgressOpen = false;
  private saveProgressTimer = 0;

  // -------------------------------------------------------- save error ----
  /**
   * The save-failed prompt. `kind` picks the wording; `canAbandon` reveals the
   * destructive option (only when the failed save was the menu hand-off, where
   * the player's stated intent was to leave).
   */
  showSaveError(kind: SaveErrorKind, canAbandon: boolean): void {
    const ov = this.el('save-error');
    this.el('se-title').textContent = 'Save failed';
    this.el('se-reason').textContent =
      kind === 'storage'
        ? 'The snapshot was written out, but browser storage refused it — the quota for this site is full. Retry once it frees up, save to a new file, or keep playing; your last successful save is intact.'
        : 'The colony could not be read — the save was never written. Nothing changed on disk. Retry, save to a new file, or keep playing; your last successful save is intact.';
    this.el('se-abandon').style.display = canAbandon ? '' : 'none';
    ov.style.display = 'flex';
    this.saveErrorOpen = true;
    // The progress card and the error card never share the screen.
    this.hideSaveProgress();
  }

  /** Close the prompt. Returns true if it was open (for chaining). */
  hideSaveError(): boolean {
    const ov = this.el('save-error');
    if (ov.style.display === 'none') return false;
    ov.style.display = 'none';
    this.saveErrorOpen = false;
    return true;
  }

  isSaveErrorOpen(): boolean {
    return this.saveErrorOpen;
  }

  private saveErrorOpen = false;

  showEnd(title: string, text: string): void {
    this.el('end-title').textContent = title;
    this.el('end-text').textContent = text;
    this.el('end-overlay').style.display = 'flex';
  }

  /**
   * The mission menu replaces the prototype's start overlay. The element
   * stays in the DOM (tests and the HUD contract reference it) but is hidden
   * while the menu system owns the pre-game screen.
   */
  hideStartOverlay(): void {
    this.el('start-overlay').style.display = 'none';
  }

  /** Reflect the developer-mode master switch on the topbar wrench. */
  setDevActive(on: boolean): void {
    this.el('dev-btn').classList.toggle('active', on);
  }
}

/** Those lines as one string — a tooltip lists them, a dossier row prints them. */
function linesText(kind: BuildingKind): string {
  if (hasRecipes(kind)) {
    return recipesFor(kind)
      .map((r) => `${r.label} — ${r.process.summary}`)
      .join('  ·  ');
  }
  return activeSummary(kind, 0);
}

/**
 * The production-line selector for a building inspector (P5), or '' for a kind
 * with nothing to choose.
 *
 * It is part of the skeleton rather than patched in later on purpose: the
 * skeleton is already per-selection, so these buttons get the same one-time
 * `data-act` wiring every other inspector control has, and the refresh path
 * only has to move the highlight. The sim still owns the answer — a click sends
 * `building/recipe` and the panel reads back whatever the sim decided.
 */
function recipeBlock(kind: BuildingKind): string {
  if (!hasRecipes(kind)) return '';
  const recs = recipesFor(kind);
  const btns = recs
    .map(
      (r, i) =>
        `<button class="btn" data-act="recipe" data-arg="${i}" id="rec-${i}" title="${r.process.summary}">${r.label}</button>`,
    )
    .join('');
  return `
        <div id="b-recipe">
          <div class="sub sm">Production line</div>
          <div class="action-grid${recs.length > 2 ? ' three' : ''}" id="b-recipe-btns">${btns}</div>
          <div class="note dim" id="b-recipe-note"></div>
        </div>`;
}

function iconFor(k: BuildingKind): string {
  switch (k) {
    case 'habitat':
      return '🏠';
    case 'solar':
      return '☀';
    case 'battery':
      return '🔋';
    case 'warehouse':
      return '📦';
    case 'workshop':
      return '🔧';
    case 'extractor':
      return '💧';
    case 'oxygenator':
      return '🫁';
    case 'greenhouse':
      return '🌱';
    case 'garage':
      return '🛻';
    case 'rtg':
      return '☢';
    case 'weatherStation':
      return '📡';
    case 'refinery':
      return '🏭';
    case 'repairBay':
      return '🛠';
    case 'pumpStation':
      return '🚰';
    case 'waterTank':
      return '💧';
  }
}

export { fmtKg, fmtDuration };
