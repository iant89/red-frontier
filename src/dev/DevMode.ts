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
 * Since the host extraction, every edit here is a **command** (see
 * `sim/host/protocol.ts`): the panel no longer holds sim objects it can poke,
 * only the read model, so a storm conjured from this panel crosses the same
 * boundary a player's move order does. That also makes the persistence contract
 * structural rather than a promise — the snapshot is produced inside the host,
 * and there is no path from this file to it.
 *
 * The battery pin is the one thing that is not an edit but a *per-step
 * enforcement*, so it is expressed as overlay **state** published to the host
 * (`host.syncOverlays`) and applied by the sim-side registry in
 * `host/overlays.ts` — a name plus the ids to grip, not a closure, because a
 * worker cannot accept a function. The pin therefore runs right after each tick,
 * on whichever side the world lives, outside every save.
 *
 * The Game owns one instance for the lifetime of the page.
 */

import type { SimHost } from '../sim/host/SimHost';
import type { SimView, SimWritable } from '../sim/host';
import type { SimAck, SimCommand } from '../sim/host';
import { BATTERY_PIN_OVERLAY, EMPTY_OVERLAYS, runOverlays } from '../sim/host';
import type { OverlayState } from '../sim/host';
import type { BuildingKind, ResourceId, RoverKind } from '../sim/defs';
import { RESOURCES } from '../sim/defs';
import type { StormKindReal } from '../sim/weather';

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

  /** Rovers whose batteries this mode has asked to pin, until proven stale. */
  private keepBatteryFull = new Set<number>();

  /** The spawn the panel has armed, if any (Game consumes it on a tap). */
  armedSpawn: SpawnSpec | null = null;

  /** The colony's owner. Every write in this class goes through it. */
  private host: SimHost | null = null;

  private log: DevLog;

  constructor(log: DevLog) {
    this.log = log;
  }

  /**
   * Wire the mode to a colony, and hand it the pins to hold. Re-attaching (a new
   * mission, a host swap) republishes them, which is the whole reason the state
   * is derived here rather than pushed once in the constructor.
   */
  attach(host: SimHost): void {
    this.host = host;
    this.publish();
  }

  /** Unwire it (mission over, host replaced) without dropping the mode's UI state. */
  detach(): void {
    this.host?.syncOverlays(EMPTY_OVERLAYS);
    this.host = null;
  }

  /** Switch off: every modifier stops applying immediately. */
  disable(): void {
    this.enabled = false;
    this.keepBatteryFull.clear();
    this.armedSpawn = null;
    this.publish();
  }

  /**
   * The overlay state to publish: nothing at all unless the mode is on, and
   * never a pin on a rover the colony no longer has.
   *
   * That last part is a *read* of the view rather than bookkeeping at delete
   * time, because a rover dies for reasons this class cannot see. Asking the
   * view is also the honest version: with a worker host the view is the world's
   * own report, so a pin is dropped as soon as the world has stopped carrying
   * the rover, not as soon as the panel guesses.
   */
  overlayState(): OverlayState {
    if (!this.enabled) return EMPTY_OVERLAYS;
    const view = this.host?.view;
    if (view) {
      for (const id of [...this.keepBatteryFull]) {
        if (!view.rovers.some((r) => r.id === id)) this.keepBatteryFull.delete(id);
      }
    }
    if (this.keepBatteryFull.size === 0) return EMPTY_OVERLAYS;
    return { [BATTERY_PIN_OVERLAY]: [...this.keepBatteryFull] };
  }

  /** Tell the host what to hold. Cheap; call it after any change to the mode. */
  private publish(): void {
    this.host?.syncOverlays(this.overlayState());
  }

  /**
   * Apply the pins to a world by hand. The host calls the same registry after
   * every step; this exists for the suite that drives a bare `Simulation`, and
   * keeping both on one implementation is the point.
   */
  applyTo(sim: SimWritable): void {
    runOverlays(sim, this.overlayState());
  }

  // -------------------------------------------------------- command plumbing ----

  /**
   * Send an edit to the colony. Without a host there is no world to edit, and a
   * silent no-op here would make a wiring bug look like a broken button.
   *
   * Note what the methods below no longer take: a colony to assign to. Only the
   * two that name a rover in their log line still read the view at all. Every
   * edit is a command out the front door, which is the whole seam — there is
   * nothing here left to poke, so nothing here can be forgotten when the sim
   * moves off-thread.
   */
  private send(command: SimCommand): SimAck {
    if (!this.host) throw new Error('DevMode is not attached to a SimHost');
    return this.host.request(command);
  }

  // ------------------------------------------------------------- time ----

  /** Jump the clock to a (1-based) sol and a time-of-day fraction, 0..1. */
  setTime(sol: number, frac: number): void {
    // The panel displays Sol 1-based; the calendar and the protocol are 0-based.
    this.send({ type: 'dev/time', sol: sol - 1, frac });
    this.host?.drainEvents(); // a jump re-anchors the sky; don't spam the log
    this.log('info', `⏱ Calendar jumped to Sol ${sol}, ${formatSolarTime(frac)} (developer).`);
  }

  // ---------------------------------------------------------- weather ----

  /** Conjure a storm of `kind`; its winds arrive within a few seconds. */
  forceStorm(kind: StormKindReal): void {
    this.send({ type: 'dev/storm/force', kind });
    this.log('warn', '🌪 Storm conjured — winds inbound in seconds (developer).');
  }

  /** Kill every storm on the map or the forecast board. */
  clearStorms(): void {
    this.send({ type: 'dev/storm/clear' });
    this.log('ok', '🌤 All storms dismissed (developer).');
  }

  /** Push the airborne-dust reading straight to `frac` (0..1); it relaxes back. */
  setDust(frac: number): void {
    this.send({ type: 'dev/dust', frac });
  }

  /** Switch the storm scheduler off entirely, or let it roll again. */
  setStormScheduler(on: boolean): void {
    this.send({ type: 'dev/storm/scheduler', on });
    this.log(
      'info',
      on
        ? 'Storm scheduler resumed (developer).'
        : 'Storm scheduler suspended — no new storms (developer).',
    );
  }

  // ------------------------------------------------------------ rovers ----

  /** Fab a rover of `kind` at (x, z); returns its id for selection. */
  spawnRover(kind: RoverKind, x: number, z: number): number {
    return this.send({ type: 'dev/spawn/rover', kind, x, z }).entityId ?? -1;
  }

  /** Set a rover's battery as a fraction of its pack (0..1). */
  setBatteryFrac(id: number, frac: number): void {
    this.send({ type: 'dev/rover/battery', roverId: id, frac });
  }

  /** Pin (or unpin) this rover's battery at full while dev mode is on. */
  setKeepBatteryFull(id: number, on: boolean): void {
    if (on) this.keepBatteryFull.add(id);
    else this.keepBatteryFull.delete(id);
    // Publish first: the top-up below is a one-shot nudge, and a pin asked for
    // after it would leave the rover briefly dischargeable again.
    this.publish();
    if (on) this.send({ type: 'dev/rover/battery', roverId: id, frac: 1 });
  }

  isKeepBatteryFull(id: number): boolean {
    return this.keepBatteryFull.has(id);
  }

  /**
   * Set one cargo slot to `kg`. The hopper's free room is the sim's business, so
   * the *landed* load comes back on the ack rather than being computed here.
   */
  setCargo(sim: SimView, id: number, res: ResourceId, kg: number): number {
    const r = sim.roverById(id);
    const landed = this.send({ type: 'dev/rover/cargo', roverId: id, resource: res, kg }).value ?? 0;
    if (r) {
      this.log('info', `${r.label}: ${RESOURCES[res].label} load set to ${Math.round(landed)} kg (developer).`);
    }
    return landed;
  }

  clearCargo(sim: SimView, id: number): void {
    const r = sim.roverById(id);
    this.send({ type: 'dev/rover/cargoClear', roverId: id });
    if (r) this.log('info', `${r.label}: cargo bay purged (developer).`);
  }

  /** Drivetrain condition, 0..100. */
  setCondition(id: number, pct: number): void {
    this.send({ type: 'dev/rover/condition', roverId: id, pct });
  }

  // --------------------------------------------------------- buildings ----

  /** Fab a building at (x, z) — returns its id, or null if the spot is illegal. */
  spawnBuilding(kind: BuildingKind, x: number, z: number): number | null {
    const ack = this.send({ type: 'dev/spawn/building', kind, x, z });
    return ack.ok ? (ack.entityId ?? null) : null;
  }

  /** Throw a construction site straight to completion, free. */
  completeBuilding(id: number): void {
    if (this.send({ type: 'dev/building/complete', buildingId: id }).ok) {
      this.log('info', `Structure #${id} completed instantly (developer).`);
    }
  }

  /** Structural health 0..100, crossing the sim's damage thresholds honestly. */
  setHealth(id: number, pct: number): void {
    this.send({ type: 'dev/building/health', buildingId: id, pct });
  }

  /** Panel cleanliness 0..1 (meaningful on solar, harmless elsewhere). */
  setCleanliness(id: number, frac: number): void {
    this.send({ type: 'dev/building/cleanliness', buildingId: id, frac });
  }

  setDamaged(id: number, on: boolean): void {
    this.send({ type: 'dev/building/damaged', buildingId: id, on });
  }

  /** Flip a structure's power switch, from the panel's checkbox. */
  setBuildingEnabled(id: number, on: boolean): void {
    this.send({ type: 'building/toggle', buildingId: id, enabled: on });
  }

  /** Set the developer upgrade level; returns the level it landed on. */
  setUpgradeLevel(id: number, level: number): number {
    const landed = this.send({ type: 'dev/building/level', buildingId: id, level }).value ?? 1;
    this.log('info', `Structure #${id} set to Mk ${landed} (developer).`);
    return landed;
  }

  // ---------------------------------------------------------- deposits ----

  /** Survey a fresh deposit of `res` at (x, z); returns its id. */
  spawnDeposit(res: ResourceId, x: number, z: number, kg: number): number {
    return this.send({ type: 'dev/spawn/deposit', resource: res, x, z, kg }).entityId ?? -1;
  }

  // ---------------------------------------------------------- colonist ----

  setColonistHealth(pct: number): void {
    this.send({ type: 'dev/colonist/health', pct });
  }

  refillSuit(): void {
    this.send({ type: 'dev/colonist/suit' });
  }
}

/** Fraction of a sol rendered as HH:MM on the 24h39m clock. */
function formatSolarTime(frac: number): string {
  const hours = frac * 24.6597;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
