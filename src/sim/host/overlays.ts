/**
 * Runtime overlays: the named, *data-driven* edits that ride beside the sim and
 * are saved nowhere (TDD §22).
 *
 * An overlay used to be a closure the UI handed to the host — perfect in one
 * thread, impossible across two. So an overlay is now a **name plus a list of
 * entity ids**, and the behaviour lives here, on the sim side of the seam:
 *
 *   host.syncOverlays({ 'dev.batteryPins': [1000, 1004] })
 *
 * The same payload travels to a worker unchanged, and both hosts run the same
 * `runOverlays` after the same step, so "the panel's modifiers never reach the
 * save file" is a property of the *host* rather than of one implementation.
 *
 * Keeping the state plain data also means the UI can display it honestly: the
 * projected view echoes `pinnedRovers`, so the panel's checkbox reflects what
 * the world is doing rather than what the panel last asked for.
 */

import type { SimWritable } from './view';
import { ROVERS } from '../defs';

/** The name the developer panel's keep-battery-full pin registers under. */
export const BATTERY_PIN_OVERLAY = 'dev.batteryPins';

/** Overlay name → the entity ids it is currently gripping. */
export type OverlayState = Record<string, number[]>;

export const EMPTY_OVERLAYS: OverlayState = {};

/**
 * Keep the pinned rovers at a full charge.
 *
 * Idempotent on purpose: it runs after every step, and a rover that is already
 * full must not be touched (that would let the pin mask a battery bug and
 * generate a revival every tick). A stranded rover being force-fed is stood back
 * up honestly — cleared of its task, pointed home, told to recharge — because a
 * machine with a full pack has no reason to lie flat.
 */
function applyBatteryPins(sim: SimWritable, ids: readonly number[]): void {
  for (const id of ids) {
    const r = sim.rovers.find((rv) => rv.id === id);
    if (!r) continue;
    const def = ROVERS[r.kind];
    if (r.battery >= def.maxBatteryKWh) continue;
    r.battery = def.maxBatteryKWh;
    if (r.phase === 'disabled') {
      r.phase = 'idle';
      r.goal = 'idle';
      r.command = { type: 'idle' };
      r.pending = [];
      r.recharge = true; // limp home, normally
      r.statusText = 'Returning to charge';
    }
  }
}

type OverlayFn = (sim: SimWritable, ids: readonly number[]) => void;

/** The registry both hosts read from. A name with no entry is ignored, not fatal. */
const OVERLAYS: Record<string, OverlayFn> = {
  [BATTERY_PIN_OVERLAY]: applyBatteryPins,
};

/** Run every active overlay against the live world. Cheap when nothing is pinned. */
export function runOverlays(sim: SimWritable, state: OverlayState): void {
  for (const name of Object.keys(state)) {
    const fn = OVERLAYS[name];
    const ids = state[name];
    if (fn && ids.length > 0) fn(sim, ids);
  }
}
