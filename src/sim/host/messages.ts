/**
 * The wire: what crosses between the client and a sim host, in both directions.
 *
 * Two rules, both borrowed from TDD §16:
 *
 *  - **Everything here is clonable.** No functions, no class instances, no
 *    cycles. `OverlayState` is the reason overlays became data instead of
 *    closures, and `ViewPayload` is the reason entities are spread rather than
 *    passed. If a type here ever needs a method, it is the boundary telling us
 *    something on the wrong side.
 *  - **Requests carry ids, fire-and-forget does not.** `advance`, `command` and
 *    `overlays` are one-way: the client never waits for them (see
 *    `WorkerSimHost.step`'s backpressure). `boot`, `restore`, `snapshot` and
 *    `load` are transactions, so they get an id and a matching reply.
 *
 * Errors come back as a `kind: 'error'` reply rather than as a thrown exception,
 * because an exception in a worker has no stack that reaches the caller and no
 * caller to catch it.
 */

import type { SimCommand } from './protocol';
import type { OverlayState } from './overlays';
import type { ViewPayload } from './projection';
import type { SimBootParams, SimSnapshot } from './view';
import type { TerrainParams } from './mirror';

/** Client → sim host. */
export type HostRequest =
  | { kind: 'boot'; id: number; params: SimBootParams }
  | { kind: 'restore'; id: number; snapshot: SimSnapshot }
  /**
   * Run the world forward, then report. The client pumps this from its frame
   * loop so the *renderer* sets the pace; the sim never runs ahead of the view
   * the UI is drawing, which is what keeps the two in step without any
   * interpolation logic.
   */
  | { kind: 'advance'; dt: number }
  /** Applied immediately, no reply: orders must not wait for the next frame. */
  | { kind: 'command'; commands: SimCommand[] }
  | { kind: 'placement'; id: number; command: Extract<SimCommand, { type: 'building/place' }> }
  | { kind: 'overlays'; state: OverlayState }
  | { kind: 'snapshot'; id: number }
  | { kind: 'load'; id: number; snapshot: SimSnapshot };

/** Sim host → client. */
export type HostReply =
  | { kind: 'ready'; id: number; view: ViewPayload; terrain: TerrainParams }
  | { kind: 'view'; view: ViewPayload }
  | { kind: 'loaded'; id: number; view: ViewPayload }
  | { kind: 'snapshot'; id: number; snapshot: SimSnapshot }
  | { kind: 'placement'; id: number; ack: import('./protocol').SimAck }
  | { kind: 'error'; id: number | null; error: string };

/** The minimum a worker object must do for us; also what a test fake provides. */
export interface HostPort {
  postMessage(message: HostRequest): void;
  set onmessage(handler: ((message: { data: HostReply }) => void) | null);
  addEventListener?(type: 'message', listener: (event: { data: HostReply }) => void): void;
  terminate?(): void;
}
