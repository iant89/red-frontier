/**
 * The sim side of the wire: everything that runs *inside* the worker.
 *
 * It is a function, not a class that knows about `self`, for a selfish reason —
 * a `WorkerGlobalScope` cannot be constructed in a test. `createSimRuntime(send)`
 * returns something that turns messages into work, and `sim.worker.ts` is the
 * five lines that bolt it to a real worker. The suite drives the identical code
 * through an in-process port, so the protocol, the projection and the overlay
 * registry are all covered without a browser.
 *
 * The order of operations in `advance` is the whole point:
 *
 *   step → overlays → drain events → project
 *
 * Overlays run *after* the tick (so a pinned battery wins over the drain that
 * just happened) and *before* the projection (so the view shows the grip rather
 * than the pre-overlay number). Events are drained last-but-one, because a
 * refusal the overlay caused should be in the same payload as its consequence.
 */

import { Simulation } from '../Simulation';
import { applyCommand } from './applyCommand';
import { decodeCommand } from './protocol';
import { projectView } from './projection';
import { runOverlays, type OverlayState } from './overlays';
import type { HostReply, HostRequest } from './messages';

export interface SimRuntime {
  handle(message: HostRequest): void;
}

export function createSimRuntime(send: (reply: HostReply) => void): SimRuntime {
  let sim: Simulation | null = null;
  let overlays: OverlayState = {};

  /**
   * The colony, or a message-shaped error — never an unhandled throw.
   *
   * `requestId` is forwarded so the client can reject *the waiter that asked*
   * rather than whichever promise happens to be pending; a transaction with no
   * answer is a loading screen that never finishes.
   */
  function world(requestId: number | null = null): Simulation | null {
    if (sim) return sim;
    send({
      kind: 'error',
      id: requestId,
      error: 'no colony is running in this worker yet',
    });
    return null;
  }

  function terrainOf(s: Simulation) {
    return { seed: s.world.seed, worldHalf: s.world.half, region: s.world.region };
  }

  /** Step the clock, hold the grips, report. The one path to a new view. */
  function advance(dt: number): void {
    const s = sim;
    if (!s) return;
    s.step(dt);
    runOverlays(s, overlays);
    const events = s.drainEvents();
    send({ kind: 'view', view: projectView(s, 'worker', overlays, events) });
  }

  return {
    handle(message: HostRequest): void {
      try {
        switch (message.kind) {
          case 'boot': {
            const { params } = message;
            sim = new Simulation({
              seed: params.seed,
              difficulty: params.difficulty,
              worldHalf: params.worldHalf,
              region: params.region,
              worldOptions: params.worldOptions,
            });
            const s = sim;
            send({
              kind: 'ready',
              id: message.id,
              terrain: terrainOf(s),
              view: projectView(s, 'worker', overlays, s.drainEvents()),
            });
            return;
          }
          case 'restore': {
            // Same order `Game.loadSave` always used: a seeded world to stand on,
            // then the payload overwrites the state. The world the mirror rebuilds
            // must be the one the *save* implies, hence `terrainOf` after restore.
            const seed = (message.snapshot as { seed?: number })?.seed ?? 1;
            const s = new Simulation({ seed });
            s.restore(message.snapshot);
            sim = s;
            send({
              kind: 'ready',
              id: message.id,
              terrain: terrainOf(s),
              view: projectView(s, 'worker', overlays, s.drainEvents()),
            });
            return;
          }
          case 'advance':
            // Ignored when there is no world yet, on purpose. `advance` is pumped
            // every frame, so complaining about one would turn a startup race into
            // a console per second; nothing is lost, because the next advance after
            // boot carries the time anyway. Commands and transactions do answer:
            // a `command` here means a client posted intent before the handshake
            // finished, which cannot be absorbed by waiting, and a promise nobody
            // settles is worse than a slow one.
            advance(message.dt);
            return;
          case 'command': {
            const s = world();
            if (!s) return;
            for (const raw of message.commands) {
              const decoded = decodeCommand(raw);
              if (!decoded.ok) {
                // Same rule as the in-process host: a malformed command is a bug
                // at the call site, so it is shouted about and otherwise ignored.
                console.error(`[sim:worker] ${decoded.error}`, raw);
                continue;
              }
              applyCommand(s, decoded.command);
            }
            return;
          }
          case 'overlays':
            overlays = message.state;
            // Apply at once, so a pin does not have to wait for the next tick to
            // take effect on a paused or slow frame.
            if (sim) runOverlays(sim, overlays);
            return;
          case 'snapshot': {
            const s = world(message.id);
            if (!s) return;
            send({ kind: 'snapshot', id: message.id, snapshot: s.snapshot() });
            return;
          }
          case 'load': {
            const s = world(message.id);
            if (!s) return;
            s.restore(message.snapshot);
            send({
              kind: 'loaded',
              id: message.id,
              view: projectView(s, 'worker', overlays, s.drainEvents()),
            });
            return;
          }
        }
      } catch (err) {
        // A worker that throws loudly dies quietly, with no stack in the caller.
        // Anything unexpected therefore comes back as a message naming it.
        send({ kind: 'error', id: null, error: err instanceof Error ? err.stack ?? err.message : String(err) });
      }
    },
  };
}
