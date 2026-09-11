/**
 * The mirror: a `SimView` implemented over view payloads, plus the one piece of
 * the world that is never sent — the terrain.
 *
 * Heights, surface geology and rock scatter are pure functions of the seed
 * (`World` builds them from noise and never mutates them), so the main thread
 * derives them itself from the same seed rather than streaming a grid nobody
 * asked for. That is also what makes an instant placement verdict possible:
 * `canPlace` runs the *same* `evaluateSite` the simulation runs, against this
 * local terrain and the projected obstacle lists — one tick stale at worst, and
 * never a different rule.
 *
 * Everything else is copied data, deliberately: mutating a rover on a mirror
 * changes nothing in the world, which is the correct outcome for a read model
 * and the reason writes have to be commands.
 *
 * `ColonyMirror` *implements* `SimView` rather than casting to it, so the
 * compiler enumerates the view's obligations. That list is the real answer to
 * "what must a worker send?" — trim the view and this class shrinks with it,
 * which is why `SimQuery` holds only what the panels actually call.
 */

import { World } from '../World';
import type { Building, Colonist, FluidFlow, HistorySample, Rover } from '../Simulation';
import type { FluidPools } from '../lifesupport';
import type { Alert, LogEvent, Severity } from '../alerts';
import type { SunState } from '../clock';
import type { BuildingKind, FluidId, ResourceAmounts } from '../defs';
import type { PowerResult } from '../power';
import type { DifficultyId, WorldOptions } from '../difficulty';
import { evaluateSite, maintenanceNeed } from '../rules';
import { BATTERY_PIN_OVERLAY } from './overlays';
import type { SimTransport } from './SimHost';
import type { ViewPayload } from './projection';
import type { AlertsView, ClockView, SimView, WeatherView, WorldView } from './view';

/**
 * The seed-derived facts needed to rebuild the terrain locally, as the *runtime*
 * reports them — after a restore, `World` is rebuilt from the save's own numbers,
 * so this comes back on the wire rather than being inferred from boot params.
 *
 * Deposit scatter is deliberately not part of it: the mirror's `World` is asked
 * for heights, slopes and surface material only, and the deposits it happens to
 * generate are thrown away in favour of the payload's. `nearDeposits: 0` says so
 * out loud, and skips the ring placement we never read.
 */
export interface TerrainParams {
  seed: number;
  worldHalf: number;
  region: string | null;
}

/** The client-side log ring, sized like the bus it mirrors (`AlertBus.maxLog`). */
const HISTORY_LIMIT = 200;

/** Severity ranking, lowest index = most urgent — mirrors the bus's own order. */
const SEVERITY_ORDER: readonly Severity[] = ['crit', 'warn', 'info', 'ok', 'opportunity'];

export class ColonyMirror implements SimView {
  /**
   * A read-only `World` of our own: same seed, same noise, therefore the same
   * planet. Only its *terrain* is consulted — deposits come from the payload,
   * because those change as the fleet digs.
   */
  private readonly ground: World;
  private readonly log: LogEvent[] = [];
  private unread: LogEvent[] = [];
  private payload: ViewPayload;

  /**
   * The sub-views are built **once**, with getters, rather than per read. A frame
   * that asks `sim.world.heightAt` forty times for terrain shading must not pay
   * for forty objects, and anything that memoises on identity (the renderer keys
   * its deposit meshes) needs the same object to come back. Stable identity and
   * current data are not in conflict here: the getter re-reads the payload.
   */
  private readonly worldView: WorldView;
  private readonly clockView: ClockView;
  private readonly weatherView: WeatherView;
  private readonly alertsView: AlertsView;

  constructor(terrain: TerrainParams, first: ViewPayload) {
    this.ground = new World({
      seed: terrain.seed,
      worldHalf: terrain.worldHalf,
      region: terrain.region,
      nearDeposits: 0,
    });
    this.payload = first;

    const ground = this.ground;
    const self = this;
    this.worldView = {
      get seed() {
        return self.payload.seed;
      },
      get half() {
        return self.payload.worldHalf;
      },
      get region() {
        return self.payload.region;
      },
      // Not `ground.deposits`: the scatter changes as the fleet digs, and the
      // world's own copy was generated from the seed, not from the colony.
      get deposits() {
        return self.payload.deposits;
      },
      heightAt: (x, z) => ground.heightAt(x, z),
      sampleSurface: (x, z) => ground.sampleSurface(x, z),
      rocks: () => ground.rocks(),
      landingSite: () => ground.landingSite(),
    };
    this.clockView = {
      get sol() {
        return self.payload.clock.sol;
      },
      get frac() {
        return self.payload.clock.frac;
      },
      phase: () => self.payload.clock.phase,
      format: () => self.payload.clock.format,
    };
    this.weatherView = {
      get time() {
        return self.payload.weather.time;
      },
      get windSpeed() {
        return self.payload.weather.windSpeed;
      },
      get windDirRad() {
        return self.payload.weather.windDirRad;
      },
      get dust() {
        return self.payload.weather.dust;
      },
      get visibility() {
        return self.payload.weather.visibility;
      },
      get storm() {
        return self.payload.weather.storm;
      },
      get stormIntensity() {
        return self.payload.weather.stormIntensity;
      },
      get solarTransmission() {
        return self.payload.weather.solarTransmission;
      },
      get rollsSuppressed() {
        return self.payload.weather.rollsSuppressed;
      },
      // The panels call these as methods; the answers were computed where the
      // storm cells live, so they are already resolved by the time they land.
      forecast: () => self.payload.weather.forecast,
      current: () => self.payload.weather.current,
      threat: () => self.payload.weather.threat,
      passesIn: () => self.payload.weather.passesIn,
    };
    this.alertsView = {
      list: () => self.payload.alerts,
      history: () => [...self.log],
      worst: () => {
        let best: Severity | null = null;
        for (const a of self.payload.alerts) {
          if (best === null || SEVERITY_ORDER.indexOf(a.severity) < SEVERITY_ORDER.indexOf(best)) {
            best = a.severity;
          }
        }
        return best;
      },
      isActive: (key: string) => self.payload.alerts.some((a) => a.key === key),
    };
  }

  /** Adopt the next payload. Called once per view message. */
  apply(payload: ViewPayload): void {
    this.payload = payload;
    if (payload.events.length > 0) {
      this.unread = this.unread.concat(payload.events);
      for (const ev of payload.events) {
        this.log.push(ev);
        if (this.log.length > HISTORY_LIMIT) this.log.shift();
      }
    }
  }

  /**
   * The log lines nobody has shown the player yet. Consumed on read, exactly
   * like the in-process host's `drainEvents`, so the HUD's toast queue cannot
   * double-print an event because a payload landed twice.
   */
  drainUnread(): LogEvent[] {
    const out = this.unread;
    this.unread = [];
    return out;
  }

  /** The overlay grips the world is actually running, echoed back. */
  get pinnedRovers(): number[] {
    return this.payload.pinnedRovers;
  }

  // ------------------------------------------------------------ fields ----

  get version(): number {
    return this.payload.version;
  }
  get seed(): number {
    return this.payload.seed;
  }
  get difficulty(): DifficultyId {
    return this.payload.difficulty;
  }
  get worldOptions(): WorldOptions {
    return this.payload.worldOptions;
  }
  get simTime(): number {
    return this.payload.simTime;
  }
  get dustTransmission(): number {
    return this.payload.dustTransmission;
  }
  get gameOver(): { reason: string; sol: number } | null {
    return this.payload.gameOver;
  }
  get rovers(): Rover[] {
    return this.payload.rovers;
  }
  get buildings(): Building[] {
    return this.payload.buildings;
  }
  get colonist(): Colonist {
    return this.payload.colonist;
  }
  get storage(): ResourceAmounts {
    return this.payload.storage;
  }
  get pools(): FluidPools {
    return this.payload.pools;
  }
  get power(): PowerResult {
    const { satisfaction, ...rest } = this.payload.power;
    // Flattened to entries for the wire so a payload stays JSON-printable; the
    // grid model wants a Map, so it is rebuilt here rather than at every read.
    return { ...rest, satisfaction: new Map(satisfaction) };
  }
  get storedKWh(): number {
    return this.payload.storedKWh;
  }
  get flows(): Record<FluidId, FluidFlow> {
    return this.payload.flows;
  }
  get lastFlows(): Record<FluidId, FluidFlow> {
    return this.payload.lastFlows;
  }
  get history(): HistorySample[] {
    return this.payload.history;
  }
  get sun(): SunState {
    return this.payload.sun;
  }

  get world(): WorldView {
    return this.worldView;
  }

  get clock(): ClockView {
    return this.clockView;
  }

  get weather(): WeatherView {
    return this.weatherView;
  }

  get alerts(): AlertsView {
    return this.alertsView;
  }

  // ----------------------------------------------------------- queries ----

  roverById(id: number): Rover | undefined {
    return this.payload.rovers.find((r) => r.id === id);
  }

  buildingById(id: number): Building | undefined {
    return this.payload.buildings.find((b) => b.id === id);
  }

  idleRovers(): Rover[] {
    return this.payload.rovers.filter(
      (r) =>
        r.phase !== 'disabled' &&
        !r.recharge &&
        !r.sheltered &&
        r.command.type === 'idle' &&
        r.pending.length === 0,
    );
  }

  needsMaintenance(buildingId: number): 'repair' | 'clean' | null {
    return maintenanceNeed(this.buildingById(buildingId));
  }

  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    return evaluateSite(kind, x, z, {
      ground: this.ground,
      buildings: this.payload.buildings,
      deposits: this.payload.deposits,
    });
  }

  storageCapacity(): number {
    return this.payload.storageCapacity;
  }

  reserveSols(f: FluidId): number {
    return this.payload.reserveSols[f];
  }

  netRatePerSol(f: FluidId): number {
    return this.payload.netRatePerSol[f];
  }
}
