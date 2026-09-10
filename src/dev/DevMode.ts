/**
 * Developer mode: the runtime *state* of the developer panel.
 *
 * Deliberately **not** part of the Simulation: nothing here is feedable into
 * snapshot(), so the mode can never leak into a save file. The world edits it
 * performs go through the sim's ordinary state — a fabricated rover is a
 * real rover — but the mode's own switches (the on/off flag, the
 * keep-battery-full list) evaporate when the mode is switched off, the
 * mission ends, or the tab closes.
 *
 * The Game owns one instance for the lifetime of the page.
 */

import type { Simulation } from '../sim/Simulation';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import { ROVERS, RESOURCES } from '../sim/defs';
import type { StormKindReal } from '../sim/weather';
import {
  DAMAGED_HEALTH,
  REPAIR_RESTART_HEALTH,
  SUIT_O2_CAPACITY,
} from '../sim/config';

/** What the panel is currently asking us to drop on the next terrain tap. */
export interface SpawnSpec {
  type: 'rover' | 'building' | 'deposit';
  /** RoverKind | BuildingKind | ResourceId, according to `type`. */
  kind: string;
  /** Deposits only: how much ore to survey in. */
  amountKg?: number;
}

export type DevLog = (severity: string, text: string) => void;

export class DevMode {
  /** Master switch. When false, {@link applyTo} does nothing at all. */
  enabled = false;

  /** Rovers whose batteries must stay pinned at full while the mode is on. */
  private keepBatteryFull = new Set<number>();

  /** The spawn the panel has armed, if any (Game consumes it on a tap). */
  armedSpawn: SpawnSpec | null = null;

  private log: DevLog;

  constructor(log: DevLog) {
    this.log = log;
  }

  /** Switch off: every modifier stops applying immediately. */
  disable(): void {
    this.enabled = false;
    this.keepBatteryFull.clear();
    this.armedSpawn = null;
  }

  /** Per-frame enforcement, called by the Game after the sim steps. */
  applyTo(sim: Simulation): void {
    if (!this.enabled) return;
    for (const id of [...this.keepBatteryFull]) {
      const r = sim.roverById(id);
      if (!r) {
        this.keepBatteryFull.delete(id);
        continue;
      }
      const def = ROVERS[r.kind];
      if (r.battery < def.maxBatteryKWh) {
        r.battery = def.maxBatteryKWh;
        // A stranded rover being force-fed can think again immediately.
        if (r.phase === 'disabled') {
          r.phase = 'idle';
          r.goal = 'idle';
          r.command = { type: 'idle' };
          r.pending = [];
          r.recharge = true; // limp home, normally
          r.statusText = 'Returning to charge';
        }
      }
    }
  }

  // ------------------------------------------------------------- time ----

  /** Jump the clock to a (1-based) sol and a time-of-day fraction, 0..1. */
  setTime(sim: Simulation, sol: number, frac: number): void {
    sim.devSetTime(sol - 1, frac); // the panel displays Sol 1-based
    sim.drainEvents();
    this.log('info', `⏱ Calendar jumped to Sol ${sol}, ${formatSolarTime(frac)} (developer).`);
  }

  // ---------------------------------------------------------- weather ----

  /** Conjure a storm of `kind`; its winds arrive within a few seconds. */
  forceStorm(sim: Simulation, kind: StormKindReal): void {
    sim.weather.debugScheduleStorm(kind, sim.simTime, 4);
    this.log('warn', '🌪 Storm conjured — winds inbound in seconds (developer).');
  }

  /** Kill every storm on the map or the forecast board. */
  clearStorms(sim: Simulation): void {
    sim.weather.debugClearStorms();
    this.log('ok', '🌤 All storms dismissed (developer).');
  }

  /** Push the airborne-dust reading straight to `frac` (0..1); it relaxes back. */
  setDust(sim: Simulation, frac: number): void {
    sim.weather.dust = clamp01(frac);
  }

  /** Switch the storm scheduler off entirely, or let it roll again. */
  setStormScheduler(sim: Simulation, on: boolean): void {
    if (on) {
      sim.weather.debugResumeRolls(sim.simTime);
      this.log('info', 'Storm scheduler resumed (developer).');
    } else {
      sim.weather.debugSuppressRolls();
      this.log('info', 'Storm scheduler suspended — no new storms (developer).');
    }
  }

  // ------------------------------------------------------------ rovers ----

  /** Fab a rover of `kind` at (x, z); returns its id for selection. */
  spawnRover(sim: Simulation, kind: RoverKind, x: number, z: number): number {
    return sim.devSpawnRover(kind, x, z).id;
  }

  /** Set a rover's battery as a fraction of its pack (0..1). */
  setBatteryFrac(sim: Simulation, id: number, frac: number): void {
    const r = sim.roverById(id);
    if (!r) return;
    r.battery = clamp01(frac) * ROVERS[r.kind].maxBatteryKWh;
  }

  /** Pin (or unpin) this rover's battery at full while dev mode is on. */
  setKeepBatteryFull(sim: Simulation, id: number, on: boolean): void {
    if (on) {
      this.keepBatteryFull.add(id);
      const r = sim.roverById(id);
      if (r) r.battery = ROVERS[r.kind].maxBatteryKWh; // top up right now
    } else {
      this.keepBatteryFull.delete(id);
    }
  }

  isKeepBatteryFull(id: number): boolean {
    return this.keepBatteryFull.has(id);
  }

  /** Set one cargo slot to `kg`, clamped into the hopper's free room. */
  setCargo(sim: Simulation, id: number, res: ResourceId, kg: number): number {
    const r = sim.roverById(id);
    if (!r) return 0;
    let others = 0;
    for (const k of Object.keys(r.cargo) as ResourceId[]) {
      if (k !== res) others += r.cargo[k];
    }
    const value = Math.min(
      Math.max(0, kg),
      Math.max(0, ROVERS[r.kind].capacityKg - others),
    );
    r.cargo[res] = value;
    this.log(
      'info',
      `${r.label}: ${RESOURCES[res].label} load set to ${Math.round(value)} kg (developer).`,
    );
    return value;
  }

  clearCargo(sim: Simulation, id: number): void {
    const r = sim.roverById(id);
    if (!r) return;
    for (const k of Object.keys(r.cargo) as ResourceId[]) r.cargo[k] = 0;
    this.log('info', `${r.label}: cargo bay purged (developer).`);
  }

  /** Drivetrain condition, 0..100. */
  setCondition(sim: Simulation, id: number, pct: number): void {
    const r = sim.roverById(id);
    if (!r) return;
    r.condition = Math.min(100, Math.max(0, pct));
  }

  // --------------------------------------------------------- buildings ----

  /** Fab a building at (x, z) — returns its id, or null if the spot is illegal. */
  spawnBuilding(sim: Simulation, kind: BuildingKind, x: number, z: number): number | null {
    return sim.devSpawnBuilding(kind, x, z)?.id ?? null;
  }

  /** Throw a construction site straight to completion, free. */
  completeBuilding(sim: Simulation, id: number): void {
    if (sim.devCompleteBuilding(id)) {
      this.log('info', `Structure #${id} completed instantly (developer).`);
    }
  }

  /** Structural health 0..100, crossing the sim's damage thresholds honestly. */
  setHealth(sim: Simulation, id: number, pct: number): void {
    const b = sim.buildingById(id);
    if (!b) return;
    b.health = Math.min(100, Math.max(0, pct));
    if (b.health <= DAMAGED_HEALTH) b.damaged = true;
    else if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) b.damaged = false;
    sim.recomputeCapacities();
  }

  /** Panel cleanliness 0..1 (meaningful on solar, harmless elsewhere). */
  setCleanliness(sim: Simulation, id: number, frac: number): void {
    const b = sim.buildingById(id);
    if (!b) return;
    b.cleanliness = clamp01(frac);
  }

  setDamaged(sim: Simulation, id: number, on: boolean): void {
    const b = sim.buildingById(id);
    if (!b || b.damaged === on) return;
    b.damaged = on;
    sim.recomputeCapacities();
  }

  /** Set the developer upgrade level; returns the level it landed on. */
  setUpgradeLevel(sim: Simulation, id: number, level: number): number {
    const landed = sim.devSetBuildingLevel(id, level);
    this.log('info', `Structure #${id} set to Mk ${landed} (developer).`);
    return landed;
  }

  // ---------------------------------------------------------- deposits ----

  /** Survey a fresh deposit of `res` at (x, z); returns its id. */
  spawnDeposit(sim: Simulation, res: ResourceId, x: number, z: number, kg: number): number {
    return sim.devSpawnDeposit(res, x, z, kg).id;
  }

  // ---------------------------------------------------------- colonist ----

  setColonistHealth(sim: Simulation, pct: number): void {
    const c = sim.colonist;
    if (c.dead) return;
    c.health = Math.min(100, Math.max(0, pct));
  }

  refillSuit(sim: Simulation): void {
    sim.colonist.suitO2 = SUIT_O2_CAPACITY;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Fraction of a sol rendered as HH:MM on the 24h39m clock. */
function formatSolarTime(frac: number): string {
  const hours = frac * 24.6597;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
