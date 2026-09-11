/**
 * The two rules the read model has to be able to answer on its own, extracted
 * from `Simulation` so they can be *shared* rather than duplicated.
 *
 * The build ghost needs an answer on every mouse move, which a worker cannot
 * supply over a round trip. The answer is therefore computed on both sides by
 * this one function: the simulation calls it with its live world, and the
 * mirror calls it with a seeded terrain clone plus the projected obstacle
 * lists. Same code, so the ghost can never disagree with the sim about what a
 * slope cap or a clearance margin means — the two sides differ only in how
 * fresh their inputs are, which is a one-tick lag, not a different rule.
 *
 * Everything here is pure: no RNG, no clock, no mutation. That is what makes it
 * safe to run on the wrong side of the boundary.
 */

import type { BuildingKind } from './defs';
import { BUILDINGS } from './defs';
import { BUILDING_MAX_HEALTH, POD_RADIUS, SPAWN_X, SPAWN_Z } from './config';

/** The terrain questions `evaluateSite` asks. `World` answers them directly. */
export interface SitingGround {
  inBounds(x: number, z: number): boolean;
  canDrive(x: number, z: number): boolean;
  canBuild(x: number, z: number): boolean;
  slopeAt(x: number, z: number): number;
}

export interface SitingInput {
  ground: SitingGround;
  /** Only position and kind matter to the rule. */
  buildings: Array<{ kind: BuildingKind; x: number; z: number }>;
  /** Spent seams do not block a foundation, so `amount` is carried along. */
  deposits: Array<{ x: number; z: number; radius: number; amount: number }>;
}

/** Slope cap: a pressurised volume needs flatter ground than an open array. */
const SLOPE_PRESSURIZED = 0.15;
const SLOPE_OPEN = 0.24;

/**
 * Returns `null` when the site is legal, otherwise the reason it is not — the
 * same strings the build ghost shows, because there is exactly one producer of
 * them.
 */
export function evaluateSite(
  kind: BuildingKind,
  x: number,
  z: number,
  ctx: SitingInput,
): string | null {
  if (!ctx.ground.inBounds(x, z)) return 'Outside the playable region.';
  const def = BUILDINGS[kind];
  if (!ctx.ground.canDrive(x, z)) return 'No safe approach — drop-off or unreachable.';
  const slope = ctx.ground.slopeAt(x, z);
  const maxSlope = def.pressurized ? SLOPE_PRESSURIZED : SLOPE_OPEN;
  if (slope > maxSlope || !ctx.ground.canBuild(x, z)) return 'Terrain too steep here.';
  if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < def.radius + POD_RADIUS + 1.5)
    return 'Too close to the landing pod.';
  for (const b of ctx.buildings) {
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < def.radius + BUILDINGS[b.kind].radius + 1.5)
      return 'Too close to an existing structure.';
  }
  for (const dep of ctx.deposits) {
    if (dep.amount <= 0) continue;
    if (Math.hypot(dep.x - x, dep.z - z) < dep.radius + def.radius + 2)
      return 'Cannot build on a resource deposit.';
  }
  return null;
}

/**
 * What a rover should be sent to do with a structure, or `null` for nothing.
 *
 * Same reasoning as `evaluateSite`: the tap handler asks this question before it
 * has any answer from the simulation, so the mirror has to be able to ask it
 * too — and a second copy of "how dirty is too dirty" is exactly the kind of
 * rule that quietly disagrees across a boundary.
 */
export function maintenanceNeed(
  b: { state: string; health: number; cleanliness: number; kind: BuildingKind } | undefined,
): 'repair' | 'clean' | null {
  if (!b || b.state !== 'online') return null;
  if (b.health < BUILDING_MAX_HEALTH - 0.5) return 'repair';
  if (BUILDINGS[b.kind].generation === 'solar' && b.cleanliness < 0.995) return 'clean';
  return null;
}
