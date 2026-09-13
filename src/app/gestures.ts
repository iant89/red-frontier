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
 * | Two fingers, apart/together | **Dolly** (pinch zoom) |
 * | Mouse drag | Orbit (unchanged) |
 * | Shift-drag / middle-drag | Pan (unchanged) |
 *
 * A two-finger frame is either a zoom or a look, never both: classifying on
 * accumulated travel keeps a look's incidental span drift from zooming the
 * camera, and a pinch's finger travel from swinging it around.
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
 * When the span has drifted this far relative to the moving finger's
 * ACCUMULATED travel, the gesture is a zoom, not a look. Accumulated totals
 * keep their ratio at any event rate (a slow pinch is a quarter-pixel per
 * event at 120 Hz, so per-frame deltas cannot classify it), and the geometry
 * separates the two: a look drifts the span second-order (travel² / span)
 * while a pinch moves it first-order (≈ the finger travel, twice that for a
 * symmetric pinch). Keeps a straight pinch from swinging the camera — and a
 * look from zooming it.
 */
export const ZOOM_DOMINANCE = 0.8;

/**
 * Span drift (px) under which a two-finger gesture is never a pinch, whatever
 * the ratio. A resting thumb breathes a pixel or two against the glass, and
 * that wobble is radially shaped — without a floor it reads as a slow
 * one-sided pinch and the camera gains a random zoom walk over a long look.
 * Two pixels of span is ~1% of zoom, so a genuine pinch crosses it in its
 * first instants and loses nothing noticeable.
 */
export const PINCH_MIN_PX = 2;

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
 * Two pointers down. Each frame is either a zoom or a look, never both.
 *
 * `startDist` is the finger span when the two-finger gesture began; the pinch
 * test compares the span's drift from it against the mover's accumulated
 * travel (see ZOOM_DOMINANCE). Once a frame classifies as a pinch its dolly
 * applies with no per-event floor, so slow pinches survive high event rates;
 * once it classifies as a look the dolly stays shut at exactly 1, so a look
 * never breathes the zoom no matter how the span wobbles.
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
  startDist: number,
): TwoPointerGesture {
  const out: TwoPointerGesture = { dolly: 1, orbit: null };

  // The finger that has travelled further is the one doing the looking.
  const mover = a.travel >= b.travel ? a : b;
  const rest = mover === a ? b : a;

  const spanDrift = Math.abs(dist - startDist);
  if (spanDrift > PINCH_MIN_PX && spanDrift > mover.travel * ZOOM_DOMINANCE) {
    out.dolly = prevDist > 0 ? prevDist / Math.max(1, dist) : 1;
    return out;
  }

  if (!isResting(rest, mover)) return out;

  const moverMag = Math.hypot(mover.dx, mover.dy);
  if (moverMag < STILL_EPS) return out;

  out.orbit = { dx: mover.dx, dy: mover.dy };
  return out;
}
