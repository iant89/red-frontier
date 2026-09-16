/**
 * Phase 2 — Power state placeholder.
 * Currently PowerResult lives in sim/power.ts; this module will own
 * grid storage and capacity in future phases.
 * For Phase 2 it re-exports the result type and provides a tiny helper.
 */

export type { PowerResult } from '../power';
import { idlePower } from '../power';
import { POD_BATTERY_KWH } from '../config';

export function initialPowerState() {
  return idlePower(POD_BATTERY_KWH, POD_BATTERY_KWH * 0.6);
}
