/**
 * The colony power grid.
 *
 * TDD §6: "producers → batteries → consumers; generation, battery
 * charge/discharge, consumer priority tiers 0–3, brownout."
 *
 * This module is a **pure resolver**: hand it the generation, the storage and
 * the ranked demands, and it returns how much each tier actually got. It has no
 * knowledge of buildings, rovers or the world — which makes the whole grid
 * trivially unit-testable and keeps `Simulation` readable.
 *
 * ## The allocation rule
 *
 * Loads are served strictly by tier, 0 first. Within a tier every consumer is
 * satisfied by the same *fraction*, so a brownout degrades a tier evenly
 * instead of arbitrarily picking winners — that keeps the sim deterministic and
 * the UI honest ("Industry at 62%" rather than "some of your machines stopped").
 *
 * Batteries are the buffer of last resort: generation is spent first, storage
 * covers the shortfall, and only genuine surplus goes back into charging.
 */

import type { PowerTier } from './config';
import { POWER_TIERS, BROWNOUT_THRESHOLD } from './config';
import { clamp } from '../lib/rng';

/** One consumer's request for this tick. */
export interface PowerDemand {
  /** Opaque handle the caller uses to map results back to an entity. */
  id: number;
  tier: PowerTier;
  /** Requested load in kW. */
  kw: number;
}

export interface PowerResult {
  /** Total generation available this tick (kW). */
  generationKw: number;
  /** Total requested load across every tier (kW). */
  demandKw: number;
  /** Load actually served (kW). */
  servedKw: number;
  /** Net battery flow: positive = charging, negative = discharging (kW). */
  batteryFlowKw: number;
  /** Grid storage after this tick (kWh). */
  storedKWh: number;
  /** Storage capacity (kWh). */
  capacityKWh: number;
  /** Fraction of each tier's demand that was met, 0..1. */
  tierSatisfaction: Record<PowerTier, number>;
  /** Requested load per tier (kW). */
  tierDemand: Record<PowerTier, number>;
  /** Per-consumer satisfaction fraction, keyed by demand id. */
  satisfaction: Map<number, number>;
  /** Any tier below full satisfaction. */
  brownout: boolean;
  /** Lowest tier index that was shed at all (null when the grid is healthy). */
  firstShedTier: PowerTier | null;
  /** Generation that had nowhere to go — full batteries, no load (kW). */
  curtailedKw: number;
}

function zeroTiers(): Record<PowerTier, number> {
  return { 0: 0, 1: 0, 2: 0, 3: 0 };
}

/**
 * Resolve one tick of the grid.
 *
 * @param generationKw  total instantaneous generation
 * @param demands       every consumer's request
 * @param storedKWh     energy currently in batteries
 * @param capacityKWh   total battery capacity
 * @param hours         length of this tick in **Mars hours** (kW × h = kWh)
 * @param maxThroughputKw  how fast storage can charge or discharge
 */
export function resolvePower(
  generationKw: number,
  demands: PowerDemand[],
  storedKWh: number,
  capacityKWh: number,
  hours: number,
  maxThroughputKw = Infinity,
): PowerResult {
  const tierDemand = zeroTiers();
  const tierSatisfaction: Record<PowerTier, number> = { 0: 1, 1: 1, 2: 1, 3: 1 };

  for (const d of demands) {
    if (d.kw > 0) tierDemand[d.tier] += d.kw;
  }
  const demandKw = tierDemand[0] + tierDemand[1] + tierDemand[2] + tierDemand[3];

  // How much the batteries could contribute over this tick, as a rate.
  const dischargeCeilingKw =
    hours > 0 ? Math.min(maxThroughputKw, storedKWh / hours) : 0;

  let genRemaining = generationKw;
  let batteryBudgetKw = dischargeCeilingKw;
  let servedKw = 0;
  let firstShedTier: PowerTier | null = null;

  for (const tier of POWER_TIERS) {
    const want = tierDemand[tier];
    if (want <= 0) {
      tierSatisfaction[tier] = 1;
      continue;
    }
    // Spend live generation first, then lean on storage.
    const fromGen = Math.min(genRemaining, want);
    genRemaining -= fromGen;
    let got = fromGen;

    if (got < want && batteryBudgetKw > 0) {
      const fromBattery = Math.min(batteryBudgetKw, want - got);
      batteryBudgetKw -= fromBattery;
      got += fromBattery;
    }

    const frac = clamp(got / want, 0, 1);
    tierSatisfaction[tier] = frac;
    servedKw += got;
    if (frac < BROWNOUT_THRESHOLD && firstShedTier === null) firstShedTier = tier;
  }

  // Net battery flow. Discharge is whatever storage covered beyond generation.
  const dischargedKw = Math.max(0, dischargeCeilingKw - batteryBudgetKw);

  // Surplus generation charges the pack, bounded by throughput and headroom.
  let chargedKw = 0;
  let curtailedKw = 0;
  if (genRemaining > 0) {
    const headroomKWh = Math.max(0, capacityKWh - storedKWh);
    const headroomKw = hours > 0 ? headroomKWh / hours : 0;
    chargedKw = Math.min(genRemaining, headroomKw, maxThroughputKw);
    curtailedKw = genRemaining - chargedKw;
  }

  const batteryFlowKw = chargedKw - dischargedKw;
  const nextStored = clamp(storedKWh + batteryFlowKw * hours, 0, capacityKWh);

  const satisfaction = new Map<number, number>();
  for (const d of demands) satisfaction.set(d.id, tierSatisfaction[d.tier]);

  return {
    generationKw,
    demandKw,
    servedKw,
    batteryFlowKw,
    storedKWh: nextStored,
    capacityKWh,
    tierSatisfaction,
    tierDemand,
    satisfaction,
    brownout: firstShedTier !== null,
    firstShedTier,
    curtailedKw,
  };
}

/** An empty grid result — used before the first tick and when restoring saves. */
export function idlePower(capacityKWh = 0, storedKWh = 0): PowerResult {
  return {
    generationKw: 0,
    demandKw: 0,
    servedKw: 0,
    batteryFlowKw: 0,
    storedKWh,
    capacityKWh,
    tierSatisfaction: { 0: 1, 1: 1, 2: 1, 3: 1 },
    tierDemand: zeroTiers(),
    satisfaction: new Map(),
    brownout: false,
    firstShedTier: null,
    curtailedKw: 0,
  };
}

/**
 * Sols of runway left at the current net drain, or `Infinity` when the grid is
 * net-positive. Drives the "batteries flat in 0.4 sol" warning.
 */
export function batteryRunwayHours(result: PowerResult): number {
  if (result.batteryFlowKw >= -1e-6) return Infinity;
  return result.storedKWh / -result.batteryFlowKw;
}
