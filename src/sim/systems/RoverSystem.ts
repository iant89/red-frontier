/**
 * Phase 10 — Extract RoverSystem
 *
 * Goal per roadmap §14: the rover is the largest and most valuable extraction.
 * "Initially move behavior without changing its design" — so everything that
 * used to answer *what a rover does this tick* on `Simulation` lives here now,
 * moved verbatim, behind a state-consuming static API:
 *
 *     input      — ColonyState (rovers, buildings, world + nav grid, weather
 *                  for shelter/visibility/work rates, storage as the depot,
 *                  the grid battery store, the clock)
 *        ↓
 *     resolver   — task lifecycle (`giveTask` / `autoAssign` / `finishTask`,
 *                  deposit reservations), per-rover tick (`updateRover`:
 *                  storm recall → grit wear → ride-home battery floor →
 *                  task execution), movement (`moveRover` along the nav path
 *                  with proximity awareness), and one executor per task
 *                  (`doMine` / `tryUnload` / `doService` / `doSalvage` /
 *                  `doRecover` / `doUnload` / `doRecharge`)
 *        ↓
 *     output     — rover position/heading/battery/condition/cargo, task and
 *                  queue state, goal/phase/nav path, per-goal log lines,
 *                  storage intake, a rescue's energy transfer
 *
 * **Nothing was redesigned.** `command` / `goal` / `phase` still overlap
 * exactly as they did; the salvage ping-pong ordering, the ride-home battery
 * clamp, the `setTravel` keep-in-flight guard and the half-power service work
 * are all preserved — Phase 11 (state simplification) and Phase 12 (automation)
 * kept them that way, and Phase 13 moved only the storage arithmetic out.
 * Adding a rover *type* still means touching `defs.ts`; this file is the
 * machinery.
 *
 * Cross-domain seams — the rover triggers these but does not own them:
 *   - {@link RoverHostHooks.constructSite} — assembling a site is
 *     ConstructionSystem's (Phase 9); a rover's construct task walks there and
 *     hands over. The `workerId` release when a site vanished or went online
 *     is rover-side bookkeeping and stays here.
 *   - {@link RoverHostHooks.canDeliverCargo} — "is this rover stuck on cargo
 *     the silos cannot take" is a haul question (LogisticsSystem, Phase 13).
 *
 * What deliberately stays elsewhere:
 *   - the fleet's *decision making* (`assignMaintenance` / `assignRescues` /
 *     `assignSupplyRuns` as they were) is FleetAutomationSystem's (Phase 12).
 *     It calls into this system's task lifecycle; it does not own it.
 *   - storage accounting, cargo transfers and the reservation table are
 *     LogisticsSystem's (Phase 13). The three pours (`tryUnload`,
 *     `unloadWhileCharging`, and the silent parked one in `goIdle`), the
 *     route's room check and `claimDeposit`/`releaseDeposit` all forward to it,
 *     which is why they cannot drift apart any more.
 *   - Garage bay `assemble` + `tick` — GarageSystem (Phase 18). The line
 *     spends materials via ConstructionSystem and spawns via RoverSystem.spawn;
 *     this module does not own the bay.
 *
 * Determinism: no RNG, no wall clock. Every draw the rover makes is from
 * state the simulation already owns, and the tie-breaks (deposit claims, the
 * scorer's stable sorts) live in the callers above.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import { UpgradeSystem } from './UpgradeSystem';
import { effectiveBuildingDef } from '../engineering/upgrades';
import { effectiveRoverDef } from '../engineering/upgrades';
import { freshRoverParts } from '../state/RoverState';
import { MaintenanceSystem } from './MaintenanceSystem';
import type { ColonyState } from '../state/ColonyState';
import { recomputeCapacitiesState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import type { Rover, RoverGoal, RoverTask } from '../state/RoverState';
import {
  cargoMass,
  defaultRoverRules,
  enterCharge,
  enterDisabled,
  enterIdle,
  enterTravel,
  enterWork,
} from '../state/RoverState';
import { LogisticsSystem, type LogisticsHostHooks } from './LogisticsSystem';
import type { Deposit } from '../World';
import type { ResourceId, RoverKind } from '../defs';
import { ALL_RESOURCES, BUILDINGS, RESOURCES, ROVERS, emptyAmounts } from '../defs';
import type { Severity } from '../alerts';
import type { Poi } from '../pois';
import {
  POI_KINDS,
  isPickedClean,
  salvageRateKgS,
} from '../pois';
import { ExplorationSystem } from './ExplorationSystem';
import { clamp } from '../../lib/rng';
import { PowerSystem } from './PowerSystem';
import {
  BUILDING_MAX_HEALTH,
  HOURS_PER_SEC,
  LIGHTS_AUTO_IRRADIANCE,
  LIGHTS_AUTO_VISIBILITY,
  POD_RADIUS,
  RECOVER_MIN_GIVE_KWH,
  RECOVER_TRANSFER_KW,
  REPAIR_RESTART_HEALTH,
  ROUTE_RESUME_ROOM_KG,
  ROVER_CLEAN_RATE,
  ROVER_COLONY_YARD_M,
  ROVER_CONDITION_SLOW,
  ROVER_PROXIMITY_CLEARANCE_M,
  ROVER_PROXIMITY_COLONY_CLEARANCE_M,
  ROVER_PROXIMITY_COLONY_SPEED_MUL,
  ROVER_PROXIMITY_SPEED_MUL,
  ROVER_REPAIR_RATE,
  ROVER_WEAR_MOVE_S,
  ROVER_WEAR_STORM_S,
  ROVER_WEAR_WORK_S,
  SIM_TICK,
  SPAWN_X,
  SPAWN_Z,
} from '../config';

const ARRIVE_EPS = 0.6;
/** How close a rover has to be to a site before its salvage work counts. */
const SALVAGE_REACH = 8;
/** Centre-to-centre distance a rescuer hooks the jumper cables up at. */
const RECOVER_REACH = 6;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Cross-domain effects the rover triggers but does not own. Implemented by
 * Simulation against the machinery that already lives there, so no second
 * source of truth appears. Same shape as `WeatherHostHooks`,
 * `PowerSystemContext`, `LifeSupportHostHooks` and `ConstructionHostHooks`.
 */
export interface RoverHostHooks {
  /**
   * Assemble a construction site this rover has walked up to — the
   * construction domain's own `ConstructionSystem.build` (Phase 9).
   */
  constructSite(r: Rover, b: Building): void;
  /**
   * True if any of this rover's cargo would currently fit in storage — the
   * haul question that decides whether a loaded rover is *busy* or *stuck*
   * (logistics domain, Phase 13).
   */
  canDeliverCargo(r: Rover): boolean;
}

export class RoverSystem {
  // ------------------------------------------------------------ factory ----

  /** A fresh rover, parked at `(x, z)`. Ids come from the state's counter. */
  static spawn(state: ColonyState, kind: RoverKind, x: number, z: number, heading: number): Rover {
    const def = ROVERS[kind];
    const r: Rover = {
      id: state.nextId++,
      kind,
      label: def.label,
      x,
      y: state.world.heightAt(x, z),
      z,
      heading,
      battery: def.maxBatteryKWh,
      cargo: emptyAmounts(),
      phase: 'idle',
      command: { type: 'idle' },
      pending: [],
      goal: 'idle',
      gx: x,
      gz: z,
      gid: 0,
      recharge: false,
      lowBatteryNotified: false,
      chargeSat: 1,
      autoTask: false,
      condition: 100,
      parts: freshRoverParts(),
      rules: defaultRoverRules(),
      routePaused: false,
      blockNotified: false,
      sheltered: false,
      lightsOn: true,
      lightsActive: false,
      navPath: [],
      navI: 0,
    };
    state.rovers.push(r);
    return r;
  }

  // ------------------------------------------------------------ queries ----

  /** True when a rover sitting here could pour its hold into a silo. */
  static nearDepot(state: ColonyState, x: number, z: number): boolean {
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < 14) return true;
    for (const w of RoverSystem.onlineWarehouses(state)) {
      if (Math.hypot(w.x - x, w.z - z) < BUILDINGS[w.kind].radius + 5) return true;
    }
    return false;
  }

  /** Somewhere a rover can draw charge: the pod, or any online habitat. */
  static nearCharger(state: ColonyState, x: number, z: number): boolean {
    // Phase 6: the charger map lives in PowerSystem
    return PowerSystem.nearCharger(state, x, z);
  }

  /** Nearest point a rover of any kind can charge at (the pod is the fallback). */
  static nearestChargerPoint(state: ColonyState, x: number, z: number): { x: number; z: number } {
    let best = { x: SPAWN_X, z: SPAWN_Z };
    let bestD = Math.hypot(SPAWN_X - x, SPAWN_Z - z);
    for (const b of state.buildings) {
      if (!RoverSystem.runnable(b) || !b.enabled) continue;
      if (!effectiveBuildingDef(b).providesCharge) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bestD) {
        bestD = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }

  /** Energy (kWh) a rover of `def` burns driving between two points. */
  static travelKWh(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    def: { cruiseSpeed: number; movePowerKw: number },
  ): number {
    // Planner heuristic — actual drain is tick-by-tick along the nav path.
    // A* here would re-plan every rover every tick (home-cost + auto-haul).
    return (Math.hypot(x2 - x1, z2 - z1) / def.cruiseSpeed) * def.movePowerKw * HOURS_PER_SEC;
  }

  /** Charger output at a position — garages charge twice as fast (GDD §4). */
  static chargeRateKwAt(state: ColonyState, x: number, z: number): number {
    // Phase 6: the charger map lives in PowerSystem
    return PowerSystem.chargeRateKwAt(state, x, z);
  }

  /**
   * How hard a worn rover can still work, 0.5..1 (GDD §5: rovers fail *soft*).
   * Above `ROVER_CONDITION_SLOW` it's business as usual; at zero condition the
   * drivetrain still turns at half rate — stranded-not-destroyed, always.
   */
  static roverWorkMul(r: Rover): number {
    return 0.5 + 0.5 * clamp(Math.min(r.condition, r.parts.motor, r.parts.circuitBoard) / ROVER_CONDITION_SLOW, 0, 1);
  }

  /**
   * The sim's one judgement call about visibility: it is dark (sun weaker
   * than the auto threshold) or the dust has closed visibility in. Both
   * inputs are authoritative sim state, so this is deterministic.
   */
  static lightsNeeded(state: ColonyState): boolean {
    return (
      state.clock.sun.irradiance < LIGHTS_AUTO_IRRADIANCE ||
      state.weather.visibility < LIGHTS_AUTO_VISIBILITY
    );
  }

  /** Whether a building is online *and* structurally sound enough to run. */
  private static runnable(b: Building): boolean {
    return b.state === 'online' && !b.damaged;
  }

  /** Online warehouses — the places a hold can actually be poured into. */
  private static onlineWarehouses(state: ColonyState): Building[] {
    return state.buildings.filter(
      (b) => RoverSystem.runnable(b) && effectiveBuildingDef(b).storagePerResourceKg > 0,
    );
  }

  // ------------------------------------------------------- reservations ----

  /**
   * Claim a deposit for a rover (TDD §8: reservations stop two rovers being
   * scheduled onto one seam). Auto tasks never steal; a player order may bump
   * an auto reservation, cancelling that rover's run so it re-plans.
   */
  /**
   * The reservation table is LogisticsSystem's (Phase 13) — a claim on a
   * pickup is resource accounting. These stay as the rover-facing names the
   * fleet and the tests already call, and pass the task-lifecycle hook a
   * *forced* claim needs.
   */
  static claimDeposit(state: ColonyState, r: Rover, depositId: number, force = false): void {
    LogisticsSystem.claimDeposit(state, r, depositId, RoverSystem.logisticsHooks, force);
  }

  static releaseDeposit(state: ColonyState, r: Rover, depositId: number): void {
    LogisticsSystem.releaseDeposit(state, r, depositId);
  }

  /** Drop everything this rover's active task holds a claim on. */
  static releaseReservations(state: ColonyState, r: Rover): void {
    LogisticsSystem.releaseReservations(state, r);
  }

  /** True when some rover is already executing a RECOVER for this one. */
  static rescueTargeted(state: ColonyState, roverId: number): boolean {
    return LogisticsSystem.rescueTargeted(state, roverId);
  }

  /** What the ledger may call back into: finishing another rover's task. */
  private static readonly logisticsHooks: LogisticsHostHooks = {
    finishTask: (r) => RoverSystem.finishTask(r),
  };

  // ------------------------------------------------------ task lifecycle ----

  /**
   * Hand a rover a task. A plain order replaces everything the rover was doing
   * (explicit player intent always wins, TDD §8); a *queued* order (Shift) is
   * appended behind the player tasks already on its queue. Ordering over an
   * automatic task always replaces it — automation only ever fills idle time.
   */
  static giveTask(state: ColonyState, r: Rover, task: RoverTask, queued: boolean): void {
    const busy = r.command.type !== 'idle' || r.pending.length > 0;
    if (queued && busy && !r.autoTask) {
      r.pending.push(task);
      return;
    }
    RoverSystem.releaseReservations(state, r);
    r.pending = [];
    r.command = task;
    r.autoTask = false;
    r.recharge = false;
    r.routePaused = false;
    r.blockNotified = false;
  }

  /** The scheduler's counterpart to {@link giveTask} — always replaces. */
  static autoAssign(r: Rover, task: RoverTask): void {
    r.pending = [];
    r.command = task;
    r.autoTask = true;
    r.routePaused = false;
  }

  /**
   * Complete the active task: release what it held, promote the next queued
   * task (if any), and drop back to idle + automation.
   */
  static finishTask(r: Rover): void {
    const next = r.pending.shift();
    if (next) {
      r.command = next;
    } else {
      r.command = { type: 'idle' };
      if (cargoMass(r) <= 0.01) r.autoTask = false;
    }
    enterIdle(r);
    r.routePaused = false;
    r.blockNotified = false;
  }

  // ----------------------------------------------------- player commands ----

  static issueMove(state: ColonyState, roverId: number, x: number, z: number, queued = false): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.phase === 'disabled') return;
    RoverSystem.giveTask(state, r, { type: 'moveTo', x, z }, queued);
  }

  static issueMine(state: ColonyState, roverId: number, depositId: number, queued = false): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.phase === 'disabled') return;
    const dep = state.world.deposits.find((d) => d.id === depositId);
    if (!dep || dep.amount <= 0) {
      log(state, 'info', 'Deposit is depleted.');
      return;
    }
    RoverSystem.giveTask(state, r, { type: 'mine', depositId }, queued);
    // A player order outranks any auto-run holding the seam.
    RoverSystem.claimDeposit(state, r, depositId, true);
  }

  /**
   * Drive to the nearest depot and pour out whatever fits (GDD §5 UNLOAD).
   * Queued behind a mining run it closes the loop explicitly; ordered plain
   * it interrupts the rover now. An empty hold is a no-op with a log line.
   */
  static issueUnload(state: ColonyState, roverId: number, queued = false): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.phase === 'disabled') return;
    if (!queued && cargoMass(r) <= 0.01) {
      log(state, 'info', `${r.label}'s hold is already empty.`);
      return;
    }
    RoverSystem.giveTask(state, r, { type: 'unload' }, queued);
  }

  /** Hold position for a while (GDD §5 WAIT — usually queued between jobs). */
  static issueWait(state: ColonyState, roverId: number, seconds: number, queued = false): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.phase === 'disabled') return;
    RoverSystem.giveTask(state, r, { type: 'wait', seconds: Math.max(0, seconds) }, queued);
  }

  static issueConstruct(state: ColonyState, roverId: number, buildingId: number, queued = false): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.phase === 'disabled') return;
    const b = state.buildings.find((o) => o.id === buildingId);
    if (!b || (b.state === 'online' && !b.upgradeJob)) return;
    if (!effectiveBuildingDef(b).buildableBy.includes(r.kind)) {
      log(state, 'warn', `${r.label} can't build a ${effectiveBuildingDef(b).label}.`);
      return;
    }
    RoverSystem.giveTask(state, r, { type: 'construct', buildingId }, queued);
  }

  static stopRover(state: ColonyState, roverId: number): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r) return;
    RoverSystem.releaseReservations(state, r);
    r.command = { type: 'idle' };
    r.pending = [];
    r.recharge = false;
    r.autoTask = false;
    enterIdle(r);
    r.routePaused = false;
  }

  /** Convert the active mining task into a repeating haul route (or back). */
  static setRepeatRoute(state: ColonyState, roverId: number, on: boolean): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r) return;
    if (r.command.type !== 'mine') {
      log(state, 'info', `${r.label} isn't working a seam — select a deposit to route it.`);
      return;
    }
    r.command.repeat = on || undefined;
    // Taking ownership of a route pulls the rover out of the auto pool.
    if (on) r.autoTask = false;
    log(
      state,
      on ? 'ok' : 'info',
      on
        ? `${r.label} set on a haul route — it will loop the seam until it's dry.`
        : `${r.label}'s haul route ended; this trip finishes the job.`,
    );
  }

  /** Flip one of the player-authored automation rules (GDD §5). */
  static setRoverRule(
    state: ColonyState,
    roverId: number,
    rule: 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue',
    on: boolean,
  ): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r) return;
    r.rules[rule] = on;
    if (!on && rule === 'autoHaul' && r.autoTask) {
      RoverSystem.finishTask(r);
    }
    const names: Record<string, string> = {
      autoHaul: 'auto-haul',
      autoService: 'auto-maintenance',
      stormShelter: 'storm sheltering',
      autoRescue: 'auto-rescue',
    };
    log(state, 'info', `${r.label} ${names[rule]} ${on ? 'enabled' : 'disabled'}.`);
  }

  /** Set the rover's return-to-charge battery floor (percent, 10–60). */
  static setChargeFloor(state: ColonyState, roverId: number, pct: number): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r) return;
    r.rules.chargeFloorPct = Math.max(10, Math.min(60, Math.round(pct)));
  }

  /**
   * Flip the position-lights switch (headlights + rear strobe). When on,
   * the sim lights them automatically at night or in low visibility — and
   * bills the battery for every hour they stay lit.
   */
  static setRoverLights(state: ColonyState, roverId: number, on: boolean): void {
    const r = state.rovers.find((o) => o.id === roverId);
    if (!r || r.lightsOn === on) return;
    r.lightsOn = on;
    log(
      state,
      'info',
      on
        ? `${r.label} lights armed — they come on at night and in blowing dust.`
        : `${r.label} lights switched off — it will run dark to save power.`,
    );
  }

  /**
   * Send a rover out to jump-start a stranded one (TDD §8's RECOVER task).
   * Returns false (with the reason logged) when there is nothing to rescue.
   */
  static issueRecover(state: ColonyState, roverId: number, strandedId: number, queued = false): boolean {
    const r = state.rovers.find((o) => o.id === roverId);
    const s = state.rovers.find((o) => o.id === strandedId);
    if (!r || r.phase === 'disabled' || !s) return false;
    if (r.id === s.id) return false;
    if (s.phase !== 'disabled') {
      log(state, 'info', `${s.label} is running fine — no rescue needed.`);
      return false;
    }
    if (state.weather.shelterRovers()) {
      log(state, 'warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    RoverSystem.giveTask(state, r, { type: 'recover', roverId: strandedId }, queued);
    log(state, 'info', `${r.label} dispatched to jump-start ${s.label}.`);
    return true;
  }

  /**
   * Send a rover to clean a building's exposed surfaces. Fails (with a log
   * line) if there is nothing to clean or the storm makes it unsafe.
   */
  static issueClean(state: ColonyState, roverId: number, buildingId: number, queued = false): boolean {
    const r = state.rovers.find((o) => o.id === roverId);
    const b = state.buildings.find((o) => o.id === buildingId);
    if (!r || r.phase === 'disabled' || !b || b.state !== 'online') return false;
    if (effectiveBuildingDef(b).generation !== 'solar') {
      log(state, 'info', `${effectiveBuildingDef(b).label} has no panels to clean.`);
      return false;
    }
    if (b.cleanliness > 0.995) {
      log(state, 'info', `The ${effectiveBuildingDef(b).label} array is already clean.`);
      return false;
    }
    if (state.weather.shelterRovers()) {
      log(state, 'warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    RoverSystem.giveTask(state, r, { type: 'clean', buildingId }, queued);
    return true;
  }

  /** Send a rover to repair a damaged (or battered) building. */
  static issueRepair(state: ColonyState, roverId: number, buildingId: number, queued = false): boolean {
    const r = state.rovers.find((o) => o.id === roverId);
    const b = state.buildings.find((o) => o.id === buildingId);
    if (!r || r.phase === 'disabled' || !b) return false;
    if (b.state !== 'online' || b.health >= BUILDING_MAX_HEALTH - 0.5) {
      log(state, 'info', `${b ? effectiveBuildingDef(b).label : 'That building'} needs no repairs.`);
      return false;
    }
    if (state.weather.shelterRovers()) {
      log(state, 'warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    RoverSystem.giveTask(state, r, { type: 'repair', buildingId }, queued);
    return true;
  }

  /**
   * Convenience dispatch used by the building inspector: pick the nearest idle
   * rover and send it to service this building (repair first, then clean).
   */
  static dispatchMaintenance(state: ColonyState, buildingId: number): boolean {
    const b = state.buildings.find((o) => o.id === buildingId);
    if (!b || b.state !== 'online') return false;
    const needsRepair = b.damaged || b.health < BUILDING_MAX_HEALTH - 0.5;
    const needsClean = effectiveBuildingDef(b).generation === 'solar' && b.cleanliness < 0.995;
    if (!needsRepair && !needsClean) return false;
    const crew = state.rovers
      .filter(
        (r) =>
          r.phase !== 'disabled' &&
          !r.recharge &&
          !r.sheltered &&
          r.command.type === 'idle',
      )
      .sort(
        (a, c) =>
          Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z) || a.id - c.id,
      );
    const rover = crew[0];
    if (!rover) {
      log(state, 'warn', 'No free rover — one has to be idle to dispatch.');
      return false;
    }
    const ok = needsRepair
      ? RoverSystem.issueRepair(state, rover.id, b.id)
      : RoverSystem.issueClean(state, rover.id, b.id);
    if (ok) {
      const job = needsRepair ? 'repair' : 'clean';
      log(state, 'info', `${rover.label} dispatched to ${job} the ${effectiveBuildingDef(b).label}.`);
    }
    return ok;
  }

  /**
   * Send a rover to cut a site apart and haul it home (GDD §05's SALVAGE task).
   *
   * Refusals are the same shape as every other order's: a log line saying why,
   * and nothing queued. The interesting one is the undiscovered site — the sim
   * knows about it, the player is not supposed to yet, so it cannot be ordered.
   */
  static issueSalvage(state: ColonyState, roverId: number, poiId: number, queued = false): boolean {
    const r = state.rovers.find((o) => o.id === roverId);
    const p = state.world.pois.find((o) => o.id === poiId);
    if (!r || r.phase === 'disabled') return false;
    if (!p) {
      log(state, 'warn', 'There is nothing at those coordinates.');
      return false;
    }
    if (!p.discovered) {
      log(state, 'info', 'Nothing has been surveyed there yet.');
      return false;
    }
    if (p.buried) {
      log(state, 'warn', `${POI_KINDS[p.kind].label} is buried — the dust got there first.`);
      return false;
    }
    if (p.kind === 'settlementSite') {
      log(state, 'info', 'A settlement site has nothing to salvage — it is a place to build.');
      return false;
    }
    if (isPickedClean(p)) {
      log(state, 'info', `${POI_KINDS[p.kind].label} has already been picked clean.`);
      return false;
    }
    RoverSystem.giveTask(state, r, { type: 'salvage', poiId }, queued);
    return true;
  }

  // ---------------------------------------------------------- per-tick ----

  /**
   * Light a rover's position lights if the switch is on and they are needed,
   * and pay for them out of the rover's own battery. A disabled rover is
   * skipped by the caller — its yellow emergency strobe costs nothing here.
   * Returns false if the lights drank the last of the battery (stranded).
   */
  static tickLights(state: ColonyState, r: Rover): boolean {
    r.lightsActive = r.lightsOn && RoverSystem.lightsNeeded(state) && r.battery > 0;
    if (!r.lightsActive) return true;
    const hours = SIM_TICK * HOURS_PER_SEC;
    r.battery = Math.max(0, r.battery - effectiveRoverDef(r).lightsPowerKw * hours);
    // Sitting out a long night with the lights on can strand a rover too.
    if (r.battery <= 0) {
      RoverSystem.disable(state, r);
      return false;
    }
    return true;
  }

  /**
   * One rover's tick: storm recall, grit wear, the ride-home battery floor,
   * then whatever task it is holding.
   */
  static updateRover(state: ColonyState, r: Rover, hooks: RoverHostHooks): void {
    const def = effectiveRoverDef(r);

    // ---- storm recall (TDD §8: "IF storm warning → return to shelter") ----
    // The rover's own command is preserved underneath; when the storm passes
    // it simply picks the job back up. The player may turn the rule off — a
    // daredevil rover keeps working at storm rate and pays for it in wear.
    // The threshold is the weather *where the rover stands*, so one machine
    // caught in the gust front shelters while a neighbour in the lee works on.
    const storm = state.weather.shelterRoversAt(r.x, r.z);
    const mustShelter = r.rules.stormShelter && storm && !RoverSystem.nearCharger(state, r.x, r.z);
    if (mustShelter && !r.sheltered) {
      r.sheltered = true;
      log(state, 'warn', `${r.label} is running for shelter — the storm is on it.`);
    } else if (!storm && r.sheltered) {
      r.sheltered = false;
      r.recharge = false; // release the shelter-charge and resume the job
    }
    if (r.sheltered) {
      r.recharge = true; // reuse the return-to-charge behaviour as the recall path
      RoverSystem.doRecharge(state, r);
      return;
    }

    // ---- grit in the actuator seals ---------------------------------------
    // Anyone outside in a blowing storm — daredevils with the shelter rule
    // off, or rovers caught in transit — grinds condition away.
    const localWear = state.weather.localIntensity(r.x, r.z);
    if (localWear > 0.4 && !RoverSystem.nearCharger(state, r.x, r.z)) {
      r.condition = Math.max(0, r.condition - ROVER_WEAR_STORM_S * localWear * SIM_TICK);
    }

    /**
     * The low-battery floor is not a fixed fraction for field work: a rover
     * far from base must turn around while it still holds the power to get
     * home. A fixed 20 % reserve is 16 kWh on a mining rover — but the ride
     * back from a distant seam can cost 19, which is how rovers used to dig
     * themselves into stranded, battery-flat graves. The player chooses the
     * fraction (GDD §5's first automation rule); the ride-home maths clamps
     * it from below. An *idle* rover below its floor heads in too — the rule
     * is about the battery, not the to-do list.
     */
    const floorPct = r.rules.chargeFloorPct / 100;
    const homePt = RoverSystem.nearestChargerPoint(state, r.x, r.z);
    const homeCost = RoverSystem.travelKWh(r.x, r.z, homePt.x, homePt.z, def) * 1.15;
    const floor = Math.max(
      def.maxBatteryKWh * floorPct,
      Math.min(homeCost, def.maxBatteryKWh * 0.9),
    );
    const idle = r.command.type === 'idle' && r.pending.length === 0;
    if (!r.recharge && (!idle || r.battery <= floor)) {
      const low = r.battery <= floor && r.goal !== 'charge' && r.goal !== 'toCharge';
      if (low) {
        r.recharge = true;
        if (!r.lowBatteryNotified) {
          r.lowBatteryNotified = true;
          log(state, 'warn', `${r.label} is low on power — returning to charge.`);
        }
      } else if (r.battery > def.maxBatteryKWh * (floorPct + 0.25)) {
        r.lowBatteryNotified = false;
      }
    }

    if (r.recharge) {
      RoverSystem.doRecharge(state, r);
      return;
    }

    const cmd = r.command;
    switch (cmd.type) {
      case 'idle':
        if (MaintenanceSystem.holdsRover(state, r) || UpgradeSystem.holdsRover(state, r)) {
          enterIdle(r);
          break;
        }
        RoverSystem.goIdle(state, r, hooks);
        break;
      case 'moveTo':
        RoverSystem.doMoveTo(state, r, cmd.x, cmd.z);
        break;
      case 'mine': {
        const dep = state.world.deposits.find((d) => d.id === cmd.depositId);
        if (!dep || dep.amount <= 0) {
          if (cargoMass(r) > 0.01) {
            RoverSystem.beginUnload(state, r);
          } else {
            RoverSystem.finishTask(r);
            log(state, 'info', `${r.label}: deposit exhausted.`);
          }
          break;
        }
        RoverSystem.doMine(state, r, dep, hooks);
        break;
      }
      case 'construct': {
        const b = state.buildings.find((o) => o.id === cmd.buildingId);
        if (!b || (b.state === 'online' && !b.upgradeJob)) {
          if (b) b.workerId = null;
          RoverSystem.finishTask(r);
          break;
        }
        // Phase 9: walk-to-site, assemble, complete — ConstructionSystem
        hooks.constructSite(r, b);
        break;
      }
      case 'clean':
      case 'repair': {
        const b = state.buildings.find((o) => o.id === cmd.buildingId);
        if (!b || b.state !== 'online') {
          RoverSystem.finishTask(r);
          break;
        }
        RoverSystem.doService(state, r, b, cmd.type);
        break;
      }
      case 'recover': {
        RoverSystem.doRecover(state, r, cmd);
        break;
      }
      case 'salvage': {
        const p = state.world.pois.find((o) => o.id === cmd.poiId);
        if (!p || p.buried || isPickedClean(p)) {
          // Gone, buried, or already stripped: report and move on to the queue.
          if (cargoMass(r) > 0.01) RoverSystem.beginUnload(state, r);
          else RoverSystem.finishTask(r);
          break;
        }
        RoverSystem.doSalvage(state, r, p, hooks);
        break;
      }
      case 'unload': {
        RoverSystem.doUnload(state, r);
        break;
      }
      case 'wait': {
        enterIdle(r);
        cmd.seconds -= SIM_TICK;
        if (cmd.seconds <= 0) RoverSystem.finishTask(r);
        break;
      }
    }
  }

  /** Move a rover one step along its nav path, burning pack and condition. */
  static moveRover(state: ColonyState, r: Rover): void {
    if (r.phase !== 'moving' || r.goal === 'idle') return;
    const def = effectiveRoverDef(r);
    const hours = SIM_TICK * HOURS_PER_SEC;
    const dest = r.navPath[r.navI] ?? { x: r.gx, z: r.gz };
    const dx = dest.x - r.x;
    const dz = dest.z - r.z;
    const dist = Math.hypot(dx, dz);
    // Proximity multiplies cruise speed this tick. Detection is instant (no
    // ramp): either the bubble is clear and we cruise, or it isn't and we crawl.
    const speedMul = RoverSystem.proximitySpeedMul(state, r);
    const step = def.cruiseSpeed * speedMul * SIM_TICK;
    if (dist <= step + ARRIVE_EPS) {
      r.x = dest.x;
      r.z = dest.z;
      if (r.navI + 1 < r.navPath.length) {
        r.navI++;
        r.y = state.world.heightAt(r.x, r.z);
        return;
      }
      r.x = r.gx;
      r.z = r.gz;
      r.phase = 'working';
      state.domainEvents.push({ type: 'rover/moved', roverId: r.id, x: r.x, z: r.z });
      RoverSystem.onArrive(state, r);
      return;
    }
    const ux = dx / dist;
    const uz = dz / dist;
    r.x += ux * step;
    r.z += uz * step;
    r.heading = lerpAngle(r.heading, Math.atan2(ux, uz), 0.18);
    r.y = state.world.heightAt(r.x, r.z);
    // Move power scales with the actual speed so a crawl burns less of the pack
    // than a full-speed dash — the proximity slowdown is a brake, not a tax.
    r.battery = Math.max(0, r.battery - def.movePowerKw * speedMul * hours);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_MOVE_S * SIM_TICK);
    if (r.battery <= 0) RoverSystem.disable(state, r);
  }

  /**
   * The rover's battery is flat: it stops where it is and waits for a
   * jump-start. Its claims are released so another rover can pick the job up.
   */
  static disable(state: ColonyState, r: Rover): void {
    enterDisabled(r);
    r.routePaused = false;
    r.lightsActive = false; // nothing left to power them; the yellow strobe takes over
    RoverSystem.releaseReservations(state, r);
    state.domainEvents.push({
      type: 'rover/disabled',
      roverId: r.id,
      reason: 'battery-depleted',
    });
    log(state, 'crit', `${r.label} is stranded — battery flat. Another rover can jump-start it.`);
  }

  // -------------------------------------------------------- task bodies ----

  /** Drive to a point and finish; the idle fallback is the caller's. */
  static doMoveTo(state: ColonyState, r: Rover, x: number, z: number): void {
    const dist = Math.hypot(x - r.x, z - r.z);
    if (dist > ARRIVE_EPS) {
      if (r.goal !== 'move' || r.phase !== 'moving') RoverSystem.setTravel(state, r, x, z, 'move');
    } else {
      RoverSystem.finishTask(r);
    }
  }

  /**
   * Idle rovers pour what fits, head for a depot with what does not, and top
   * themselves up if they happen to be parked on a charger.
   */
  static goIdle(state: ColonyState, r: Rover, hooks: RoverHostHooks): void {
    enterIdle(r);

    if (cargoMass(r) <= 0.01) {
      r.autoTask = false;
    }

    // Holding cargo the silos had no room for? Keep offering it — construction
    // and processing free up space continuously, so mass is never stranded.
    if (cargoMass(r) > 0.01 && hooks.canDeliverCargo(r)) {
      if (RoverSystem.nearDepot(state, r.x, r.z)) {
        // A parked rover pours in silence: the player did not order this, and
        // the "still holds cargo" warning belongs to the unload task below.
        LogisticsSystem.unloadCargo(state, r);
      } else {
        RoverSystem.beginUnload(state, r);
        return;
      }
    }
    // Parked at a charger, an idle rover tops itself up (grid permitting —
    // the actual energy transfer happens in PowerSystem.tick).
    if (RoverSystem.nearCharger(state, r.x, r.z) && r.battery < effectiveRoverDef(r).maxBatteryKWh - 1e-6) {
      // (idle, charging): parked on a pad and topping up — the goal stays
      // 'idle' because no charge *task* is running.
      r.phase = 'charging';
    }
  }

  /** Head for a charger and sit there until the pack is nearly full. */
  static doRecharge(state: ColonyState, r: Rover): void {
    const def = effectiveRoverDef(r);
    // A rover that limps home with a full hold empties it while it charges:
    // every charger sits on a depot, so there is no detour involved. Whatever
    // the silos have room for goes in now; whatever doesn't rides back out.
    RoverSystem.unloadWhileCharging(state, r);
    if (r.battery >= def.maxBatteryKWh * 0.98 && !r.sheltered) {
      r.recharge = false;
      enterIdle(r);
      return;
    }
    if (r.sheltered && RoverSystem.nearCharger(state, r.x, r.z)) {
      // Storm shelter: parked and plugged in until the sky clears, however
      // full the battery is.
      enterCharge(r);
      return;
    }
    if (RoverSystem.nearCharger(state, r.x, r.z)) {
      enterCharge(r);
    } else if (r.goal !== 'toCharge') {
      const pt = RoverSystem.nearestChargerPoint(state, r.x, r.z);
      RoverSystem.setTravel(state, r, pt.x, pt.z, 'toCharge');
    }
  }

  /**
   * Pour whatever fits out of a recharging rover's hold. Runs every tick the
   * rover spends heading in or plugged in, so cargo that arrives while the
   * silo is full still drains away the moment consumption frees some room —
   * the rover always rolls back out to its job as empty as the colony allows.
   */
  static unloadWhileCharging(state: ColonyState, r: Rover): void {
    if (cargoMass(r) <= 0.01 || !RoverSystem.nearDepot(state, r.x, r.z)) return;
    const { moved, blocked } = LogisticsSystem.unloadCargo(state, r);
    if (moved > 0.01) {
      log(state, 'ok', `${r.label} delivered ${Math.round(moved)} kg to storage.`);
      r.blockNotified = false;
    }
    if (blocked && cargoMass(r) > 0.01 && !r.blockNotified) {
      log(state, 'warn', `${r.label} still holds cargo — those silos are full.`);
      r.blockNotified = true;
    }
  }

  /**
   * Rehydrate execution state for a restored colony (roadmap Phase 11).
   *
   * A save carries the *task*, never `goal`/`phase`: a restored rover resumes
   * at rest. This re-applies the one rule that is already true before the
   * first tick — a partially-charged rover parked on a charger is charging.
   * It lives here, next to the tick rules it has to agree with, rather than
   * inline in `Simulation.restore`.
   */
  static rehydrate(state: ColonyState): void {
    for (const r of state.rovers) {
      if (r.battery <= 0) continue;
      if (r.battery >= effectiveRoverDef(r).maxBatteryKWh - 1e-6) continue;
      if (RoverSystem.nearCharger(state, r.x, r.z)) r.phase = 'charging';
    }
  }

  /**
   * Give a rover a nav path to a target and a goal to name it by. Keeps an
   * in-flight path: callers (beginUnload, doMine) used to rewrite gx/gz every
   * tick, which was fine for a straight line and fatal once the first A*
   * waypoint is the current cell centre.
   */
  static setTravel(state: ColonyState, r: Rover, tx: number, tz: number, goal: RoverGoal): void {
    if (
      r.phase === 'moving' &&
      r.goal === goal &&
      r.navPath.length > 0 &&
      Math.hypot((r.navPath[r.navPath.length - 1]?.x ?? tx) - tx, (r.navPath[r.navPath.length - 1]?.z ?? tz) - tz) < 2
    ) {
      return;
    }
    enterTravel(r, goal);
    r.navPath = state.world.findPath(r.x, r.z, tx, tz) ?? [{ x: tx, z: tz }];
    r.navI = 0;
    const last = r.navPath[r.navPath.length - 1] ?? { x: tx, z: tz };
    r.gx = last.x;
    r.gz = last.z;
  }

  /**
   * True when this rover is inside the colony yard — the pad and its approach
   * lanes. Proximity is stricter here because the yard is a crowded return path.
   */
  static inColonyYard(x: number, z: number): boolean {
    return Math.hypot(x - SPAWN_X, z - SPAWN_Z) <= ROVER_COLONY_YARD_M;
  }

  /**
   * Hull clearance (metres) to the nearest obstacle the rover must watch for
   * while moving: other rovers, buildings, the landing pod, and discovered
   * sites still on the ground. Measured from hull to hull
   * (`centreDist − selfR − otherR`), so the issue's "5 feet" sits *outside*
   * the chassis rather than inside it.
   *
   * The destination of the current goal is skipped when the rover is already
   * within arrival reach of it — otherwise a builder crawling up to a site,
   * or a rescuer closing on a stranded rover, would slow forever and never
   * finish the job. Open terrain (no obstacle inside a very long radius)
   * returns Infinity.
   */
  static nearestObstacleClearance(state: ColonyState, r: Rover): number {
    const selfR = effectiveRoverDef(r).radius;
    let best = Infinity;

    // ---- other rovers ------------------------------------------------------
    for (const o of state.rovers) {
      if (o.id === r.id) continue;
      // A recover target is the job, not an obstacle, once the rescuer is
      // inside the hook-up radius — doRecover arrives at 6 m centre-to-centre.
      if (
        r.goal === 'toRecover' &&
        r.command.type === 'recover' &&
        r.command.roverId === o.id
      ) {
        continue;
      }
      const d = Math.hypot(o.x - r.x, o.z - r.z) - selfR - effectiveRoverDef(o).radius;
      if (d < best) best = d;
    }

    // ---- landing pod -------------------------------------------------------
    // The pad is a real body the fleet parks against. Skip it only when the
    // rover is heading in to charge or unload *and* already inside the pad's
    // arrival ring — those goals intentionally terminate on the pad.
    {
      const padClear = Math.hypot(SPAWN_X - r.x, SPAWN_Z - r.z) - selfR - POD_RADIUS;
      const arrivingHome =
        (r.goal === 'toCharge' || r.goal === 'toDepot') &&
        Math.hypot(SPAWN_X - r.x, SPAWN_Z - r.z) <= POD_RADIUS + 6;
      if (!arrivingHome && padClear < best) best = padClear;
    }

    // ---- buildings ---------------------------------------------------------
    for (const b of state.buildings) {
      const bR = effectiveBuildingDef(b).radius;
      const centre = Math.hypot(b.x - r.x, b.z - r.z);
      // Skip the structure this rover is actively driving to, once it is
      // inside the task's arrival reach — otherwise the crawl never ends and
      // the builder / cleaner / unloader never starts work.
      const targeting =
        ((r.goal === 'toSite' || r.goal === 'toService') && r.gid === b.id) ||
        (r.goal === 'toDepot' &&
          effectiveBuildingDef(b).storagePerResourceKg > 0 &&
          RoverSystem.runnable(b));
      const arriveReach = bR + 5;
      if (targeting && centre <= arriveReach) continue;
      const d = centre - selfR - bR;
      if (d < best) best = d;
    }

    // ---- discovered sites still on the ground ------------------------------
    // Settlement markers and buried drops are not physical obstacles; a live
    // wreck or a landed container is.
    for (const p of state.world.pois) {
      if (!p.discovered || p.buried) continue;
      if (p.kind === 'settlementSite') continue;
      const pR = 4; // rough footprint of a wreck / drop container
      const centre = Math.hypot(p.x - r.x, p.z - r.z);
      if (r.goal === 'toSalvage' && r.gid === p.id && centre <= pR + 5) continue;
      const d = centre - selfR - pR;
      if (d < best) best = d;
    }

    return best;
  }

  /**
   * Speed multiplier from proximity awareness (issue #11). Returns 1 when the
   * road is clear; drops immediately to a crawl once anything sits inside the
   * hull-clearance bubble. The colony yard uses a wider bubble and a slower
   * crawl. Never zero — a stuck pair must still inch so they cannot lock
   * nose-to-nose forever.
   */
  static proximitySpeedMul(state: ColonyState, r: Rover): number {
    const yard = RoverSystem.inColonyYard(r.x, r.z);
    const clearance = yard
      ? ROVER_PROXIMITY_COLONY_CLEARANCE_M
      : ROVER_PROXIMITY_CLEARANCE_M;
    const gap = RoverSystem.nearestObstacleClearance(state, r);
    if (gap >= clearance) return 1;
    return yard ? ROVER_PROXIMITY_COLONY_SPEED_MUL : ROVER_PROXIMITY_SPEED_MUL;
  }

  /** Arrival hands control to the goal's working phase. */
  static onArrive(state: ColonyState, r: Rover): void {
    r.y = state.world.heightAt(r.x, r.z);
    switch (r.goal) {
      case 'toCharge':
        enterCharge(r);
        break;
      case 'toSite': {
        const b = state.buildings.find((o) => o.id === r.gid);
        if (b) {
          enterWork(r, 'build');
        } else {
          // Defensive: nothing removes a building without releasing its crew
          // (`ConstructionSystem.demolish` does), but a bare `goal = 'idle'`
          // here would leave the arrival's `phase='working'` behind it.
          enterIdle(r);
        }
        break;
      }
      case 'toService':
        enterWork(r, 'service');
        break;
      case 'toSalvage':
        enterWork(r, 'salvage');
        break;
      case 'toDepot':
        RoverSystem.tryUnload(state, r);
        break;
      case 'move': {
        if (r.command.type === 'moveTo') r.command = { type: 'idle' };
        enterIdle(r);
        break;
      }
      default:
        enterIdle(r);
    }
  }

  // ------------------------------------------------------------ mining ----

  /**
   * One tick of a mining task: park (or resume) the haul route, bail out when
   * the hold is as full as the colony can take, walk to the seam, then dig.
   */
  static doMine(state: ColonyState, r: Rover, dep: Deposit, hooks: RoverHostHooks): void {
    const def = effectiveRoverDef(r);
    const hours = SIM_TICK * HOURS_PER_SEC;
    const onRoute = r.command.type === 'mine' && !!r.command.repeat;

    /**
     * A haul route parks at the depot while the silo has no room for its
     * cargo, and sets out again the moment consumption frees some up. Without
     * this a full silo turns the route into a depot ping-pong.
     */
    const stuck = cargoMass(r) > 0.01 ? !hooks.canDeliverCargo(r) : LogisticsSystem.room(state, dep.resource) < ROUTE_RESUME_ROOM_KG;
    if (onRoute && stuck) {
      enterIdle(r);
      r.routePaused = true;
      return;
    }
    r.routePaused = false;

    /**
     * Stop when the load is worth hauling home. For an automatic run that
     * means "as much as the colony can actually accept" — a 1.5 t rover should
     * not sit at a rock filling up when the silo can only take 150 kg.
     */
    const autoTarget = r.autoTask
      ? Math.max(60, Math.min(def.capacityKg, LogisticsSystem.room(state, dep.resource)))
      : def.capacityKg;
    if (cargoMass(r) >= Math.min(def.capacityKg, autoTarget) - 1e-6) {
      RoverSystem.beginUnload(state, r);
      return;
    }
    const reach = dep.radius + 2.6;
    const dist = Math.hypot(dep.x - r.x, dep.z - r.z);
    if (dist > reach) {
      if (r.goal !== 'mine' || r.phase !== 'moving') RoverSystem.setTravel(state, r, dep.x, dep.z, 'mine');
      return;
    }
    RoverSystem.claimDeposit(state, r, dep.id);
    enterWork(r, 'mine');
    const rate =
      RESOURCES[dep.resource].mineRateKg *
      def.mineSpeedMul *
      state.weather.workMultiplierAt(r.x, r.z) *
      RoverSystem.roverWorkMul(r);
    const gained = Math.min(rate * SIM_TICK, dep.amount, def.capacityKg - cargoMass(r));
    if (gained > 0) {
      dep.amount -= gained;
      r.cargo[dep.resource] += gained;
    }
    r.battery = Math.max(0, r.battery - def.workPowerKw * hours);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * SIM_TICK);
    if (r.battery <= 0) RoverSystem.disable(state, r);
    if (dep.amount <= 0.01) {
      log(state, 'info', `${RESOURCES[dep.resource].label} deposit exhausted.`);
    }
  }

  /** Head for the nearest online warehouse (the pod is the fallback). */
  static beginUnload(state: ColonyState, r: Rover): void {
    let best = { x: SPAWN_X, z: SPAWN_Z };
    let bestD = Math.hypot(SPAWN_X - r.x, SPAWN_Z - r.z);
    for (const w of RoverSystem.onlineWarehouses(state)) {
      const d = Math.hypot(w.x - r.x, w.z - r.z);
      if (d < bestD) {
        bestD = d;
        best = { x: w.x, z: w.z };
      }
    }
    RoverSystem.setTravel(state, r, best.x, best.z, 'toDepot');
  }

  /**
   * Pour out what fits and decide what the task does next: a repeat route or
   * a plain player mining run rolls back out to the seam, a salvage run keeps
   * going while the site has anything left, and an automatic run is
   * single-trip by design.
   */
  static tryUnload(state: ColonyState, r: Rover): void {
    if (!RoverSystem.nearDepot(state, r.x, r.z)) {
      RoverSystem.setTravel(state, r, SPAWN_X, SPAWN_Z, 'toDepot');
      return;
    }
    const { moved, blocked } = LogisticsSystem.unloadCargo(state, r);
    if (moved > 0.01) {
      log(state, 'ok', `${r.label} delivered ${Math.round(moved)} kg to storage.`);
      r.blockNotified = false;
    }
    if (blocked && cargoMass(r) > 0.01 && !r.blockNotified) {
      log(state, 'warn', `${r.label} still holds cargo — those silos are full.`);
      r.blockNotified = true;
    }
    const cmd = r.command;
    if (cmd.type === 'mine') {
      const dep = state.world.deposits.find((d) => d.id === cmd.depositId);
      const seamDry = !dep || dep.amount <= 0.01;
      if (cmd.repeat && !seamDry) {
        // The route loops: straight back out to the seam (or, if the silo is
        // full, doMine parks the rover here until there is room again).
        enterIdle(r);
        return;
      }
      if (!r.autoTask && !seamDry) {
        // A plain player-ordered mining run keeps going until the seam is dry.
        enterIdle(r);
        return;
      }
      if (cmd.repeat && seamDry) {
        log(state, 'ok', `${r.label}'s haul route complete — the seam is worked out.`);
      }
    }
    if (cmd.type === 'salvage') {
      const p = state.world.pois.find((o) => o.id === cmd.poiId);
      // A site too big for one hold keeps the rover running — out, back, out
      // again — until it is stripped, exactly like a player-ordered mining run
      // that has not finished its seam.
      if (p && !p.buried && !isPickedClean(p)) {
        enterIdle(r);
        return;
      }
    }
    // Automatic runs are single-trip: dropping the load returns the rover to
    // the pool so the scheduler can re-decide what the colony needs *now*.
    RoverSystem.finishTask(r);
  }

  // ------------------------------------------------- cleaning & repair ----

  /**
   * Storm-era maintenance (GDD §5's CLEAN and REPAIR tasks). Cleaning scrubs
   * dust off a solar array; repair restores structural health and re-commissions
   * a building the storm tripped offline. Both are deliberately slow rover
   * work — the recovery should cost the player something, not a click.
   */
  static doService(state: ColonyState, r: Rover, b: Building, kind: 'clean' | 'repair'): void {
    const def = effectiveBuildingDef(b);
    const dist = Math.hypot(b.x - r.x, b.z - r.z);
    const siteReach = def.radius + 4;
    const hours = SIM_TICK * HOURS_PER_SEC;
    if (dist > siteReach) {
      r.gid = b.id;
      if (r.goal !== 'toService' || r.phase === 'idle') {
        RoverSystem.setTravel(state, r, b.x, b.z, 'toService');
      }
      return;
    }
    r.gid = b.id;
    enterWork(r, 'service');

    // A worn rover works slower — and the work wears it further.
    const mul = RoverSystem.roverWorkMul(r);
    if (kind === 'repair') {
      b.health = Math.min(BUILDING_MAX_HEALTH, b.health + ROVER_REPAIR_RATE * mul * SIM_TICK);
      if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) {
        b.damaged = false;
        log(state, 'ok', `${def.label} repaired and back online.`);
        recomputeCapacitiesState(state);
      }
    } else {
      b.cleanliness = Math.min(1, b.cleanliness + ROVER_CLEAN_RATE * mul * SIM_TICK);
    }
    r.battery = Math.max(0, r.battery - effectiveRoverDef(r).workPowerKw * hours * 0.5);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * 0.5 * SIM_TICK);
    if (r.battery <= 0) RoverSystem.disable(state, r);

    const done =
      kind === 'repair'
        ? b.health >= BUILDING_MAX_HEALTH - 0.5
        : b.cleanliness >= 0.999;
    if (done) {
      log(
        state,
        'ok',
        kind === 'repair'
          ? `${r.label} finished repairing the ${def.label}.`
          : `${r.label} cleaned the ${def.label} array — output restored.`,
      );
      RoverSystem.finishTask(r);
    }
  }

  /**
   * The SALVAGE task (GDD §05, §06, §10): drive out to a site, cut it apart, and
   * fill the hold. Bulk salvage rides home through the ordinary haul-and-unload
   * chain, so a wreck 400 m out is a logistics problem rather than a special
   * case — and a site too big for one hold keeps the rover running, exactly like
   * a seam that a plain mining order has not finished.
   *
   * Surviving cells do not ride home in the hold; they go into the grid store
   * once the bulk cargo is stripped. Drops contain no fluids: exposed water and
   * food would freeze, and the current logistics model cannot recover fluids in
   * the field.
   */
  static doSalvage(state: ColonyState, r: Rover, p: Poi, hooks: RoverHostHooks): void {
    const def = effectiveRoverDef(r);
    const hours = SIM_TICK * HOURS_PER_SEC;
    const reach = SALVAGE_REACH;

    /**
     * A full hold turns for home and *keeps* its depot heading. This check
     * must run before the distance check below — the exact order `doMine`
     * uses. The at-site branch used to sit in front of it and clobbered
     * goal/phase back to `salvage` every tick before re-calling beginUnload,
     * which re-pathed from scratch each tick (the rover never got past the
     * first A* waypoint and froze just outside the reach ring); and once a
     * loaded rover crossed the ring, the far branch turned it straight back
     * to the site — the "hauling to storage ↔ heading to the site"
     * ping-pong.
     */
    if (def.capacityKg - cargoMass(r) <= 0.01) {
      if (RoverSystem.nearDepot(state, r.x, r.z)) {
        // Full silos park the rover at the depot — retrying as consumption
        // frees room — with the same "Route paused" read a stuck haul
        // route gives, instead of twiddling depot paths every tick.
        r.routePaused = !hooks.canDeliverCargo(r);
        RoverSystem.tryUnload(state, r);
      } else {
        RoverSystem.beginUnload(state, r);
      }
      return;
    }
    r.routePaused = false;

    const dist = Math.hypot(p.x - r.x, p.z - r.z);
    if (dist > reach) {
      r.gid = p.id;
      if (r.goal !== 'toSalvage' || r.phase !== 'moving') RoverSystem.setTravel(state, r, p.x, p.z, 'toSalvage');
      return;
    }
    r.gid = p.id;
    enterWork(r, 'salvage');

    const room = def.capacityKg - cargoMass(r);
    const rate = salvageRateKgS(p.kind) * state.weather.workMultiplierAt(r.x, r.z) * RoverSystem.roverWorkMul(r);
    const { takenKg, perResource } = ExplorationSystem.takeSalvage(p, room, rate, SIM_TICK);
    for (const res of ALL_RESOURCES) {
      const kg = perResource[res];
      if (kg && kg > 0) r.cargo[res] += kg;
    }
    r.battery = Math.max(0, r.battery - def.workPowerKw * hours);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * SIM_TICK);
    if (r.battery <= 0) RoverSystem.disable(state, r);

    if (!isPickedClean(p)) {
      return;
    }
    ExplorationSystem.recoverSiteCells(state, p);
    const label = POI_KINDS[p.kind].label;
    state.domainEvents.push({
      type: 'salvage/recovered',
      poiId: p.id,
      roverId: r.id,
      kg: takenKg,
    });
    log(
      state,
      'ok',
      p.kind === 'supplyDrop'
        ? `${r.label} recovered the ${p.manifest.toLowerCase()} drop — ${Math.round(takenKg)} kg aboard, and the site is empty.`
        : `${r.label} stripped the ${label} — ${Math.round(takenKg)} kg aboard. Nothing left out here.`,
    );
    RoverSystem.finishTask(r);
  }


  /**
   * The RECOVER task (TDD §8): drive out to a battery-flat rover, hook up the
   * jumper cables, and give it enough charge to get home — while keeping
   * enough to get the rescuer back too. Pure energy maths, no vibes.
   */
  static doRecover(
    state: ColonyState,
    r: Rover,
    cmd: { type: 'recover'; roverId: number; give?: number; given?: number },
  ): void {
    const s = state.rovers.find((o) => o.id === cmd.roverId);
    if (!s || s.phase !== 'disabled') {
      // Already rescued (or gone) — nothing to do.
      RoverSystem.finishTask(r);
      return;
    }
    const dist = Math.hypot(s.x - r.x, s.z - r.z);
    if (dist > RECOVER_REACH) {
      if (r.goal !== 'toRecover' || r.phase === 'idle') {
        RoverSystem.setTravel(state, r, s.x, s.z, 'toRecover');
      }
      return;
    }
    r.gid = s.id;
    enterWork(r, 'recover');

    if (cmd.give === undefined) {
      // First hookup: size the transfer honestly.
      const sDef = effectiveRoverDef(s);
      const home = RoverSystem.nearestChargerPoint(state, s.x, s.z);
      const need = Math.max(
        RoverSystem.travelKWh(s.x, s.z, home.x, home.z, sDef) * 1.25,
        sDef.maxBatteryKWh * 0.15,
      );
      const rDef = effectiveRoverDef(r);
      const rHome = RoverSystem.nearestChargerPoint(state, s.x, s.z); // the rescuer walks back from there
      const reserve = Math.max(
        rDef.maxBatteryKWh * (r.rules.chargeFloorPct / 100),
        RoverSystem.travelKWh(s.x, s.z, rHome.x, rHome.z, rDef) * 1.15,
      );
      const spare = r.battery - reserve;
      if (spare < Math.min(need, RECOVER_MIN_GIVE_KWH)) {
        log(
          state,
          'warn',
          `${r.label} can't spare enough charge to jump-start ${s.label} — charge up first.`,
        );
        RoverSystem.finishTask(r);
        return;
      }
      cmd.give = Math.min(need, spare);
      cmd.given = 0;
    }

    // Trickle the cables over a couple of seconds so it reads as work.
    const step = Math.min(RECOVER_TRANSFER_KW * SIM_TICK, cmd.give - (cmd.given ?? 0));
    const got = Math.min(step, Math.max(0, r.battery));
    r.battery -= got;
    s.battery += got;
    cmd.given = (cmd.given ?? 0) + got;

    if (cmd.given >= cmd.give - 1e-6) {
      enterIdle(s);
      s.command = { type: 'idle' };
      s.pending = [];
      s.recharge = true;
      s.lowBatteryNotified = true; // it *is* low; don't warn again on the way in
      state.domainEvents.push({
        type: 'rover/repaired',
        roverId: s.id,
        reason: 'jump-start',
      });
      log(
        state,
        'ok',
        `${r.label} jump-started ${s.label} — ${cmd.given.toFixed(1)} kWh handed over. Both heading in to charge.`,
      );
      r.recharge = true;
      RoverSystem.finishTask(r);
    }
  }

  /**
   * The UNLOAD task: drive in and pour out whatever the silos have room for.
   * tryUnload does the pouring (and the log lines); a non-mine command falls
   * straight through to finishTask there. Cargo that doesn't fit — full silos
   * — rides on: the idle fallback keeps offering it as room frees up.
   */
  static doUnload(state: ColonyState, r: Rover): void {
    if (cargoMass(r) <= 0.01) {
      RoverSystem.finishTask(r);
      return;
    }
    if (RoverSystem.nearDepot(state, r.x, r.z)) {
      RoverSystem.tryUnload(state, r);
    } else if (r.goal !== 'toDepot' || r.phase === 'idle') {
      RoverSystem.beginUnload(state, r);
    }
  }
}


/** Append a simulation log line — the same call `Simulation.event` makes. */
function log(state: ColonyState, severity: Severity, text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}
