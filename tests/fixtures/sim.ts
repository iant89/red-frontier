/**
 * Shared setup for the `tests/sim/*` suites.
 *
 * These are the helpers the single monolithic simulation suite used to keep
 * privately; every suite that places buildings or advances time borrows them,
 * so a fix to a helper lands everywhere at once.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import type { BuildingKind } from '../../src/sim/defs';
import { SOL_SECONDS } from '../../src/sim/config';

/** Nearest deposit of `res` with something left in it. */
export function nearDeposit(sim: Simulation, res: string) {
  return sim.world.deposits
    .filter((d) => d.resource === res && d.amount > 0)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
}

/** Advance `sols` of simulated time at the fixed step. */
export function run(sim: Simulation, sols: number): void {
  const ticks = Math.round(20 * SOL_SECONDS * sols);
  for (let i = 0; i < ticks; i++) sim.step(1 / 20);
}

/** First spot on a ring around the base where `kind` may legally be placed. */
export function findSpot(sim: Simulation, kind: BuildingKind): { x: number; z: number } {
  for (let r = 34; r <= 120; r += 3) {
    for (let a = 0; a < 360; a += 7) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      if (sim.canPlace(kind, x, z) === null) return { x, z };
    }
  }
  throw new Error(`no legal placement found for ${kind}`);
}

export function build(sim: Simulation, kind: BuildingKind) {
  const spot = findSpot(sim, kind);
  const b = sim.placeBuilding(kind, spot.x, spot.z);
  assert.ok(b, `${kind} placement failed`);
  return b!;
}

/** Place a building and fast-forward until it is online (or give up). */
export function buildAndWait(sim: Simulation, kind: BuildingKind, maxSols = 25) {
  const b = build(sim, kind);
  for (let i = 0; i < maxSols * 4; i++) {
    run(sim, 0.25);
    if (sim.buildingById(b.id)?.state === 'online') return b;
  }
  throw new Error(`${kind} never came online within ${maxSols} sols`);
}

/**
 * Place an already-online building for tests whose subject is not construction.
 * Keeping construction setup out of power, weather and persistence tests makes
 * those suites both faster and more isolated; sim/build still exercises the
 * complete live construction path through buildAndWait.
 */
export function buildOnline(sim: Simulation, kind: BuildingKind) {
  const b = build(sim, kind);
  assert.ok(sim.devCompleteBuilding(b.id), `${kind} could not be completed for setup`);
  return b;
}

/** The opening move most integration suites need: a working, stocked base. */
export function bootstrap(
  sim: Simulation,
  kinds: BuildingKind[] = ['warehouse', 'solar', 'battery', 'extractor', 'oxygenator'],
): void {
  for (const k of kinds) buildAndWait(sim, k);
}
