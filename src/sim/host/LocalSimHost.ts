/**
 * The in-process host: today's behaviour, behind tomorrow's interface.
 *
 * It owns a `Simulation`, applies commands to it synchronously, runs overlays
 * after every step, and hands the live sim out as the view. That last part is
 * intentionally zero-copy — this class buys no performance, only the seam. Its
 * job is to prove the contract is *sufficient*: if every gesture and every panel
 * edit can be expressed as a command on this object, then a worker holding the
 * same object can serve the same UI with no other code changing.
 *
 * Acks are synchronous here. That is a property of this class, not of
 * {@link SimHost}, and the only reason callers can still be written the way they
 * were is that a round trip in-process is free.
 */

import { Simulation } from '../Simulation';
import type { SimAck, SimCommand } from './protocol';
import { decodeCommand } from './protocol';
import { applyCommand } from './applyCommand';
import type { SimHost } from './SimHost';
import { runOverlays, type OverlayState } from './overlays';
import type { SimBootParams, SimLogEvent, SimSnapshot, SimView } from './view';

export class LocalSimHost implements SimHost {
  readonly transport = 'in-process' as const;

  private readonly sim: Simulation;
  private overlays: OverlayState = {};
  private disposed = false;

  constructor(sim: Simulation) {
    this.sim = sim;
  }

  /**
   * The live sim *is* the view — same object, narrower type. No copies, no
   * staleness, and a main-thread read costs exactly what it used to.
   */
  get view(): SimView {
    return this.sim;
  }

  step(frameDt: number): void {
    if (this.disposed) return;
    this.sim.step(frameDt);
    // Overlays ride the same cadence they always did — once per delivered
    // frame, so a pinned battery keeps its grip while the world runs. Identical
    // code to the worker's, which is the entire reason they are functions here.
    runOverlays(this.sim, this.overlays);
  }

  send(command: SimCommand): void {
    this.dispatch(command);
  }

  request(command: SimCommand): SimAck {
    return this.dispatch(command);
  }

  drainEvents(): SimLogEvent[] {
    return this.sim.drainEvents();
  }

  syncOverlays(state: OverlayState): void {
    this.overlays = state;
  }

  async requestSnapshot(): Promise<SimSnapshot> {
    return this.sim.snapshot();
  }

  async loadSnapshot(snapshot: SimSnapshot): Promise<void> {
    this.sim.restore(snapshot);
  }

  dispose(): void {
    this.disposed = true;
    this.overlays = {};
  }

  /** The one place the protocol's runtime gate runs, for every host flavour. */
  private dispatch(command: SimCommand): SimAck {
    if (this.disposed) return { ok: false, error: 'the colony has shut down' };
    const decoded = decodeCommand(command);
    if (!decoded.ok) {
      // A malformed command is a bug at the call site, never a game event: the
      // colony must not change shape because a panel sent the wrong thing.
      console.error(`[sim:host] ${decoded.error}`, command);
      return { ok: false, error: decoded.error };
    }
    return applyCommand(this.sim, decoded.command);
  }
}

/** Boot a fresh colony behind a host (the wizard's "begin"). */
export function createLocalHost(params: SimBootParams): LocalSimHost {
  return new LocalSimHost(
    new Simulation({
      seed: params.seed,
      difficulty: params.difficulty,
      worldHalf: params.worldHalf,
      region: params.region,
      worldOptions: params.worldOptions,
    }),
  );
}

/**
 * Bring a saved colony back behind a host. The seed in the payload rebuilds the
 * world before `restore` overwrites it — the same order `Game.loadSave` used,
 * kept here so the boot sequence has one shape whether it starts fresh or not.
 */
export function restoreLocalHost(snapshot: SimSnapshot, fallbackSeed = 1): LocalSimHost {
  const seed = (snapshot as { seed?: number })?.seed ?? fallbackSeed;
  const sim = new Simulation({ seed });
  sim.restore(snapshot);
  return new LocalSimHost(sim);
}
