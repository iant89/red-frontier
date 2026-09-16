/**
 * Phase 4 — Extract ClockSystem
 *
 * Goal per roadmap §8: Remove time advancement logic from Simulation.ts
 *
 * Responsibilities:
 *   - simulation time (simTime)
 *   - tick count (ticksRun)
 *   - day/night state (SolClock + SunState)
 *   - fixed-step timing (remainder, SIM_TICK accumulation, max catch-up)
 *
 * Does NOT know about:
 *   - Three.js, DOM, renderer, UI
 *   - weather, power, rovers, etc. (future systems)
 *
 * Design: State contains data (ColonyState.clock, simTime, ticksRun, remainder).
 * System contains behavior — pure static methods operating on that state.
 * This keeps the "State = data, System = behavior" boundary clean and makes
 * ClockSystem testable in isolation.
 */

import { SolClock, type SunState } from '../clock';
import { SIM_TICK, SOL_SECONDS, START_SOL_FRAC } from '../config';
import { clamp } from '../../lib/rng';
import type { ColonyState } from '../state/ColonyState';

export const CLOCK_MAX_TICKS = 400;

export class ClockSystem {
  /**
   * Fixed-step accumulation — mirrors old Simulation.step remainder logic.
   * Returns how many SIM_TICKs are owed for this frame.
   * Mutates state.remainder.
   *
   * Epsilon absorbs representation error so a delivery that is mathematically
   * a whole number of ticks always yields that many ticks.
   * Caps at CLOCK_MAX_TICKS to bound catch-up when tab was backgrounded.
   */
  static consume(state: ColonyState, frameDt: number): number {
    if (frameDt <= 0 || !Number.isFinite(frameDt)) return 0;
    state.remainder += frameDt;

    let owed = Math.floor(state.remainder / SIM_TICK + 1e-9);

    if (owed > CLOCK_MAX_TICKS) {
      owed = CLOCK_MAX_TICKS;
      state.remainder = 0; // drop backlog rather than fast-forward
    } else {
      state.remainder -= owed * SIM_TICK;
    }
    return owed;
  }

  /**
   * Advance one fixed tick: simTime, ticksRun, clock.
   * Returns true when a new sol began.
   */
  static tick(state: ColonyState): boolean {
    state.simTime += SIM_TICK;
    state.ticksRun++;
    return state.clock.advance(SIM_TICK);
  }

  /**
   * Jump the mission calendar: set sol and frac (0=midnight, 0.25=sunrise, 0.5=noon).
   * Syncs simTime so weather scheduler and history windows stay coherent.
   * Only touches clock + simTime — caller (Simulation.devSetTime) handles
   * weather.time, history, flows.
   */
  static setTime(state: ColonyState, sol: number, frac: number): void {
    const target = Math.max(0, Math.floor(sol));
    const f = clamp(frac, 0, 0.9999);
    state.clock.restore({ sol: target, frac: f });
    state.simTime = Math.max(0, (target + f - START_SOL_FRAC) * SOL_SECONDS);
  }

  // ---- read-only projections (delegated for convenience) -------------------

  static sun(state: ColonyState): SunState {
    return state.clock.sun;
  }

  static format(state: ColonyState): string {
    return state.clock.format();
  }

  static phase(state: ColonyState): string {
    return state.clock.phase();
  }

  static solsElapsed(state: ColonyState): number {
    return state.clock.solsElapsed;
  }

  // ---- persistence helpers -------------------------------------------------

  static snapshot(state: ColonyState): { simTime: number; ticksRun: number; clock: { sol: number; frac: number } } {
    return {
      simTime: state.simTime,
      ticksRun: state.ticksRun,
      clock: state.clock.snapshot(),
    };
  }

  static restore(state: ColonyState, data: { simTime?: number; ticksRun?: number; clock?: { sol?: number; frac?: number } }): void {
    state.simTime = data.simTime || 0;
    state.ticksRun = data.ticksRun ?? Math.floor(state.simTime / SIM_TICK + 1e-9);
    state.remainder = 0;
    state.clock.restore(data.clock);
  }

  // ---- factory -------------------------------------------------------------

  static createClock(): SolClock {
    return new SolClock();
  }
}

// Re-export for convenience
export { SolClock, type SunState } from '../clock';
export { SIM_TICK } from '../config';
