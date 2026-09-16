/**
 * Phase 9 — Extract ConstructionSystem
 *
 * Goal per roadmap §13: separate construction rules and progress from the
 * main simulation. No redesign — the siting rule was already extracted
 * (`evaluateSite` in `sim/rules.ts`, shared with the host mirror so the build
 * ghost can never disagree with the sim); what was missing is a named owner
 * for the *job* around it:
 *
 *     input      — ColonyState (buildings as sites, storage as the material
 *                  ledger, the fleet, weather for work rates, the site's
 *                  remaining cost and the definition's cost/buildTime)
 *        ↓
 *     resolver   — verdict (may it be sited) / tickSiteMaterials (pour what
 *                  is available into the site) / assignBuilders (who builds
 *                  it) / build (assemble it) / complete (switch it on)
 *        ↓
 *     output     — site list, remainingCost, needsMaterials, progress,
 *                  workerId, building state, storage, capacities, alerts
 *
 * **The siting authority stays in the simulation.** `verdict` delegates to
 * the same `evaluateSite` the sim always called, with the live world and the
 * live building/deposit lists. Slope, terrain, clearance and deposit checks
 * are not duplicated here and must never move to the UI (roadmap §13
 * "Preserve"): the build ghost answers optimistically from the mirror, but
 * `building/place` re-checks here before anything is sited.
 *
 * Cross-domain seams — construction triggers these but does not own them:
 *   - {@link ConstructionHostHooks.setTravel} / {@link ConstructionHostHooks.finishTask}
 *     / {@link ConstructionHostHooks.autoAssign} / {@link ConstructionHostHooks.disableRover}
 *     / {@link ConstructionHostHooks.roverWorkMul} — the rover is the worker,
 *     and pathing, task lifecycle and wear are RoverSystem's (Phase 10).
 *   - {@link ConstructionHostHooks.canDeliverCargo} — "is this rover stuck on
 *     cargo the silos cannot take" is a haul question (LogisticsSystem,
 *     Phase 13).
 *   - Capacity recompute is *not* a seam: `recomputeCapacitiesState` is a pure
 *     state function, so completion calls it directly.
 *
 * Phase 7 left `completeBuilding`'s implementor on Simulation behind
 * `LifeSupportHostHooks.completeBuilding` (a colonist assisting a build).
 * This phase absorbs that implementor — the contract on the life-support side
 * is unchanged, Simulation just points it here.
 *
 * Determinism: no RNG, no wall clock — the same sites, same stores, same
 * fleet and same weather always assemble at the same rate. Builder choice is
 * a stable sort (nearest, then lowest id), so it cannot wobble between runs.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import { recomputeCapacitiesState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { remainingCostTotal } from '../state/BuildingState';
import type { Rover, RoverGoal, RoverTask } from '../state/RoverState';
import { cargoMass } from '../state/RoverState';
import { evaluateSite } from '../rules';
import type { BuildingKind, ResourceAmounts } from '../defs';
import { BUILDINGS, ROVERS, RESOURCES, ALL_RESOURCES, emptyAmounts } from '../defs';
import type { Severity } from '../alerts';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  BUILDING_MAX_HEALTH,
  ROVER_WEAR_WORK_S,
} from '../config';

/** Distance inside which an online workshop lends tools to a site. */
const WORKSHOP_ASSIST_RADIUS = 70;
/** The speed-up an online, enabled workshop within that radius grants. */
const WORKSHOP_ASSIST_MUL = 1.35;
/** A builder works from this far out (structure radius plus slack). */
const SITE_REACH_SLACK = 4;

/**
 * Side effects construction triggers but does not own. Implemented by
 * Simulation against the machinery that already lives there, so no second
 * source of truth appears; RoverSystem (Phase 10) and LogisticsSystem
 * (Phase 13) will absorb the implementor, not the contract.
 */
export interface ConstructionHostHooks {
  /** Path a rover toward a goal (rover domain). */
  setTravel(r: Rover, x: number, z: number, goal: RoverGoal): void;
  /** The rover's active task is done: release it and re-plan (rover domain). */
  finishTask(r: Rover): void;
  /** The scheduler's assignment — always replaces the current task. */
  autoAssign(r: Rover, task: RoverTask): void;
  /** The rover's battery went flat mid-job (rover/failure domain). */
  disableRover(r: Rover): void;
  /** Condition-scaled work rate for this rover (rover domain). */
  roverWorkMul(r: Rover): number;
  /**
   * True if any of this rover's cargo would currently fit in storage — the
   * haul question that decides whether a loaded rover is *busy* or *stuck*
   * (logistics domain).
   */
  canDeliverCargo(r: Rover): boolean;
}

export class ConstructionSystem {
  // ------------------------------------------------------------ siting ----

  /**
   * The authoritative siting verdict: `null` when the site is legal,
   * otherwise the reason it is not. Delegates to the one `evaluateSite` the
   * host mirror also runs, against the *live* world — this is the call
   * `building/place` re-checks before anything is sited.
   */
  static verdict(state: ColonyState, kind: BuildingKind, x: number, z: number): string | null {
    return evaluateSite(kind, x, z, {
      ground: state.world,
      buildings: state.buildings,
      deposits: state.world.deposits,
    });
  }

  /**
   * Site a building. Returns the new site, or `null` (with the reason logged)
   * when the ground refuses it. A site starts hungry: its full cost is
   * outstanding until {@link tickSiteMaterials} pours storage into it.
   */
  static place(state: ColonyState, kind: BuildingKind, x: number, z: number): Building | null {
    const err = ConstructionSystem.verdict(state, kind, x, z);
    if (err) {
      ConstructionSystem.log(state, 'warn', err);
      return null;
    }
    const def = BUILDINGS[kind];
    const b = ConstructionSystem.newBuilding(state, kind, x, z);
    state.buildings.push(b);
    ConstructionSystem.log(state, 'info', `${def.label} sited — assigning a builder.`);
    return b;
  }

  /**
   * Developer backdoor: fab a finished building out of thin air. Same siting
   * authority as {@link place}, no cost outstanding, and it goes through
   * {@link complete} so the capacity recompute and the "+storage / +kW" log
   * line are identical to an ordinary finish.
   */
  static devSpawn(state: ColonyState, kind: BuildingKind, x: number, z: number): Building | null {
    const err = ConstructionSystem.verdict(state, kind, x, z);
    if (err) {
      ConstructionSystem.log(state, 'warn', err);
      return null;
    }
    const b = ConstructionSystem.newBuilding(state, kind, x, z);
    b.state = 'building';
    b.remainingCost = emptyAmounts();
    b.needsMaterials = false;
    b.progress = 1;
    state.buildings.push(b);
    ConstructionSystem.complete(state, b);
    return b;
  }

  /** A fresh site record. Ids come from the state's own counter. */
  private static newBuilding(
    state: ColonyState,
    kind: BuildingKind,
    x: number,
    z: number,
  ): Building {
    const def = BUILDINGS[kind];
    return {
      id: state.nextId++,
      kind,
      x,
      z,
      rot: 0,
      state: 'site',
      remainingCost: { ...def.cost },
      needsMaterials: false,
      progress: 0,
      buildTime: def.buildTime,
      workerId: null,
      enabled: true,
      powerSat: 1,
      throughput: 0,
      genKw: 0,
      loadKw: 0,
      idleReason: '',
      health: BUILDING_MAX_HEALTH,
      cleanliness: 1,
      damaged: false,
      assembly: null,
      level: 1,
    };
  }

  // --------------------------------------------------------- materials ----

  /**
   * Pour whatever is available in storage into every unfinished site's
   * remaining cost, and keep the "awaiting materials" alert honest. Runs
   * before builder assignment (TDD §4 step 8) so a site stocked this tick can
   * be staffed this tick.
   */
  static tickSiteMaterials(state: ColonyState): void {
    for (const b of state.buildings) {
      if (b.state === 'online') continue;
      if (remainingCostTotal(b) <= 0) {
        b.needsMaterials = false;
        continue;
      }
      const took = ConstructionSystem.commitAvailableMaterials(state, b);
      if (took > 0 && b.state === 'site') {
        ConstructionSystem.log(
          state,
          'info',
          `Materials delivered to the ${BUILDINGS[b.kind].label} site.`,
        );
      }
      const left = remainingCostTotal(b);
      b.needsMaterials = left > 0;
      if (left > 0) {
        state.alerts.raise(
          `mats-${b.id}`,
          'warn',
          `${BUILDINGS[b.kind].label} awaiting materials`,
          `Still needs ${ConstructionSystem.missingList(b.remainingCost)}.`,
          state.simTime,
          state.clock.format(),
          b.id,
        );
      } else {
        state.alerts.clear(`mats-${b.id}`, state.simTime, state.clock.format());
        ConstructionSystem.log(
          state,
          'ok',
          `${BUILDINGS[b.kind].label} site fully stocked — ready to assemble.`,
        );
      }
    }
  }

  /**
   * Pour whatever is available in storage into a site's remaining cost.
   * Returns the mass committed this tick.
   */
  static commitAvailableMaterials(state: ColonyState, b: Building): number {
    let took = 0;
    for (const res of ALL_RESOURCES) {
      const need = b.remainingCost[res];
      if (need <= 0) continue;
      const give = Math.min(need, state.storage[res]);
      if (give <= 0) continue;
      state.storage[res] -= give;
      b.remainingCost[res] = Math.max(0, need - give);
      took += give;
    }
    return took;
  }

  /** True when storage covers every line of a cost. */
  static hasMaterials(state: ColonyState, amounts: ResourceAmounts): boolean {
    for (const res of ALL_RESOURCES) {
      if (amounts[res] > 0 && state.storage[res] < amounts[res]) return false;
    }
    return true;
  }

  /** Take a cost out of storage (floored at zero). */
  static consumeMaterials(state: ColonyState, amounts: ResourceAmounts): void {
    for (const res of ALL_RESOURCES) {
      state.storage[res] = Math.max(0, state.storage[res] - amounts[res]);
    }
  }

  /** Player-facing list of what a cost still needs: "40 kg Regolith, …". */
  static missingList(amounts: ResourceAmounts): string {
    const parts: string[] = [];
    for (const res of ALL_RESOURCES) {
      if (amounts[res] > 0.01) {
        parts.push(`${Math.ceil(amounts[res])} kg ${RESOURCES[res].label}`);
      }
    }
    return parts.join(', ') || 'materials';
  }

  // ------------------------------------------------------- worker choice ----

  /**
   * Staff the unfinished sites: nearest capable rover that is genuinely free,
   * one worker per site. Construction outranks an *automatic* supply run but
   * never a player order.
   */
  static assignBuilders(state: ColonyState, hooks: ConstructionHostHooks): void {
    const sites = state.buildings.filter((b) => b.state !== 'online');
    for (const b of sites) {
      if (b.workerId !== null) {
        // Release a worker that wandered off (recharging, reassigned, etc).
        const w = state.rovers.find((r) => r.id === b.workerId);
        if (
          !w ||
          w.phase === 'disabled' ||
          !(w.command.type === 'construct' && w.command.buildingId === b.id)
        ) {
          b.workerId = null;
        } else {
          continue;
        }
      }
      // Only fully-stocked sites get a builder; delivery is someone else's job.
      if (remainingCostTotal(b) > 0) continue;

      const capable = state.rovers
        .filter(
          (r) =>
            r.phase !== 'disabled' &&
            !r.recharge &&
            // Construction outranks an automatic supply run, never a player order.
            (r.command.type === 'idle' || r.autoTask) &&
            /**
             * Don't pull a rover off a delivery it can still complete — but a
             * rover sitting on cargo the silos have no room for is *stuck*, not
             * busy, and must stay eligible for work. Otherwise a full silo
             * quietly disqualifies the whole fleet and construction deadlocks.
             */
            (cargoMass(r) <= 0.01 || !hooks.canDeliverCargo(r)) &&
            BUILDINGS[b.kind].buildableBy.includes(r.kind),
        )
        .sort(
          (a, c) =>
            Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z) ||
            a.id - c.id,
        );
      const worker = capable[0];
      if (!worker) continue;
      hooks.autoAssign(worker, { type: 'construct', buildingId: b.id });
      b.workerId = worker.id;
    }
  }

  // ---------------------------------------------------------- progress ----

  /**
   * One tick of a rover's construct task: walk to the site if it is not in
   * reach, then assemble. Materials are delivered by
   * {@link tickSiteMaterials}; a builder only assembles, and walks off a site
   * that is still hungry.
   */
  static build(state: ColonyState, r: Rover, b: Building, hooks: ConstructionHostHooks): void {
    const dist = Math.hypot(b.x - r.x, b.z - r.z);
    const siteReach = BUILDINGS[b.kind].radius + SITE_REACH_SLACK;
    const hours = SIM_TICK * HOURS_PER_SEC;
    if (dist > siteReach) {
      r.gid = b.id;
      if (r.goal !== 'toSite' || r.phase === 'idle') {
        hooks.setTravel(r, b.x, b.z, 'toSite');
      }
      return;
    }
    r.gid = b.id;
    r.goal = 'build';
    r.phase = 'working';
    r.statusText = 'Building';

    const def = BUILDINGS[b.kind];

    // Materials are delivered by tickSiteMaterials; a builder only assembles.
    if (remainingCostTotal(b) > 0) {
      if (b.workerId === r.id) b.workerId = null;
      hooks.finishTask(r);
      return;
    }
    if (b.state === 'site') {
      b.state = 'building';
      ConstructionSystem.log(state, 'info', `${r.label} began assembling the ${def.label}.`);
    }

    // A workshop within range lends tools and speeds the job up.
    let mul = 1;
    for (const w of state.buildings) {
      if (w.kind !== 'workshop' || w.state !== 'online' || !w.enabled) continue;
      if (Math.hypot(w.x - b.x, w.z - b.z) < WORKSHOP_ASSIST_RADIUS) {
        mul = WORKSHOP_ASSIST_MUL;
        break;
      }
    }

    const work =
      ROVERS[r.kind].buildPower *
      mul *
      state.weather.workMultiplierAt(r.x, r.z) *
      hooks.roverWorkMul(r);
    const before = b.progress;
    b.progress = Math.min(1, b.progress + (work * SIM_TICK) / b.buildTime);
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].workPowerKw * hours * 0.6);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * 0.7 * SIM_TICK);
    if (r.battery <= 0) hooks.disableRover(r);
    if (before < 1 && b.progress >= 1) {
      ConstructionSystem.complete(state, b);
      hooks.finishTask(r);
    }
  }

  /**
   * A structure is finished: switch it on, drop the worker, and let the grid
   * and silos learn about what just came online.
   */
  static complete(state: ColonyState, b: Building): void {
    if (b.state === 'online') return;
    b.state = 'online';
    b.progress = 1;
    b.workerId = null;
    recomputeCapacitiesState(state);
    const def = BUILDINGS[b.kind];
    const extras: string[] = [];
    if (def.storagePerResourceKg) extras.push(`+${def.storagePerResourceKg} kg per silo`);
    if (def.batteryKWh) extras.push(`grid +${def.batteryKWh} kWh`);
    if (def.powerProduceKw) extras.push(`+${def.powerProduceKw} kW peak`);
    ConstructionSystem.log(
      state,
      'ok',
      `${def.label} is online${extras.length ? ` — ${extras.join(', ')}` : ''}.`,
    );
  }

  /**
   * Complete a site instantly, for free (developer panel). Any rover walking a
   * construct task to it is released exactly like a demolition release.
   */
  static devComplete(state: ColonyState, id: number, hooks: ConstructionHostHooks): boolean {
    const b = state.buildings.find((x) => x.id === id);
    if (!b || b.state === 'online') return false;
    b.remainingCost = emptyAmounts();
    b.needsMaterials = false;
    state.alerts.clear(`mats-${b.id}`, state.simTime, state.clock.format());
    for (const r of state.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        hooks.finishTask(r);
      }
    }
    b.workerId = null;
    b.progress = 1;
    ConstructionSystem.complete(state, b);
    return true;
  }

  // ------------------------------------------------------- cancellation ----

  /**
   * Cancel an unfinished site (refunding what was already delivered) or
   * dismantle a standing structure. Either way the record leaves the colony
   * and any builder walking to it is released.
   */
  static demolish(state: ColonyState, buildingId: number, hooks: ConstructionHostHooks): void {
    const idx = state.buildings.findIndex((b) => b.id === buildingId);
    if (idx < 0) return;
    const b = state.buildings[idx];
    // Return whatever was already delivered to the site back to storage.
    if (b.state !== 'online') {
      const def = BUILDINGS[b.kind];
      let refunded = 0;
      for (const res of ALL_RESOURCES) {
        const committed = def.cost[res] - b.remainingCost[res];
        if (committed <= 0) continue;
        /**
         * Refund the full amount even if it overfills the silo. This material
         * *came out* of that silo, so putting it back can never be an exploit —
         * and quietly destroying a player's resources on cancel is far worse
         * than a temporarily over-full store, which drains as it gets used.
         *
         * Caveat found while extracting this (Phase 9), preserved not fixed:
         * the `recomputeCapacitiesState` call at the end of this method clamps
         * every silo back to capacity, so when the silo is *already full* the
         * refund is silently lost and the promise above does not hold. It does
         * hold in the ordinary case (room in the silo), and
         * `SimulationAssertions` still permits over-capacity storage on the
         * strength of this comment. Deciding which of the three is wrong is a
         * behavior change — see the roadmap's Phase 9 "quirks" block.
         */
        state.storage[res] += committed;
        refunded += committed;
      }
      ConstructionSystem.log(
        state,
        'info',
        `${def.label} site cancelled${refunded > 1 ? ` — ${Math.round(refunded)} kg recovered` : ''}.`,
      );
      state.alerts.clear(`mats-${b.id}`, state.simTime, state.clock.format());
    } else {
      ConstructionSystem.log(state, 'warn', `${BUILDINGS[b.kind].label} dismantled.`);
    }
    for (const r of state.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        hooks.finishTask(r);
      }
    }
    state.buildings.splice(idx, 1);
    recomputeCapacitiesState(state);
  }

  // ------------------------------------------------------------- plumbing ----

  private static log(state: ColonyState, severity: Severity, text: string): void {
    state.alerts.event(severity, text, state.simTime, state.clock.format());
  }
}
