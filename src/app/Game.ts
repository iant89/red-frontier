/**
 * Application shell — Phase 19 composition root.
 *
 * Owns lifecycle (main menu / new game / load / launch), developer mode, and
 * the wiring between controllers, the simulation host, the renderer and the HUD.
 *
 * Controllers own their former Game responsibilities:
 *   GameLoop, InputController, SelectionController, BuildController,
 *   SaveController, MenuController, UpdateController.
 *
 * The dependency arrows still point one way. The simulation knows nothing about
 * this file, and this file knows nothing about the simulation: it holds a
 * {@link SimHost}, reads it through a {@link SimView}, and changes it only by
 * sending a {@link SimCommand}. Everything the player does arrives here as a
 * gesture and leaves as a message. Which host is on the other end — this thread
 * or a worker — is not this file's business (TDD §16).
 */

import { EngineeringController } from './EngineeringController';
import type { SimHost, SimView } from '../sim/host';
import { createHost, planHost, restoreHost } from '../sim/host';
import { GameRenderer } from '../render/Renderer';
import type { OverlayMode } from '../render/Renderer';
import { CameraRig } from './CameraRig';
import { HUD } from '../ui/HUD';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import { BUILDINGS, ROVERS } from '../sim/defs';
import { DevMode } from '../dev/DevMode';
import type { SpawnSpec } from '../dev/DevMode';
import { DevPanel } from '../dev/DevPanel';
import { SAVE_VERSION } from '../sim/config';
import { SaveStore } from '../ui/SaveStore';
import { LoadingScreen, nextFrame, delay } from '../ui/LoadingScreen';
import { MainMenu } from '../ui/MainMenu';
import { NewGameWizard } from '../ui/NewGameWizard';
import { LoadGameScreen } from '../ui/LoadGameScreen';
import { GameSettings } from '../ui/Settings';
import { WORLD_SIZES, DEFAULT_WORLD_OPTIONS, hashSeed } from '../sim/difficulty';
import type { NewGameConfig } from '../sim/difficulty';
import { AudioSystem } from '../audio/AudioSystem';
import { getProfiler, resetProfiler, setProfilerEnabled } from '../sim/debug/Profiler';

import { GameLoop } from './GameLoop';
import { InputController } from './InputController';
import { SelectionController, type Selection } from './SelectionController';
import { BuildController } from './BuildController';
import { SaveController } from './SaveController';
import { MenuController } from './MenuController';
import { UpdateController } from './UpdateController';
import { TutorialPanel } from '../ui/TutorialPanel';

void SAVE_VERSION;

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
  private menu: { unmount(): void } | null = null;

  private lastAuto = 0;
  private lastInspector = 0;
  private started = false;
  private endShown = false;

  private canvas: HTMLCanvasElement;

  // ------------------------------------------------------- controllers ----
  private readonly loopCtrl: GameLoop;
  private readonly inputCtrl: InputController;
  private readonly selectionCtrl: SelectionController;
  private readonly buildCtrl: BuildController;
  private readonly saveCtrl: SaveController;
  private readonly menuCtrl: MenuController;
  private readonly engineeringCtrl: EngineeringController;
  private readonly updateCtrl: UpdateController;
  private readonly tutorialPanel: TutorialPanel;

  // ---- smoke / test field aliases (same names as pre-Phase-19 Game) ----
  /** @internal pause-smoke / pause-save read this */
  get saveContext(): 'auto' | 'manual' | 'menu' | 'update' {
    return this.saveCtrl.saveContext;
  }
  set saveContext(v: 'auto' | 'manual' | 'menu' | 'update') {
    this.saveCtrl.saveContext = v;
  }
  get saveInFlight(): boolean {
    return this.saveCtrl.saveInFlight;
  }
  get lastSave(): { at: number | null; ok: boolean | null } {
    return this.saveCtrl.lastSave;
  }
  get autosaveSec(): number {
    return this.saveCtrl.autosaveSec;
  }
  set autosaveSec(v: number) {
    this.saveCtrl.autosaveSec = v;
  }
  get pauseMenu() {
    return this.menuCtrl.pauseMenu;
  }
  /** Selection mirror for DevPanel / syncUI (owned by SelectionController). */
  private get selected(): Selection {
    return this.selectionCtrl.selected;
  }
  private set selected(sel: Selection) {
    this.selectionCtrl.selected = sel;
  }
  private get pendingBuild(): BuildingKind | null {
    return this.buildCtrl.pendingBuild;
  }
  private get shiftHeld(): boolean {
    return this.inputCtrl.shiftHeld;
  }

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

    // Shared HUD bag: controllers close over the bag; HUD is filled before any
    // method runs. Circular controller deps via arrows are safe the same way.
    const hudBag: { hud: HUD } = { hud: null as unknown as HUD };

    this.saveCtrl = new SaveController({
      getHost: () => this.host,
      getSim: () => this.sim,
      getSaveId: () => this.saveId,
      setSaveId: (id) => {
        this.saveId = id;
      },
      getStore: () => this.store,
      getStarted: () => this.started,
      setStarted: (v) => {
        this.started = v;
      },
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      closePauseMenu: () => this.menuCtrl.closePauseMenu(),
      getUpdateCheck: () => this.updateCtrl.updateCheck,
      detachDev: () => this.dev.detach(),
      disposeHost: () => {
        this.host?.dispose();
      },
    });

    this.menuCtrl = new MenuController({
      getStarted: () => this.started,
      getHost: () => this.host,
      getSim: () => this.sim,
      getRenderer: () => this.renderer,
      getSaveId: () => this.saveId,
      getStore: () => this.store,
      getLastSave: () => this.saveCtrl.lastSave,
      setAutosaveSec: (sec) => {
        this.saveCtrl.autosaveSec = sec;
      },
      bumpLastAuto: () => {
        this.lastAuto = performance.now();
      },
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      settings: this.settings,
      manualSave: () => this.saveCtrl.manualSave(),
      returnToMenu: () => this.saveCtrl.returnToMenu(),
    });

    this.updateCtrl = new UpdateController({
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      isSaveInFlight: () => this.saveCtrl.saveInFlight,
      setSaveContext: (ctx) => {
        this.saveCtrl.saveContext = ctx;
      },
      save: (quiet, onDone) => this.saveCtrl.save(quiet, onDone),
      leaveToMenu: (ms) => this.saveCtrl.leaveToMenu(ms),
    });

    this.buildCtrl = new BuildController({
      getHost: () => this.host,
      getSim: () => this.sim,
      getRenderer: () => this.renderer,
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      isShiftHeld: () => this.inputCtrl.shiftHeld,
      uiCoversPoint: (x, y) => this.inputCtrl.uiCoversPoint(x, y),
      getMouse: () => this.inputCtrl.mouse,
      setSelected: (sel) => {
        this.selectionCtrl.selected = sel;
      },
      syncUI: (force) => this.syncUI(force),
    });

    this.engineeringCtrl = new EngineeringController({
      getHost: () => this.host, getSim: () => this.sim, getRenderer: () => this.renderer,
      get hud() { return hudBag.hud; },
      blocked: () => !!this.menuCtrl.pauseMenu || hudBag.hud.isSaveProgressOpen() || hudBag.hud.isSaveErrorOpen() || hudBag.hud.isUpdateNoticeOpen(),
      action: (a, arg) => this.selectionCtrl.handleAction(a, arg),
    });

    this.selectionCtrl = new SelectionController({
      getHost: () => this.host,
      getSim: () => this.sim,
      getRenderer: () => this.renderer,
      getRig: () => this.rig,
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      isShiftHeld: () => this.inputCtrl.shiftHeld,
      uiCoversPoint: (x, y) => this.inputCtrl.uiCoversPoint(x, y),
      getPendingBuild: () => this.buildCtrl.pendingBuild,
      setPendingBuild: (k) => this.buildCtrl.setPendingBuild(k),
      placeBuild: (x, y) => this.buildCtrl.placeBuild(x, y),
      openEngineering: (target) => this.engineeringCtrl.open(target),
      hasArmedSpawn: () => !!this.dev.armedSpawn,
      placeDevSpawn: (x, z) => this.placeDevSpawn(x, z),
      syncUI: (force) => this.syncUI(force),
    });

    this.inputCtrl = new InputController({
      canvas: this.canvas,
      getStarted: () => this.started,
      getRig: () => this.rig,
      getRenderer: () => this.renderer,
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      isPauseMenuOpen: () => !!this.menuCtrl.pauseMenu,
      isEngineeringOpen: () => this.engineeringCtrl.isOpen,
      closePauseMenu: () => this.menuCtrl.closePauseMenu(),
      isSaveInFlight: () => this.saveCtrl.saveInFlight,
      updateNoticeLater: () => this.updateCtrl.updateNoticeLater(),
      manualSave: () => this.manualSave(),
      toggleDevPanel: () => this.toggleDevPanel(),
      hasArmedSpawn: () => !!this.dev.armedSpawn,
      clearArmedSpawn: () => this.setArmedSpawn(null),
      getPendingBuild: () => this.buildCtrl.pendingBuild,
      setPendingBuild: (k) => this.buildCtrl.setPendingBuild(k),
      setSelected: (sel) => {
        this.selectionCtrl.selected = sel;
      },
      primaryTap: (x, y) => this.selectionCtrl.primaryTap(x, y),
      contextTap: (x, y) => this.selectionCtrl.contextTap(x, y),
      centerOnSelected: () => this.selectionCtrl.centerOnSelected(),
      cycleIdle: () => this.selectionCtrl.cycleIdle(),
      syncUI: (force) => this.syncUI(force),
    });

    this.loopCtrl = new GameLoop({
      canvas: this.canvas,
      getStarted: () => this.started,
      getHost: () => this.host,
      getRenderer: () => this.renderer,
      getRig: () => this.rig,
      get hud() {
        return hudBag.hud;
      },
      audio: this.audio,
      getAutosaveSec: () => this.saveCtrl.autosaveSec,
      getLastAuto: () => this.lastAuto,
      setLastAuto: (ms) => {
        this.lastAuto = ms;
      },
      saveQuiet: () => this.saveCtrl.save(true),
      updateGhost: () => this.buildCtrl.updateGhost(),
      updateSelectionVisual: () => this.selectionCtrl.updateSelectionVisual(),
      syncUI: (force) => this.syncUI(force),
      getUpdateCheck: () => this.updateCtrl.updateCheck,
      isEndShown: () => this.endShown,
      setEndShown: (v) => {
        this.endShown = v;
      },
    });

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
      onSaveProgress: (open, saved) => this.menuCtrl.onSaveProgress(open, saved),
      onSaveRetry: () => this.retrySave(),
      onSaveAsNew: () => this.saveAsNew(),
      onSaveDismiss: () => this.hud.hideSaveError(),
      onSaveAbandon: () => this.abandonToMenu(),
      // The update card's actions — all of them the player's, none automatic.
      onUpdateSave: () => this.updateNoticeSave(),
      onUpdateReload: () => this.updateNoticeReload(),
      onUpdateLater: () => this.updateNoticeLater(),
    });

    hudBag.hud = this.hud;

    this.tutorialPanel = new TutorialPanel({
      onDismissHint: (hintId) => {
        this.host?.send({ type: 'tutorial/dismiss', hintId } as any);
      },
      onAction: (a, arg) => this.handleAction(a, arg),
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
    this.engineeringCtrl.close(false);
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
    this.selectionCtrl.reset();
    this.buildCtrl.reset();
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
    this.saveCtrl.resetForLaunch(this.settings.autosaveIntervalSec());
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
    this.tutorialPanel.update(host.view);
    this.syncUI(true);
    this.started = true;
    // In production builds, watch for a newer deploy while playing (TDD §23).
    // Dev mode is out: the dev server ships no manifest and HMR already
    // keeps the page current.
    this.updateCtrl.start();
    this.audio.setScene('game');
    this.audio.setPaused(this.hud.speedIdx === 0);
    this.audio.update(host.view, this.hud.speedIdx === 0 || !!host.view.gameOver);
    this.audio.missionStarted();
  }

  // ---- thin delegates (preserve private method surface for pause-save pins) ----

  private attachInput(): void {
    this.inputCtrl.attachInput();
  }

  private setPendingBuild(kind: BuildingKind | null): void {
    this.buildCtrl.setPendingBuild(kind);
  }

  private handleAction(a: string, arg?: number | string): void {
    this.selectionCtrl.handleAction(a, arg);
  }

  private save(quiet = false, onDone?: (ok: boolean, stamp: string) => void): void {
    this.saveCtrl.save(quiet, onDone);
  }

  private manualSave(): void {
    this.menuCtrl.manualSave();
  }

  private retrySave(): void {
    this.saveCtrl.retrySave();
  }

  private saveAsNew(): void {
    this.saveCtrl.saveAsNew();
  }

  private abandonToMenu(): void {
    this.saveCtrl.abandonToMenu();
  }

  private onNewBuild(found: import('./UpdateCheck').UpdateFound): void {
    this.updateCtrl.onNewBuild(found);
  }

  private updateNoticeSave(): void {
    this.updateCtrl.updateNoticeSave();
  }

  private updateNoticeReload(): void {
    this.updateCtrl.updateNoticeReload();
  }

  private updateNoticeLater(): void {
    this.updateCtrl.updateNoticeLater();
  }

  private returnToMenu(): void {
    this.saveCtrl.returnToMenu();
  }

  private openPauseMenu(): void {
    this.engineeringCtrl.close();
    this.menuCtrl.openPauseMenu();
  }

  private closePauseMenu(): boolean {
    return this.menuCtrl.closePauseMenu();
  }

  private pauseSettings(): import('../ui/PauseMenu').PauseMenuSettings {
    return this.menuCtrl.pauseSettings();
  }

  private applyGraphics(): void {
    this.menuCtrl.applyGraphics();
  }

  private buildColonyStats(): import('../ui/PauseMenu').ColonyStats | null {
    return this.menuCtrl.buildColonyStats();
  }

  private resize(): void {
    this.loopCtrl.resize();
  }

  private loop(nowMs: number): void {
    this.loopCtrl.loop(nowMs);
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
      this.buildCtrl.pendingBuild = null;
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
        this.devPanel.setStatus(
          `${BUILDINGS[spec.kind as BuildingKind].label} #${id} fabricated online`,
        );
      } else {
        this.devPanel.setStatus('Cannot fabricate there — see the colony log for why');
      }
    } else {
      const depId = this.dev.spawnDeposit(spec.kind as ResourceId, x, z, spec.amountKg ?? 2500);
      this.devPanel.setStatus(
        depId >= 0
          ? `${spec.kind} deposit surveyed in — ${Math.round(spec.amountKg ?? 2500)} kg`
          : `${spec.kind} is refined, not mined — spawn an ore seam instead`,
      );
    }
    // Shift-place keeps the spawn armed, exactly like the build palette.
    if (!this.shiftHeld) this.setArmedSpawn(null);
    this.syncUI(true);
  }

  private syncUI(force: boolean): void {
    if (!this.sim) return;
    this.engineeringCtrl.update();
    const now = performance.now();
    // The HUD patches cached nodes, but there is no value in doing it at 144 Hz.
    if (!force && now - this.lastInspector < 120) return;
    this.lastInspector = now;

    this.hud.updateVitals(this.sim);
    this.hud.updateAlerts(this.sim.alerts.list(), this.sim.alerts);
    this.hud.updateAffordability(this.sim);
    this.tutorialPanel.update(this.sim);
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
        if (b) this.hud.showBuilding(b, this.sim, true);
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
