/**
 * Phase 17 — Extract HistorySystem
 *
 * Goal per roadmap §21: separate historical records from simulation mechanics.
 *
 * ---------------------------------------------------------------------------
 * The distinction
 * ---------------------------------------------------------------------------
 *
 *   Simulation / domain systems
 *       =  what is happening this tick (power, fluids, failures, …).
 *
 *   HistorySystem (this module)
 *       =  what we remember about it. Today that is the vitals time-series
 *          Sampling used to live as Simulation.recordHistory / resetFlows —
 *          move-not-redesign. The flow-window reset is inseparable from the
 *          sample gate (every tick either samples-or-skips, then always
 *          rolls the fluid accumulators), so both live here.
 *
 * Flow:
 *
 *     Simulation.tick (after failures → alerts)
 *         ↓
 *     HistorySystem.tick
 *         ↓
 *     state.history / lastHistoryAt / flowWindow / flows / lastFlows
 *
 * Phase 4 landed the event log the section above deferred: discrete domain
 * events now persist in a bounded, sol-stamped ring owned by HistoryState
 * (`state.journal`, wired through `DomainEventLog.sink`), and the vitals
 * downsample into `state.solHistory`. AlertBus remains the HUD's live log;
 * the journal is the structured record future replay / analytics /
 * mission-report work (P11/P12) hangs off.
 *
 * ---------------------------------------------------------------------------
 * Responsibilities (roadmap §21, extended by commercial Phase 4)
 * ---------------------------------------------------------------------------
 *   - event history          `state.journal` ring (discrete events; sink in ColonyState)
 *   - important milestones   journal entries via the skip list (HistoryState)
 *   - failures               journaled from FailureSystem/AlertSystem events
 *   - discoveries            journaled from ExplorationSystem events
 *   - construction completion journaled from ConstructionSystem events
 *   - rover incidents        journaled from RoverSystem/GarageSystem events
 *   - vitals sampling        `tick` — power / fluid HistorySample ring buffer
 *   - sol downsampling       `tick` — one SolHistoryRow per closed sol
 *   - flow-window roll       `tick` — trailing-sol fluid rate window
 *
 * ---------------------------------------------------------------------------
 * What deliberately does NOT live here
 * ---------------------------------------------------------------------------
 *   - **AlertBus / AlertSystem** — notifications (Phase 16).
 *   - **Failure checks / tripDamaged / endMission** — FailureSystem.
 *   - **Public rate query *names*** stay on Simulation (host boundary);
 *     the arithmetic lives here as statics Simulation thin-delegates to
 *     (Phase 18 — coordinate, don't implement).
 *   - **Replay / analytics / mission reports** — future consumers.
 *
 * Determinism: pure reads of ColonyState + fixed HISTORY_INTERVAL_S /
 * HISTORY_SAMPLES / SOL_SECONDS; no RNG, no DOM, no wall clock.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import { emptyFlows } from '../state/ResourceState';
import {
  HISTORY_SAMPLES,
  HISTORY_INTERVAL_S,
  SOL_SECONDS,
  SOLS_PER_SEC,
  SIM_TICK,
  SOL_HISTORY_ROWS,
} from '../config';
import { ALL_FLUIDS, ALL_COMPONENTS, MINEABLE_RESOURCES } from '../defs';
import type { FluidId } from '../defs';
import { emptySolAccumulator } from '../state/HistoryState';

export class HistorySystem {
  /**
   * Sample colony vitals when the interval has elapsed, then always roll the
   * per-tick fluid accumulators into the trailing-sol window.
   *
   * Preserves the exact gate, ring-buffer cap and flow-reset
   * Simulation.recordHistory / resetFlows used — move-not-redesign.
   *
   * Phase 4 additions:
   *  - the sample widens (ore/steel/components, fleet utilization, the
   *    trailing-sol produced/consumed rates split by direction);
   *  - `newSol` (the clock's roll, same flag AutonomySystem already takes)
   *    closes one {@link SolHistoryRow} from the sol's samples and rolls the
   *    transient accumulator for the next — the downsampled long record, so
   *    a 200-sol colony holds 240 rows instead of 300 000 samples;
 *  - the sample feeds nothing back: rows and samples are reports, never
   *    inputs, so no future tick can depend on which sols are remembered.
   */
  static tick(state: ColonyState, newSol = false): void {
    if (newSol) HistorySystem.rollSol(state);
    if (state.simTime - state.lastHistoryAt < HISTORY_INTERVAL_S) {
      // Flows are per-tick accumulators; reset them after they've been read.
      HistorySystem.resetFlows(state);
      return;
    }
    state.lastHistoryAt = state.simTime;
    const sample = {
      t: state.simTime,
      genKw: state.power.generationKw,
      loadKw: state.power.servedKw,
      storedFrac: state.power.capacityKWh > 0 ? state.power.storedKWh / state.power.capacityKWh : 0,
      water: state.pools.amounts.water,
      oxygen: state.pools.amounts.oxygen,
      food: state.pools.amounts.food,
      ore: MINEABLE_RESOURCES.reduce((sum, r) => sum + state.storage[r], 0),
      steel: state.storage.steel,
      components: ALL_COMPONENTS.reduce((sum, c) => sum + state.components[c], 0),
      roverUtil: HistorySystem.fleetUtilization(state),
      prod: {
        water: HistorySystem.flowRatePerSol(state, 'water', 'produced'),
        oxygen: HistorySystem.flowRatePerSol(state, 'oxygen', 'produced'),
        food: HistorySystem.flowRatePerSol(state, 'food', 'produced'),
      },
      cons: {
        water: HistorySystem.flowRatePerSol(state, 'water', 'consumed'),
        oxygen: HistorySystem.flowRatePerSol(state, 'oxygen', 'consumed'),
        food: HistorySystem.flowRatePerSol(state, 'food', 'consumed'),
      },
    };
    state.history.push(sample);
    while (state.history.length > HISTORY_SAMPLES) state.history.shift();

    // The sol accumulator folds the sample in — means at roll time are
    // sample-averages; the battery column keeps its worst moment instead.
    const acc = state._solAcc;
    acc.count++;
    acc.genKw += sample.genKw;
    acc.loadKw += sample.loadKw;
    acc.roverUtil += sample.roverUtil;
    if (sample.storedFrac < acc.storedFracMin) acc.storedFracMin = sample.storedFrac;

    HistorySystem.resetFlows(state);
  }

  /**
   * Close the sol that just ended into one downsampled row. Called at the
   * top of the first tick of a new sol, so the trailing flow window at this
   * moment *is* the closed sol (one tick of lag, same convention as the rate
   * queries). A sol with no samples (a time jump landed on midnight) closes
   * no row — the accumulator resets and the next full sol reports.
   */
  private static rollSol(state: ColonyState): void {
    const acc = state._solAcc;
    if (acc.count > 0) {
      const prod = { water: 0, oxygen: 0, food: 0 } as Record<FluidId, number>;
      const cons = { water: 0, oxygen: 0, food: 0 } as Record<FluidId, number>;
      for (const w of state.flowWindow) {
        for (const f of ALL_FLUIDS) {
          prod[f] += w.f[f].produced;
          cons[f] += w.f[f].consumed;
        }
      }
      state.solHistory.push({
        // clock.sol already advanced: whole sols completed = the closing sol's
        // 1-based display number.
        sol: state.clock.sol,
        genKwAvg: acc.genKw / acc.count,
        loadKwAvg: acc.loadKw / acc.count,
        storedFracMin: acc.storedFracMin,
        roverUtilAvg: acc.roverUtil / acc.count,
        water: state.pools.amounts.water,
        oxygen: state.pools.amounts.oxygen,
        food: state.pools.amounts.food,
        ore: MINEABLE_RESOURCES.reduce((sum, r) => sum + state.storage[r], 0),
        steel: state.storage.steel,
        components: ALL_COMPONENTS.reduce((sum, c) => sum + state.components[c], 0),
        prod,
        cons,
      });
      while (state.solHistory.length > SOL_HISTORY_ROWS) state.solHistory.shift();
    }
    acc.count = 0;
    acc.genKw = 0;
    acc.loadKw = 0;
    acc.roverUtil = 0;
    acc.storedFracMin = 1;
  }

  /** Fraction of the fleet holding a live task — the AUTONOMY.md work split. */
  static fleetUtilization(state: ColonyState): number {
    if (state.rovers.length === 0) return 0;
    let busy = 0;
    for (const r of state.rovers) {
      if (r.phase === 'moving' || r.phase === 'working') busy++;
    }
    return busy / state.rovers.length;
  }

  /**
   * Trailing-sol rate in one direction (produced or consumed), kg/sol — the
   * same window arithmetic as {@link netRatePerSol}, split so the dashboard
   * can show production and consumption as separate series. The window lags
   * one tick by convention (this tick's flows roll in at resetFlows).
   */
  static flowRatePerSol(state: ColonyState, f: FluidId, dir: 'produced' | 'consumed'): number {
    if (state.flowWindow.length === 0) return 0;
    const span = state.simTime - state.flowWindow[0].t;
    if (span <= 1e-6) return 0;
    let total = 0;
    for (const w of state.flowWindow) total += w.f[f][dir];
    return total / (span * SOLS_PER_SEC);
  }

  /**
   * Flows accumulate within a tick and are read by the HUD as a rate. We keep
   * the previous tick's totals around so the UI never samples a zeroed frame.
   */
  static resetFlows(state: ColonyState): void {
    state.flowWindow.push({
      t: state.simTime,
      f: {
        water: { ...state.flows.water },
        oxygen: { ...state.flows.oxygen },
        food: { ...state.flows.food },
      },
    });
    // Keep exactly one trailing sol of samples.
    const cutoff = state.simTime - SOL_SECONDS;
    while (state.flowWindow.length > 1 && state.flowWindow[0].t < cutoff) {
      state.flowWindow.shift();
    }

    state.lastFlows = {
      water: { ...state.flows.water },
      oxygen: { ...state.flows.oxygen },
      food: { ...state.flows.food },
    };
    state.flows = emptyFlows();
  }

  /**
   * Clear sampling windows after a save restore. Matches the previous
   * Simulation.restore body (history / flowWindow emptied, lastHistoryAt
   * rewound) so resumed colonies do not inherit stale charts. The sol
   * accumulator is derived too, so it resets the same way; `solHistory` and
   * `journal` are the saved long record and deliberately survive.
   */
  static clear(state: ColonyState): void {
    state.history = [];
    state.flowWindow = [];
    state.lastHistoryAt = -Infinity;
    state._solAcc = emptySolAccumulator();
  }

  /**
   * Re-anchor sampling after a calendar jump (`devSetTime`). The weather
   * scheduler and history windows must stay coherent after the jump — same
   * fields Simulation.devSetTime cleared before this phase. The sol in
   * progress closes no row (the journal keeps its old stamps — it is a log).
   */
  static afterTimeJump(state: ColonyState): void {
    state.lastHistoryAt = -Infinity;
    state.lastFlows = emptyFlows();
    state.flowWindow = [];
    state._solAcc = emptySolAccumulator();
  }

  /** Net rate of a fluid in kg/sol, averaged over the trailing sol. */
  static netRatePerSol(state: ColonyState, f: FluidId): number {
    if (state.flowWindow.length === 0) return 0;
    const span = state.simTime - state.flowWindow[0].t;
    if (span <= 1e-6) return 0;
    let produced = 0;
    let consumed = 0;
    for (const w of state.flowWindow) {
      produced += w.f[f].produced;
      consumed += w.f[f].consumed;
    }
    return (produced - consumed) / (span * SOLS_PER_SEC);
  }

  /** Instantaneous rate for the current tick — used for live throughput read-outs. */
  static instantRatePerSol(state: ColonyState, f: FluidId): number {
    const sols = SIM_TICK * SOLS_PER_SEC;
    if (sols <= 0) return 0;
    const fl = state.lastFlows[f];
    return (fl.produced - fl.consumed) / sols;
  }

  /** Sols of reserve left for a fluid at the trailing-sol net rate. */
  static reserveSols(state: ColonyState, f: FluidId): number {
    const net = HistorySystem.netRatePerSol(state, f);
    if (net >= -1e-9) return Infinity;
    return state.pools.amounts[f] / -net;
  }
}
