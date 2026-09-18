/**
 * Phase 19 — pause menu open/close, settings contract, colony expedition stats.
 * Move-not-redesign from Game.ts.
 */

import { colonistStatusText } from '../sim/Simulation';
import type { SimView } from '../sim/host';
import { SOL_SECONDS, SUIT_O2_CAPACITY } from '../sim/config';
import { ALL_RESOURCES, ALL_FLUIDS, RESOURCES, FLUIDS, ROVERS } from '../sim/defs';
import { WORLD_SIZES, DIFFICULTIES } from '../sim/difficulty';
import { stormLabel } from '../sim/weather';
import { PauseMenu, type ColonyStats, type PauseMenuSettings } from '../ui/PauseMenu';
import type { GameSettings } from '../ui/Settings';
import { renderResolutionCap } from '../ui/Settings';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import type { GameRenderer } from '../render/Renderer';
import type { SaveStore } from '../ui/SaveStore';
import { worldSizeFromHalf } from './SaveController';

export interface MenuControllerDeps {
  getStarted: () => boolean;
  getHost: () => unknown;
  getSim: () => SimView | null;
  getRenderer: () => GameRenderer | null;
  getSaveId: () => string | null;
  getStore: () => SaveStore;
  getLastSave: () => { at: number | null; ok: boolean | null };
  setAutosaveSec: (sec: number) => void;
  /** Reset the autosave window when the interval shortens. */
  bumpLastAuto: () => void;
  hud: HUD;
  audio: AudioSystem;
  settings: GameSettings;
  manualSave: () => void;
  returnToMenu: () => void;
}

export class MenuController {
  /** The in-game pause menu, while open. */
  pauseMenu: PauseMenu | null = null;
  /** The speed to restore when the pause menu closes. */
  prePauseSpeed = 1;

  constructor(private readonly d: MenuControllerDeps) {}

  /**
   * The ☰ button's destination: freeze the sim and open the pause menu. The
   * world keeps *rendering* behind the frost — what stops is the clock, so
   * the player sees the colony they paused, not a blank.
   */
  openPauseMenu(): void {
    if (!this.d.getStarted() || this.pauseMenu || !this.d.getHost()) return;
    // The update card already owns the frozen colony; a second overlay on top
    // of it would be two menus fighting for the same player.
    if (
      this.d.hud.isSaveErrorOpen() ||
      this.d.hud.isSaveProgressOpen() ||
      this.d.hud.isUpdateNoticeOpen()
    )
      return;
    this.prePauseSpeed = this.d.hud.speedIdx;
    this.d.hud.setSpeed(0);
    this.d.audio.setPaused(true);
    const menu = new PauseMenu({
      getStats: () => this.buildColonyStats(),
      settings: this.pauseSettings(),
      onResume: () => this.closePauseMenu(),
      onSave: () => this.d.manualSave(),
      onReturnToMenu: () => this.d.returnToMenu(),
    });
    menu.mount();
    this.pauseMenu = menu;
  }

  /** Resume: restore the pre-pause speed and unmount. True if it was open. */
  closePauseMenu(): boolean {
    if (!this.pauseMenu) return false;
    this.pauseMenu.unmount();
    this.pauseMenu = null;
    this.d.hud.setSpeed(this.prePauseSpeed);
    this.d.audio.setPaused(this.d.hud.speedIdx === 0);
    return true;
  }

  /** The pause menu's settings contract: values + live-applying callbacks. */
  pauseSettings(): PauseMenuSettings {
    const s = this.d.settings;
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
        this.d.hud.setAutopause(on);
      },
      onSaveOnTabHide: (on) => s.setSaveOnTabHide(on),
      onAutosaveInterval: (sec) => {
        s.setAutosaveInterval(sec);
        this.d.setAutosaveSec(sec);
        // A shorter interval should not wait out the previous window.
        this.d.bumpLastAuto();
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
        this.d.hud.setPanelsHidden(on);
      },
      onResetPanelLayout: () => this.d.hud.resetPanelLayout(),
    };
  }

  /** Push the persisted graphical settings into the live renderer. */
  applyGraphics(): void {
    const r = this.d.getRenderer();
    if (!r) return;
    r.setPixelRatioCap(renderResolutionCap(this.d.settings.renderResolution()));
    r.setShadows(this.d.settings.shadows());
    r.weatherFx.setVisible(this.d.settings.weatherFx());
  }

  /**
   * The expedition tab's data pull: one plain object straight off the host
   * view. Pure read — nothing here may touch a mutator, which is what keeps
   * it honest on the worker transport.
   */
  buildColonyStats(): ColonyStats | null {
    const sim = this.d.getSim();
    if (!sim) return null;
    const saveId = this.d.getSaveId();
    const meta = saveId ? this.d.getStore().get(saveId) : null;
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
      lastSave: { ...this.d.getLastSave() },
      gameOver: { active: !!sim.gameOver, reason: sim.gameOver?.reason ?? '' },
    };
  }
}
