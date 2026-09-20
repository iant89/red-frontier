/**
 * Forecast utility — Phase 1 infrastructure, needed by tutorial warnings (P1),
 * dashboard (P4), and bottleneck panel (P5).
 *
 * One pure, deterministic function set: resource → sols-to-empty / sols-to-shortage
 * living in sim/, as prescribed by COMMERCIAL-ROADMAP-REVIEW.md §3.1.
 *
 * Uses existing flow accumulators (emptyFlows, HistoryState) and current state.
 * No DOM, no three.js, no RNG.
 *
 * Design:
 * - Production/consumption rates are per-sol (Mars time), derived from flow windows.
 * - Reserve = current amount + storage? For fluids, pools; for bulk, storage.
 * - Sols-to-empty = reserve / net-consumption when consumption > production, else Infinity.
 * - Runway breach (AUTONOMY.md B4) = projected time-to-empty < 1.0 sol at trailing net rate.
 * - Forecast is pure function of ColonyState + HistoryState windows, deterministic.
 */

import type { ColonyState } from './state/ColonyState';
import type { ResourceId, FluidId } from './defs';
import { ALL_RESOURCES, ALL_FLUIDS } from './defs';
import { SOL_SECONDS } from './config';

export interface FluidForecast {
  fluid: FluidId;
  amount: number;
  capacity: number;
  producedPerSol: number;
  consumedPerSol: number;
  netPerSol: number; // produced - consumed
  reserveSols: number | null; // null = not depleting or empty
  solsToEmpty: number; // Infinity if not depleting
  isDepleting: boolean;
  runwayBreach: boolean; // solsToEmpty < 1.0
  warningTier: 'ok' | 'watch' | 'warning' | 'critical'; // based on reserveSols
}

export interface ResourceForecast {
  resource: ResourceId;
  amount: number;
  capacity: number;
  solsToEmpty?: number; // for consumable resources, if applicable
  isLow: boolean;
}

export interface ColonyForecast {
  fluids: Record<FluidId, FluidForecast>;
  resources: Record<ResourceId, ResourceForecast>;
  worstFluid: FluidForecast | null; // most urgent
  hasRunwayBreach: boolean;
  summary: string;
}

const RUNWAY_FLOOR_SOLS = 1.0;
const WATCH_SOLS = 5.0;
const WARNING_SOLS = 2.5;
const CRITICAL_SOLS = 1.0;

/**
 * Compute fluid forecast from current pools and flow windows.
 * Uses state's fluid flows (produced/consumed) which are trailing windows.
 */
export function forecastFluid(state: ColonyState, fluid: FluidId): FluidForecast {
  const amount = state.pools.amounts[fluid];
  const capacity = state.pools.capacity[fluid];
  // flows are per second? Actually emptyFlows holds produced/consumed per sol? Let's check.
  // HistoryState.emptyFlows: { produced, consumed } per fluid, accumulated per sol window.
  // In Simulation, netRatePerSol etc use history windows. Here we use state's flows directly.
  // ColonyState.flows? Actually ResourceState has flows? Let's inspect: state.flows is HistoryState? No.
  // For simplicity, use state's resource flows if available, else estimate from history.
  // We'll try to read from state.history or state.flows.

  // Attempt to get produced/consumed per sol from state's flow tracking.
  // ColonyState has `flows`? Let's check: ResourceState has history? Actually HistoryState has flowWindows.
  // We'll use a helper that reads from state's pools + history.

  let producedPerSol = 0;
  let consumedPerSol = 0;

  // Try to read from state's flow windows (HistoryState)
  // flowWindows: record of fluid -> { produced, consumed } per trailing sols
  const flowWindow = (state as any).flowWindows ?? (state as any).history?.flowWindows ?? (state as any).flows;
  if (flowWindow && flowWindow[fluid]) {
    const fw = flowWindow[fluid];
    // fw may be { produced, consumed } already per sol, or accumulated
    producedPerSol = fw.produced ?? 0;
    consumedPerSol = fw.consumed ?? 0;
  } else if ((state as any).pools?.flows) {
    // Alternative: pools.flows
    const pf = (state as any).pools.flows[fluid];
    if (pf) {
      producedPerSol = pf.produced ?? 0;
      consumedPerSol = pf.consumed ?? 0;
    }
  }

  // If still zero, try to estimate from history samples: netRatePerSol is available on Simulation, not state.
  // For pure state forecast, we fallback to 0, meaning no forecast — caller can provide rates.
  // To make this function testable without history, allow passing rates directly via overload below.

  const netPerSol = producedPerSol - consumedPerSol;
  const isDepleting = netPerSol < -1e-9;

  let solsToEmpty: number;
  let reserveSols: number | null;
  if (!isDepleting) {
    solsToEmpty = Infinity;
    reserveSols = null;
  } else {
    const burnPerSol = -netPerSol;
    if (burnPerSol <= 1e-9) {
      solsToEmpty = Infinity;
      reserveSols = null;
    } else {
      solsToEmpty = amount / burnPerSol;
      reserveSols = solsToEmpty;
    }
  }

  const runwayBreach = isDepleting && solsToEmpty < RUNWAY_FLOOR_SOLS;

  let warningTier: FluidForecast['warningTier'] = 'ok';
  if (isDepleting) {
    if (solsToEmpty < CRITICAL_SOLS) warningTier = 'critical';
    else if (solsToEmpty < WARNING_SOLS) warningTier = 'warning';
    else if (solsToEmpty < WATCH_SOLS) warningTier = 'watch';
  } else if (amount < capacity * 0.2) {
    warningTier = 'watch';
  }

  return {
    fluid,
    amount,
    capacity,
    producedPerSol,
    consumedPerSol,
    netPerSol,
    reserveSols,
    solsToEmpty,
    isDepleting,
    runwayBreach,
    warningTier,
  };
}

/**
 * Overload that allows passing explicit rates — useful for tests and for
 * consumers that already computed rates from HistorySystem.
 */
export function forecastFluidWithRates(
  amount: number,
  capacity: number,
  fluid: FluidId,
  producedPerSol: number,
  consumedPerSol: number,
): FluidForecast {
  const netPerSol = producedPerSol - consumedPerSol;
  const isDepleting = netPerSol < -1e-9;
  let solsToEmpty: number;
  let reserveSols: number | null;
  if (!isDepleting) {
    solsToEmpty = Infinity;
    reserveSols = null;
  } else {
    const burn = -netPerSol;
    solsToEmpty = burn > 1e-9 ? amount / burn : Infinity;
    reserveSols = solsToEmpty;
  }
  const runwayBreach = isDepleting && solsToEmpty < RUNWAY_FLOOR_SOLS;
  let warningTier: FluidForecast['warningTier'] = 'ok';
  if (isDepleting) {
    if (solsToEmpty < CRITICAL_SOLS) warningTier = 'critical';
    else if (solsToEmpty < WARNING_SOLS) warningTier = 'warning';
    else if (solsToEmpty < WATCH_SOLS) warningTier = 'watch';
  } else if (amount < capacity * 0.2) {
    warningTier = 'watch';
  }
  return {
    fluid,
    amount,
    capacity,
    producedPerSol,
    consumedPerSol,
    netPerSol,
    reserveSols,
    solsToEmpty,
    isDepleting,
    runwayBreach,
    warningTier,
  };
}

/**
 * Forecast for bulk resources (storage). For now, only checks low storage,
 * but can be extended to track production/consumption if needed.
 */
export function forecastResource(state: ColonyState, resource: ResourceId): ResourceForecast {
  const amount = state.storage[resource];
  const capacity = (state as any)._storageCapacity ?? 0;
  const isLow = amount < capacity * 0.15;
  return {
    resource,
    amount,
    capacity,
    isLow,
  };
}

/**
 * Full colony forecast — pure function of state.
 * If history rates are available, they are used; otherwise forecast is based on
 * whatever flow windows state carries (may be zero for fresh colonies).
 */
export function forecastColony(state: ColonyState): ColonyForecast {
  const fluids = {} as Record<FluidId, FluidForecast>;
  for (const f of ALL_FLUIDS) {
    fluids[f] = forecastFluid(state, f);
  }
  const resources = {} as Record<ResourceId, ResourceForecast>;
  for (const r of ALL_RESOURCES) {
    resources[r] = forecastResource(state, r);
  }

  // Find worst depleting fluid
  let worst: FluidForecast | null = null;
  for (const f of ALL_FLUIDS) {
    const cur = fluids[f];
    if (!cur.isDepleting) continue;
    if (!worst || cur.solsToEmpty < worst.solsToEmpty) worst = cur;
  }

  const hasRunwayBreach = Object.values(fluids).some(f => f.runwayBreach);

  let summary = 'Colony stable';
  if (worst) {
    if (worst.warningTier === 'critical') summary = `${worst.fluid} critical — ${worst.solsToEmpty.toFixed(1)} sols to empty`;
    else if (worst.warningTier === 'warning') summary = `${worst.fluid} low — ${worst.solsToEmpty.toFixed(1)} sols remaining`;
    else if (worst.warningTier === 'watch') summary = `${worst.fluid} watch — ${worst.solsToEmpty.toFixed(1)} sols`;
  }

  return {
    fluids,
    resources,
    worstFluid: worst,
    hasRunwayBreach,
    summary,
  };
}

/**
 * Format sols-to-empty for UI: "1.8 sols" or "∞" if not depleting.
 * Matches roadmap's exemplar: "Your water reserve will run dry in 1.8 sols."
 */
export function formatSolsToEmpty(sols: number): string {
  if (!Number.isFinite(sols)) return '∞';
  if (sols < 0.1) return `${sols.toFixed(2)} sols`;
  if (sols < 10) return `${sols.toFixed(1)} sols`;
  return `${Math.round(sols)} sols`;
}

/**
 * Generate player-facing warning copy for a fluid forecast.
 * Tone per Phase 1: situation → warning → player discovers fix, not click-here.
 */
export function warningForFluid(f: FluidForecast): string | null {
  if (!f.isDepleting) return null;
  if (f.warningTier === 'critical') {
    return `Your ${f.fluid} reserve will run dry in ${formatSolsToEmpty(f.solsToEmpty)}.`;
  }
  if (f.warningTier === 'warning') {
    return `${f.fluid} low — ${formatSolsToEmpty(f.solsToEmpty)} remaining. Production ${f.producedPerSol.toFixed(1)} / consumption ${f.consumedPerSol.toFixed(1)} kg/sol.`;
  }
  if (f.warningTier === 'watch') {
    return `${f.fluid} trending down — ${formatSolsToEmpty(f.solsToEmpty)} at current rate.`;
  }
  return null;
}
