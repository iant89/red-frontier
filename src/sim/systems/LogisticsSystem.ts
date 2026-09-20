/**
 * Phase 13 — Extract LogisticsSystem
 *
 * Goal per roadmap §17: make resource movement a first-class subsystem, with
 * **one authoritative owner** for resource accounting. Before this phase three
 * systems moved the same kilograms with their own arithmetic:
 *
 *   RoverSystem         three copies of "pour the hold into the silos"
 *   ConstructionSystem  site commits, the garage spend, the demolish refund
 *   ProductionSystem    the solid inputs a process consumes
 *
 * and the capacity rules (per-resource `_storageCapacity`, the deliberate
 * over-fill on a refund) lived in a comment in `SimulationAssertions` rather
 * than in code in one place. They all come through here now.
 *
 * ---------------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------------
 *
 *   pickups ─────────────►┌──────────────┐──────────────► deliveries
 *   mining, salvage       │  rover cargo │                unload at a depot
 *                         └──────────────┘
 *   production ──────────►┌──────────────┐──────────────► production inputs
 *   refunds ─────────────►│   storage    │──────────────► site commits
 *                         │ (per-resource│                garage assembly
 *                         │  capacity)   │
 *                         └──────────────┘
 *
 * Every arrow above is a method here. Storage is the one ledger: `capacity` /
 * `room` describe it; `store` / `take` move mass with the clamping rules;
 * `unloadCargo` / `loadCargo` move it through a rover's hold; `deliverToSite` /
 * `consumeMaterials` move it into a structure's cost; `refund` is the one
 * documented exception to the clamp.
 *
 * **Reservations.** A reservation is a claim on a *pickup*. Only deposits are
 * reserved today: a seam is claimed by the auto-run working it and released
 * when the rover drops the task ({@link LogisticsSystem.claimDeposit} and
 * friends), while a starving site uses a different mechanism entirely (its
 * lowered `remainingCost` is a production-style demand, not a claim). That
 * asymmetry is real and recorded rather than smoothed over: unifying the two
 * would change which rover gets which job — a behavior change, not an
 * extraction.
 *
 * ---------------------------------------------------------------------------
 * What deliberately does NOT live here
 * ---------------------------------------------------------------------------
 *   - **Fluid pools** (`state.pools`, `lifesupport.ts`'s `addFluid` /
 *     `takeFluid`). Phase 7 owns them and they are clamped on both sides; a
 *     future "fluids are a resource like any other" pass would fold them in,
 *     and doing it here would collide with that system's balance constants.
 *   - **Cargo capacity** (`ROVERS[kind].capacityKg`) is a rover property;
 *     {@link LogisticsSystem.loadCargo} enforces it while the rover's own
 *     rules about *what to pick up* stay in `RoverSystem`.
 *   - **The capacity computation** (`recomputeCapacitiesState`, Phase 2's):
 *     which buildings are online decides how big storage is. This module reads
 *     the result and enforces it; it does not decide it.
 *
 * Determinism: pure arithmetic over state, no RNG, no clock, no DOM.
 */

import { effectiveRoverDef } from '../engineering/upgrades';
import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import type { Rover } from '../state/RoverState';
import { cargoMass } from '../state/RoverState';
import { storageRoom } from '../state/ResourceState';
import type { ResourceAmounts, ResourceId } from '../defs';
import { ALL_RESOURCES, RESOURCES, ROVERS } from '../defs';

/**
 * Cross-domain effects the ledger triggers but does not own. The only one
 * today is the task side of a *forced* claim: a player order that takes a seam
 * from an automatic run finishes that run's task so it re-plans instead of
 * walking to a seam it no longer owns. Same shape as the other systems' hooks.
 */
export interface LogisticsHostHooks {
  finishTask(r: Rover): void;
}

export class LogisticsSystem {
  // -------------------------------------------------------- availability ----

  /** Storage capacity per resource (kg) — the ledger's one scale. */
  static capacity(state: ColonyState): number {
    return state._storageCapacity;
  }

  /** Free space for one resource (kg). */
  static room(state: ColonyState, res: ResourceId): number {
    return storageRoom(state.storage, state._storageCapacity, res);
  }

  /** Everything in storage (kg). */
  static total(state: ColonyState): number {
    let t = 0;
    for (const res of ALL_RESOURCES) t += state.storage[res];
    return t;
  }

  /** Capacity across every silo (kg). */
  static totalCapacity(state: ColonyState): number {
    return state._storageCapacity * ALL_RESOURCES.length;
  }

  /** True only when *every* silo is full (nothing can be unloaded at all). */
  static isFull(state: ColonyState): boolean {
    for (const res of ALL_RESOURCES) {
      if (LogisticsSystem.room(state, res) > 0.01) return false;
    }
    return true;
  }

  /** Resources whose silo is full — the useful warning. */
  static fullResources(state: ColonyState): ResourceId[] {
    return ALL_RESOURCES.filter((res) => LogisticsSystem.room(state, res) <= 0.01);
  }

  /** True if any of this rover's cargo would currently fit in storage. */
  static canDeliver(state: ColonyState, r: Rover): boolean {
    for (const res of ALL_RESOURCES) {
      if (r.cargo[res] > 0.01 && LogisticsSystem.room(state, res) > 0.01) return true;
    }
    return false;
  }

  /** True when storage covers every line of a cost. */
  static hasMaterials(state: ColonyState, amounts: ResourceAmounts): boolean {
    for (const res of ALL_RESOURCES) {
      if (amounts[res] > 0 && state.storage[res] < amounts[res]) return false;
    }
    return true;
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

  // ----------------------------------------------------------- transfers ----

  /**
   * Put mass into storage, clamped to the silo's capacity. Returns what fitted.
   * A negative or non-finite mass is a no-op, not a hole in the ledger.
   */
  static store(state: ColonyState, res: ResourceId, kg: number): number {
    if (!(kg > 0) || !Number.isFinite(kg)) return 0;
    const accepted = Math.min(kg, LogisticsSystem.room(state, res));
    state.storage[res] += accepted;
    return accepted;
  }

  /**
   * Take mass out of storage, floored at zero. Returns what was actually
   * there. The floor (rather than a throw) is deliberate: callers ask for a
   * *rate* and the tick boundary can leave less than the last request.
   */
  static take(state: ColonyState, res: ResourceId, kg: number): number {
    if (!(kg > 0) || !Number.isFinite(kg)) return 0;
    const got = Math.min(kg, Math.max(0, state.storage[res]));
    state.storage[res] -= got;
    return got;
  }

  /**
   * Put delivered material *back* into storage in full, even past capacity.
   * This is the demolish refund's rule and the one place the ledger is allowed
   * to overflow: the material came out of that silo, so returning it can never
   * be an exploit, and quietly destroying a player's resources on cancel is
   * worse than a temporarily over-full store. `recomputeCapacitiesState` clamps
   * the excess away on the next recompute — a known quirk, pinned by the
   * construction suite and left as a decision, not fixed here.
   */
  static refund(state: ColonyState, res: ResourceId, kg: number): void {
    if (!(kg > 0) || !Number.isFinite(kg)) return;
    state.storage[res] += kg;
  }

  /**
   * Load mass into a rover's hold, clamped to its capacity. Returns what fit.
   * The rover's own rules — what it decided to pick up, and when — stay in
   * `RoverSystem`; this is the arithmetic of the hold.
   */
  static loadCargo(r: Rover, res: ResourceId, kg: number): number {
    if (!(kg > 0) || !Number.isFinite(kg)) return 0;
    const space = Math.max(0, effectiveRoverDef(r).capacityKg - cargoMass(r));
    const loaded = Math.min(kg, space);
    r.cargo[res] += loaded;
    return loaded;
  }

  /**
   * Pour whatever fits out of a rover's hold into storage where it stands.
   * Returns the mass moved and whether anything is still stuck because its
   * silo is full — the *caller* decides what to say about that, which is why
   * this reports instead of logging (the three pre-extraction copies disagreed
   * about exactly that: one of them was silent).
   */
  static unloadCargo(state: ColonyState, r: Rover): { moved: number; blocked: boolean } {
    let moved = 0;
    let blocked = false;
    for (const res of ALL_RESOURCES) {
      if (r.cargo[res] <= 0) continue;
      if (LogisticsSystem.room(state, res) <= 0.01) {
        blocked = true;
        continue;
      }
      const gave = LogisticsSystem.store(state, res, r.cargo[res]);
      r.cargo[res] -= gave;
      moved += gave;
    }
    return { moved, blocked };
  }

  /**
   * Pour whatever storage has into a site's remaining cost. Returns the mass
   * committed. Site delivery is the one delivery that needs no rover: the
   * colony's own stockpile feeds a starving site as room is made for it.
   */
  static deliverToSite(state: ColonyState, b: Building): number {
    let took = 0;
    for (const res of ALL_RESOURCES) {
      const need = b.remainingCost[res];
      if (need <= 0) continue;
      const gave = LogisticsSystem.take(state, res, need);
      if (gave <= 0) continue;
      b.remainingCost[res] = Math.max(0, need - gave);
      took += gave;
    }
    return took;
  }

  /**
   * Spend a cost out of storage (the garage's assembly line). Floored at zero
   * like {@link LogisticsSystem.take}: a caller that got this far has already
   * asked {@link LogisticsSystem.hasMaterials}, and a second spend in the same
   * tick must not drive the ledger negative.
   */
  static consumeMaterials(state: ColonyState, amounts: ResourceAmounts): void {
    for (const res of ALL_RESOURCES) {
      LogisticsSystem.take(state, res, amounts[res]);
    }
  }

  // --------------------------------------------------------- reservations ----

  /**
   * Claim a deposit for one rover. A rich seam can host a second rover; a
   * worked-out scrap heap cannot — that is the "held" rule the fleet's scorer
   * reads. `force` is a *player* order taking the seam from an automatic run:
   * the run's task is finished so it re-plans instead of walking to a seam it
   * no longer owns.
   */
  static claimDeposit(
    state: ColonyState,
    r: Rover,
    depositId: number,
    hooks: LogisticsHostHooks,
    force = false,
  ): void {
    const dep = state.world.deposits.find((d) => d.id === depositId);
    if (!dep) return;
    const holder = dep.reservedBy;
    if (holder == null || holder === r.id) {
      dep.reservedBy = r.id;
      return;
    }
    if (!force) return;
    const other = state.rovers.find((o) => o.id === holder);
    if (
      other &&
      other.autoTask &&
      other.command.type === 'mine' &&
      other.command.depositId === depositId
    ) {
      hooks.finishTask(other);
      state.alerts.event(
        'info',
        `${other.label} re-planned — ${r.label} took over that seam.`,
        state.simTime,
        state.clock.format(),
      );
    }
    dep.reservedBy = r.id;
  }

  /** Give a deposit back the moment its worker stops wanting it. */
  static releaseDeposit(state: ColonyState, r: Rover, depositId: number): void {
    const dep = state.world.deposits.find((d) => d.id === depositId);
    if (dep && dep.reservedBy === r.id) dep.reservedBy = null;
  }

  /** Drop everything this rover's active task holds a claim on. */
  static releaseReservations(state: ColonyState, r: Rover): void {
    if (r.command.type === 'mine') LogisticsSystem.releaseDeposit(state, r, r.command.depositId);
  }

  /** Who holds this seam, if anyone. */
  static reservationOf(state: ColonyState, depositId: number): number | null {
    const dep = state.world.deposits.find((d) => d.id === depositId);
    return dep?.reservedBy ?? null;
  }

  /**
   * True when some rover is already executing a RECOVER for this one. A rescue
   * is a claim on a *rover* rather than on a resource, but it is the same
   * question — "is someone already coming for this" — so the fleet asks it
   * here, next to the other reservation queries.
   */
  static rescueTargeted(state: ColonyState, roverId: number): boolean {
    return state.rovers.some(
      (r) => r.command.type === 'recover' && r.command.roverId === roverId,
    );
  }
}
