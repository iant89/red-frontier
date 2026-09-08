/**
 * Life support: the fluid economy and the one human it exists to keep alive.
 *
 * GDD §08. Water is extracted from ice, split into oxygen, and drunk by both
 * the crew and the crops. Everything here is expressed **per sol** so the
 * numbers read like a mission plan rather than a spreadsheet.
 *
 * The colonist is deliberately fragile in one specific way: oxygen kills in
 * minutes, water in days, food in weeks. That ordering is what makes the build
 * order (extractor → oxygenator → greenhouse) feel discovered rather than
 * dictated.
 */

import type { FluidAmounts, FluidId } from './defs';
import { ALL_FLUIDS, emptyFluids } from './defs';
import {
  COLONIST_O2_PER_SOL,
  COLONIST_WATER_PER_SOL,
  COLONIST_FOOD_PER_SOL,
  WATER_RECLAIM_FRACTION,
  SUIT_O2_CAPACITY,
  HEALTH_LOSS_NO_O2,
  HEALTH_LOSS_NO_WATER,
  HEALTH_LOSS_NO_FOOD,
  HEALTH_REGEN,
} from './config';
import { clamp } from '../lib/rng';

// ---------------------------------------------------------- fluid pools ----

export interface FluidPools {
  amounts: FluidAmounts;
  capacity: FluidAmounts;
}

export function makePools(initial?: Partial<FluidAmounts>): FluidPools {
  return {
    amounts: { ...emptyFluids(), ...initial },
    capacity: emptyFluids(),
  };
}

/** Remove up to `want` of a fluid. Returns how much was actually available. */
export function takeFluid(p: FluidPools, id: FluidId, want: number): number {
  if (want <= 0) return 0;
  const got = Math.min(want, p.amounts[id]);
  p.amounts[id] -= got;
  if (p.amounts[id] < 1e-9) p.amounts[id] = 0;
  return got;
}

/** Add a fluid, discarding anything past capacity. Returns the accepted mass. */
export function addFluid(p: FluidPools, id: FluidId, amount: number): number {
  if (amount <= 0) return 0;
  const room = Math.max(0, p.capacity[id] - p.amounts[id]);
  const accepted = Math.min(amount, room);
  p.amounts[id] += accepted;
  return accepted;
}

/** Free space for a fluid (kg). */
export function fluidHeadroom(p: FluidPools, id: FluidId): number {
  return Math.max(0, p.capacity[id] - p.amounts[id]);
}

export function fluidFraction(p: FluidPools, id: FluidId): number {
  if (p.capacity[id] <= 0) return 0;
  return clamp(p.amounts[id] / p.capacity[id], 0, 1);
}

// -------------------------------------------------------------- colonist ----

export type ColonistActivity =
  | 'sheltered'
  | 'walking'
  | 'assisting'
  | 'returning'
  | 'incapacitated';

export interface Colonist {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** 0..100. Zero means the mission is over. */
  health: number;
  /** Oxygen left in the EVA suit (kg). Only drains outside. */
  suitO2: number;
  /** True when the colonist is inside a pressurised volume. */
  inside: boolean;
  /** Entity id of the shelter they are in (0 = the landing pod). */
  shelterId: number;
  activity: ColonistActivity;
  /** Player-issued destination, if any. */
  order: ColonistOrder;
  /** Travel target. */
  gx: number;
  gz: number;
  /** Which needs went unmet on the last tick — drives alerts and the HUD. */
  starved: { oxygen: boolean; water: boolean; food: boolean };
  /** True once the colonist has died; the sim latches this. */
  dead: boolean;
}

export type ColonistOrder =
  | { type: 'shelter' }
  | { type: 'moveTo'; x: number; z: number }
  | { type: 'assist'; buildingId: number };

export function makeColonist(
  id: number,
  name: string,
  x: number,
  y: number,
  z: number,
): Colonist {
  return {
    id,
    name,
    x,
    y,
    z,
    heading: 0,
    health: 100,
    suitO2: SUIT_O2_CAPACITY,
    inside: true,
    shelterId: 0,
    activity: 'sheltered',
    order: { type: 'shelter' },
    gx: x,
    gz: z,
    starved: { oxygen: false, water: false, food: false },
    dead: false,
  };
}

/** Per-sol demand of one colonist, before any recycling. */
export const COLONIST_DEMAND: Record<FluidId, number> = {
  oxygen: COLONIST_O2_PER_SOL,
  water: COLONIST_WATER_PER_SOL,
  food: COLONIST_FOOD_PER_SOL,
};

export interface NeedsOutcome {
  /** Fraction of each need that was met this tick, 0..1. */
  met: Record<FluidId, number>;
  /** Water returned to the pools by habitat reclamation (kg). */
  reclaimed: number;
  /** Net health change applied this tick. */
  healthDelta: number;
}

/**
 * Consume one tick of life support for a colonist and update their health.
 *
 * @param c        the colonist (mutated)
 * @param pools    colony fluid pools (mutated)
 * @param sols     length of this tick in sols
 * @param recycles whether their current shelter reclaims water
 */
export function applyColonistNeeds(
  c: Colonist,
  pools: FluidPools,
  sols: number,
  recycles: boolean,
): NeedsOutcome {
  const met: Record<FluidId, number> = { oxygen: 1, water: 1, food: 1 };
  let reclaimed = 0;

  // ---- oxygen -------------------------------------------------------------
  const o2Want = COLONIST_O2_PER_SOL * sols;
  if (c.inside) {
    // Breathing station air, and topping the suit back up while docked.
    const got = takeFluid(pools, 'oxygen', o2Want);
    met.oxygen = o2Want > 0 ? got / o2Want : 1;
    const refill = Math.min(
      SUIT_O2_CAPACITY - c.suitO2,
      takeFluid(pools, 'oxygen', Math.min(SUIT_O2_CAPACITY - c.suitO2, sols * 4)),
    );
    c.suitO2 = clamp(c.suitO2 + refill, 0, SUIT_O2_CAPACITY);
  } else {
    // On suit reserves only. This is the clock that makes EVA tense.
    const got = Math.min(o2Want, c.suitO2);
    c.suitO2 = Math.max(0, c.suitO2 - got);
    met.oxygen = o2Want > 0 ? got / o2Want : 1;
  }

  // ---- water --------------------------------------------------------------
  const waterWant = COLONIST_WATER_PER_SOL * sols;
  const waterGot = takeFluid(pools, 'water', waterWant);
  met.water = waterWant > 0 ? waterGot / waterWant : 1;
  if (recycles && waterGot > 0) {
    reclaimed = addFluid(pools, 'water', waterGot * WATER_RECLAIM_FRACTION);
  }

  // ---- food ---------------------------------------------------------------
  const foodWant = COLONIST_FOOD_PER_SOL * sols;
  const foodGot = takeFluid(pools, 'food', foodWant);
  met.food = foodWant > 0 ? foodGot / foodWant : 1;

  // ---- health -------------------------------------------------------------
  c.starved = {
    oxygen: met.oxygen < 0.999,
    water: met.water < 0.999,
    food: met.food < 0.999,
  };

  let healthDelta = 0;
  healthDelta -= (1 - met.oxygen) * HEALTH_LOSS_NO_O2 * sols;
  healthDelta -= (1 - met.water) * HEALTH_LOSS_NO_WATER * sols;
  healthDelta -= (1 - met.food) * HEALTH_LOSS_NO_FOOD * sols;
  if (healthDelta === 0) healthDelta = HEALTH_REGEN * sols;

  c.health = clamp(c.health + healthDelta, 0, 100);
  if (c.health <= 0) c.dead = true;

  return { met, reclaimed, healthDelta };
}

export function colonistStatusText(c: Colonist): string {
  if (c.dead) return 'Deceased';
  switch (c.activity) {
    case 'sheltered':
      return c.shelterId === 0 ? 'Sheltered — landing pod' : 'Sheltered';
    case 'walking':
      return 'On EVA — walking';
    case 'assisting':
      return 'On EVA — assisting construction';
    case 'returning':
      return 'Returning to shelter';
    case 'incapacitated':
      return 'Incapacitated';
  }
}

/** The most urgent unmet need, for alert copy. */
export function worstNeed(c: Colonist): FluidId | null {
  if (c.starved.oxygen) return 'oxygen';
  if (c.starved.water) return 'water';
  if (c.starved.food) return 'food';
  return null;
}

/**
 * Sols of life left in a pool at the current net drain rate.
 * `netPerSol` is negative when draining.
 */
export function solsRemaining(amount: number, netPerSol: number): number {
  if (netPerSol >= -1e-9) return Infinity;
  return amount / -netPerSol;
}

export { ALL_FLUIDS };
