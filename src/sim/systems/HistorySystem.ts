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
 * Potential later architecture (not this phase):
 *
 *     Domain Event → HistorySystem → HistoryState (event log)
 *
 *     for milestones, failures, discoveries, construction completion and
 *     rover incidents. Those one-shot narratives currently write AlertBus
 *     (`state.alerts`); redesigning them into a parallel event log would
 *     change save/UI and is deferred. This module is the named owner that
 *     future replay / analytics / mission-report work can hang off.
 *
 * ---------------------------------------------------------------------------
 * Responsibilities (roadmap §21)
 * ---------------------------------------------------------------------------
 *   - event history          foundation only — AlertBus remains the live log
 *   - important milestones   foundation only (see above)
 *   - failures               foundation only (FailureSystem → AlertSystem today)
 *   - discoveries            foundation only (ExplorationSystem → alerts today)
 *   - construction completion foundation only (ConstructionSystem → alerts)
 *   - rover incidents        foundation only (RoverSystem → alerts today)
 *   - vitals sampling        `tick` — power / fluid HistorySample ring buffer
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
} from '../config';
import type { FluidId } from '../defs';

export class HistorySystem {
  /**
   * Sample colony vitals when the interval has elapsed, then always roll the
   * per-tick fluid accumulators into the trailing-sol window.
   *
   * Preserves the exact gate, sample shape, ring-buffer cap and flow-reset
   * Simulation.recordHistory / resetFlows used — move-not-redesign.
   */
  static tick(state: ColonyState): void {
    if (state.simTime - state.lastHistoryAt < HISTORY_INTERVAL_S) {
      // Flows are per-tick accumulators; reset them after they've been read.
      HistorySystem.resetFlows(state);
      return;
    }
    state.lastHistoryAt = state.simTime;
    state.history.push({
      t: state.simTime,
      genKw: state.power.generationKw,
      loadKw: state.power.servedKw,
      storedFrac: state.power.capacityKWh > 0 ? state.power.storedKWh / state.power.capacityKWh : 0,
      water: state.pools.amounts.water,
      oxygen: state.pools.amounts.oxygen,
      food: state.pools.amounts.food,
    });
    while (state.history.length > HISTORY_SAMPLES) state.history.shift();
    HistorySystem.resetFlows(state);
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
   * rewound) so resumed colonies do not inherit stale charts.
   */
  static clear(state: ColonyState): void {
    state.history = [];
    state.flowWindow = [];
    state.lastHistoryAt = -Infinity;
  }

  /**
   * Re-anchor sampling after a calendar jump (`devSetTime`). The weather
   * scheduler and history windows must stay coherent after the jump — same
   * fields Simulation.devSetTime cleared before this phase.
   */
  static afterTimeJump(state: ColonyState): void {
    state.lastHistoryAt = -Infinity;
    state.lastFlows = emptyFlows();
    state.flowWindow = [];
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
