/**
 * The view payload: the one-tick projection of the colony that crosses the
 * boundary, and the only thing a worker ever sends about state.
 *
 * Design notes, because the shape is the interesting part:
 *
 *  - **Entities are spread wholesale, not field-picked.** `{ ...rover }` cannot
 *    drift when a field is added to `Rover`, which is the failure mode a hand-
 *    written list of twenty fields always falls into. The payload is a snapshot
 *    of plain data; entity *classes* never cross, only their shapes.
 *  - **Derived numbers are computed once, on the sim side.** `reserveSols` and
 *    `netRatePerSol` walk a rolling flow window; the HUD asks for them every
 *    120 ms. Sending the answers beats making the mirror reimplement — and then
 *    silently disagree about — the smoothing.
 *  - **`satisfaction` becomes a list of entries.** A `Map` survives
 *    `postMessage`, but not `JSON.stringify`, and a payload you can print is a
 *    payload you can debug. The mirror rebuilds the Map on the way back.
 *  - **`nextId` is here for the client.** An id-allocating command needs to know
 *    which id the sim *will* hand out; see `WorkerSimHost.request`.
 *
 * What is *not* in the payload: the terrain. Heights, surface material and rock
 * scatter are pure functions of the seed, so the mirror derives them locally
 * (`mirror.ts`) rather than streaming a grid nobody asked for.
 */

import type { Simulation, Rover, Building, HistorySample, FluidFlow } from '../Simulation';
import type { Deposit } from '../World';
import type { Poi } from '../pois';
import type { Alert, LogEvent } from '../alerts';
import type { SunState } from '../clock';
import type { StormCell, StormKind, StormKindReal } from '../weather';
import type { FluidId, ResourceAmounts } from '../defs';
import { ALL_FLUIDS } from '../defs';
import type { PowerTier } from '../config';
import type { DifficultyId, WorldOptions } from '../difficulty';
import type { OverlayState } from './overlays';
import { BATTERY_PIN_OVERLAY } from './overlays';
import type { SimTransport } from './SimHost';

/** What a weather system is doing, as the panels need it — plain data. */
export interface WeatherPayload {
  time: number;
  windSpeed: number;
  windDirRad: number;
  dust: number;
  visibility: number;
  storm: StormKind;
  stormIntensity: number;
  solarTransmission: number;
  rollsSuppressed: boolean;
  forecast: { kind: StormKind; label: string; arrivesIn: number } | null;
  current: StormCell | null;
  threat: {
    kind: StormKindReal;
    label: string;
    distKm: number;
    bearingRad: number;
    arrivesIn: number;
    radiusKm: number;
  } | null;
  passesIn: number;
}

/** `PowerResult` with the Map flattened. See the header note. */
export interface PowerPayload {
  generationKw: number;
  demandKw: number;
  servedKw: number;
  batteryFlowKw: number;
  storedKWh: number;
  capacityKWh: number;
  tierSatisfaction: Record<PowerTier, number>;
  tierDemand: Record<PowerTier, number>;
  brownout: boolean;
  firstShedTier: PowerTier | null;
  curtailedKw: number;
  satisfaction: Array<[number, number]>;
}

export interface ViewPayload {
  transport: SimTransport;
  /** The save schema version, so a stale mirror is detectable. */
  version: number;
  seed: number;
  difficulty: DifficultyId;
  worldOptions: WorldOptions;
  worldHalf: number;
  region: string | null;
  simTime: number;
  /** Grid energy held right now (kWh) — the HUD's battery line. */
  storedKWh: number;
  /** What the next created entity will be called. */
  nextId: number;
  gameOver: { reason: string; sol: number } | null;
  dustTransmission: number;
  clock: { sol: number; frac: number; phase: string; format: string };
  sun: SunState;
  weather: WeatherPayload;
  power: PowerPayload;
  storage: ResourceAmounts;
  pools: { amounts: Record<FluidId, number>; capacity: Record<FluidId, number> };
  flows: Record<FluidId, FluidFlow>;
  lastFlows: Record<FluidId, FluidFlow>;
  history: HistorySample[];
  rovers: Rover[];
  buildings: Building[];
  colonist: Simulation['colonist'];
  deposits: Array<Pick<Deposit, 'id' | 'resource' | 'x' | 'z' | 'amount' | 'maxAmount' | 'radius'>>;
  /**
   * Sites and landed drops, spread whole. Discovery and salvage progress are
   * player-mutated state, so unlike the terrain they cannot be re-derived
   * client-side from the seed — they have to travel.
   */
  pois: Poi[];
  alerts: Alert[];
  /** Log lines produced since the previous payload. */
  events: LogEvent[];
  /** Per-fluid numbers the HUD shows; computed where the smoothing lives. */
  reserveSols: Record<FluidId, number>;
  netRatePerSol: Record<FluidId, number>;
  storageCapacity: number;
  /** Echoed back so the panel can show what the world is actually doing. */
  pinnedRovers: number[];
}

function livePins(sim: Simulation, overlays: OverlayState): number[] {
  const wanted = new Set(overlays[BATTERY_PIN_OVERLAY] ?? []);
  if (wanted.size === 0) return [];
  return sim.rovers.filter((r) => wanted.has(r.id)).map((r) => r.id);
}

/** Cheap per-entity copy: every field, because a picked list always drifts. */
function copy<T extends object>(src: T): T {
  return { ...src };
}

/**
 * Project the colony. `events` are passed in rather than drained here, so this
 * stays a pure read — the *runtime* owns when the queue is emptied.
 */
export function projectView(
  sim: Simulation,
  transport: SimTransport,
  overlays: OverlayState,
  events: LogEvent[] = [],
): ViewPayload {
  return {
    transport,
    version: sim.version,
    seed: sim.seed,
    difficulty: sim.difficulty,
    worldOptions: { ...sim.worldOptions },
    worldHalf: sim.world.half,
    region: sim.world.region,
    simTime: sim.simTime,
    storedKWh: sim.storedKWh,
    nextId: sim.nextEntityId,
    gameOver: sim.gameOver,
    dustTransmission: sim.dustTransmission,
    clock: {
      sol: sim.clock.sol,
      frac: sim.clock.frac,
      phase: sim.clock.phase(),
      format: sim.clock.format(),
    },
    sun: { ...sim.sun },
    weather: {
      time: sim.weather.time,
      windSpeed: sim.weather.windSpeed,
      windDirRad: sim.weather.windDirRad,
      dust: sim.weather.dust,
      visibility: sim.weather.visibility,
      storm: sim.weather.storm,
      stormIntensity: sim.weather.stormIntensity,
      solarTransmission: sim.weather.solarTransmission,
      rollsSuppressed: sim.weather.rollsSuppressed,
      forecast: sim.weather.forecast(),
      current: sim.weather.current() ? { ...sim.weather.current()! } : null,
      threat: sim.weather.threat(),
      passesIn: sim.weather.passesIn(),
    },
    power: {
      generationKw: sim.power.generationKw,
      demandKw: sim.power.demandKw,
      servedKw: sim.power.servedKw,
      batteryFlowKw: sim.power.batteryFlowKw,
      storedKWh: sim.power.storedKWh,
      capacityKWh: sim.power.capacityKWh,
      tierSatisfaction: { ...sim.power.tierSatisfaction },
      tierDemand: { ...sim.power.tierDemand },
      brownout: sim.power.brownout,
      firstShedTier: sim.power.firstShedTier,
      curtailedKw: sim.power.curtailedKw,
      satisfaction: [...sim.power.satisfaction.entries()],
    },
    storage: { ...sim.storage },
    pools: { amounts: { ...sim.pools.amounts }, capacity: { ...sim.pools.capacity } },
    flows: copyFlows(sim.flows),
    lastFlows: copyFlows(sim.lastFlows),
    history: sim.history.map(copy),
    rovers: sim.rovers.map(copy),
    buildings: sim.buildings.map(copy),
    colonist: copy(sim.colonist),
    deposits: sim.world.deposits.map((d) => ({
      id: d.id,
      resource: d.resource,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
    })),
    pois: sim.world.pois.map((p) => ({
      ...p,
      salvage: { ...p.salvage },
    })),
    alerts: sim.alerts.list().map(copy),
    events,
    reserveSols: fluidMap((f) => sim.reserveSols(f)),
    netRatePerSol: fluidMap((f) => sim.netRatePerSol(f)),
    storageCapacity: sim.storageCapacity(),
    // The ids the world is *actually* gripping, not the ids someone asked for: a
    // pin on a rover that no longer exists is dropped here, so a panel reading
    // this echo can never show a grip the world has let go of.
    pinnedRovers: livePins(sim, overlays),
  };
}

function fluidMap(fn: (f: FluidId) => number): Record<FluidId, number> {
  const out = {} as Record<FluidId, number>;
  for (const f of ALL_FLUIDS) out[f] = fn(f);
  return out;
}

function copyFlows(src: Record<FluidId, FluidFlow>): Record<FluidId, FluidFlow> {
  const out = {} as Record<FluidId, FluidFlow>;
  for (const f of ALL_FLUIDS) out[f] = { produced: src[f].produced, consumed: src[f].consumed };
  return out;
}
