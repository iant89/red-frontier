/**
 * Phase 2/6 — Power state.
 *
 * Owns grid storage state: the initial (pod-only) power result and the
 * battery capacity implied by the colony's current buildings. The behavior
 * that drives the grid lives in `sim/systems/PowerSystem.ts` (Phase 6); the
 * pure resolver it delegates to lives in `sim/power.ts`.
 */

import { idlePower } from '../power';
import { POD_BATTERY_KWH, devLevelMul } from '../config';
import { BUILDINGS } from '../defs';
import type { ColonyState } from './ColonyState';

export type { PowerResult } from '../power';

/** The pod's own grid at game start: RTG-sized buffer, three-fifths full. */
export function initialPowerState() {
  return idlePower(POD_BATTERY_KWH, POD_BATTERY_KWH * 0.6);
}

/**
 * Total battery capacity: the landing pod's pack plus every online, enabled,
 * undamaged battery building (upgrades scale theirs by level).
 */
export function batteryCapacityKWh(state: ColonyState): number {
  let cap = POD_BATTERY_KWH;
  for (const b of state.buildings) {
    if (b.state === 'online' && !b.damaged && b.enabled) {
      cap += BUILDINGS[b.kind].batteryKWh * devLevelMul(b.level);
    }
  }
  return cap;
}
