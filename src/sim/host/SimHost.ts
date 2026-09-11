/**
 * The host: the only thing the presentation layers are allowed to hold.
 *
 * `app/`, `ui/`, `render/` and `dev/` used to hold a `Simulation` and do with it
 * as they pleased — step it, mutate it, read it at whatever rate suited them.
 * `SimHost` is the seam that replaces that: a read model in, a command stream
 * out, and the tick loop owned by whoever implements the interface.
 *
 * Only {@link LocalSimHost} exists today. That is deliberate: the extraction is
 * worth landing on its own, because it converts "the sim is decoupled" from an
 * aspiration in a README into a type the compiler enforces. A `WorkerSimHost`
 * then implements this same interface by moving `step()` into a timer inside the
 * worker and turning `send()` into `postMessage`, and nothing downstream of that
 * change needs to know it happened.
 */

import type { SimAck, SimCommand } from './protocol';
import type { SimSnapshot, SimView, SimWritable } from './view';
import type { SimLogEvent } from './view';

/**
 * A runtime overlay: code that edits live state every step, from outside the
 * sim, and is therefore saved nowhere. Developer mode's keep-battery-full pin is
 * the only one today (TDD §22), and the contract it depends on — "the panel's
 * modifiers never reach the save file" — is kept by the fact that overlays are
 * registered on the *host*, never stored in the world.
 *
 * The point of routing overlays through the host rather than a per-frame call in
 * `Game.loop` is that a worker host runs the same overlay *inside the worker*,
 * right after each tick. Overlay code must therefore be DOM-free and importable
 * from a sim context; {@link SimWritable} is what enforces that it cannot reach
 * for anything else.
 */
export interface SimOverlay {
  readonly name: string;
  afterStep(sim: SimWritable): void;
}

/** How the host reaches the sim — surfaced so UI can be honest about latency. */
export type SimTransport = 'in-process' | 'worker';

export interface SimHost {
  /** The read model. Valid until the next step; never a live handle's twin. */
  readonly view: SimView;

  /** Whether state is on this thread (`in-process`) or behind a port. */
  readonly transport: SimTransport;

  /**
   * Advance the world by `frameDt` game seconds. An in-process host runs the
   * fixed substeps here; a worker host ignores this call because its own timer
   * drives the tick, and the render loop merely asks for the newest view.
   */
  step(frameDt: number): void;

  /** Fire-and-forget intent. The common case: orders, toggles, spawns. */
  send(command: SimCommand): void;

  /**
   * Intent whose result the caller needs *now* — a fabricated entity's id, the
   * level an upgrade landed on. An in-process host answers from the sim
   * directly; a worker host must answer optimistically from its mirrored view
   * and let the next snapshot correct it. Kept separate from `send` so the
   * places that genuinely depend on a reply stay few and visible.
   */
  request(command: SimCommand): SimAck;

  /**
   * Take the log lines produced since the last call. A read that consumes, so
   * it belongs to the host rather than the view.
   */
  drainEvents(): SimLogEvent[];

  /** Register an overlay; re-registering the same name replaces it. */
  attachOverlay(overlay: SimOverlay): void;
  detachOverlay(name: string): void;

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
