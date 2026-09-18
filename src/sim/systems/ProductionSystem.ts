/**
 * Phase 8 — Extract ProductionSystem
 *
 * Goal per roadmap §12: separate resource production from Simulation
 * orchestration. No redesign — processes are already declarative
 * (`BuildingDef.process` in `sim/defs.ts`); what was missing is a named
 * owner for the three questions PowerSystem asks about them:
 *
 *     input      — ColonyState (storage, fluid pools, sun, dust, the
 *                  building's process definition and upgrade level)
 *        ↓
 *     resolver   — desiredThroughput (how hard it *wants* to run, 0..1,
 *                  ignoring power) / runProcess (move the mass)
 *        ↓
 *     output     — storage and pool amounts, flow accounting, idle reasons
 *
 * These three methods *are* {@link PowerSystemContext}. Phase 6 left the
 * implementor on Simulation; this phase absorbs it. PowerSystem still
 * owns *when* a process runs (satisfaction × want) and *whether* the
 * domain is even asked why it is idle ("No power" wins a brownout).
 *
 * Garage bay service + assembly lives in GarageSystem (Phase 18) — it
 * consumes `powerSat` rather than converting mass, so it is not production.
 *
 * Determinism: no RNG, no wall clock — the same stores, same sun, same
 * tick always move the same mass.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { BUILDINGS, ALL_RESOURCES, ALL_FLUIDS, RESOURCES, FLUIDS } from '../defs';
import { addFluid, takeFluid, fluidHeadroom } from '../lifesupport';
import { clamp } from '../../lib/rng';
import { SIM_TICK, HOURS_PER_SEC, SOLS_PER_SEC, devLevelMul } from '../config';
import { LogisticsSystem } from './LogisticsSystem';

export class ProductionSystem {
  /**
   * How hard a process wants to run this tick, 0..1, considering only its
   * inputs and its output headroom — power is applied separately.
   */
  static desiredThroughput(state: ColonyState, b: Building): number {
    const def = BUILDINGS[b.kind];
    if (!def.process) return def.powerDrawKw > 0 ? 1 : 0;
    const hours = SIM_TICK * HOURS_PER_SEC;
    const p = def.process;
    // An upgraded line moves mul× the mass per hour, so its *want* is gated
    // against the multiplied rates too — the gate and the flow must agree.
    const mul = devLevelMul(b.level);
    let factor = 1;

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const rate = p.solidIn[res];
        if (!rate) continue;
        const need = rate * mul * hours;
        factor = Math.min(factor, need > 0 ? state.storage[res] / need : 1);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidIn[f];
        if (!rate) continue;
        const need = rate * mul * hours;
        factor = Math.min(factor, need > 0 ? state.pools.amounts[f] / need : 1);
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidOut[f];
        if (!rate) continue;
        const make = rate * mul * hours;
        factor = Math.min(factor, make > 0 ? fluidHeadroom(state.pools, f) / make : 1);
      }
    }
    if (p.needsLight) {
      // Crops slow to a crawl in the dark rather than stopping dead — grow
      // lamps keep a trickle going, which is what the power draw is for.
      // The panels' own dust film does not matter here (the crops are inside),
      // but the sky's ambient dust absolutely does.
      const light = 0.15 + 0.85 * clamp(state.clock.sun.irradiance * state.dustTransmission, 0, 1);
      factor = Math.min(factor, light);
    }
    return clamp(factor, 0, 1);
  }

  /** Why a process with power is still not running. */
  static processBlockReason(state: ColonyState, b: Building): string {
    if (b.damaged) return 'Damaged — needs repair';
    const def = BUILDINGS[b.kind];
    const p = def.process;
    if (!p) return '';
    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        if (p.solidIn[res] && state.storage[res] <= 1e-6) {
          return `Out of ${RESOURCES[res].label}`;
        }
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        if (p.fluidIn[f] && state.pools.amounts[f] <= 1e-6) {
          return `Out of ${FLUIDS[f].label}`;
        }
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        if (p.fluidOut[f] && fluidHeadroom(state.pools, f) <= 1e-6) {
          return `${FLUIDS[f].label} tanks full`;
        }
      }
    }
    if (p.needsLight && state.clock.sun.irradiance < 0.02) return 'Waiting for daylight';
    return 'Idle';
  }

  /** Move mass through a process at `rate` (0..1) for `hours` Mars hours. */
  static runProcess(state: ColonyState, b: Building, rate: number, hours: number): void {
    const p = BUILDINGS[b.kind].process!;
    const perSol = 1 / (hours <= 0 ? 1 : hours) / (SIM_TICK * SOLS_PER_SEC ? 1 : 1);
    void perSol;

    // A developer-mode upgraded line converts more mass for the same power.
    const mul = devLevelMul(b.level);

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const r = p.solidIn[res];
        if (!r) continue;
        // Phase 13: solid inputs are the storage ledger's to move.
        LogisticsSystem.take(state, res, r * mul * rate * hours);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidIn[f];
        if (!r) continue;
        const got = takeFluid(state.pools, f, r * mul * rate * hours);
        state.flows[f].consumed += got;
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidOut[f];
        if (!r) continue;
        const made = addFluid(state.pools, f, r * mul * rate * hours);
        state.flows[f].produced += made;
      }
    }
  }
}
