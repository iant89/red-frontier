/**
 * The in-process host: today's behaviour, behind tomorrow's interface.
 *
 * It owns a `Simulation`, applies commands to it synchronously, runs overlays
 * after every step, and hands out a **projected** SimView via ColonyMirror —
 * the same immutable presentation surface WorkerSimHost serves. Presentation
 * never receives the live Simulation object (Phase 20).
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
import { ColonyMirror } from './mirror';
import { projectView } from './projection';
import type { SimBootParams, SimLogEvent, SimSnapshot, SimView } from './view';
import type { DomainEvent } from '../domainEvents';

export class LocalSimHost implements SimHost {
  readonly transport = 'in-process' as const;

  private readonly sim: Simulation;
  private overlays: OverlayState = {};
  private disposed = false;
  /** Projected read model — rebuilt/applied whenever the live sim changes. */
  private mirror: ColonyMirror | null = null;
  private viewDirty = true;

  constructor(sim: Simulation) {
    this.sim = sim;
  }

  /**
   * The projected, immutable view — same ColonyMirror shape WorkerSimHost uses.
   * Never the live Simulation.
   */
  get view(): SimView {
    this.refreshView();
    return this.mirror!;
  }

  step(frameDt: number): void {
    if (this.disposed) return;
    this.sim.step(frameDt);
    // Overlays ride the same cadence they always did — once per delivered
    // frame, so a pinned battery keeps its grip while the world runs. Identical
    // code to the worker's, which is the entire reason they are functions here.
    runOverlays(this.sim, this.overlays);
    // Refresh in place so GameLoop's already-held `const view = host.view`
    // sees post-step state (renderer/audio use that reference; syncUI re-gets).
    this.viewDirty = true;
    this.refreshView();
  }

  send(command: SimCommand): void {
    this.dispatch(command);
  }

  request(command: SimCommand): SimAck {
    return this.dispatch(command);
  }

  requestPlacement(command: Extract<SimCommand, { type: 'building/place' }>): Promise<SimAck> {
    return Promise.resolve(this.dispatch(command));
  }

  drainEvents(): SimLogEvent[] {
    return this.sim.drainEvents();
  }

  drainDomainEvents(): ReadonlyArray<DomainEvent> {
    return this.sim.drainDomainEvents();
  }

  syncOverlays(state: OverlayState): void {
    this.overlays = state;
    this.viewDirty = true;
  }

  async requestSnapshot(): Promise<SimSnapshot> {
    return this.sim.snapshot();
  }

  async loadSnapshot(snapshot: SimSnapshot): Promise<void> {
    this.sim.restore(snapshot);
    // World identity may change on restore — drop the mirror so terrain rebuilds.
    this.mirror = null;
    this.viewDirty = true;
  }

  dispose(): void {
    this.disposed = true;
    this.overlays = {};
    this.mirror = null;
    this.viewDirty = true;
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
    const ack = applyCommand(this.sim, decoded.command);
    if (ack.ok) {
      // Same freshness contract as step: update the held ColonyMirror in place.
      this.viewDirty = true;
      this.refreshView();
    }
    return ack;
  }

  /**
   * Project the live sim into the mirror. Events stay on the sim's queue
   * (`drainEvents`); the payload carries an empty event list so we do not
   * double-consume log lines that the HUD still expects from the host.
   */
  private refreshView(): void {
    if (!this.viewDirty && this.mirror) return;
    const payload = projectView(this.sim, 'in-process', this.overlays, [], []);
    if (!this.mirror) {
      this.mirror = new ColonyMirror(
        {
          seed: this.sim.world.seed,
          worldHalf: this.sim.world.half,
          region: this.sim.world.region,
        },
        payload,
      );
    } else {
      this.mirror.apply(payload);
    }
    this.viewDirty = false;
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
