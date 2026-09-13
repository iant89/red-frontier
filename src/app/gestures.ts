/**
 * Pointer gesture mapping for the camera (issue #1).
 *
 * The rules live here as pure functions rather than inline in `Game.pointerMove`
 * so they can be unit tested headlessly — there is no way to drive real touch
 * events in the node test harness, and the gesture map is exactly the part that
 * was wrong.
 *
 * ## The map
 *
 * | Input | Gesture |
 * |---|---|
 * | One finger (touch) | **Pan** — content tracks the finger 1:1 |
 * | Two fingers, one resting | **Orbit** — the travelling finger looks around |
 * | Two fingers, apart/together | **Dolly** (pinch zoom), always live |
 * | Mouse drag | Orbit (unchanged) |
 * | Shift-drag / middle-drag | Pan (unchanged) |
 *
 * Touch flips to pan-first because that is the primary way to move around on a
 * phone; the desktop map is deliberately left alone.
 */

/** Per-frame movement below this (px) is noise from a resting finger. */
export const STILL_EPS = 0.5;

/**
 * Accumulated travel (px) under which a finger counts as "resting" outright,
 * regardless of what the other finger is doing. Sized above typical capacitive
 * jitter so a planted thumb never starts an orbit on its own.
 */
export const REST_TRAVEL_PX = 8;

/**
 * A finger also counts as resting if it has travelled this fraction (or less)
 * of the other finger's travel — the "one finger down, one finger drags" shape
 * still reads correctly when the anchor slides a little.
 */
export const REST_RATIO = 0.35;

/**
 * When the pinch distance is changing this fast relative to the moving
 * finger's travel, the gesture is a zoom, not a look. Keeps a straight
 * pinch from also swinging the camera around.
 */
export const ZOOM_DOMINANCE = 0.8;

export type CameraGesture =
  | { kind: 'none' }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'orbit'; dx: number; dy: number };

/** One pointer's movement this frame, plus how far it has travelled overall. */
export interface PointerDelta {
  dx: number;
  dy: number;
  /** Accumulated travel since the two-finger gesture began. */
  travel: number;
}

/**
 * One pointer down. On touch this pans; on the mouse it orbits unless a pan
 * modifier (Shift, or the middle button) is held.
 */
export function singlePointerGesture(input: {
  touch: boolean;
  panModifier: boolean;
  dx: number;
  dy: number;
}): CameraGesture {
  const { touch, panModifier, dx, dy } = input;
  if (Math.abs(dx) < STILL_EPS && Math.abs(dy) < STILL_EPS) return { kind: 'none' };
  // Touch has no Shift key and no middle button, so the modifier path was
  // unreachable on a phone — that is why panning was impossible there.
  if (touch || panModifier) return { kind: 'pan', dx, dy };
  return { kind: 'orbit', dx, dy };
}

/** True when `rest` is holding still enough to be the anchor of a look gesture. */
export function isResting(rest: PointerDelta, mover: PointerDelta): boolean {
  if (rest.travel <= REST_TRAVEL_PX) return true;
  return rest.travel <= mover.travel * REST_RATIO;
}

export interface TwoPointerGesture {
  /** Multiplier for `CameraRig.dolly`; 1 means no zoom this frame. */
  dolly: number;
  /** Orbit delta in pixels, or null when this frame is not a look. */
  orbit: { dx: number; dy: number } | null;
}

/**
 * Two pointers down. Pinch always drives the dolly; an orbit is layered on top
 * only when one finger is resting and the other is genuinely travelling.
 *
 * Note there is deliberately **no** midpoint pan here. Welding pan to zoom was
 * the second half of issue #1: the two fought each other, so the net
 * translation came out far smaller than the finger travel suggested.
 */
export function twoPointerGesture(
  a: PointerDelta,
  b: PointerDelta,
  prevDist: number,
  dist: number,
): TwoPointerGesture {
  const dolly = prevDist > 0 ? prevDist / Math.max(1, dist) : 1;
  const out: TwoPointerGesture = { dolly, orbit: null };

  // The finger that has travelled further is the one doing the looking.
  const mover = a.travel >= b.travel ? a : b;
  const rest = mover === a ? b : a;
  if (!isResting(rest, mover)) return out;

  const moverMag = Math.hypot(mover.dx, mover.dy);
  if (moverMag < STILL_EPS) return out;

  // A straight pinch moves one finger a lot while changing the span just as
  // much — that is a zoom, and layering an orbit on it feels like a slip.
  const pinchMag = Math.abs(dist - prevDist);
  if (prevDist > 0 && pinchMag > moverMag * ZOOM_DOMINANCE) return out;

  out.orbit = { dx: mover.dx, dy: mover.dy };
  return out;
}
