/**
 * Phase 6 — Formalize PowerSystem
 *
 * Goal per roadmap §10: turn the existing power architecture into the model
 * for other systems. No redesign — the pure resolver already lives in
 * `sim/power.ts` (`resolvePower`); what was missing is a named owner for the
 * pipeline around it. This system is that owner:
 *
 *     input      — generation (pod RTG + buildings) and demand (pod life
 *                  support, building processes, rover charging) read off
 *                  ColonyState
 *        ↓
 *     resolver   — resolvePower (sim/power.ts, unchanged, pure)
 *        ↓
 *     output     — state.power / state.storedKWh, per-building genKw, loadKw,
 *                  throughput, powerSat, idleReason; per-rover chargeSat and
 *                  battery charge
 *
 * Cross-domain seams:
 *   - {@link PowerSystemContext} — how hard a process wants to run and what
 *     happens when it runs are *production* questions (Phase 8); the system
 *     only needs the answers, so they cross a context interface implemented
 *     by Simulation. No second source of truth.
 *   - Garage bay service + assembly (consumes `powerSat`) lives in
 *     GarageSystem (Phase 18); Simulation calls it right after this tick.
 *
 * Determinism: no RNG, no wall clock — the same state and sun always resolve
 * to the same grid. The per-tick `PowerResult` is stored on `state.power`
 * deliberately (the view projects it), so its allocation is necessary, not
 * waste; the demand list and desired-throughput map are tick-local scratch.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts.
 */

import { resolvePower, idlePower, type PowerDemand } from '../power';
import { batteryCapacityKWh } from '../state/PowerState';
import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { BUILDINGS, ROVERS } from '../defs';
import { clamp } from '../../lib/rng';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  POD_POWER_KW,
  POD_LIFE_SUPPORT_KW,
  POD_RADIUS,
  SPAWN_X,
  SPAWN_Z,
  ROVER_CHARGE_TIER,
  ROVER_CHARGE_RATE_KW,
  GARAGE_CHARGE_RATE_KW,
  devLevelMul,
} from '../config';

/**
 * The production-domain questions PowerSystem must ask to build its demand
 * list and apply its result. Implemented by ProductionSystem (Phase 8);
 * Simulation only wires the context. The contract did not change.
 */
export interface PowerSystemContext {
  /** How hard a building's process wants to run this tick, 0..1, ignoring power. */
  desiredThroughput(b: Building): number;
  /** Run one tick of the building's process at the satisfied throughput. */
  runProcess(b: Building, throughput: number, hours: number): void;
  /** Why a process that wants to run currently cannot (inputs, headroom). */
  processBlockReason(b: Building): string;
}

export class PowerSystem {
  /**
   * Resolve generation, demand and storage for this tick, then run every
   * building's process at whatever fraction of power it actually received.
   *
   * Runs right after the weather tick, so `state.dustTransmission` is this
   * tick's reading.
   */
  static tick(state: ColonyState, ctx: PowerSystemContext): void {
    const hours = SIM_TICK * HOURS_PER_SEC;
    const sun = state.clock.sun;

    // ---- input: generation ------------------------------------------------
    let genKw = POD_POWER_KW;
    for (const b of state.buildings) {
      b.genKw = 0;
      if (b.state !== 'online' || !b.enabled || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      if (!def.generation || def.powerProduceKw <= 0) continue;
      /**
       * TDD §11/§12's solar chain: irradiance x atmospheric dust x panel
       * cleanliness. The RTG doesn't care what the sky is doing — that is the
       * point of it.
       */
      const out =
        (def.generation === 'solar'
          ? def.powerProduceKw * sun.irradiance * state.dustTransmission * b.cleanliness
          : def.powerProduceKw) * devLevelMul(b.level);
      b.genKw = out;
      genKw += out;
    }

    // ---- input: demand ----------------------------------------------------
    const demands: PowerDemand[] = [];
    // The pod's own scrubbers and heaters are the highest priority load there is.
    demands.push({ id: -1, tier: 0, kw: POD_LIFE_SUPPORT_KW });

    const desired = new Map<number, number>();
    for (const b of state.buildings) {
      b.loadKw = 0;
      b.throughput = 0;
      b.idleReason = '';
      if (b.state !== 'online') {
        b.powerSat = 1;
        continue;
      }
      const def = BUILDINGS[b.kind];
      if (b.damaged) {
        b.powerSat = 1;
        b.idleReason = 'Damaged — needs repair';
        continue;
      }
      if (!b.enabled) {
        b.powerSat = 1;
        b.idleReason = 'Switched off';
        continue;
      }
      // How hard would this building *like* to run, ignoring power?
      const want = ctx.desiredThroughput(b);
      desired.set(b.id, want);
      const load = def.idlePowerKw + (def.powerDrawKw - def.idlePowerKw) * want;
      if (load > 0) demands.push({ id: b.id, tier: def.tier, kw: load });
    }

    // Rover charging is the lowest-priority load on the grid.
    for (const r of state.rovers) {
      const def = ROVERS[r.kind];
      const wantsCharge =
        r.phase !== 'disabled' &&
        r.battery < def.maxBatteryKWh - 1e-6 &&
        (r.phase === 'charging' || r.goal === 'charge') &&
        PowerSystem.nearCharger(state, r.x, r.z);
      if (!wantsCharge) {
        r.chargeSat = 0;
        continue;
      }
      const needKWh = def.maxBatteryKWh - r.battery;
      const kw = Math.min(PowerSystem.chargeRateKwAt(state, r.x, r.z), hours > 0 ? needKWh / hours : 0);
      if (kw > 0) demands.push({ id: r.id, tier: ROVER_CHARGE_TIER, kw });
    }

    // ---- resolver ---------------------------------------------------------
    const capacity = batteryCapacityKWh(state);
    state.storedKWh = Math.min(state.storedKWh, capacity);
    const result = resolvePower(genKw, demands, state.storedKWh, capacity, hours);
    state.power = result;
    state.storedKWh = result.storedKWh;

    // ---- output: apply ----------------------------------------------------
    for (const b of state.buildings) {
      if (b.state !== 'online' || !b.enabled || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      const sat = result.satisfaction.get(b.id) ?? 1;
      b.powerSat = sat;
      const want = desired.get(b.id) ?? 0;
      const actual = want * sat;
      b.throughput = actual;
      b.loadKw = (def.idlePowerKw + (def.powerDrawKw - def.idlePowerKw) * want) * sat;
      if (def.process) {
        if (actual > 1e-6) ctx.runProcess(b, actual, hours);
        else if (!b.idleReason) {
          b.idleReason = sat < 0.99 ? 'No power' : ctx.processBlockReason(b);
        }
      }
    }

    for (const r of state.rovers) {
      const def = ROVERS[r.kind];
      const sat = result.satisfaction.get(r.id);
      if (sat === undefined) continue;
      r.chargeSat = sat;
      const needKWh = def.maxBatteryKWh - r.battery;
      const kw = Math.min(PowerSystem.chargeRateKwAt(state, r.x, r.z), hours > 0 ? needKWh / hours : 0);
      r.battery = Math.min(def.maxBatteryKWh, r.battery + kw * sat * hours);
    }
  }

  // ---------------------------------------------------- charger queries ----

  /** Somewhere a rover can draw charge: the pod, or any online habitat. */
  static nearCharger(state: ColonyState, x: number, z: number): boolean {
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < POD_RADIUS + 6) return true;
    for (const b of state.buildings) {
      if (b.state !== 'online' || b.damaged || !b.enabled) continue;
      if (!BUILDINGS[b.kind].providesCharge) continue;
      if (Math.hypot(b.x - x, b.z - z) < BUILDINGS[b.kind].radius + 5) return true;
    }
    return false;
  }

  /** How fast a rover at this spot can charge: garages fast-charge, else base rate. */
  static chargeRateKwAt(state: ColonyState, x: number, z: number): number {
    for (const b of state.buildings) {
      if (b.kind !== 'garage' || b.state !== 'online' || b.damaged || !b.enabled) continue;
      if (Math.hypot(b.x - x, b.z - z) < BUILDINGS.garage.radius + 5) {
        return GARAGE_CHARGE_RATE_KW * devLevelMul(b.level);
      }
    }
    return ROVER_CHARGE_RATE_KW;
  }

  // ------------------------------------------------------ lifecycle -------

  /**
   * Rebuild grid state after a restore: clamp the saved storage to the
   * capacity the restored buildings actually provide, and park an idle
   * result until the next tick resolves the real grid.
   */
  static restore(state: ColonyState, storedKWh: number | undefined): void {
    state.storedKWh = clamp(storedKWh ?? 0, 0, batteryCapacityKWh(state));
    state.power = idlePower(batteryCapacityKWh(state), state.storedKWh);
  }
}
