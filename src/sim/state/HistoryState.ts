/**
 * Phase 17 — History state.
 *
 * Owns the time-series sample shape. Sampling behavior lives in
 * `sim/systems/HistorySystem.ts`. Live per-tick fluid accumulators stay in
 * ResourceState (`emptyFlows`).
 *
 * Future (not this phase): a discrete event log (milestones, failures,
 * discoveries, construction completion, rover incidents) would also land
 * here as HistoryState fields. Those narratives currently live on AlertBus.
 */

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
