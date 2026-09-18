/**
 * Phase 7 — Extract LifeSupportSystem
 *
 * Goal per roadmap §11: separate colonist survival mechanics from the main
 * simulation. No redesign — the pure needs resolver already lives in
 * `sim/lifesupport.ts` (`applyColonistNeeds`); what was missing is a named
 * owner for the pipeline around it. This system is that owner:
 *
 *     input      — ColonyState (colonist, fluid pools, buildings as
 *                  pressurised volumes, weather for EVA limits, the
 *                  difficulty consumption multiplier, elapsed tick)
 *        ↓
 *     resolver   — applyColonistNeeds (sim/lifesupport.ts, unchanged, pure)
 *        ↓
 *     output     — pool amounts, colonist health / suit / inside / order /
 *                  activity, flow accounting, potential mission-end
 *
 * Cross-domain seams:
 *   - {@link LifeSupportHostHooks.endMission} — death is a failure-domain
 *     effect (Phase 15); Simulation implements it against the existing
 *     private method so there is no second source of truth.
 *   - {@link LifeSupportHostHooks.completeBuilding} — assisting construction
 *     is a construction-domain question (Phase 9). Same shape as Phase 6's
 *     PowerSystemContext: the system only needs the answer.
 *
 * Power results are an *input* in the roadmap sense (the pod's scrubbers are
 * a tier-0 load), but the fluid draw itself does not consult the grid —
 * consumption continues through a brownout. That is current behaviour,
 * pinned by tests, not a new coupling.
 *
 * Determinism: no RNG, no wall clock — the same state, same weather, same
 * tick always produce the same pools and the same colonist.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts.
 */

import {
  applyColonistNeeds,
  makeColonist,
  type Colonist,
  type ColonistOrder,
} from '../lifesupport';
import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { remainingCostTotal } from '../state/BuildingState';
import { BUILDINGS, ALL_FLUIDS, emptyFluids } from '../defs';
import { clamp } from '../../lib/rng';
import {
  SIM_TICK,
  SOLS_PER_SEC,
  SOL_SECONDS,
  SPAWN_X,
  SPAWN_Z,
  POD_RADIUS,
  COLONIST_SPEED,
  COLONIST_BUILD_POWER,
  COLONIST_O2_PER_SOL,
  COLONIST_WATER_PER_SOL,
  COLONIST_FOOD_PER_SOL,
  SUIT_O2_CAPACITY,
} from '../config';

const ARRIVE_EPS = 0.6;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** A pressurised volume the colonist can live in (pod is id 0). */
export interface Shelter {
  id: number;
  x: number;
  z: number;
  radius: number;
  recycles: boolean;
}

/**
 * Cross-domain effects life support triggers but does not own. Implemented
 * by Simulation (wired to ConstructionSystem / FailureSystem);
 * will absorb the implementor, not the contract.
 */
export interface LifeSupportHostHooks {
  /** The colonist has died (failure domain). */
  endMission(reason: string): void;
  /**
   * A building the colonist was assisting has reached progress 1
   * (construction domain).
   */
  completeBuilding(b: Building): void;
}

export class LifeSupportSystem {
  /**
   * Consume one tick of life support: detect which shelter (if any) the
   * colonist occupies, draw oxygen / water / food, refill the suit while
   * docked, account the flows, and end the mission if they did not make it.
   *
   * Runs after the power tick (TDD §4 step 5), so `state.power` is this
   * tick's result — even though the fluid draw itself does not consult it.
   */
  static tick(state: ColonyState, hooks: LifeSupportHostHooks): void {
    // Difficulty appetite: a Survivor crew burns through stores faster.
    const sols = SIM_TICK * SOLS_PER_SEC * state.consumptionMul;
    const c = state.colonist;
    if (c.dead) return;

    // Which shelter (if any) is the colonist inside?
    let inside = false;
    let shelterId = -1;
    let recycles = false;
    for (const s of LifeSupportSystem.shelters(state)) {
      if (Math.hypot(s.x - c.x, s.z - c.z) <= s.radius + 1.5) {
        inside = true;
        shelterId = s.id;
        recycles = s.recycles;
        break;
      }
    }
    const wasInside = c.inside;
    c.inside = inside;
    c.shelterId = inside ? shelterId : -1;
    if (wasInside && !inside) {
      state.alerts.event(
        'info',
        `${c.name} has gone EVA. Suit O₂ reserve: ${(c.suitO2 * 60 / COLONIST_O2_PER_SOL / 24.66).toFixed(0)} min.`,
        state.simTime,
        state.clock.format(),
      );
    } else if (!wasInside && inside) {
      state.alerts.event(
        'ok',
        `${c.name} is back inside and repressurised.`,
        state.simTime,
        state.clock.format(),
      );
    }

    const outcome = applyColonistNeeds(c, state.pools, sols, recycles);

    state.flows.oxygen.consumed += COLONIST_O2_PER_SOL * sols * outcome.met.oxygen;
    state.flows.water.consumed += COLONIST_WATER_PER_SOL * sols * outcome.met.water;
    state.flows.food.consumed += COLONIST_FOOD_PER_SOL * sols * outcome.met.food;
    state.flows.water.produced += outcome.reclaimed;

    if (c.dead && !state.gameOver) {
      hooks.endMission(`${c.name} did not survive.`);
    }
  }

  /**
   * Walk the colonist toward their current order. Survival overrides —
   * a critically low suit, or a storm that blocks EVA — abort whatever
   * they were doing and send them home. Assisting construction is the
   * one cross-domain effect, paid through {@link LifeSupportHostHooks.completeBuilding}.
   *
   * Runs with rover movement (TDD §4 step 7), *after* the life-support
   * tick, so a death this tick is already latched before we set
   * `incapacitated`.
   */
  static tickColonist(state: ColonyState, hooks: LifeSupportHostHooks): void {
    const c = state.colonist;
    if (c.dead) {
      c.activity = 'incapacitated';
      return;
    }

    // Out of suit oxygen? Override any order and run for the nearest airlock.
    const suitCritical = !c.inside && c.suitO2 <= SUIT_O2_CAPACITY * 0.25;
    if (suitCritical && c.order.type !== 'shelter') {
      c.order = { type: 'shelter' };
      state.alerts.event(
        'crit',
        `${c.name}'s suit reserve is critical — aborting EVA.`,
        state.simTime,
        state.clock.format(),
      );
    }

    // A storm rolling in does the same: nobody is outside in a severe storm.
    if (!c.inside && state.weather.blocksEVAAt(c.x, c.z) && c.order.type !== 'shelter') {
      c.order = { type: 'shelter' };
      state.alerts.event(
        'crit',
        `${c.name} recalled — the storm is too severe to stay outside.`,
        state.simTime,
        state.clock.format(),
      );
    }

    let tx = c.x;
    let tz = c.z;
    let arriveActivity: Colonist['activity'] = 'sheltered';

    switch (c.order.type) {
      case 'shelter': {
        const s = LifeSupportSystem.nearestShelter(state, c.x, c.z);
        tx = s.x;
        tz = s.z;
        arriveActivity = 'sheltered';
        break;
      }
      case 'moveTo':
        tx = c.order.x;
        tz = c.order.z;
        // Standing at the destination is a valid state: the colonist waits
        // there (on suit reserves) until told otherwise or the suit forces an
        // abort. Silently drifting home would make EVA orders feel ignored.
        arriveActivity = 'walking';
        break;
      case 'assist': {
        const buildingId = c.order.buildingId;
        const b = state.buildings.find((x) => x.id === buildingId);
        if (!b || b.state === 'online') {
          c.order = { type: 'shelter' };
          return;
        }
        tx = b.x;
        tz = b.z;
        arriveActivity = 'assisting';
        break;
      }
    }

    const dx = tx - c.x;
    const dz = tz - c.z;
    const dist = Math.hypot(dx, dz);
    const arriveAt =
      c.order.type === 'assist'
        ? BUILDINGS[
            state.buildings.find((x) => x.id === (c.order as { buildingId: number }).buildingId)?.kind ?? 'habitat'
          ].radius + 3
        : c.order.type === 'shelter'
          ? 1.5
          : ARRIVE_EPS;

    if (dist > arriveAt) {
      const stepLen = COLONIST_SPEED * SIM_TICK;
      const ux = dx / dist;
      const uz = dz / dist;
      c.x += ux * Math.min(stepLen, dist);
      c.z += uz * Math.min(stepLen, dist);
      c.heading = lerpAngle(c.heading, Math.atan2(ux, uz), 0.2);
      c.activity = c.order.type === 'shelter' ? 'returning' : 'walking';
    } else {
      c.activity = arriveActivity;
      // Assisting the build crew: a real, if modest, contribution.
      if (c.order.type === 'assist') {
        const buildingId = c.order.buildingId;
        const b = state.buildings.find((x) => x.id === buildingId);
        if (b && b.state === 'building' && remainingCostTotal(b) <= 0) {
          b.progress = Math.min(
            1,
            b.progress + (COLONIST_BUILD_POWER * SIM_TICK) / b.buildTime,
          );
          if (b.progress >= 1) hooks.completeBuilding(b);
        }
      }
    }
    c.y = state.world.heightAt(c.x, c.z);
  }

  // ------------------------------------------------------- player intent ----

  /**
   * Issue a colonist order. Refuses an EVA the suit cannot survive, and
   * refuses one the weather will not allow — the sim should say so rather
   * than let the player discover it by killing their only human.
   */
  static order(state: ColonyState, order: ColonistOrder): void {
    const c = state.colonist;
    if (c.dead) return;
    if (order.type === 'moveTo') {
      /**
       * Refuse an EVA the suit cannot survive. The colonist carries a fixed
       * oxygen reserve, so there is a hard radius beyond which walking out is
       * simply suicide — the sim should say so rather than let the player
       * discover it by killing their only human.
       */
      const from = LifeSupportSystem.nearestShelter(state, order.x, order.z);
      const legDist = Math.hypot(order.x - from.x, order.z - from.z);
      const solsOfSuit = c.suitO2 / COLONIST_O2_PER_SOL;
      const reach = solsOfSuit * SOL_SECONDS * COLONIST_SPEED * 0.45;
      if (legDist > reach) {
        state.alerts.event(
          'warn',
          `Too far for an EVA — ${c.name}'s suit holds about ${Math.round(reach)} m of round trip.`,
          state.simTime,
          state.clock.format(),
        );
        return;
      }
      // A dust storm is the other hard no: visibility gone, grit in the seals.
      if (state.weather.blocksEVAAt(c.x, c.z)) {
        state.alerts.event(
          'warn',
          'EVA refused — the storm is too severe to go outside.',
          state.simTime,
          state.clock.format(),
        );
        return;
      }
      c.gx = order.x;
      c.gz = order.z;
    }
    c.order = order;
  }

  // ------------------------------------------------------ shelter queries ----

  /** Every pressurised volume the colonist could shelter in (pod is id 0). */
  static shelters(state: ColonyState): Shelter[] {
    const out: Shelter[] = [
      { id: 0, x: SPAWN_X, z: SPAWN_Z, radius: POD_RADIUS, recycles: false },
    ];
    for (const b of state.buildings) {
      if (b.state !== 'online' || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      if (!def.pressurized) continue;
      out.push({
        id: b.id,
        x: b.x,
        z: b.z,
        radius: def.radius,
        recycles: b.kind === 'habitat' && b.enabled,
      });
    }
    return out;
  }

  static nearestShelter(state: ColonyState, x: number, z: number): { x: number; z: number } {
    const list = LifeSupportSystem.shelters(state);
    let best = list[0];
    let bestD = Infinity;
    for (const s of list) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return { x: best.x, z: best.z };
  }

  // ------------------------------------------------------ lifecycle -------

  /**
   * Rebuild fluid pools and the colonist after a restore. Capacities must
   * already have been recomputed from the restored buildings (the caller
   * does that); this clamps the saved fluids into those tanks and rebuilds
   * the colonist from the save's fields.
   *
   * `fluids` and `colonistSave` are deliberately `unknown`: schema knowledge
   * stays behind the persistence boundary (Phase 3).
   */
  static restore(state: ColonyState, fluids: unknown, colonistSave: unknown): void {
    state.pools.amounts = { ...emptyFluids(), ...((fluids ?? {}) as Record<string, number>) };
    for (const f of ALL_FLUIDS) {
      state.pools.amounts[f] = clamp(state.pools.amounts[f], 0, state.pools.capacity[f]);
    }

    const cd = (colonistSave ?? {}) as {
      id?: number;
      name?: string;
      x?: number;
      z?: number;
      heading?: number;
      health?: number;
      suitO2?: number;
      inside?: boolean;
      shelterId?: number;
      order?: ColonistOrder;
      dead?: boolean;
    };
    state.colonist = makeColonist(
      cd.id ?? 1,
      cd.name ?? 'Cmdr. Vega',
      cd.x ?? SPAWN_X,
      0,
      cd.z ?? SPAWN_Z,
    );
    state.colonist.y = state.world.heightAt(state.colonist.x, state.colonist.z);
    state.colonist.heading = cd.heading ?? 0;
    state.colonist.health = cd.health ?? 100;
    state.colonist.suitO2 = cd.suitO2 ?? SUIT_O2_CAPACITY;
    state.colonist.inside = cd.inside ?? true;
    state.colonist.shelterId = cd.shelterId ?? 0;
    state.colonist.order = cd.order ?? { type: 'shelter' };
    state.colonist.dead = !!cd.dead;
  }
}
