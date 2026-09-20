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
 * `solidOut` (P5) is the refining half of the same job: a process may *make*
 * bulk solids, which land in the storage ledger through LogisticsSystem and
 * are therefore hauled, reserved and spent like mined ore — one ledger, not a
 * parallel one for refined goods.
 *
 * `componentOut` (P5 slice 2) is the manufacturing half, and the one place this
 * system touches a *second* ledger: components are counted, not weighed, so a
 * finished unit goes to `ComponentSystem` and the fraction that is not finished
 * yet stays on the building's bench (`Building.craft`). Which line a building
 * runs at all is `Building.recipe`, resolved through `defs.activeProcess` — the
 * one reader the sim, renderer and HUD all share, so they cannot disagree.
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
import {
  BUILDINGS,
  ALL_RESOURCES,
  ALL_FLUIDS,
  ALL_COMPONENTS,
  COMPONENTS,
  RESOURCES,
  FLUIDS,
  activeProcess,
  recipesFor,
} from '../defs';
import { ComponentSystem } from './ComponentSystem';
import type { Severity } from '../alerts';
import { addFluid, takeFluid, fluidHeadroom } from '../lifesupport';
import { clamp } from '../../lib/rng';
import { SIM_TICK, HOURS_PER_SEC, devLevelMul } from '../config';
import { LogisticsSystem } from './LogisticsSystem';

export class ProductionSystem {
  /**
   * How hard a process wants to run this tick, 0..1, considering only its
   * inputs and its output headroom — power is applied separately.
   */
  static desiredThroughput(state: ColonyState, b: Building): number {
    const def = BUILDINGS[b.kind];
    // The line this building is *running* — its fixed process, or whichever
    // recipe the player selected (P5). Everything below reads that, never
    // `def.process`, so a workshop on the board line wants boards.
    const p = activeProcess(b.kind, b.recipe);
    if (!p) return def.powerDrawKw > 0 ? 1 : 0;
    const hours = SIM_TICK * HOURS_PER_SEC;
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
    if (p.solidOut) {
      // Refining (P5): a smelter can only run as fast as its output silo has
      // room. Same ledger, same clamp as a rover unloading a cargo bed.
      for (const res of ALL_RESOURCES) {
        const rate = p.solidOut[res];
        if (!rate) continue;
        const make = rate * mul * hours;
        factor = Math.min(factor, make > 0 ? LogisticsSystem.room(state, res) / make : 1);
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
    if (p.componentOut) {
      // Components are racked whole, so the gate is a whole free slot rather
      // than a fraction: a line with nowhere to put a finished motor stops.
      for (const comp of ALL_COMPONENTS) {
        if (p.componentOut[comp] && ComponentSystem.room(state, comp) < 1) factor = 0;
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
    const p = activeProcess(b.kind, b.recipe);
    if (!p) return '';
    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        if (p.solidIn[res] && state.storage[res] <= 1e-6) {
          return `Out of ${RESOURCES[res].label}`;
        }
      }
    }
    if (p.solidOut) {
      for (const res of ALL_RESOURCES) {
        if (p.solidOut[res] && LogisticsSystem.room(state, res) <= 1e-6) {
          return `${RESOURCES[res].label} silo full`;
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
    if (p.componentOut) {
      for (const comp of ALL_COMPONENTS) {
        if (p.componentOut[comp] && ComponentSystem.room(state, comp) < 1) {
          return `${COMPONENTS[comp].label} rack full`;
        }
      }
    }
    if (p.needsLight && state.clock.sun.irradiance < 0.02) return 'Waiting for daylight';
    return 'Idle';
  }

  /** Move mass through a process at `rate` (0..1) for `hours` Mars hours. */
  static runProcess(state: ColonyState, b: Building, rate: number, hours: number): void {
    const p = activeProcess(b.kind, b.recipe)!;

    // A developer-mode upgraded line converts more mass for the same power.
    const mul = devLevelMul(b.level);

    /**
     * What the inputs actually handed over, 0..1 — and the fraction the outputs
     * are allowed to claim. Mass is conserved through a process: an output is
     * *earned* by input that arrived, never by input that was asked for.
     *
     * `desiredThroughput` normally keeps the ask inside what the stores hold,
     * but it answers per building before any of them draws, so two lines on one
     * silo (two refineries on the same ore pile, two extractors on the same ice)
     * can both be granted a full rate and the second one comes up short. Without
     * this coupling that shortfall was made up out of nothing — water from ice
     * that was not there, steel from ore that was not there.
     */
    let earned = 1;

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const r = p.solidIn[res];
        if (!r) continue;
        // Phase 13: solid inputs are the storage ledger's to move.
        const amount = r * mul * rate * hours;
        const took = LogisticsSystem.take(state, res, amount);
        if (amount > 0) earned = Math.min(earned, took / amount);
        if (took > 1e-9) {
          state.domainEvents.push({
            type: 'resource/consumed',
            resource: res,
            amount: took,
            buildingId: b.id,
          });
        }
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidIn[f];
        if (!r) continue;
        const want = r * mul * rate * hours;
        const got = takeFluid(state.pools, f, want);
        if (want > 0) earned = Math.min(earned, got / want);
        state.flows[f].consumed += got;
        if (got > 1e-9) {
          state.domainEvents.push({
            type: 'resource/consumed',
            resource: f,
            amount: got,
            buildingId: b.id,
          });
        }
      }
    }
    if (p.solidOut) {
      for (const res of ALL_RESOURCES) {
        const r = p.solidOut[res];
        if (!r) continue;
        // Refined material joins the one bulk ledger: clamped to silo room,
        // then hauled, stored and spent exactly like dug ore (roadmap §39).
        const made = LogisticsSystem.store(state, res, r * mul * rate * hours * earned);
        if (made > 1e-9) {
          state.domainEvents.push({
            type: 'resource/produced',
            resource: res,
            amount: made,
            buildingId: b.id,
          });
        }
      }
    }
    if (p.componentOut) {
      for (const comp of ALL_COMPONENTS) {
        const r = p.componentOut[comp];
        if (!r) continue;
        // The bench keeps the fraction; the ledger only ever holds whole units.
        // `desiredThroughput` refuses to run a line whose rack is full, so this
        // normally stores exactly what finished. The clamp is the belt to that
        // brace: if a second workshop fills the rack mid-tick, this line keeps at
        // most the one unit it just finished rather than banking invisible
        // progress that all lands at once when the rack frees up.
        b.craft[comp] = Math.min(1, b.craft[comp] + r * mul * rate * hours * earned);
        const whole = Math.floor(b.craft[comp]);
        if (whole < 1) continue;
        const racked = ComponentSystem.store(state, comp, whole);
        b.craft[comp] -= racked;
        if (racked > 0) {
          state.domainEvents.push({
            type: 'component/crafted',
            component: comp,
            amount: racked,
            buildingId: b.id,
          });
        }
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidOut[f];
        if (!r) continue;
        const made = addFluid(state.pools, f, r * mul * rate * hours * earned);
        state.flows[f].produced += made;
        if (made > 1e-9) {
          state.domainEvents.push({
            type: 'resource/produced',
            resource: f,
            amount: made,
            buildingId: b.id,
          });
        }
      }
    }
  }

  /**
   * Switch a building's production line (P5). The sim answers, the UI never
   * guesses: an unknown building, a kind with a fixed line, or an index outside
   * the recipe list are all refusals with a line in the log, exactly like a
   * placement verdict. Selecting the line already running is a no-op success, so
   * a stale UI click cannot spam the log.
   *
   * Work in progress survives the changeover — `craft` is keyed by component,
   * not by recipe — so stopping a motor run half way through does not throw the
   * half-made motor away.
   */
  static setRecipe(state: ColonyState, buildingId: number, recipe: number): boolean {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) {
      ProductionSystem.log(state, 'warn', 'No such structure to reconfigure.');
      return false;
    }
    const def = BUILDINGS[b.kind];
    const list = recipesFor(b.kind);
    if (list.length === 0) {
      ProductionSystem.log(state, 'warn', `${def.label} runs a fixed line — there is nothing to switch.`);
      return false;
    }
    if (!Number.isInteger(recipe) || recipe < 0 || recipe >= list.length) {
      ProductionSystem.log(state, 'warn', `${def.label} does not run a line ${recipe}.`);
      return false;
    }
    if (b.recipe === recipe) return true;
    b.recipe = recipe;
    ProductionSystem.log(state, 'info', `${def.label} switched to ${list[recipe].label}.`);
    return true;
  }

  private static log(state: ColonyState, severity: Severity, text: string): void {
    state.alerts.event(severity, text, state.simTime, state.clock.format());
  }
}
