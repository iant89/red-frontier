/**
 * Phase 3 (slice 2) — colony standing orders.
 *
 * A policy is a player-authored rule the colony satisfies by issuing *the same
 * actions a player would* — a mine run, a building toggle, a maintenance
 * dispatch — marked as policy-issued so the autonomy stat stays honest
 * (COMMERCIAL-ROADMAP-REVIEW.md §5 P3; AUTONOMY.md §4.2/§5).
 *
 * Four policies, no scripting language. Every one is a fixed shape with a
 * boolean and (where it means anything) one number the player sets; the
 * `policy/*` commands set those fields and nothing else. The PolicySystem
 * reads them each tick.
 *
 * `held` is bookkeeping the night-power policy needs to give back what it
 * took: the ids of buildings *it* switched off, so a building the player
 * turned off by hand is never turned on by a policy.
 */

import type { ResourceId } from '../defs';

export type PolicyId = 'stockpile' | 'nightPower' | 'stormShelter' | 'autoMaintain';

export const POLICY_IDS: readonly PolicyId[] = ['stockpile', 'nightPower', 'stormShelter', 'autoMaintain'];

export interface StockpilePolicy {
  on: boolean;
  /** The bulk resource to keep in the silos. */
  resource: ResourceId;
  /** Floor in kg; the policy dispatches idle rovers while storage is below it. */
  minKg: number;
}

export interface NightPowerPolicy {
  on: boolean;
  /** Battery state of charge (0..100 %) below which industry is shed after dark. */
  minBatteryPct: number;
}

export interface StormShelterPolicy {
  on: boolean;
}

export interface AutoMaintainPolicy {
  on: boolean;
  /** Wear (0..100 %) at which a building gets a maintenance dispatch. */
  maxWearPct: number;
}

export interface PolicyState {
  stockpile: StockpilePolicy;
  nightPower: NightPowerPolicy;
  stormShelter: StormShelterPolicy;
  autoMaintain: AutoMaintainPolicy;
  /** Buildings the night-power policy switched off and still owes a switch-on. */
  held: number[];
  /** Total actions every policy has issued over the colony's life (the read model's "N actions"). */
  actions: number;
}

export function emptyPolicyState(): PolicyState {
  return {
    stockpile: { on: false, resource: 'ice', minKg: 200 },
    nightPower: { on: false, minBatteryPct: 40 },
    stormShelter: { on: false },
    autoMaintain: { on: false, maxWearPct: 30 },
    held: [],
    actions: 0,
  };
}

/** True when any policy is armed — the "is this colony run to a policy" question. */
export function anyPolicyOn(p: PolicyState): boolean {
  return p.stockpile.on || p.nightPower.on || p.stormShelter.on || p.autoMaintain.on;
}
