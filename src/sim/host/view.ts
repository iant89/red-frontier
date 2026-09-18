/**
 * The read model: everything the presentation layers are allowed to *see*.
 *
 * Phase 20: entity surfaces are explicit immutable view models (`RoverView`,
 * `BuildingView`, …) produced by `projectView`. A live `Simulation` no longer
 * satisfies `SimView` — both LocalSimHost and WorkerSimHost hand out a
 * ColonyMirror over projected payloads, so presentation cannot observe (or
 * mutate) sim entity identity.
 *
 * What is *not* here, on purpose:
 *
 *  - **Writes.** Every mutation is a `SimCommand` (see `protocol.ts`). The view
 *    exposes pure queries only — `canPlace`, `needsMaintenance`, `reserveSols` —
 *    so a future worker can serve them from a mirrored cache instead of a round
 *    trip. `tests/sim/host.test.ts` pins that no view member collides with a
 *    sim mutator.
 *  - **The event queue.** `drainEvents()` clears as it reads, which is a write,
 *    so it lives on the host, not the view.
 *  - **Time control.** Stepping is the host's job; a view is a frozen "what is
 *    true right now".
 */

import type { Simulation } from '../Simulation';
import type { World } from '../World';
import type { AlertBus } from '../alerts';
import type { SolClock } from '../clock';
import type { BuildingKind, FluidId } from '../defs';
import type { DifficultyId, WorldOptions } from '../difficulty';
import type { Poi } from '../pois';
import type { PowerResult } from '../power';
import type { SunState } from '../clock';
import type {
  AlertsView,
  BuildingView,
  ColonistView,
  ResourceView,
  RoverView,
  WeatherView,
} from './viewModels';

export type {
  AlertView,
  AlertsView,
  BuildingView,
  ColonistView,
  ResourceView,
  RoverView,
  WeatherView,
} from './viewModels';

/**
 * The static world the renderer and placement previews need: heights, surface
 * material, scatter, and the deposit map. A worker serves this from a cached
 * heightmap + deposit list sent once at mission start, so terrain reads stay
 * synchronous on the UI thread even when the sim is off-thread.
 *
 * Note what is missing: `findPath`, `canBuild`, `navStats`. Those are the sim's
 * decisions about movement and siting, not facts about the ground.
 */
export type WorldView = Pick<
  World,
  | 'seed'
  | 'half'
  | 'region'
  | 'deposits'
  | 'pois'
  | 'heightAt'
  | 'sampleSurface'
  | 'rocks'
  | 'landingSite'
>;

/** The sol clock, read-only. Time travel is a `dev/time` command. */
export type ClockView = Pick<SolClock, 'sol' | 'frac' | 'format' | 'phase'>;

/**
 * The whole read model. `Readonly<…>` / `ReadonlyArray` guard presentation
 * slots; nested bags on entities are owned copies from projection.
 */
export type SimFields = ResourceView & {
  // world + identity
  readonly version: number;
  readonly seed: number;
  readonly difficulty: DifficultyId;
  readonly worldOptions: WorldOptions;
  readonly simTime: number;
  // entities — immutable view models
  readonly rovers: ReadonlyArray<RoverView>;
  readonly buildings: ReadonlyArray<BuildingView>;
  readonly colonist: ColonistView;
  // power + outcome
  readonly power: PowerResult;
  readonly gameOver: { reason: string; sol: number } | null;
  // environment
  readonly sun: SunState;
  readonly dustTransmission: number;
  /** Narrowed subviews: the live objects are readable, their mutators are not. */
  readonly world: WorldView;
  readonly alerts: AlertsView;
  readonly clock: ClockView;
  readonly weather: WeatherView;
};

// ---------------------------------------------------------- pure queries ----

/**
 * The methods a view may answer. Each is a read of state the view already
 * carries, with no side effects — which is what makes them safe to serve from a
 * cache across a worker boundary.
 *
 * Declared explicitly (not `Pick<Simulation, …>`) so return types are view
 * models rather than live entity interfaces. The name list is still the
 * contract `mirror.ts` must implement — see architecture guards in
 * `tests/sim/host.test.ts`.
 */
export interface SimQuery {
  roverById(id: number): RoverView | undefined;
  buildingById(id: number): BuildingView | undefined;
  poiById(id: number): Poi | undefined;
  idleRovers(): ReadonlyArray<RoverView>;
  needsMaintenance(buildingId: number): 'repair' | 'clean' | null;
  canPlace(kind: BuildingKind, x: number, z: number): string | null;
  storageCapacity(): number;
  reserveSols(f: FluidId): number;
  netRatePerSol(f: FluidId): number;
}

/**
 * The whole read model a host hands to `app/`, `ui/`, `render/` and `dev/`:
 * state plus the pure queries over it, and nothing else.
 */
export type SimView = SimFields & SimQuery;

// ------------------------------------------------- the writable overlay ----

/**
 * The narrow, *writable* slice a runtime overlay may touch (TDD §22).
 *
 * Developer mode's keep-battery-full pin has to write live state every step, and
 * it must not be part of any save. Rather than hand the whole `Simulation` to
 * panel code, the host hands it exactly these members. Anything else the overlay
 * wants has to become a command or an explicit sim-side backdoor — again, the
 * compiler is the one holding the line.
 *
 * Note: this is *not* the presentation surface. Overlays run against the live
 * Simulation inside the host; SimView is the projected immutable read model.
 */
export type SimWritable = Pick<
  Simulation,
  'rovers' | 'buildings' | 'colonist' | 'weather' | 'clock' | 'simTime' | 'recomputeCapacities'
>;

/** Snapshot payload, as `Simulation.snapshot()` produces it: plain JSON. */
export type SimSnapshot = object;

/** Everything needed to boot a colony, from the mission wizard. */
export interface SimBootParams {
  seed: number;
  difficulty: DifficultyId;
  worldHalf: number;
  region: string | null;
  worldOptions: WorldOptions;
}

/** A log line leaving the sim, shaped for the HUD. */
export type SimLogEvent = ReturnType<AlertBus['drain']>[number];
