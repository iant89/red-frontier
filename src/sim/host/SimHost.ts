/**
 * The host: the only thing the presentation layers are allowed to hold.
 *
 * `app/`, `ui/`, `render/` and `dev/` used to hold a `Simulation` and do with it
 * as they pleased — step it, mutate it, read it at whatever rate suited them.
 * `SimHost` is the seam that replaces that: a read model in, a command stream
 * out, and the tick loop owned by whoever implements the interface.
 *
 * Both {@link LocalSimHost} and {@link WorkerSimHost} implement it, and neither is
 * special-cased by the callers below. That is the payoff of the extraction: it
 * converted "the sim is decoupled" from an aspiration in a README into a type the
 * compiler enforces, and the worker host then only had to *implement* something
 * that was already the only door.
 *
 * What the interface deliberately refuses to be: synchronous about state that
 * lives on the other side of a port. `request` is the one place a caller may want
 * an answer before a frame, and it is documented as optimistic there; `canPlace`
 * is not on this interface at all, because a placement preview cannot wait for a
 * round trip — it is served by the mirrored view running the same rule locally.
 */

import type { SimAck, SimCommand } from './protocol';
import type { SimSnapshot, SimView, SimLogEvent } from './view';
import type { OverlayState } from './overlays';

/** How the host reaches the sim — surfaced so UI can be honest about latency. */
export type SimTransport = 'in-process' | 'worker';

export interface SimHost {
  /** The read model. Valid until the next step; never a live handle's twin. */
  readonly view: SimView;

  /** Whether state is on this thread (`in-process`) or behind a port. */
  readonly transport: SimTransport;

  /**
   * Advance the world by `frameDt` game seconds. An in-process host runs the
   * fixed substeps here and the view is already current on return; a worker host
   * posts the advance and reports back when it lands, so its view is one round
   * trip behind. Neither runs the world on its own clock while the tab is
   * backgrounded, because the *frame loop* is what asks for time.
   */
  step(frameDt: number): void;

  /** Fire-and-forget intent. The common case: orders, toggles, spawns. */
  send(command: SimCommand): void;

  /**
   * Intent whose result the caller needs *now* — a fabricated entity's id, the
   * level an upgrade landed on. An in-process host answers from the sim directly;
   * a worker host answers optimistically from the ids the sim has announced and
   * lets the next payload correct it. Kept separate from `send` so the places
   * that genuinely depend on a reply stay few and visible — and so a refusal
   * across a port can only ever be a no-op, never a lie about the world.
   */
  request(command: SimCommand): SimAck;

  /** Ask the authoritative sim to validate and place a building. */
  requestPlacement(command: Extract<SimCommand, { type: 'building/place' }>): Promise<SimAck>;

  /**
   * Take the log lines produced since the last call. A read that consumes, so
   * it belongs to the host rather than the view.
   */
  drainEvents(): SimLogEvent[];

  /**
   * Publish the runtime overlays to apply after every step. An overlay edits live
   * state from outside the sim and is therefore saved nowhere — developer mode's
   * keep-battery-full pin is the only one today (TDD §22), and "never reaches
   * the save file" is a property of *this* call: the grips are held on the host,
   * and a snapshot is taken from the world without them.
   *
   * State rather than code, because a worker cannot accept a closure. The names
   * and their behaviour live on the sim side (`host/overlays.ts`); a name with no
   * implementation is ignored, so an older worker never throws at a newer panel.
   */
  syncOverlays(state: OverlayState): void;

  /**
   * Serialize the colony, and restore one. Asynchronous by contract: the whole
   * point of the worker migration includes getting a colony-sized
   * `JSON.stringify` off the UI thread (TDD §15, §20's save budget).
   */
  requestSnapshot(): Promise<SimSnapshot>;
  loadSnapshot(snapshot: SimSnapshot): Promise<void>;

  /** Tear the world down and stop every source of work with it. */
  dispose(): void;
}
