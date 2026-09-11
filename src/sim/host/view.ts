/**
 * The read model: everything the presentation layers are allowed to *see*.
 *
 * `SimView` is derived from `Simulation` with `Pick`, so it can never drift from
 * the sim's own fields — but the derivation is one-directional: a `Simulation`
 * satisfies `SimView`, while a `SimView` is **not** a `Simulation`. That single
 * asymmetry is what makes the worker migration safe: the moment the HUD, the
 * renderer and the dev panel are typed against the view, the compiler refuses
 * any code path that reaches for a sim-only method (`step`, `snapshot`,
 * `placeBuilding`, `issue*`), and those refusals are exactly the list of things
 * that must become commands.
 *
 * What is *not* here, on purpose:
 *
 *  - **Writes.** Every mutation is a `SimCommand` (see `protocol.ts`). The view
 *    exposes pure queries only — `canPlace`, `needsMaintenance`, `reserveSols` —
 *    so a future worker can serve them from a mirrored cache instead of a round
 *    trip. `tests/sim/host.test.ts` pins that no view member collides with a
 *    sim mutator, which is the same rule enforced by `Pick` but readable as a
 *    failure message.
 *  - **The event queue.** `drainEvents()` clears as it reads, which is a write,
 *    so it lives on the host, not the view.
 *  - **Time control.** Stepping is the host's job; a view is a frozen "what is
 *    true right now".
 */

import type { Simulation } from '../Simulation';
import type { World } from '../World';
import type { AlertBus } from '../alerts';
import type { SolClock } from '../clock';
import type { Weather } from '../weather';
import type { DifficultyId, WorldOptions } from '../difficulty';

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
  'seed' | 'half' | 'region' | 'deposits' | 'heightAt' | 'sampleSurface' | 'rocks' | 'landingSite'
>;

/** The alert board, read-only. Raising and clearing alerts is sim-internal. */
export type AlertsView = Pick<AlertBus, 'list' | 'history' | 'worst' | 'isActive'>;

/** The sol clock, read-only. Time travel is a `dev/time` command. */
export type ClockView = Pick<SolClock, 'sol' | 'frac' | 'format' | 'phase'>;

/**
 * Weather, read as a snapshot of the sky. The debug hooks are excluded, so the
 * panel's "conjure a storm" button has no choice but to go through a command.
 */
export type WeatherView = Readonly<
  Omit<Weather, 'update' | 'debugScheduleStorm' | 'debugClearStorms' | 'debugResumeRolls'>
>;

/**
 * The whole read model. `Readonly<…>` guards the *slots* (no `view.rovers = []`);
 * entity fields stay open in-process, and the discipline that they are written
 * only by the sim is enforced structurally: the sim-side mutators they would
 * need are simply not on this type.
 */
export type SimFields = Readonly<
  Pick<
    Simulation,
    // world + identity
    | 'version'
    | 'seed'
    | 'difficulty'
    | 'worldOptions'
    | 'simTime'
    // entities
    | 'rovers'
    | 'buildings'
    | 'colonist'
    // economy + life support
    | 'storage'
    | 'pools'
    | 'power'
    | 'storedKWh'
    | 'flows'
    | 'lastFlows'
    | 'history'
    | 'gameOver'
    // environment
    | 'sun'
    | 'dustTransmission'
  >
> & {
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
 */
export type SimQuery = Pick<
  Simulation,
  | 'roverById'
  | 'buildingById'
  | 'onlineBuildings'
  | 'onlineWarehouses'
  | 'idleRovers'
  | 'shelters'
  | 'depositAt'
  | 'buildingAt'
  | 'nearDepot'
  | 'nearCharger'
  | 'needsMaintenance'
  | 'canPlace'
  | 'defsFor'
  | 'lightsNeeded'
  | 'storageCapacity'
  | 'storageRoom'
  | 'storageTotal'
  | 'storageTotalCapacity'
  | 'storageFull'
  | 'fullResources'
  | 'batteryCapacity'
  | 'solsOfReserve'
  | 'reserveSols'
  | 'netRatePerSol'
  | 'instantRatePerSol'
>;

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