/**
 * Phase 17 — History state.
 *
 * Owns the time-series sample shape and the empty-window helpers that
 * HistorySystem / ColonyState use to initialise and clear sampling state.
 * The behavior that appends samples lives in `sim/systems/HistorySystem.ts`.
 *
 * Future (not this phase): a discrete event log (milestones, failures,
 * discoveries, construction completion, rover incidents) would also land
 * here as HistoryState fields. Those narratives currently live on AlertBus.
 */

import type { FluidId } from '../defs';
import type { FluidFlow } from './ResourceState';

/** One point on the colony vitals chart (power + fluid pools). */
export interface HistorySample {
  t: number;
  genKw: number;
  loadKw: number;
  storedFrac: number;
  water: number;
  oxygen: number;
  food: number;
}

/** Zeroed per-tick fluid accumulators. */
export function emptyFlows(): Record<FluidId, FluidFlow> {
  return {
    water: { produced: 0, consumed: 0 },
    oxygen: { produced: 0, consumed: 0 },
    food: { produced: 0, consumed: 0 },
  };
}

