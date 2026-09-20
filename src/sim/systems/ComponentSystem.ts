/**
 * P5 slice 2 — ComponentSystem: the manufactured-unit ledger.
 *
 * Components are the second material system the industrial chain needed, and
 * they are deliberately **not** folded into {@link LogisticsSystem}:
 *
 *     bulk solids (kg)   → LogisticsSystem  — weighed, hauled, poured, reserved
 *     components (units) → ComponentSystem  — counted, racked, spent whole
 *
 * A motor is not 40 kg of anything. Storing counts in the kg ledger would make
 * every capacity, haul and reservation rule lie about what it is measuring, so
 * components get their own integer ledger with the same *shape* of API — the
 * familiarity is the point, a reader who knows `store`/`take`/`room` on one
 * ledger already knows the other.
 *
 * Capacity is rack space, and the only racks in the game are workshops
 * (`BuildingDef.componentSlots`). The landing pod has none, so a colony cannot
 * craft anything until a workshop stands — which is the same bootstrap logic the
 * Refinery follows for steel, one step further down the chain.
 *
 * Whole units only: `store` and `take` floor their request. The fractional work
 * that gets a unit *to* whole lives on the building that is making it
 * (`Building.craft`), accumulated by ProductionSystem — never here.
 *
 * Determinism: no RNG, no wall clock.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts.
 */

import type { ColonyState } from '../state/ColonyState';
import {
  ALL_COMPONENTS,
  COMPONENTS,
  type ComponentAmounts,
  type ComponentId,
} from '../defs';

export class ComponentSystem {
  /** Rack space for one component type (units). */
  static capacity(state: ColonyState): number {
    return state._componentCapacity;
  }

  /** Free rack space for one component type (units). */
  static room(state: ColonyState, comp: ComponentId): number {
    return Math.max(0, state._componentCapacity - state.components[comp]);
  }

  /** Everything on the racks (units). */
  static total(state: ColonyState): number {
    let t = 0;
    for (const c of ALL_COMPONENTS) t += state.components[c];
    return t;
  }

  /** Rack space across every component type (units). */
  static totalCapacity(state: ColonyState): number {
    return state._componentCapacity * ALL_COMPONENTS.length;
  }

  /**
   * Put whole units on the rack, clamped to the room there is. Returns what was
   * actually racked — the caller keeps the difference as work in progress.
   */
  static store(state: ColonyState, comp: ComponentId, units: number): number {
    const whole = Math.floor(units);
    if (!(whole > 0) || !Number.isFinite(whole)) return 0;
    const accepted = Math.min(whole, ComponentSystem.room(state, comp));
    state.components[comp] += accepted;
    return accepted;
  }

  /**
   * Take whole units off the rack, floored at zero. Returns what was actually
   * there, like the bulk ledger's `take`: callers ask for a cost and the rack
   * answers with the truth.
   */
  static take(state: ColonyState, comp: ComponentId, units: number): number {
    const whole = Math.floor(units);
    if (!(whole > 0) || !Number.isFinite(whole)) return 0;
    const got = Math.min(whole, Math.max(0, state.components[comp]));
    state.components[comp] -= got;
    return got;
  }

  /** Can the racks cover this whole cost? */
  static has(state: ColonyState, amounts: ComponentAmounts): boolean {
    for (const c of ALL_COMPONENTS) {
      if (amounts[c] > 0 && state.components[c] < amounts[c]) return false;
    }
    return true;
  }

  /** Spend a cost that {@link has} already approved. */
  static consume(state: ColonyState, amounts: ComponentAmounts): void {
    for (const c of ALL_COMPONENTS) {
      if (amounts[c] > 0) ComponentSystem.take(state, c, amounts[c]);
    }
  }

  /**
   * The shortfall as one sentence, for the refusal a player reads. Reads as
   * "components" when nothing specific is owed, the way the bulk ledger's
   * `missingList` reads as "materials".
   */
  static missingList(amounts: ComponentAmounts): string {
    const parts: string[] = [];
    for (const c of ALL_COMPONENTS) {
      if (amounts[c] > 0) parts.push(`${Math.ceil(amounts[c])} × ${COMPONENTS[c].label}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'components';
  }
}
