/**
 * Application shell: owns the frame loop, input, and the wiring between the
 * simulation, the renderer and the HUD.
 *
 * The dependency arrows all point one way. The sim knows nothing about this
 * file; the renderer and HUD only read the sim. Everything the player does
 * arrives here as a gesture and leaves as a *command* on the simulation.
 */

import { Simulation } from '../sim/Simulation';
import type { Rover } from '../sim/Simulation';
import { GameRenderer } from '../render/Renderer';
import type { OverlayMode } from '../render/Renderer';
import { CameraRig } from './CameraRig';
import { HUD } from '../ui/HUD';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import { BUILDINGS, BUILDING_ORDER, ROVERS } from '../sim/defs';
import { DevMode } from '../dev/DevMode';
import type { SpawnSpec } from '../dev/DevMode';
import { DevPanel } from '../dev/DevPanel';
import { SPEEDS, AUTOSAVE_INTERVAL_S, SAVE_VERSION } from '../sim/config';
import { SaveStore } from '../ui/SaveStore';
import { LoadingScreen, nextFrame, delay } from '../ui/LoadingScreen';
import { MainMenu } from '../ui/MainMenu';
import { NewGameWizard } from '../ui/NewGameWizard';
import { LoadGameScreen } from '../ui/LoadGameScreen';
import { WORLD_SIZES, DEFAULT_WORLD_OPTIONS, hashSeed } from '../sim/difficulty';
import type { NewGameConfig } from '../sim/difficulty';

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
}

type Selection =
  | { type: 'rover'; id: number }
  | { type: 'building'; id: number }
  | { type: 'colonist'; id: number }
  | null;

export class Game {
  sim: Simulation | null = null;
  renderer: GameRenderer | null = null;
  rig: CameraRig | null = null;
  hud: HUD;

  /** Developer mode: runtime-only editor state (never reaches the save file). */
  private dev: DevMode;
  private devPanel: DevPanel;

  private store!: SaveStore;
  private saveId: string | null = null;
  private menu: { unmount(): void } | null = null;
  private selected: Selection = null;
  private pendingBuild: BuildingKind | null = null;
  private mouse = { x: -1, y: -1, in: false };
  private pointers = new Map<number, ActivePointer>();
  private pointerCount = 0;
  private pinchLast = 0;
  private midLastX = 0;
  private midLastY = 0;
  private lastAuto = 0;
  private lastInspector = 0;
  private started = false;
  private shiftHeld = false;
  private longPressTimer: number | null = null;
  private endShown = false;

  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.hud = new HUD({
      onSpeed: () => {
        /* HUD owns the speed index; the loop reads it */
      },
      onPickBuild: (k) => this.setPendingBuild(k),
      onAction: (a, arg) => this.handleAction(a, arg),
      onStart: (seedText, near) => this.quickStart(seedText, near),
      onOverlay: (m) => this.renderer?.setOverlay(m),
      onMenu: () => this.returnToMenu(),
      onDev: () => this.toggleDevMode(),
    });
    this.dev = new DevMode((sev, text) => this.hud.addLog(sev, text));
    this.devPanel = new DevPanel(this.dev, {
      getSim: () => this.sim,
      getSelection: () => this.selected,
      select: (sel) => {
        this.selected = sel;
        this.syncUI(true);
      },
      getSpawnPoint: () =>
        this.rig ? { x: this.rig.target.x, z: this.rig.target.z } : { x: 0, z: 0 },
      armSpawn: (spec) => this.setArmedSpawn(spec),
      setHint: (t) => this.hud.hint(t),
      onClose: () => this.toggleDevMode(false),
    });
    this.store = new SaveStore();
    // The mission menu owns the pre-game screen; the HUD owns everything after.
    this.hud.hideStartOverlay();
    this.attachInput();
    window.addEventListener('resize', () => this.resize());

    // Persist on tab hide — TDD §23 asks for saves on visibility transitions.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.started) this.save(true);
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
      const sim = new Simulation({
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
      this.launch(sim);
      loader.setActiveStep(3);
      loader.setProgress(0.87, 'Deploying rovers…');
      await nextFrame();

      this.renderer?.sync(sim);
      this.renderer?.render();
      this.saveId = this.store.create(
        {
          name: config.saveName,
          difficulty: config.difficulty,
          worldSize: config.worldSize,
          region: config.region,
          seedText: config.seedText,
        },
        sim.snapshot(),
        1,
      );
      loader.markAllDone();
      loader.setProgress(1, 'Touchdown confirmed.');
      await delay(340);

      const site = sim.world.landingSite();
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
      const data = record.data as { seed?: number };
      const sim = new Simulation({ seed: data?.seed ?? 1 });
      loader.setActiveStep(1);
      loader.setProgress(0.32, 'Restoring terrain and deposits…');
      await nextFrame();
      sim.restore(record.data);
      loader.setActiveStep(2);
      loader.setProgress(0.68, 'Rebuilding terrain mesh…');
      await nextFrame();
      this.launch(sim);
      this.saveId = meta.id;
      loader.setActiveStep(3);
      loader.setProgress(0.9, `Resuming Sol ${sim.clock.sol + 1}…`);
      await nextFrame();
      this.renderer?.sync(sim);
      this.renderer?.render();
      loader.markAllDone();
      loader.setProgress(1, 'Welcome back, Commander.');
      await delay(320);
      this.hud.addLog('ok', `Save restored — ${sim.clock.format()}.`);
    } catch (err) {
      console.error(err);
      loader.setProgress(1, `Could not restore that save (${(err as Error).message}).`);
      await delay(2200);
      this.showMainMenu();
    } finally {
      loader.unmount();
    }
  }

  private launch(sim: Simulation): void {
    this.sim = sim;
    this.selected = null;
    this.pendingBuild = null;
    this.endShown = false;
    // A fresh colony starts clean: dev mode off, no armed spawns, no pins.
    this.dev.disable();
    this.devPanel.setVisible(false);
    this.devPanel.setArmed(null);
    this.hud.setDevActive(false);
    this.hud.setBuild(null);
    this.lastAuto = performance.now();
    this.renderer = new GameRenderer(this.canvas, sim.world);
    this.renderer.setOverlay(this.hud.overlay as OverlayMode);
    this.rig = new CameraRig(this.renderer.camera, sim.world.half);
    this.resize();
    this.hud.updateVitals(sim);
    this.syncUI(true);
    this.started = true;
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
    this.pinchLast = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    this.midLastX = (arr[0].x + arr[1].x) / 2;
    this.midLastY = (arr[0].y + arr[1].y) / 2;
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

    if (this.pointerCount === 1) {
      if (p.travel < DRAG_START) return; // still possibly a tap
      p.dragging = true;
      if (this.shiftHeld) this.rig.panByPixels(dx, dy, window.innerHeight);
      else this.rig.rotateByPixels(dx, dy, window.innerWidth, window.innerHeight);
    } else if (this.pointerCount === 2) {
      const arr = [...this.pointers.values()];
      const a = arr[0];
      const b = arr[1];
      a.dragging = true;
      b.dragging = true;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (this.pinchLast > 0) this.rig.dolly(this.pinchLast / Math.max(1, dist));
      this.rig.panByPixels(midX - this.midLastX, midY - this.midLastY, window.innerHeight);
      this.pinchLast = dist;
      this.midLastX = midX;
      this.midLastY = midY;
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

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      this.save();
      return;
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      this.toggleDevMode();
      return;
    }
    if (e.key === 'Escape') {
      if (this.hud.closeAlertHistory() || this.hud.closeBuildInfo()) return;
      if (this.dev.armedSpawn) {
        this.setArmedSpawn(null);
        return;
      }
      if (this.pendingBuild) this.setPendingBuild(null);
      else this.selected = null;
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      this.hud.setSpeed(this.hud.speedIdx === 0 ? 1 : 0);
      return;
    }
    if (key === 'v') {
      this.renderer?.setOverlay(this.hud.cycleOverlay() as OverlayMode);
      return;
    }
    if (key === 'f') {
      this.centerOnSelected();
      return;
    }
    if (key === 'h') {
      this.hud.openAlertHistory();
      return;
    }
    if (key === '.') {
      this.cycleIdle();
      this.syncUI(true);
      return;
    }
    // Number keys select build blueprints in palette order.
    const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
    if (idx >= 0 && idx < BUILDING_ORDER.length) {
      const kind = BUILDING_ORDER[idx];
      this.setPendingBuild(this.pendingBuild === kind ? null : kind);
    }
  }

  // ---------------------------------------------------------- gestures ----
  private contextTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.pendingBuild) {
      this.setPendingBuild(null);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.sim.issueMove(this.selected.id, pt.x, pt.z, this.shiftHeld);
    } else if (this.selected?.type === 'colonist') {
      this.sim.orderColonist({ type: 'moveTo', x: pt.x, z: pt.z });
    } else if (this.selected?.type === 'building') {
      // Right-clicking empty ground with a structure selected clears it.
      this.selected = null;
      this.syncUI(true);
    }
  }

  private primaryTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.pendingBuild) {
      this.placeBuild(x, y);
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
      if (pick.type === 'rover') {
        // With a rover selected, tapping a stranded one dispatches a rescue —
        // the same grammar as deposit → mine (P4's RECOVER task).
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const target = this.sim.roverById(pick.id);
        if (rv && target && target.id !== rv.id && target.phase === 'disabled') {
          this.sim.issueRecover(rv.id, target.id, this.shiftHeld);
        } else if (this.selected?.type === 'rover' && this.selected.id === pick.id) {
          // Tapping the selected rover again deselects it.
          this.selected = null;
        } else {
          this.selected = { type: 'rover', id: pick.id };
        }
      } else if (pick.type === 'building') {
        // With a rover selected, tapping a battered or buried structure sends
        // the rover to service it — the same grammar as deposit → mine.
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const job = this.sim.needsMaintenance(pick.id);
        if (rv && job) {
          if (job === 'repair') this.sim.issueRepair(rv.id, pick.id, this.shiftHeld);
          else this.sim.issueClean(rv.id, pick.id, this.shiftHeld);
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
      } else if (pick.type === 'deposit') {
        if (this.selected?.type === 'rover') {
          this.sim.issueMine(this.selected.id, pick.id, this.shiftHeld);
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
      this.sim.issueMove(this.selected.id, pt.x, pt.z, this.shiftHeld);
    } else if (this.selected) {
      // Tapping empty ground with a structure or the colonist selected
      // clears the selection (a rover instead takes it as a move order).
      this.selected = null;
      this.syncUI(true);
    }
  }

  private setPendingBuild(kind: BuildingKind | null): void {
    this.pendingBuild = kind;
    this.hud.setBuild(kind);
    if (!kind) this.renderer?.showGhost(null, 0, 0, false);
    this.syncUI(true);
  }

  private placeBuild(x: number, y: number): void {
    if (!this.renderer || !this.sim || !this.pendingBuild) return;
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    const b = this.sim.placeBuilding(this.pendingBuild, pt.x, pt.z);
    if (b) {
      this.selected = { type: 'building', id: b.id };
      // Shift-place keeps the blueprint armed for laying out solar farms.
      if (!this.shiftHeld) this.setPendingBuild(null);
    }
  }

  // ------------------------------------------------------- developer mode ----

  /**
   * Flip the developer panel and every live modifier it carries. Nothing the
   * panel does is persisted — the mode itself lives outside the sim, and its
   * upgrade levels are runtime-only by sim design.
   */
  private toggleDevMode(force?: boolean): void {
    if (!this.started) return;
    const on = force ?? !this.dev.enabled;
    const changed = on !== this.dev.enabled;
    if (on) {
      this.dev.enabled = true;
    } else {
      // Every modifier stops dead: pins released, any armed spawn disarmed.
      this.setArmedSpawn(null);
      this.dev.disable();
    }
    this.devPanel.setVisible(on);
    this.hud.setDevActive(on);
    if (changed) {
      this.hud.addLog(
        'info',
        on
          ? '🛠 Developer mode ON — world edits are live and stay out of the save file.'
          : '🛠 Developer mode OFF — modifiers released.',
      );
    }
    this.syncUI(true);
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
      const id = this.dev.spawnRover(this.sim, spec.kind as RoverKind, x, z);
      this.selected = { type: 'rover', id };
      this.devPanel.setStatus(`${ROVERS[spec.kind as RoverKind].label} #${id} fabricated`);
    } else if (spec.type === 'building') {
      const id = this.dev.spawnBuilding(this.sim, spec.kind as BuildingKind, x, z);
      if (id !== null) {
        this.selected = { type: 'building', id };
        this.devPanel.setStatus(`${BUILDINGS[spec.kind as BuildingKind].label} #${id} fabricated online`);
      } else {
        this.devPanel.setStatus('Cannot fabricate there — see the colony log for why');
      }
    } else {
      this.dev.spawnDeposit(this.sim, spec.kind as ResourceId, x, z, spec.amountKg ?? 2500);
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
        if (this.selected.type === 'rover') this.sim.stopRover(this.selected.id);
        break;
      case 'unload':
        if (this.selected.type === 'rover')
          this.sim.issueUnload(this.selected.id, this.shiftHeld);
        break;
      case 'wait':
        if (this.selected.type === 'rover')
          this.sim.issueWait(this.selected.id, Number(arg) || 60, true);
        break;
      case 'recenter':
        this.centerOnSelected();
        break;
      case 'repeathaul':
        if (this.selected.type === 'rover') {
          const rv = this.sim.roverById(this.selected.id);
          this.sim.setRepeatRoute(this.selected.id, !(rv?.command.type === 'mine' && rv.command.repeat));
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
          this.sim.setRoverRule(this.selected.id, rule, arg === 1);
        }
        break;
      case 'rule-charge':
        if (this.selected.type === 'rover' && typeof arg === 'number') {
          this.sim.setChargeFloor(this.selected.id, arg);
        }
        break;
      case 'rule-lights':
        if (this.selected.type === 'rover') {
          this.sim.setRoverLights(this.selected.id, arg === 1);
        }
        break;
      case 'toggle':
        if (this.selected.type === 'building') {
          const b = this.sim.buildingById(this.selected.id);
          if (b) this.sim.setBuildingEnabled(b.id, !b.enabled);
        }
        break;
      case 'demolish':
        if (this.selected.type === 'building') {
          this.sim.demolish(this.selected.id);
          this.selected = null;
        }
        break;
      case 'shelter':
        this.sim.orderColonist({ type: 'shelter' });
        break;
      case 'service':
        if (this.selected.type === 'building') {
          this.sim.dispatchMaintenance(this.selected.id);
        }
        break;
      case 'assemble':
        if (this.selected.type === 'building' && typeof arg === 'string') {
          this.sim.assembleRover(this.selected.id, arg as RoverKind);
        }
        break;
    }
    this.syncUI(true);
  }

  /** Jump to the next rover with nothing to do (`.` hotkey + HUD button). */
  private idleCycleIdx = 0;
  private cycleIdle(): void {
    if (!this.sim) return;
    const idle = this.sim.idleRovers();
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

  private save(quiet = false): void {
    if (!this.sim || !this.saveId) return;
    try {
      this.store.update(this.saveId, this.sim.snapshot(), this.sim.clock.sol + 1);
      if (!quiet) this.hud.flashSave(`Saved · ${this.sim.clock.format()}`);
    } catch (e) {
      // Quota is the realistic failure here; say so rather than failing silently.
      this.hud.flashSave('Save failed — browser storage full?');
      console.error(e);
    }
  }

  /** Persist the colony and hand control back to the main menu. */
  private returnToMenu(): void {
    if (!this.started) return;
    this.save(true);
    this.hud.flashSave('Saved — returning to menu…');
    // A clean boot is the only honest teardown for a WebGL colony: the menu
    // (and its splash) rebuilds in under a second.
    window.setTimeout(() => window.location.reload(), 700);
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
    if (!this.started || !this.renderer || !this.sim || !this.rig) return;
    const t = nowMs / 1000;
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1; // clamp after a stall rather than fast-forwarding
    if (dt < 0) dt = 0;

    const speed = SPEEDS[this.hud.speedIdx];
    if (speed > 0 && !this.sim.gameOver) this.sim.step(dt * speed);

    // Developer-mode modifiers ride on top of the sim, never inside it —
    // which is why they're saved nowhere.
    this.dev.applyTo(this.sim);

    for (const ev of this.sim.drainEvents()) {
      this.hud.addLog(ev.severity, ev.text, ev.stamp);
    }

    this.renderer.sync(this.sim);
    this.rig.update();

    if (nowMs - this.lastAuto > AUTOSAVE_INTERVAL_S * 1000) {
      this.lastAuto = nowMs;
      this.save(true);
    }

    this.updateGhost();
    this.updateSelectionVisual();
    const renderer = this.renderer;
    this.hud.updateMarkers(this.sim, (x, z) => renderer.project(x, z));
    this.syncUI(false);
    this.renderer.render();

    if (this.sim.gameOver && !this.endShown) {
      this.endShown = true;
      this.save(true);
      this.hud.showEnd(
        'MISSION LOST',
        `${this.sim.gameOver.reason} Sol ${this.sim.gameOver.sol}. Mars does not negotiate.`,
      );
    }
  }

  private updateGhost(): void {
    if (!this.renderer || !this.sim) return;
    if (!this.pendingBuild || !this.mouse.in) {
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

    if (this.selected) {
      if (this.selected.type === 'rover') {
        const r = this.sim.roverById(this.selected.id);
        if (r) this.hud.showRover(r, this.sim);
        else this.selected = null;
      } else if (this.selected.type === 'building') {
        const b = this.sim.buildingById(this.selected.id);
        if (b) this.hud.showBuilding(b, this.sim);
        else this.selected = null;
      } else {
        this.hud.showColonist(this.sim.colonist, this.sim);
      }
    }
    if (!this.selected) this.hud.clearInspector();

    // The dev panel reflects live sim state on the same throttled cadence.
    this.devPanel.update();

    if (!this.pendingBuild && force && !this.dev.armedSpawn) this.hud.hint(null);
  }
}
