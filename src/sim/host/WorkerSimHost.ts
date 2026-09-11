/**
 * The worker host: the same `SimHost` contract, served from another thread.
 *
 * Three decisions carry the design, and each exists because the obvious
 * alternative is worse:
 *
 *  **The client pumps the clock.** `step(dt)` posts `advance{dt}` rather than the
 *  worker running its own `setInterval`. A timer in a background tab is throttled
 *  to roughly one tick a second, so a self-driving worker means the colony races
 *  ahead while hidden and the tab is punished for it; a client-driven clock means
 *  world and picture advance together. It also buys "the sim never runs ahead of
 *  the view being drawn" for free — no interpolation, no second clock to
 *  reconcile, and the fixed-substep contract inside `Simulation.step` is untouched.
 *
 *  **Backpressure, by accumulation.** If a payload is still in flight, the next
 *  `step` does not post: it adds to a pending total, and the following advance
 *  carries both. A stutter therefore delivers one bigger tick instead of a queue
 *  of them, which is what `Simulation`'s substep cap already assumes. Dropping
 *  the time would be a game that quietly pauses; queueing it would be a game that
 *  catches up in a burst.
 *
 *  **`request` is optimistic.** The callers that need an answer before the next
 *  frame want an *id* or a *number*, and both are predictable from the last
 *  payload. A wrong guess is survivable by construction — `Game` already clears a
 *  selection whose entity is missing, so a refused placement reads as a flicker
 *  rather than a desync, and the next payload rebases the counter.
 */

import type { SimAck, SimCommand } from './protocol';
import { ColonyMirror } from './mirror';
import type { HostPort, HostReply, HostRequest } from './messages';
import type { ViewPayload } from './projection';
import type { OverlayState } from './overlays';
import type { SimHost, SimTransport } from './SimHost';
import type { SimBootParams, SimLogEvent, SimSnapshot, SimView } from './view';

export interface WorkerInit {
  /** Exactly one of these: a fresh colony, or one being resumed. */
  boot?: SimBootParams;
  restore?: SimSnapshot;
}

export class WorkerSimHost implements SimHost {
  readonly transport: SimTransport = 'worker';

  private readonly port: HostPort;
  private readonly mirror: ColonyMirror;
  private disposed = false;

  /** Clock time owed to the worker that has not been posted yet. */
  private pendingDt = 0;
  private advanceInFlight = false;

  /** The id the sim will hand out next, advanced by our own optimistic guesses. */
  private nextId = 0;

  private seq = 1;
  /**
   * Transactions awaiting a reply. One map, because a snapshot and a load differ
   * only in what they hand back, and `fulfill` receives the whole reply: a second
   * map of resolvers would exist purely to work around a waiter shape too narrow
   * to carry its own answer.
   */
  private readonly waiting = new Map<number, { fulfill: (reply: HostReply) => void; reject: (e: Error) => void }>();

  private constructor(port: HostPort, mirror: ColonyMirror, first: ViewPayload) {
    this.port = port;
    this.mirror = mirror;
    this.nextId = first.nextId;
    port.onmessage = (event) => this.receive(event.data);
  }

  /**
   * Handshake: boot the world inside the worker, wait for it to name its own
   * terrain, then build the mirror. The mirror's `World` is generated from the
   * *sim's* numbers rather than the boot params, because a restored save rebuilds
   * the world from the save — a client that guessed would render a planet the
   * colony is not standing on.
   */
  static connect(port: HostPort, init: WorkerInit): Promise<WorkerSimHost> {
    const id = 1;
    const request: HostRequest = init.boot
      ? { kind: 'boot', id, params: init.boot }
      : { kind: 'restore', id, snapshot: init.restore as SimSnapshot };
    return new Promise<WorkerSimHost>((resolve, reject) => {
      port.onmessage = (event) => {
        const reply = event.data;
        if (reply.kind === 'error') {
          port.onmessage = null;
          reject(new Error(reply.error));
          return;
        }
        if (reply.kind !== 'ready' || reply.id !== id) return;
        port.onmessage = null; // the constructor installs the real handler
        try {
          resolve(new WorkerSimHost(port, new ColonyMirror(reply.terrain, reply.view), reply.view));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      port.postMessage(request);
    });
  }

  get view(): SimView {
    return this.mirror;
  }

  // ------------------------------------------------------------- stepping ----

  /**
   * Ask the world for `frameDt` seconds. When the host is not mid-advance this is
   * a post; when it is, the time is banked. Note that `step(0)` posts nothing —
   * an in-process host runs its overlays on a zero-length step, and the worker
   * gets the same result a different way: `syncOverlays` applies the grips the
   * moment they change, so a pin toggled while paused takes effect immediately.
   */
  step(frameDt: number): void {
    if (this.disposed || frameDt <= 0) return;
    this.pendingDt += frameDt;
    this.pump();
  }

  private pump(): void {
    if (this.advanceInFlight || this.pendingDt <= 0) return;
    const dt = this.pendingDt;
    this.pendingDt = 0;
    this.advanceInFlight = true;
    this.post({ kind: 'advance', dt });
  }

  // -------------------------------------------------------------- writing ----

  send(command: SimCommand): void {
    if (this.disposed) return;
    this.post({ kind: 'command', commands: [command] });
  }

  /**
   * The optimistic half of the protocol. The `case` list *is* the contract: these
   * are the commands whose ack anyone reads, which is why it is four id
   * allocations and two echoes, and nothing else.
   */
  request(command: SimCommand): SimAck {
    this.send(command);
    switch (command.type) {
      case 'building/place':
      case 'dev/spawn/rover':
      case 'dev/spawn/building':
      case 'dev/spawn/deposit':
        return { ok: true, entityId: this.nextId++ };
      case 'dev/building/level':
        return { ok: true, value: command.level };
      case 'dev/rover/cargo':
        return { ok: true, value: command.kg };
      default:
        return { ok: true };
    }
  }

  requestPlacement(command: Extract<SimCommand, { type: 'building/place' }>): Promise<SimAck> {
    if (this.disposed) return Promise.reject(new Error('the colony has shut down'));
    const id = this.seq++;
    return new Promise<SimAck>((resolve, reject) => {
      this.waiting.set(id, {
        fulfill: (reply) => {
          if (reply.kind === 'placement') resolve(reply.ack);
          else reject(new Error(`the sim answered a placement request with a ${reply.kind}`));
        },
        reject,
      });
      this.post({ kind: 'placement', id, command });
    }).finally(() => this.waiting.delete(id));
  }

  /** The mirror's log ring is the client-side half of the bus; the sim drains
   *  per advance, so this cannot lose or repeat a line. */
  drainEvents(): SimLogEvent[] {
    return this.mirror.drainUnread();
  }

  syncOverlays(state: OverlayState): void {
    // Posted, not remembered: the world holds the grips, and it applies them the
    // moment they arrive — which is why a pin toggled while paused takes effect
    // without waiting for a tick the client would have to fake.
    this.post({ kind: 'overlays', state });
  }

  // ----------------------------------------------------------- snapshots ----

  /**
   * The one place the boundary shows: serialising a colony is a few hundred KB of
   * JSON, and asking for it returns a promise instead of freezing a frame.
   */
  requestSnapshot(): Promise<SimSnapshot> {
    if (this.disposed) return Promise.reject(new Error('the colony has shut down'));
    const id = this.seq++;
    return new Promise<SimSnapshot>((resolve, reject) => {
      this.waiting.set(id, {
        fulfill: (reply) => {
          // Never throw from a message handler: an exception here escapes into the
          // worker's own error event, where no caller is left to catch it.
          if (reply.kind === 'snapshot') resolve(reply.snapshot);
          else reject(new Error(`the sim answered a snapshot request with a ${reply.kind}`));
        },
        reject,
      });
      this.post({ kind: 'snapshot', id });
    }).finally(() => this.waiting.delete(id));
  }

  loadSnapshot(snapshot: SimSnapshot): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('the colony has shut down'));
    const id = this.seq++;
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(id, { fulfill: () => resolve(), reject });
      this.post({ kind: 'load', id, snapshot });
    }).finally(() => this.waiting.delete(id));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.onmessage = null;
    this.port.terminate?.();
    const error = new Error('the colony has shut down');
    for (const { reject } of this.waiting.values()) reject(error);
    this.waiting.clear();
  }

  // --------------------------------------------------------------- wire ----

  private post(message: HostRequest): void {
    if (this.disposed) return;
    this.port.postMessage(message);
  }

  private receive(reply: HostReply): void {
    switch (reply.kind) {
      case 'view':
        this.loadView(reply.view);
        return;
      case 'loaded':
        this.loadView(reply.view);
        this.settle(reply.id, reply);
        return;
      case 'snapshot':
      case 'placement':
        this.settle(reply.id, reply);
        return;
      case 'error':
        // The runtime already logs the sim's own refusals as events; anything
        // arriving here is a defect, and saying so is all a host can usefully do.
        console.error('[sim:worker]', reply.error);
        if (reply.id !== null) this.fail(reply.id, new Error(reply.error));
        return;
      case 'ready':
        return;
    }
  }

  private loadView(payload: ViewPayload): void {
    this.mirror.apply(payload);
    // Rebase, never advance: the sim owns the counter, and a pin from an earlier
    // guess that never landed is corrected here rather than defended.
    this.nextId = payload.nextId;
    this.advanceInFlight = false;
    if (this.pendingDt > 0) this.pump();
  }

  private settle(id: number, reply: HostReply): void {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    waiter.fulfill(reply);
  }

  private fail(id: number, error: Error): void {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    waiter.reject(error);
  }
}
