/**
 * Application shell: owns the frame loop, input, and the wiring between the
 * simulation, the renderer and the HUD.
 *
 * The dependency arrows all point one way. The simulation knows nothing about
 * this file, and this file knows nothing about the simulation: it holds a
 * {@link SimHost}, reads it through a {@link SimView}, and changes it only by
 * sending a {@link SimCommand}. Everything the player does arrives here as a
 * gesture and leaves as a message. Which host is on the other end — this thread
 * or a worker — is not this file's business (TDD §16).
 */

import type { Rover } from '../sim/Simulation';
import { colonistStatusText } from '../sim/Simulation';
import type { SimCommand, SimHost, SimView } from '../sim/host';
import { createHost, planHost, restoreHost } from '../sim/host';
import { GameRenderer } from '../render/Renderer';
import type { OverlayMode } from '../render/Renderer';
import { CameraRig } from './CameraRig';
import { singlePointerGesture, twoPointerGesture } from './gestures';
import { HUD } from '../ui/HUD';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import { BUILDINGS, BUILDING_ORDER, ROVERS, ALL_RESOURCES, ALL_FLUIDS, RESOURCES, FLUIDS } from '../sim/defs';
import { DevMode } from '../dev/DevMode';
import type { SpawnSpec } from '../dev/DevMode';
import { DevPanel } from '../dev/DevPanel';
import { SPEEDS, AUTOSAVE_INTERVAL_S, SAVE_VERSION, SOL_SECONDS, SUIT_O2_CAPACITY } from '../sim/config';
import { SaveStore } from '../ui/SaveStore';
import type { NewSaveInput } from '../ui/SaveStore';
import { LoadingScreen, nextFrame, delay } from '../ui/LoadingScreen';
import { MainMenu } from '../ui/MainMenu';
import { NewGameWizard } from '../ui/NewGameWizard';
import { LoadGameScreen } from '../ui/LoadGameScreen';
import { PauseMenu, type ColonyStats, type PauseMenuSettings } from '../ui/PauseMenu';
import { GameSettings, renderResolutionCap } from '../ui/Settings';
import { WORLD_SIZES, DIFFICULTIES, DEFAULT_WORLD_OPTIONS, hashSeed } from '../sim/difficulty';
import type { NewGameConfig, WorldSizeId } from '../sim/difficulty';
import { stormLabel } from '../sim/weather';
import { AudioSystem } from '../audio/AudioSystem';
import { BUILD_COMMIT, shortSha } from '../ui/BuildStatus';
import { UpdateCheck, updateCheckIntervalOverride } from './UpdateCheck';
import { getProfiler, resetProfiler, setProfilerEnabled } from '../sim/debug/Profiler';

void SAVE_VERSION;

const TAP_TRAVEL = 8; // px before a press becomes a camera drag
const DRAG_START = 5; // px before a press counts as a drag at all
const LONG_PRESS_MS = 480;

interface ActivePointer {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  travel: number;
  t0: number;
  button: number;
  dragging: boolean;
  /** Touch (or pen) rather than a mouse — decides pan-first vs orbit-first. */
  touch: boolean;
  /** This frame's movement, consumed and cleared by the gesture map. */
  dx: number;
  dy: number;
  /** Travel accumulated since the current two-finger gesture began. */
  gestureTravel: number;
}

type Selection =
  | { type: 'rover'; id: number }
  | { type: 'building'; id: number }
  | { type: 'colonist'; id: number }
  | { type: 'poi'; id: number }
  | null;

/**
 * Reverse-look up a world size from the world's half-extent, for the
 * expedition tab and the "save as new file" identity when the slot's meta is
 * missing. Falls back to the classic campaign size.
 */
function worldSizeFromHalf(half: number): WorldSizeId {
  for (const [id, def] of Object.entries(WORLD_SIZES)) {
    if (def.worldHalf === half) return id as WorldSizeId;
  }
  return 'medium';
}

export class Game {
  /**
   * The colony's host — the only handle this class keeps to the simulation.
   * Everything below reaches the world through it: reads via `view`, writes via
   * `order()`, time via `step()`.
   */
  host: SimHost | null = null;
  renderer: GameRenderer | null = null;
  rig: CameraRig | null = null;
  hud: HUD;
  /** Presentation-only soundscape; it only reads the host view. */
  private audio: AudioSystem;

  /** Developer mode: runtime-only editor state (never reaches the save file). */
  private dev: DevMode;
  private devPanel: DevPanel;

  private store!: SaveStore;
  private saveId: string | null = null;
  /** Persisted player settings (pause menu → settings). */
  private settings: GameSettings;
  /** The in-game pause menu, while open. */
  private pauseMenu: PauseMenu | null = null;
  /** The speed to restore when the pause menu closes. */
  private prePauseSpeed = 1;
  private menu: { unmount(): void } | null = null;
  /**
   * What the in-flight save is for. The save-failed prompt phrases its
   * options by context: a *menu* hand-off can offer "return without saving",
   * an *update* save defers to the update banner, *auto* saves only prompt
   * while the player is actually looking.
   */
  private saveContext: 'auto' | 'manual' | 'menu' | 'update' = 'auto';
  /** Whether a save is currently in flight (snapshot request outstanding). */
  private saveInFlight = false;
  /** The most recent save's outcome, for the expedition tab. */
  private lastSave: { at: number | null; ok: boolean | null } = { at: null, ok: null };
  /** Seconds between autosaves, 0 = off; read from settings at launch. */
  private autosaveSec: number = AUTOSAVE_INTERVAL_S;
  private selected: Selection = null;
  private pendingBuild: BuildingKind | null = null;
  private mouse = { x: -1, y: -1, in: false };
  private pointers = new Map<number, ActivePointer>();
  private pointerCount = 0;
  private pinchLast = 0;
  /** Finger span when the current two-finger gesture began (pinch drift baseline). */
  private pinchStart = 0;
  private lastAuto = 0;
  private lastInspector = 0;
  /** In-play update check while a colony runs (TDD §23); null in dev mode. */
  private updateCheck: UpdateCheck | null = null;
  private started = false;
  private shiftHeld = false;
  private longPressTimer: number | null = null;
  private endShown = false;

  private canvas: HTMLCanvasElement;

  /**
   * The colony as the outside world may see it: a read model, never a live sim.
   * `scripts/mobile-smoke.mjs` reads world state back through this, which is why
   * it stays a getter on the Game rather than a field that could go stale.
   */
  get sim(): SimView | null {
    return this.host?.view ?? null;
  }

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.audio = new AudioSystem();
    // The graph starts lazily on the first user gesture (browser autoplay
    // policy), but its first scene is already the main-menu ambience.
    this.audio.setScene('menu');
    this.settings = new GameSettings();
    this.hud = new HUD({
      onSpeed: (idx) => this.audio.setPaused(idx === 0),
      onPickBuild: (k) => this.setPendingBuild(k),
      onAction: (a, arg) => this.handleAction(a, arg),
      onStart: (seedText, near) => this.quickStart(seedText, near),
      onOverlay: (m) => this.renderer?.setOverlay(m),
      // The ☰ button opens the pause menu; leaving is one of *its* options
      // (which saves first, the way the old button did — but without the
      // race that disposed the host before the save could finish).
      onMenu: () => this.openPauseMenu(),
      onDev: () => this.toggleDevPanel(),
      onSaveRetry: () => this.retrySave(),
      onSaveAsNew: () => this.saveAsNew(),
      onSaveDismiss: () => this.hud.hideSaveError(),
      onSaveAbandon: () => this.abandonToMenu(),
    });
    this.dev = new DevMode(
      (sev, text) => this.hud.addLog(sev, text),
      (command, ack) => {
        if (ack.ok) this.audio.command(command.type);
        else this.audio.reject();
      },
    );
    this.devPanel = new DevPanel(this.dev, {
      getSim: () => this.host?.view ?? null,
      // The panel edits entities it has backdoors for; a site is not one of
      // them (yet), so it is reported as no selection rather than widened into
      // the panel's own type.
      getSelection: () => (this.selected?.type === 'poi' ? null : this.selected),
      select: (sel) => {
        this.selected = sel;
        this.syncUI(true);
      },
      getSpawnPoint: () =>
        this.rig ? { x: this.rig.target.x, z: this.rig.target.z } : { x: 0, z: 0 },
      armSpawn: (spec) => this.setArmedSpawn(spec),
      setHint: (t) => this.hud.hint(t),
      onToggleEnabled: (on) => this.setDevEnabled(on),
      onClose: () => this.setDevPanelVisible(false),
    });
    this.store = new SaveStore();
    // The mission menu owns the pre-game screen; the HUD owns everything after.
    this.hud.hideStartOverlay();
    this.attachInput();
    window.addEventListener('resize', () => this.resize());

    // Persist on tab hide — TDD §23 asks for saves on visibility transitions.
    // The pause menu's "save when the tab is hidden" setting can switch this
    // off for players who don't want a background write.
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'hidden' &&
        this.started &&
        this.settings.saveOnTabHide() &&
        !this.saveInFlight
      )
        this.save(true);
    });

    this.showMainMenu();
    this.loop(performance.now());
  }

  // ------------------------------------------------------- menus ----
  private closeMenu(): void {
    if (this.menu) {
      this.menu.unmount();
      this.menu = null;
    }
  }

  private showMainMenu(): void {
    this.closeMenu();
    this.audio.setScene('menu');
    const menu = new MainMenu({
      saves: this.store.list(),
      onNewGame: () => this.openNewGame(),
      onLoadGame: () => this.openLoadGame(),
      onContinue: (id) => void this.loadSave(id),
    });
    this.menu = menu;
    menu.mount();
  }

  private openNewGame(): void {
    this.closeMenu();
    const wiz = new NewGameWizard({
      onCancel: () => this.showMainMenu(),
      onBegin: (config) => void this.startNewGame(config),
    });
    this.menu = wiz;
    wiz.mount();
  }

  private openLoadGame(): void {
    this.closeMenu();
    const loads = new LoadGameScreen({
      store: this.store,
      onLaunch: (id) => void this.loadSave(id),
      onNewGame: () => this.openNewGame(),
      onBack: () => this.showMainMenu(),
    });
    this.menu = loads;
    loads.mount();
  }

  /** Fallback if the legacy start overlay ever fires (it is hidden in play). */
  private quickStart(seedText: string, near: number): void {
    void this.startNewGame({
      saveName: 'Ares Expedition',
      seedText: seedText || 'mars2066',
      difficulty: 'pioneer',
      worldSize: 'medium',
      region: null,
      options: { ...DEFAULT_WORLD_OPTIONS, nearDeposits: near },
    });
  }

  // ------------------------------------------------------ mission start ----
  private async startNewGame(config: NewGameConfig): Promise<void> {
    this.closeMenu();
    const size = WORLD_SIZES[config.worldSize];
    const seed = hashSeed(config.seedText || 'mars2066');
    const loader = new LoadingScreen({
      kicker: 'Descent sequence',
      title: (config.saveName || 'RED FRONTIER').toUpperCase().slice(0, 26),
      steps: ['Charting landing site', 'Generating world', 'Building terrain', 'Deploying colony'],
    });
    loader.mount();
    try {
      loader.setActiveStep(0);
      loader.setProgress(0.05, `Plotting descent to ${config.region ?? 'a surveyed site'}…`);
      await nextFrame();
      await delay(140);

      loader.setActiveStep(1);
      loader.setProgress(0.2, 'Seeding Martian geology…');
      await nextFrame();
      // The world comes up behind a host rather than in a constructor call here,
      // and the host is chosen by a factory rather than by this file: seeding,
      // mirroring the terrain and (when asked for) standing up a worker are one
      // await, so the frame loop, the renderer and the panels never learn which
      // side of a thread boundary the colony is on (TDD §16).
      const plan = planHost(location.search);
      if (plan.transport === 'worker')
        loader.setProgress(0.3, 'Spinning up the simulation thread…');
      await nextFrame();
      const host = await createHost({
        seed,
        difficulty: config.difficulty,
        worldHalf: size.worldHalf,
        region: config.region,
        worldOptions: config.options,
      });
      loader.setProgress(0.56, 'Surveying deposits and weather…');
      await nextFrame();

      loader.setActiveStep(2);
      loader.setProgress(0.68, 'Building terrain mesh…');
      await nextFrame();
      this.launch(host);
      loader.setActiveStep(3);
      loader.setProgress(0.87, 'Deploying rovers…');
      await nextFrame();

      this.renderer?.sync(host.view);
      this.renderer?.render();
      this.saveId = this.store.create(
        {
          name: config.saveName,
          difficulty: config.difficulty,
          worldSize: config.worldSize,
          region: config.region,
          seedText: config.seedText,
        },
        await host.requestSnapshot(),
        1,
      );
      loader.markAllDone();
      loader.setProgress(1, 'Touchdown confirmed.');
      await delay(340);

      const site = host.view.world.landingSite();
      this.hud.addLog(
        'ok',
        `Descent stage down at ${site.name} — ${size.label} claim, ${config.seedText} seed. Two rovers deployed.`,
      );
      this.hud.addLog(
        'info',
        config.difficulty === 'survivor'
          ? 'Survivor protocol: stores are lean and the storms will be cruel. Ice → water → oxygen, and hurry.'
          : 'Priority one: ice → Water Extractor → Oxygen Generator. Solar dies at night, so build batteries too.',
      );
    } catch (err) {
      console.error(err);
      loader.setProgress(1, `World generation failed: ${(err as Error).message}`);
      await delay(2000);
      this.showMainMenu();
    } finally {
      loader.unmount();
    }
  }

  private async loadSave(id: string): Promise<void> {
    const record = this.store.read(id);
    if (!record) {
      this.showMainMenu();
      return;
    }
    this.closeMenu();
    const meta = record.meta;
    const loader = new LoadingScreen({
      kicker: 'Colony records',
      title: (meta.name || 'RED FRONTIER').toUpperCase().slice(0, 26),
      steps: ['Reading colony record', 'Restoring world', 'Rebuilding terrain', 'Resuming mission'],
    });
    loader.mount();
    try {
      loader.setActiveStep(0);
      loader.setProgress(0.07, `Reading \u201c${meta.name}\u201d…`);
      await nextFrame();
      await delay(140);
      loader.setActiveStep(1);
      loader.setProgress(0.32, 'Restoring terrain and deposits…');
      await nextFrame();
      // The host boots the world and restores it in one move, so a corrupt or
      // future-versioned save fails before a renderer or a camera has anything
      // pointed at it. With a worker host that restore happens off-thread, and
      // the terrain the renderer is about to build is derived locally from the
      // seed the save names — which is why the restore path needs no second call.
      const host = await restoreHost(record.data as object);
      loader.setActiveStep(2);
      loader.setProgress(0.68, 'Rebuilding terrain mesh…');
      await nextFrame();
      this.launch(host);
      this.saveId = meta.id;
      loader.setActiveStep(3);
      loader.setProgress(0.9, `Resuming Sol ${host.view.clock.sol + 1}…`);
      await nextFrame();
      this.renderer?.sync(host.view);
      this.renderer?.render();
      loader.markAllDone();
      loader.setProgress(1, 'Welcome back, Commander.');
      await delay(320);
      this.hud.addLog('ok', `Save restored — ${host.view.clock.format()}.`);
    } catch (err) {
      console.error(err);
      loader.setProgress(1, `Could not restore that save (${(err as Error).message}).`);
      await delay(2200);
      this.showMainMenu();
    } finally {
      loader.unmount();
    }
  }

  private launch(host: SimHost): void {
    // Unwiring the developer mode first matters now that its edits are commands:
    // a battery pin left attached would re-apply itself to the new colony.
    this.dev.detach();
    this.host = host;
    this.selected = null;
    this.pendingBuild = null;
    this.endShown = false;
    // A fresh colony starts clean: dev mode off, no armed spawns, no pins.
    this.dev.disable();
    this.devPanel.setVisible(false);
    this.devPanel.setArmed(null);
    this.devPanel.setEnabled(false);
    this.hud.setDevActive(false);
    this.hud.setBuild(null);
    this.lastAuto = performance.now();
    // A fresh colony: the save-failed prompt and the expedition tab both read
    // these, so reset them rather than inherit the previous mission's state.
    this.lastSave = { at: null, ok: null };
    this.saveContext = 'auto';
    this.saveInFlight = false;
    this.autosaveSec = this.settings.autosaveIntervalSec();
    // Profiler is development-only diagnostics (Milestone 1): reset on every
    // launch, disabled until dev mode is turned on. Tests enable it via harness.
    resetProfiler();
    setProfilerEnabled(false);
    this.renderer = new GameRenderer(this.canvas, host.view.world);
    this.renderer.setOverlay(this.hud.overlay as OverlayMode);
    this.rig = new CameraRig(this.renderer.camera, host.view.world.half);
    this.resize();
    // Apply the persisted graphical settings to the brand-new renderer.
    this.applyGraphics();
    // The mode's per-step overlay installs on the host it edits, which is why
    // the frame loop no longer mentions developer mode at all.
    this.dev.attach(host);
    this.hud.updateVitals(host.view);
    this.syncUI(true);
    this.started = true;
    // In production builds, watch for a newer deploy while playing (TDD §23).
    // Dev mode is out: the dev server ships no manifest and HMR already
    // keeps the page current.
    if (import.meta.env.PROD) {
      this.updateCheck = new UpdateCheck({
        current: BUILD_COMMIT,
        intervalMs: updateCheckIntervalOverride(),
        onFound: (latest) => this.onNewBuild(latest),
      });
      this.updateCheck.start();
    }
    this.audio.setScene('game');
    this.audio.setPaused(this.hud.speedIdx === 0);
    this.audio.update(host.view, this.hud.speedIdx === 0 || !!host.view.gameOver);
    this.audio.missionStarted();
  }

  // -------------------------------------------------------------- input ----
  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => this.pointerCancel(e));
    window.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.in = true;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.rig) return;
        e.preventDefault();
        this.rig.dolly(Math.pow(1.13, e.deltaY > 0 ? 1 : -1));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shiftHeld = false;
    });
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.started) return;
    if (this.hud.isWorldMapOpen()) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.shiftHeld = e.shiftKey || e.button === 1;
    const p: ActivePointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      travel: 0,
      t0: performance.now(),
      button: e.button,
      dragging: false,
      touch: e.pointerType !== 'mouse',
      dx: 0,
      dy: 0,
      gestureTravel: 0,
    };
    this.pointers.set(e.pointerId, p);
    this.pointerCount = this.pointers.size;
    if (this.pointerCount === 2) this.resetPinch();

    // Long press = context order on touch (TDD §18).
    if (this.longPressTimer !== null) window.clearTimeout(this.longPressTimer);
    if (this.pointerCount === 1 && e.pointerType !== 'mouse') {
      this.longPressTimer = window.setTimeout(() => {
        const still = this.pointers.get(e.pointerId);
        if (still && still.travel < TAP_TRAVEL) {
          still.dragging = true; // consume the gesture
          this.contextTap(still.x, still.y);
        }
      }, LONG_PRESS_MS);
    }
  }

  private resetPinch(): void {
    const arr = [...this.pointers.values()];
    if (arr.length < 2) return;
    const dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    this.pinchLast = dist;
    this.pinchStart = dist;
    // Travel is measured from the start of the two-finger gesture, so whichever
    // finger went down first doesn't get counted as "the mover" for free.
    for (const q of arr) {
      q.gestureTravel = 0;
      q.dx = 0;
      q.dy = 0;
    }
  }

  private pointerMove(e: PointerEvent): void {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.in = true;
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.started) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.travel += Math.hypot(dx, dy);
    p.x = e.clientX;
    p.y = e.clientY;

    if (!this.rig) return;

    p.dx = dx;
    p.dy = dy;
    p.gestureTravel += Math.hypot(dx, dy);

    if (this.pointerCount === 1) {
      if (p.travel < DRAG_START) return; // still possibly a tap
      const g = singlePointerGesture({
        touch: p.touch,
        panModifier: this.shiftHeld,
        dx,
        dy,
      });
      if (g.kind === 'none') return; // a resting finger must not nudge the camera
      p.dragging = true;
      if (g.kind === 'pan') this.rig.panByPixels(g.dx, g.dy, window.innerHeight);
      else this.rig.rotateByPixels(g.dx, g.dy, window.innerWidth, window.innerHeight);
      p.dx = 0;
      p.dy = 0;
    } else if (this.pointerCount === 2) {
      const arr = [...this.pointers.values()];
      const a = arr[0];
      const b = arr[1];
      a.dragging = true;
      b.dragging = true;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // The map classifies on per-gesture travel, so project it explicitly:
      // passing the pointers themselves would hand it `travel` (accumulated
      // since touch-down, including any one-finger pan from before the second
      // finger landed) and the look would credit the wrong finger.
      const g = twoPointerGesture(
        { dx: a.dx, dy: a.dy, travel: a.gestureTravel },
        { dx: b.dx, dy: b.dy, travel: b.gestureTravel },
        this.pinchLast,
        dist,
        this.pinchStart,
      );
      if (g.dolly !== 1) this.rig.dolly(g.dolly);
      // Two fingers look around; pan is the one-finger gesture now. Driving
      // both off the same gesture is what made panning feel broken (#1).
      if (g.orbit) {
        this.rig.rotateByPixels(
          g.orbit.dx,
          g.orbit.dy,
          window.innerWidth,
          window.innerHeight,
        );
      }
      this.pinchLast = dist;
      a.dx = 0;
      a.dy = 0;
      b.dx = 0;
      b.dy = 0;
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.pointerCount = this.pointers.size;
    const dur = performance.now() - p.t0;
    const isTap = !p.dragging && p.travel < TAP_TRAVEL && dur < 500;
    if (isTap && this.started) {
      if (e.button === 2) this.contextTap(e.clientX, e.clientY);
      else this.primaryTap(e.clientX, e.clientY);
    }
    if (this.pointerCount === 2) this.resetPinch();
    if (e.button === 1) this.shiftHeld = false;
  }

  private pointerCancel(e: PointerEvent): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.pointers.delete(e.pointerId);
    this.pointerCount = this.pointers.size;
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key === 'Shift') this.shiftHeld = true;
    if (!this.started) return;
    const key = e.key.toLowerCase();

    // Typing into a field (the dev panel's number boxes, a wizard input)
    // must never trigger game hotkeys.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    this.audio.activateFromUserGesture();

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      this.manualSave();
      return;
    }
    // The pause menu owns the keyboard while it is open: Esc resumes, and
    // everything else is ignored so a stray key never leaks into a frozen
    // colony (or the world map underneath the frost).
    if (this.pauseMenu) {
      if (e.key === 'Escape') {
        this.closePauseMenu();
        this.audio.command('rover/stop');
      }
      return;
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      this.toggleDevPanel();
      return;
    }
    if (e.key === 'Escape') {
      if (this.hud.closeWorldMap() || this.hud.closeAlertHistory() || this.hud.closeBuildInfo()) {
        this.audio.command('rover/stop');
        return;
      }
      if (this.dev.armedSpawn) {
        this.setArmedSpawn(null);
        this.audio.command('rover/stop');
        return;
      }
      if (this.pendingBuild) this.setPendingBuild(null);
      else this.selected = null;
      this.audio.command('rover/stop');
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const next = this.hud.speedIdx === 0 ? 1 : 0;
      this.hud.setSpeed(next);
      this.audio.setPaused(next === 0);
      return;
    }
    if (key === 'v') {
      this.renderer?.setOverlay(this.hud.cycleOverlay() as OverlayMode);
      this.audio.select();
      return;
    }
    if (key === 'f') {
      this.centerOnSelected();
      this.audio.select();
      return;
    }
    if (key === 'h') {
      this.hud.openAlertHistory();
      this.audio.select();
      return;
    }
    if (key === 'm') {
      if (this.hud.isWorldMapOpen()) this.hud.closeWorldMap();
      else this.hud.openWorldMap();
      this.audio.select();
      return;
    }
    if (key === '.') {
      this.cycleIdle();
      this.syncUI(true);
      this.audio.select();
      return;
    }
    // Number keys select build blueprints in palette order.
    const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
    if (idx >= 0 && idx < BUILDING_ORDER.length) {
      const kind = BUILDING_ORDER[idx];
      this.setPendingBuild(this.pendingBuild === kind ? null : kind);
      this.audio.select();
    }
  }

  // ---------------------------------------------------------- gestures ----
  /**
   * True when HUD chrome is visually at this screen point. Belt and braces on
   * top of the panels' `pointer-events`: a tap that lands on any UI surface —
   * a speed button, a panel, a chip — must never leak through to the canvas
   * and become a move order for the selected rover.
   */
  private uiCoversPoint(x: number, y: number): boolean {
    try {
      const el = document.elementFromPoint(x, y);
      return !!el && el !== this.canvas;
    } catch {
      return false; // headless/odd environments: the CSS layer already guards
    }
  }

  private contextTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.uiCoversPoint(x, y)) return;
    if (this.pendingBuild) {
      this.setPendingBuild(null);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.order({
        type: 'rover/move',
        roverId: this.selected.id,
        x: pt.x,
        z: pt.z,
        queue: this.shiftHeld,
      });
    } else if (this.selected?.type === 'colonist') {
      this.order({ type: 'colonist/order', order: { type: 'moveTo', x: pt.x, z: pt.z } });
    } else if (this.selected?.type === 'building') {
      // Right-clicking empty ground with a structure selected clears it.
      this.selected = null;
      this.syncUI(true);
    }
  }

  private primaryTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.uiCoversPoint(x, y)) return;
    if (this.pendingBuild) {
      void this.placeBuild(x, y);
      return;
    }
    // A click-to-place spawn the developer panel armed consumes the tap.
    if (this.dev.armedSpawn) {
      const pt = this.renderer.raycastTerrain(x, y);
      if (pt) this.placeDevSpawn(pt.x, pt.z);
      return;
    }
    const pick = this.renderer.pickTargetAt(x, y);
    if (pick) {
      // World selections are not DOM controls, so they get their own quiet
      // confirmation rather than relying on the menu/HUD click listener.
      this.audio.select();
      if (pick.type === 'rover') {
        // With a rover selected, tapping a stranded one dispatches a rescue —
        // the same grammar as deposit → mine (P4's RECOVER task).
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const target = this.sim.roverById(pick.id);
        if (rv && target && target.id !== rv.id && target.phase === 'disabled') {
          this.order({
            type: 'rover/recover',
            roverId: rv.id,
            strandedId: target.id,
            queue: this.shiftHeld,
          });
        } else if (this.selected?.type === 'rover' && this.selected.id === pick.id) {
          // Tapping the selected rover again deselects it.
          this.selected = null;
        } else {
          this.selected = { type: 'rover', id: pick.id };
        }
      } else if (pick.type === 'building') {
        // With a rover selected, tapping a construction site sends the rover to
        // build it, while tapping a battered or dusty structure sends it to
        // service — the same grammar as deposit → mine. Buildable check keeps
        // the wrong chassis from being dispatched to a site it cannot work.
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const b = this.sim.buildingById(pick.id);
        const isSite = b !== undefined && b.state !== 'online';
        const canBuild =
          isSite && rv !== undefined && BUILDINGS[b!.kind].buildableBy.includes(rv.kind);
        const job = this.sim.needsMaintenance(pick.id);
        if (rv && canBuild) {
          this.order({
            type: 'rover/construct',
            roverId: rv.id,
            buildingId: pick.id,
            queue: this.shiftHeld,
          });
        } else if (rv && job) {
          this.order(
            job === 'repair'
              ? { type: 'rover/repair', roverId: rv.id, buildingId: pick.id, queue: this.shiftHeld }
              : { type: 'rover/clean', roverId: rv.id, buildingId: pick.id, queue: this.shiftHeld },
          );
        } else if (this.selected?.type === 'building' && this.selected.id === pick.id) {
          // Tapping the selected structure again deselects it.
          this.selected = null;
        } else {
          this.selected = { type: 'building', id: pick.id };
        }
      } else if (pick.type === 'colonist') {
        if (this.selected?.type === 'colonist' && this.selected.id === pick.id) {
          this.selected = null;
        } else {
          this.selected = { type: 'colonist', id: pick.id };
        }
      } else if (pick.type === 'poi') {
        // The same grammar as a deposit: with a rover selected, tapping a site
        // sends it to salvage. Without one, the panel explains what it is.
        const site = this.sim.poiById(pick.id);
        if (this.selected?.type === 'rover' && site) {
          this.order({
            type: 'rover/salvage',
            roverId: this.selected.id,
            poiId: pick.id,
            queue: this.shiftHeld,
          });
        } else if (this.selected?.type === 'poi' && this.selected.id === pick.id) {
          this.selected = null;
        } else {
          this.selected = { type: 'poi', id: pick.id };
        }
      } else if (pick.type === 'deposit') {
        if (this.selected?.type === 'rover') {
          this.order({
            type: 'rover/mine',
            roverId: this.selected.id,
            depositId: pick.id,
            queue: this.shiftHeld,
          });
        } else {
          const d = this.sim.world.deposits.find((dp) => dp.id === pick.id);
          this.hud.addLog(
            'info',
            d
              ? `${d.resource} deposit — about ${Math.round(d.amount)} kg. Select a rover, then tap it to mine.`
              : 'Select a rover first, then tap a deposit to mine it.',
          );
        }
      }
      this.syncUI(true);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.order({
        type: 'rover/move',
        roverId: this.selected.id,
        x: pt.x,
        z: pt.z,
        queue: this.shiftHeld,
      });
    } else if (this.selected) {
      // Tapping empty ground with a structure or the colonist selected
      // clears the selection (a rover instead takes it as a move order).
      this.selected = null;
      this.syncUI(true);
    }
  }

  /**
   * The one way this class writes to the colony: an intent, handed to the host.
   * Reads stay on `this.sim` (the view), which is why the gesture handlers below
   * look unchanged — only the writes had to be told where they end up.
   */
  private order(command: SimCommand): void {
    const host = this.host;
    if (!host) return;
    // The audio director is presentation-only: it hears the player's intent,
    // while the host remains the sole authority that may mutate the colony.
    this.audio.command(command.type);
    host.send(command);
  }

  private setPendingBuild(kind: BuildingKind | null): void {
    this.pendingBuild = kind;
    this.hud.setBuild(kind);
    if (!kind) this.renderer?.showGhost(null, 0, 0, false);
    this.syncUI(true);
  }

  private async placeBuild(x: number, y: number): Promise<void> {
    const host = this.host;
    if (!this.renderer || !host || !this.pendingBuild) return;
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    const kind = this.pendingBuild;
    // Placing is the one gesture whose result the UI needs immediately: the new
    // structure must be selected, and only the sim knows the id it allocated.
    // `request` is the ack path the protocol reserves for exactly that.
    try {
      const ack = await host.requestPlacement({ type: 'building/place', kind, x: pt.x, z: pt.z });
      if (ack.ok && ack.entityId !== undefined) {
        this.audio.command('building/place');
        this.selected = { type: 'building', id: ack.entityId };
        // Shift-place keeps the blueprint armed for laying out solar farms.
        if (!this.shiftHeld) this.setPendingBuild(null);
      } else {
        this.audio.reject();
      }
    } catch {
      // A host can disappear while a placement request is in flight (for
      // example, when returning to the menu). Its rejection is feedback, not a
      // reason to leave an unhandled promise behind.
      this.audio.reject();
    }
  }

  // ------------------------------------------------------- developer mode ----

  /**
   * The developer-mode master switch, decoupled from panel visibility: the
   * panel's own toggle drives this, so closing the panel leaves the mode on.
   * Nothing it does is persisted — the mode itself lives outside the sim, and
   * its upgrade levels are runtime-only by sim design.
   */
  private setDevEnabled(on: boolean): void {
    if (!this.started) return;
    if (on === this.dev.enabled) return;
    if (on) {
      this.dev.enable();
      // Milestone 1 profiler: enable diagnostics when dev mode is on.
      // Expose via window for console inspection (dev-only, tree-shakes in prod if unused).
      setProfilerEnabled(true);
      resetProfiler();
      try {
        (window as any).profiler = getProfiler();
        (window as any).profilerReport = () => {
          const rep = getProfiler().report();
          console.log(rep.summary);
          console.log(rep.table);
          return rep;
        };
      } catch {
        /* headless */
      }
    } else {
      // Every modifier stops dead: pins released, any armed spawn disarmed.
      this.setArmedSpawn(null);
      this.dev.disable();
      setProfilerEnabled(false);
      try {
        delete (window as any).profiler;
        delete (window as any).profilerReport;
      } catch {
        /* headless */
      }
    }
    this.devPanel.setEnabled(on);
    this.hud.setDevActive(on);
    this.hud.addLog(
      'info',
      on
        ? '🛠 Developer mode ON — world edits are live and stay out of the save file. Profiler enabled (window.profilerReport()).'
        : '🛠 Developer mode OFF — modifiers released.',
    );
    this.syncUI(true);
  }

  /** Show or hide the developer panel without touching the master switch. */
  private setDevPanelVisible(on: boolean): void {
    if (!this.started) return;
    this.devPanel.setVisible(on);
    this.syncUI(true);
  }

  /** The 🛠 button and the backtick key open and close the panel only. */
  private toggleDevPanel(): void {
    this.setDevPanelVisible(!this.devPanel.isVisible());
  }

  /**
   * Arm (or disarm) a click-to-place spawn from the developer panel. The next
   * terrain tap fabricates it; Shift+taps keep placing, Esc cancels — the
   * same grammar as the build palette.
   */
  private setArmedSpawn(spec: SpawnSpec | null): void {
    this.dev.armedSpawn = spec;
    if (spec && this.pendingBuild) {
      this.pendingBuild = null;
      this.hud.setBuild(null);
    }
    this.devPanel.setArmed(spec);
    if (spec) {
      const what =
        spec.type === 'deposit'
          ? `${spec.kind} deposit (${Math.round(spec.amountKg ?? 0)} kg)`
          : spec.type === 'building'
            ? BUILDINGS[spec.kind as BuildingKind].label
            : ROVERS[spec.kind as RoverKind].label;
      this.hud.hint(
        `<b>Developer spawn</b> — click terrain to fabricate a ${what}, Shift+click for several, Esc to cancel.`,
      );
    } else if (!this.pendingBuild) {
      this.hud.hint(null);
    }
  }

  /** Execute the armed click-to-place spawn at a tapped world point. */
  private placeDevSpawn(x: number, z: number): void {
    const spec = this.dev.armedSpawn;
    if (!spec || !this.sim) return;
    if (spec.type === 'rover') {
      const id = this.dev.spawnRover(spec.kind as RoverKind, x, z);
      this.selected = { type: 'rover', id };
      this.devPanel.setStatus(`${ROVERS[spec.kind as RoverKind].label} #${id} fabricated`);
    } else if (spec.type === 'building') {
      const id = this.dev.spawnBuilding(spec.kind as BuildingKind, x, z);
      if (id !== null) {
        this.selected = { type: 'building', id };
        this.devPanel.setStatus(`${BUILDINGS[spec.kind as BuildingKind].label} #${id} fabricated online`);
      } else {
        this.devPanel.setStatus('Cannot fabricate there — see the colony log for why');
      }
    } else {
      this.dev.spawnDeposit(spec.kind as ResourceId, x, z, spec.amountKg ?? 2500);
      this.devPanel.setStatus(
        `${spec.kind} deposit surveyed in — ${Math.round(spec.amountKg ?? 2500)} kg`,
      );
    }
    // Shift-place keeps the spawn armed, exactly like the build palette.
    if (!this.shiftHeld) this.setArmedSpawn(null);
    this.syncUI(true);
  }

  private handleAction(a: string, arg?: number | string): void {
    if (!this.sim) return;
    if (a === 'focus' && typeof arg === 'number') {
      const r = this.sim.roverById(arg);
      const b = this.sim.buildingById(arg);
      if (r) this.selected = { type: 'rover', id: arg };
      else if (b) this.selected = { type: 'building', id: arg };
      else if (this.sim.colonist.id === arg) this.selected = { type: 'colonist', id: arg };
      this.centerOnSelected();
      this.syncUI(true);
      return;
    }
    if (a === 'cycle-idle') {
      this.cycleIdle();
      this.syncUI(true);
      return;
    }
    if (!this.selected) return;
    switch (a) {
      case 'deselect':
        this.selected = null;
        break;
      case 'stop':
        if (this.selected.type === 'rover')
          this.order({ type: 'rover/stop', roverId: this.selected.id });
        break;
      case 'unload':
        if (this.selected.type === 'rover')
          this.order({ type: 'rover/unload', roverId: this.selected.id, queue: this.shiftHeld });
        break;
      case 'wait':
        if (this.selected.type === 'rover')
          this.order({
            type: 'rover/wait',
            roverId: this.selected.id,
            seconds: Number(arg) || 60,
            queue: true,
          });
        break;
      case 'recenter':
        this.centerOnSelected();
        break;
      case 'repeathaul':
        if (this.selected.type === 'rover') {
          const rv = this.sim.roverById(this.selected.id);
          this.order({
            type: 'rover/repeatRoute',
            roverId: this.selected.id,
            on: !(rv?.command.type === 'mine' && rv.command.repeat),
          });
        }
        break;
      case 'rule-haul':
      case 'rule-svc':
      case 'rule-storm':
      case 'rule-rescue':
        if (this.selected.type === 'rover') {
          const rule =
            a === 'rule-haul'
              ? 'autoHaul'
              : a === 'rule-svc'
                ? 'autoService'
                : a === 'rule-storm'
                  ? 'stormShelter'
                  : 'autoRescue';
          this.order({ type: 'rover/rule', roverId: this.selected.id, rule, on: arg === 1 });
        }
        break;
      case 'rule-charge':
        if (this.selected.type === 'rover' && typeof arg === 'number') {
          this.order({ type: 'rover/chargeFloor', roverId: this.selected.id, pct: arg });
        }
        break;
      case 'rule-lights':
        if (this.selected.type === 'rover') {
          this.order({ type: 'rover/lights', roverId: this.selected.id, on: arg === 1 });
        }
        break;
      case 'toggle':
        if (this.selected.type === 'building') {
          const b = this.sim.buildingById(this.selected.id);
          if (b) {
            const next = !b.enabled;
            this.order({ type: 'building/toggle', buildingId: b.id, enabled: next });
            // Worker host: the view is a mirror that stays stale until the
            // next `view` message arrives. Flip it optimistically so the
            // `syncUI(true)` that follows this switch reads the intended
            // state and the power button feels instant. The local host has
            // already mutated the live sim, so the guard keeps us from
            // flipping it back.
            const viewB = this.sim.buildingById(b.id);
            if (viewB && viewB.enabled !== next) {
              (viewB as { enabled: boolean }).enabled = next;
            }
          }
        }
        break;
      case 'demolish':
        if (this.selected.type === 'building') {
          this.order({ type: 'building/demolish', buildingId: this.selected.id });
          this.selected = null;
        }
        break;
      case 'shelter':
        this.order({ type: 'colonist/order', order: { type: 'shelter' } });
        break;
      case 'service':
        if (this.selected.type === 'building') {
          this.order({ type: 'building/maintain', buildingId: this.selected.id });
        }
        break;
      case 'assemble':
        if (this.selected.type === 'building' && typeof arg === 'string') {
          this.order({ type: 'building/assemble', buildingId: this.selected.id, kind: arg as RoverKind });
        }
        break;
    }
    this.syncUI(true);
  }

  /** Jump to the next rover with nothing to do (`.` hotkey + HUD button). */
  private idleCycleIdx = 0;
  private cycleIdle(): void {
    const idle = this.sim?.idleRovers();
    if (!idle) return;
    if (idle.length === 0) {
      this.hud.flashSave('No idle rovers');
      return;
    }
    const r = idle[this.idleCycleIdx % idle.length];
    this.idleCycleIdx = (this.idleCycleIdx + 1) % idle.length;
    this.selected = { type: 'rover', id: r.id };
    this.centerOnSelected();
  }

  private centerOnSelected(): void {
    if (!this.rig || !this.selected || !this.sim) return;
    const e =
      this.selected.type === 'rover'
        ? this.sim.roverById(this.selected.id)
        : this.selected.type === 'building'
          ? this.sim.buildingById(this.selected.id)
          : this.sim.colonist;
    if (e) this.rig.target.set(e.x, 4, e.z);
  }

  /**
   * Persist the colony. `quiet` suppresses the progress dialog, flash and
   * sound (autosaves, the tab-hide save); `onDone` reports the outcome to
   * callers that must act on it — the return-to-menu hand-off is the one that
   * does (and must: it is not allowed to dispose the host until this settles).
   *
   * A user-initiated save gets the full-screen progress dialog; a failed save
   * turns it into the save-failed prompt with recovery options, rather than a
   * toast the player reads half a second too late.
   */
  private save(quiet = false, onDone?: (ok: boolean, stamp: string) => void): void {
    const host = this.host;
    const id = this.saveId;
    if (!host || !id) {
      // No slot to write into. A user-initiated save is still recoverable:
      // the prompt's "save as new file" creates the missing slot.
      if (!quiet) {
        this.hud.showSaveError('read', this.saveContext === 'menu');
      }
      onDone?.(false, '');
      return;
    }
    // Everything about the payload — reading the world, serialising it, and the
    // sol it is stamped with — is taken *before* the handoff, so an autosave can
    // never interleave two colonies if the mission ends mid-write.
    const sol = host.view.clock.sol + 1;
    const stamp = host.view.clock.format();
    if (!quiet) this.hud.saveProgressStart(this.saveContext === 'menu' ? 'Returning to main menu' : 'Saving colony');
    // TDD §20 budgets a save at 1–2 s of user-visible time; asking the host for
    // the snapshot instead of building it here is how that stays off the frame
    // loop once the sim runs on its own thread.
    this.saveInFlight = true;
    void host
      .requestSnapshot()
      .then(
        (snapshot) => {
          try {
            if (!quiet) this.hud.saveProgressStage(2);
            this.store.update(id, snapshot, sol);
            this.lastSave = { at: Date.now(), ok: true };
            if (!quiet) {
              this.hud.saveProgressEnd(true);
              this.hud.flashSave(`Saved · ${stamp}`);
              this.audio.saved();
            }
            onDone?.(true, stamp);
          } catch (e) {
            // Quota is the realistic failure here; the snapshot was good, the
            // disk said no.
            console.error(e);
            this.onSaveFailure('storage', quiet, onDone);
          }
        },
        (e) => {
          console.error(e);
          this.onSaveFailure('read', quiet, onDone);
        },
      )
      .finally(() => {
        this.saveInFlight = false;
      });
  }

  /**
   * One place that decides how a failed save is surfaced: the prompt, when
   * the player can see it and can act; a logged line plus a toast, when they
   * cannot (a background autosave in a hidden tab). The caller always gets
   * `onDone(false)` either way.
   */
  private onSaveFailure(
    kind: 'read' | 'storage',
    quiet: boolean,
    onDone: ((ok: boolean, stamp: string) => void) | undefined,
  ): void {
    this.lastSave = { at: Date.now(), ok: false };
    if (!quiet) this.hud.saveProgressEnd(false);
    const visible = document.visibilityState !== 'hidden';
    if (!quiet || (visible && this.saveContext !== 'update')) {
      this.hud.showSaveError(kind, this.saveContext === 'menu');
    } else {
      this.hud.flashSave('Save failed — the colony could not be saved');
    }
    this.hud.addLog(
      'warn',
      `Save failed${kind === 'storage' ? ' — browser storage full' : ' — the colony could not be read'}. ` +
        `Your last successful save is unchanged.`,
    );
    this.audio.reject();
    onDone?.(false, '');
  }

  /** A manual save from the pause menu (or Ctrl+S): full progress dialog. */
  private manualSave(): void {
    if (!this.host || !this.started) return;
    this.saveContext = 'manual';
    this.save(false);
  }

  /** The failed-save prompt's "retry": re-run the save in its own context. */
  private retrySave(): void {
    if (this.saveContext === 'menu') {
      this.hud.hideSaveError();
      this.returnToMenu();
    } else {
      this.hud.hideSaveError();
      this.saveContext = 'manual';
      this.save(false);
    }
  }

  /**
   * The failed-save prompt's "save as new file": take a fresh snapshot and
   * write it to a brand-new slot, adopting the current colony's identity.
   * Useful when the existing slot is corrupt or the quota write keeps
   * failing into the same key.
   */
  private saveAsNew(): void {
    const host = this.host;
    if (!host || !this.started) {
      this.hud.hideSaveError();
      return;
    }
    const meta = this.saveId ? this.store.get(this.saveId) : null;
    const sim = this.sim;
    const input: NewSaveInput = {
      name: meta?.name ?? 'Recovered Colony',
      difficulty: sim?.difficulty ?? meta?.difficulty ?? 'pioneer',
      worldSize:
        meta?.worldSize ??
        (sim ? worldSizeFromHalf(sim.world.half) : 'medium'),
      region: meta?.region ?? sim?.world.region ?? null,
      seedText: meta?.seedText ?? '',
    };
    const sol = host.view.clock.sol + 1;
    this.hud.hideSaveError();
    this.hud.saveProgressStart('Saving to a new file');
    this.saveInFlight = true;
    void host
      .requestSnapshot()
      .then(
        (snapshot) => {
          this.hud.saveProgressStage(2);
          const newId = this.store.create(input, snapshot, sol);
          this.saveId = newId;
          this.lastSave = { at: Date.now(), ok: true };
          this.hud.saveProgressEnd(true);
          this.hud.flashSave('Saved to a new file');
          this.audio.saved();
          // If the failed save was the return-to-menu hand-off, the player's
          // intent was to leave — the new file is written, so finish the job.
          if (this.saveContext === 'menu') {
            this.saveContext = 'auto';
            this.leaveToMenu();
          } else {
            this.saveContext = 'manual';
          }
        },
        (e) => {
          console.error(e);
          this.hud.saveProgressEnd(false);
          this.hud.showSaveError('read', this.saveContext === 'menu');
          this.audio.reject();
        },
      )
      .finally(() => {
        this.saveInFlight = false;
      });
  }

  /**
   * The failed-save prompt's "return without saving" (menu context only):
   * the player explicitly chose to leave; the colony goes back as the last
   * successful save left it.
   */
  private abandonToMenu(): void {
    this.hud.hideSaveError();
    this.hud.flashSave('Returned to menu — progress since the last save was not written');
    this.saveContext = 'auto';
    this.leaveToMenu();
  }

  /**
   * A newer build is live (TDD §23). The check has already stopped itself —
   * one notice per session, never a nag. Freeze the colony so nothing moves
   * while the save and the reload happen, tell the player what is going on,
   * persist, and let the reload land them on the new build.
   */
  private onNewBuild(latest: string): void {
    this.hud.setSpeed(0);
    this.audio.setPaused(true);
    this.hud.showUpdateNotice(BUILD_COMMIT, latest);
    // The update banner carries this save's progress and its failure
    // fallback, so the save-failed prompt must not pile on top of it.
    this.saveContext = 'update';
    this.save(true, (ok, stamp) => {
      if (ok) {
        this.audio.saved();
        this.hud.updateNoticeText(
          `Colony saved · ${stamp}. Reloading to build ${shortSha(latest)}…`,
        );
        this.leaveToMenu(3000);
      } else {
        this.audio.reject();
        this.hud.updateNoticeText(
          `The colony could not be saved — your last autosave is at most ${this.autosaveSec || AUTOSAVE_INTERVAL_S} s old. ` +
            `Reload to the new build, or keep playing this one.`,
        );
        this.hud.updateNoticeAction('Reload anyway', () => this.leaveToMenu());
      }
    });
  }

  /**
   * Persist the colony and hand control back to the main menu.
   *
   * The hand-off is ordered, because the ordering is the whole bug this used
   * to have: the old code fired the save and disposed the host on the very
   * next line, so with the (default) worker transport the pending snapshot
   * request was rejected as "the colony has shut down" — which is exactly the
   * "Save failed — the colony could not be read" the player saw on every menu
   * click. The dispose now happens only in `onDone`, after the write has
   * settled one way or the other; a failure lands on the save-failed prompt
   * instead of a toast.
   */
  private returnToMenu(): void {
    if (!this.started) return;
    this.closePauseMenu();
    this.updateCheck?.stop();
    this.saveContext = 'menu';
    this.save(false, (ok) => {
      if (ok) {
        this.saveContext = 'auto';
        this.leaveToMenu();
      }
      // ok === false: onSaveFailure already raised the prompt with Retry /
      // Save-as-new / Return-without-saving for the menu context.
    });
  }

  /**
   * Tear the colony down and let the page reload onto the main menu. Callers
   * have already made the save decision; this only stops the world and goes.
   * A host with a timer inside it must not be left ticking through the
   * reload, which is why this runs after (never before) the save settles.
   */
  private leaveToMenu(reloadMs = 700): void {
    this.closePauseMenu();
    this.updateCheck?.stop();
    this.dev.detach();
    this.host?.dispose();
    this.started = false;
    // Fade the live colony layers back to the command-deck bed during the
    // hand-off; a reload creates the same menu scene again on the next page.
    this.audio.setScene('menu');
    this.audio.setPaused(true);
    // A clean boot is the only honest teardown for a WebGL colony: the menu
    // (and its splash) rebuilds in under a second.
    window.setTimeout(() => window.location.reload(), reloadMs);
  }

  // -------------------------------------------------------- pause menu ----

  /**
   * The ☰ button's destination: freeze the sim and open the pause menu. The
   * world keeps *rendering* behind the frost — what stops is the clock, so
   * the player sees the colony they paused, not a blank.
   */
  private openPauseMenu(): void {
    if (!this.started || this.pauseMenu || !this.host) return;
    if (this.hud.isSaveErrorOpen() || this.hud.isSaveProgressOpen()) return;
    this.prePauseSpeed = this.hud.speedIdx;
    this.hud.setSpeed(0);
    this.audio.setPaused(true);
    const menu = new PauseMenu({
      getStats: () => this.buildColonyStats(),
      settings: this.pauseSettings(),
      onResume: () => this.closePauseMenu(),
      onSave: () => this.manualSave(),
      onReturnToMenu: () => this.returnToMenu(),
    });
    menu.mount();
    this.pauseMenu = menu;
  }

  /** Resume: restore the pre-pause speed and unmount. True if it was open. */
  private closePauseMenu(): boolean {
    if (!this.pauseMenu) return false;
    this.pauseMenu.unmount();
    this.pauseMenu = null;
    this.hud.setSpeed(this.prePauseSpeed);
    this.audio.setPaused(this.hud.speedIdx === 0);
    return true;
  }

  /** The pause menu's settings contract: values + live-applying callbacks. */
  private pauseSettings(): import('../ui/PauseMenu').PauseMenuSettings {
    const s = this.settings;
    return {
      autopauseOnCrit: s.autopauseOnCrit(),
      saveOnTabHide: s.saveOnTabHide(),
      autosaveIntervalSec: s.autosaveIntervalSec(),
      renderResolution: s.renderResolution(),
      shadows: s.shadows(),
      weatherFx: s.weatherFx(),
      hudPanelsHidden: s.hudPanelsHidden(),
      onAutopause: (on) => {
        s.setAutopause(on);
        this.hud.setAutopause(on);
      },
      onSaveOnTabHide: (on) => s.setSaveOnTabHide(on),
      onAutosaveInterval: (sec) => {
        s.setAutosaveInterval(sec);
        this.autosaveSec = sec;
        // A shorter interval should not wait out the previous window.
        this.lastAuto = performance.now();
      },
      onRenderResolution: (r) => {
        s.setRenderResolution(r);
        this.applyGraphics();
      },
      onShadows: (on) => {
        s.setShadows(on);
        this.applyGraphics();
      },
      onWeatherFx: (on) => {
        s.setWeatherFx(on);
        this.applyGraphics();
      },
      onHudPanelsHidden: (on) => {
        s.setHudPanelsHidden(on);
        this.hud.setPanelsHidden(on);
      },
      onResetPanelLayout: () => this.hud.resetPanelLayout(),
    };
  }

  /** Push the persisted graphical settings into the live renderer. */
  private applyGraphics(): void {
    const r = this.renderer;
    if (!r) return;
    r.setPixelRatioCap(renderResolutionCap(this.settings.renderResolution()));
    r.setShadows(this.settings.shadows());
    r.weatherFx.setVisible(this.settings.weatherFx());
  }

  /**
   * The expedition tab's data pull: one plain object straight off the host
   * view. Pure read — nothing here may touch a mutator, which is what keeps
   * it honest on the worker transport.
   */
  private buildColonyStats(): ColonyStats | null {
    const sim = this.sim;
    if (!sim) return null;
    const meta = this.saveId ? this.store.get(this.saveId) : null;
    const site = sim.world.landingSite();
    const p = sim.power;
    const cap = sim.storageCapacity();
    const c = sim.colonist;
    const rovers = sim.rovers;
    const stranded = rovers.filter((r) => r.phase === 'disabled').length;
    const idle = sim.idleRovers().length;
    const online = sim.buildings.filter((b) => b.state === 'online').length;
    const building = sim.buildings.filter((b) => b.state === 'building').length;
    const damaged = sim.buildings.filter((b) => b.damaged).length;
    const alerts = sim.alerts.list();
    const wx = sim.weather;
    return {
      name: meta?.name ?? site.name ?? 'Red Frontier',
      clockText: sim.clock.format(),
      difficulty: DIFFICULTIES[sim.difficulty]?.label ?? sim.difficulty,
      worldSize: WORLD_SIZES[worldSizeFromHalf(sim.world.half)]?.label ?? '—',
      region: site?.name ?? '—',
      seedText: meta?.seedText ?? '',
      solsPlayed: sim.simTime / SOL_SECONDS,
      power: {
        genKw: p.generationKw,
        loadKw: p.servedKw,
        batteryPct: p.capacityKWh > 0 ? (p.storedKWh / p.capacityKWh) * 100 : 0,
        curtailKw: p.curtailedKw,
      },
      resources: ALL_RESOURCES.map((r) => ({
        label: RESOURCES[r].label,
        amount: sim.storage[r],
        capacity: cap,
      })),
      fluids: ALL_FLUIDS.map((f) => ({
        label: FLUIDS[f].label,
        amount: sim.pools.amounts[f],
        capacity: sim.pools.capacity[f],
        netPerSol: sim.netRatePerSol(f),
      })),
      crew: {
        name: c.name,
        status: colonistStatusText(c),
        healthPct: c.health,
        suitPct: c.inside ? 100 : (c.suitO2 / SUIT_O2_CAPACITY) * 100,
        inside: c.inside,
      },
      fleet: {
        total: rovers.length,
        working: rovers.length - idle - stranded,
        idle,
        stranded,
        avgBatteryPct:
          rovers.length > 0
            ? (rovers.reduce((s, r) => s + r.battery / ROVERS[r.kind].maxBatteryKWh, 0) /
                rovers.length) *
              100
            : 0,
        avgConditionPct:
          rovers.length > 0 ? rovers.reduce((s, r) => s + r.condition, 0) / rovers.length : 0,
      },
      structures: {
        total: sim.buildings.length,
        online,
        building,
        damaged,
      },
      weather: {
        storm: stormLabel(wx.storm),
        wind: wx.windSpeed,
        dustPct: wx.dust * 100,
        visibilityPct: wx.visibility * 100,
      },
      alerts: {
        crit: alerts.filter((a) => a.severity === 'crit').length,
        warn: alerts.filter((a) => a.severity === 'warn').length,
        opportunity: alerts.filter((a) => a.severity === 'opportunity').length,
      },
      lastSave: { ...this.lastSave },
      gameOver: { active: !!sim.gameOver, reason: sim.gameOver?.reason ?? '' },
    };
  }

  // -------------------------------------------------------- per-frame ----
  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer?.resize(w, h);
  }

  private lastT = 0;

  private loop(nowMs: number): void {
    requestAnimationFrame((t) => this.loop(t));
    const host = this.host;
    if (!this.started || !this.renderer || !host || !this.rig) return;
    const view = host.view;
    const t = nowMs / 1000;
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1; // clamp after a stall rather than fast-forwarding
    if (dt < 0) dt = 0;

    const speed = SPEEDS[this.hud.speedIdx];
    // The host owns the tick now. Stepping is the one call in this loop that a
    // worker host answers differently — and "differently" is all: an in-process
    // host runs the fixed substeps, a worker's own timer does, and this frame
    // simply reads whatever the newest view holds.
    //
    // A paused world still hands the frame over at zero, because the host also
    // runs its runtime overlays there: a developer-mode battery pin has to keep
    // its grip while the player inspects a frozen colony.
    host.step(speed > 0 && !view.gameOver ? dt * speed : 0);

    // Developer-mode modifiers ride on top of the sim, never inside it — which
    // is why they're saved nowhere. They are a host overlay now, so the pin
    // keeps its grip without this loop knowing developer mode exists.
    for (const ev of host.drainEvents()) {
      this.hud.addLog(ev.severity, ev.text, ev.stamp);
      this.audio.event(ev);
    }
    // This lives outside the simulation tick. `loop()` still runs at speed 0,
    // so a paused player hears the frozen wind/storm ambience rather than a
    // dead soundscape.
    this.audio.update(view, speed === 0 || !!view.gameOver);

    this.renderer.sync(view);
    this.rig.update();

    // Autosave cadence is a player setting (pause menu → game); 0 disables it.
    if (this.autosaveSec > 0 && nowMs - this.lastAuto > this.autosaveSec * 1000) {
      this.lastAuto = nowMs;
      this.save(true);
    }

    this.updateGhost();
    this.updateSelectionVisual();
    const renderer = this.renderer;
    this.hud.updateMarkers(view, (x, z) => renderer.project(x, z));
    this.syncUI(false);
    this.renderer.render();

    const over = view.gameOver;
    if (over && !this.endShown) {
      this.endShown = true;
      // A dead colony has no business reloading mid-death — the player
      // returns to the menu, and its badge covers the rest.
      this.updateCheck?.stop();
      this.save(true);
      this.hud.showEnd(
        'MISSION LOST',
        `${over.reason} Sol ${over.sol}. Mars does not negotiate.`,
      );
    }
  }

  private updateGhost(): void {
    if (!this.renderer || !this.sim) return;
    // Over HUD chrome the blueprint ghost hides — the panel owns that pixel.
    if (!this.pendingBuild || !this.mouse.in || this.uiCoversPoint(this.mouse.x, this.mouse.y)) {
      this.renderer.showGhost(null, 0, 0, false);
      return;
    }
    const pt = this.renderer.raycastTerrain(this.mouse.x, this.mouse.y);
    if (!pt) {
      this.renderer.showGhost(null, 0, 0, false);
      return;
    }
    const err = this.sim.canPlace(this.pendingBuild, pt.x, pt.z);
    this.renderer.showGhost(this.pendingBuild, pt.x, pt.z, err === null);
    if (err) this.hud.hint(`<b>Cannot build here</b> — ${err}`);
    else {
      const def = BUILDINGS[this.pendingBuild];
      this.hud.hint(
        `Placing <b>${def.label}</b> — click to site it, Shift+click to place several, Esc to cancel.`,
      );
    }
  }

  private updateSelectionVisual(): void {
    if (!this.renderer || !this.sim) return;
    if (!this.selected) {
      this.renderer.setSelection(null);
      this.renderer.showRoute(null);
      return;
    }
    if (this.selected.type === 'rover') {
      const rv = this.sim.roverById(this.selected.id);
      if (!rv) {
        this.selected = null;
        this.renderer.setSelection(null);
        this.renderer.showRoute(null);
        return;
      }
      this.renderer.setSelection({ x: rv.x, z: rv.z, radius: ROVERS[rv.kind].radius });
      this.renderer.showRoute(this.routePoints(rv));
    } else if (this.selected.type === 'building') {
      const b = this.sim.buildingById(this.selected.id);
      if (!b) {
        this.selected = null;
        this.renderer.setSelection(null);
        this.renderer.showRoute(null);
        return;
      }
      this.renderer.setSelection({ x: b.x, z: b.z, radius: BUILDINGS[b.kind].radius });
      this.renderer.showRoute(null);
    } else {
      const c = this.sim.colonist;
      this.renderer.setSelection({ x: c.x, z: c.z, radius: 2 });
      this.renderer.showRoute(null);
    }
  }

  /**
   * The selected rover's route, as world points: where it is now, where the
   * active task is headed, then every queued task's destination. The renderer
   * just draws the polyline (it never interprets tasks).
   */
  private routePoints(rv: Rover): Array<{ x: number; z: number }> | null {
    if (!this.sim) return null;
    const pts: Array<{ x: number; z: number }> = [{ x: rv.x, z: rv.z }];
    for (const t of [rv.command, ...rv.pending]) {
      let p: { x: number; z: number } | null = null;
      if (t.type === 'moveTo') p = { x: t.x, z: t.z };
      else if (t.type === 'mine') {
        const d = this.sim.world.deposits.find((dp) => dp.id === t.depositId);
        if (d) p = { x: d.x, z: d.z };
      } else if (t.type === 'construct' || t.type === 'clean' || t.type === 'repair') {
        const b = this.sim.buildingById(t.buildingId);
        if (b) p = { x: b.x, z: b.z };
      } else if (t.type === 'recover') {
        const s = this.sim.roverById(t.roverId);
        if (s) p = { x: s.x, z: s.z };
      }
      if (p && Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z) > 1) {
        pts.push(p);
      }
    }
    return pts.length > 1 ? pts : null;
  }

  private syncUI(force: boolean): void {
    if (!this.sim) return;
    const now = performance.now();
    // The HUD patches cached nodes, but there is no value in doing it at 144 Hz.
    if (!force && now - this.lastInspector < 120) return;
    this.lastInspector = now;

    this.hud.updateVitals(this.sim);
    this.hud.updateAlerts(this.sim.alerts.list(), this.sim.alerts);
    this.hud.updateAffordability(this.sim);
    // minimap — cheap, throttled inside HUD by key
    try {
      const cam = this.rig ? { x: this.rig.target.x, z: this.rig.target.z } : null;
      this.hud.updateMinimap(this.sim as any, cam, this.selected as any);
    } catch {}

    if (this.selected) {
      if (this.selected.type === 'rover') {
        const r = this.sim.roverById(this.selected.id);
        if (r) this.hud.showRover(r, this.sim, true);
        else this.selected = null;
      } else if (this.selected.type === 'building') {
        const b = this.sim.buildingById(this.selected.id);
        if (b) this.hud.showBuilding(b, this.sim);
        else this.selected = null;
      } else if (this.selected.type === 'poi') {
        const p = this.sim.poiById(this.selected.id);
        if (p) this.hud.showPoi(p, this.sim, true);
        else this.selected = null;
      } else {
        this.hud.showColonist(this.sim.colonist, this.sim, true);
      }
    }
    if (!this.selected) this.hud.clearInspector();

    // The dev panel reflects live sim state on the same throttled cadence.
    this.devPanel.update();

    if (!this.pendingBuild && force && !this.dev.armedSpawn) this.hud.hint(null);
  }
}
