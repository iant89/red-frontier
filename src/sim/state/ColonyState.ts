/**
 * Phase 2 — Formalize ColonyState.
 *
 * Goal per roadmap §6: Separate simulation state from simulation behavior.
 *
 *   Simulation
 *      ↓
 *   ColonyState
 *
 * State contains data. Systems contain behavior (future phases).
 *
 * This module is the first extraction: it owns all authoritative data that
 * was previously direct fields on Simulation. Simulation now holds a
 * `state: ColonyState` and proxies its old public surface for backward
 * compatibility, so existing tests and hosts keep working.
 *
 * No presentation dependency (no DOM, no Three.js).
 * No behavior — only data + tiny pure helpers.
 */

import { effectiveBuildingDef } from '../engineering/upgrades';
import { emptyWaterState, reconcileWater, type WaterState } from './WaterState';
import { freshRoverParts } from './RoverState';
import { World } from '../World';
import { SolClock } from '../clock';
import { createWeatherState } from './WeatherState';
import type { Weather } from '../weather';
import { AlertBus } from '../alerts';
import { DomainEventLog } from '../domainEvents';
import { mulberry32 } from '../../lib/rng';
import {
  BASE_STORAGE_PER_RESOURCE,
  BASE_COMPONENT_SLOTS,
  BASE_DUST_TRANSMISSION,
  POD_BATTERY_KWH,
  POD_POWER_KW,
  POD_LIFE_SUPPORT_KW,
  SAVE_VERSION,
  SPAWN_X,
  SPAWN_Z,
  devLevelMul,
} from '../config';
import {
  emptyAmounts,
  emptyComponents,
  POD_STARTING_FLUIDS,
  POD_FLUID_CAPACITY,
  emptyFluids,
  ROVERS,
  BUILDINGS,
} from '../defs';
import type {
  ComponentAmounts,
  ResourceAmounts,
  FluidId,
  RoverKind,
  BuildingKind,
} from '../defs';
import { ALL_RESOURCES, ALL_FLUIDS, ALL_COMPONENTS } from '../defs';
import { DIFFICULTIES, DEFAULT_WORLD_OPTIONS, richnessMulFor, suppliesMulFor } from '../difficulty';
import type { DifficultyId, WorldOptions } from '../difficulty';
import { initialPowerState } from './PowerState';
import type { PowerResult } from '../power';
import { makePools, makeColonist, type Colonist, type FluidPools } from '../lifesupport';
import { DROP_FIRST_SOL_MIN, DROP_FIRST_SOL_MAX } from '../config';
import { defaultRoverRules, type Rover, type RoverTask } from './RoverState';
import type { Building } from './BuildingState';
import type { HistorySample } from './HistoryState';
import { emptyFlows, type FluidFlow } from './ResourceState';
import { emptyTutorialState, type TutorialState } from './TutorialState';
import { emptyObjectiveState, type ObjectiveState } from './ObjectiveState';
import { emptyUnlocks, type UnlockRegistry } from '../unlocks';
import type { Poi } from '../pois';

export interface ColonyState {
  /** Save version — mirrors SAVE_VERSION, kept here for snapshot coherence. */
  version: number;
  seed: number;
  difficulty: DifficultyId;
  worldOptions: WorldOptions;
  consumptionMul: number;

  world: World;
  clock: SolClock;
  weather: Weather;
  alerts: AlertBus;
  /** Per-tick domain event collector (Phase 21). Ephemeral — not saved. */
  domainEvents: DomainEventLog;

  rovers: Rover[];
  buildings: Building[];
  colonist: Colonist;

  storage: ResourceAmounts;
  /**
   * Manufactured components on the racks, in whole units (P5). A second ledger
   * beside `storage` on purpose: components are counted, bulk solids are weighed,
   * and `ComponentSystem` owns this one the way `LogisticsSystem` owns that one.
   */
  components: ComponentAmounts;
  pools: FluidPools;
  water: WaterState;
  power: PowerResult;
  storedKWh: number;

  flows: Record<FluidId, FluidFlow>;
  lastFlows: Record<FluidId, FluidFlow>;
  flowWindow: Array<{ t: number; f: Record<FluidId, FluidFlow> }>;
  history: HistorySample[];
  lastHistoryAt: number;

  gameOver: { reason: string; sol: number } | null;
  dustTransmission: number;

  nextDropSol: number;
  dropRng: () => number;

  tutorial: TutorialState;

  /**
   * Phase 2: the engineering-project board — which projects are on offer and
   * which have landed. Ids only; the content is in `sim/projects/`.
   */
  objectives: ObjectiveState;
  /**
   * Phase 2: the unlock registry — the shared primitive projects (P2), POI
   * rewards (P7) and campaign chapters (P9) all write to and read from.
   */
  unlocks: UnlockRegistry;
  /**
   * Sol the player last issued a direct order. The autonomy streak is measured
   * from here (AUTONOMY.md §4.1; Phase 3 owns the full stat, Phase 2 records
   * the number so the flagship project is measurable from sol 1).
   */
  lastDirectOrderSol: number;

  simTime: number;
  ticksRun: number;
  remainder: number;
  nextId: number;
  _storageCapacity: number;
  /** Derived: component rack space, from online undamaged workshops. */
  _componentCapacity: number;
  stormAnnounced: boolean;
}

export interface ColonyStateParams {
  seed: number;
  nearDeposits?: number;
  difficulty?: DifficultyId;
  worldHalf?: number;
  region?: string | null;
  worldOptions?: Partial<WorldOptions>;
}

/**
 * Create a fresh ColonyState — mirrors what Simulation constructor used to do.
 * No behavior, only data initialization.
 */
export function createColonyState(params: ColonyStateParams): ColonyState {
  const seed = params.seed;
  const difficulty = params.difficulty ?? 'pioneer';
  const worldOptions = { ...DEFAULT_WORLD_OPTIONS, ...(params.worldOptions ?? {}) };
  const diff = DIFFICULTIES[difficulty] ?? DIFFICULTIES.pioneer;
  const consumptionMul = diff.consumptionMul;

  const world = new World({
    seed,
    nearDeposits: params.nearDeposits ?? worldOptions.nearDeposits ?? 0.2,
    worldHalf: params.worldHalf,
    region: params.region ?? null,
    richness: richnessMulFor(worldOptions.richness),
  });

  const weather = createWeatherState(seed, difficulty, worldOptions);

  const clock = new SolClock();
  const alerts = new AlertBus();
  const domainEvents = new DomainEventLog();
  const colonist = makeColonist(1, 'Cmdr. Vega', SPAWN_X, world.heightAt(SPAWN_X, SPAWN_Z), SPAWN_Z + 3);
  const storage = emptyAmounts();
  const components = emptyComponents();
  const pools = makePools();
  const power = initialPowerState();
  const storedKWh = POD_BATTERY_KWH * 0.6;

  const flows = emptyFlows();
  const lastFlows = emptyFlows();
  const history: HistorySample[] = [];
  const flowWindow: Array<{ t: number; f: Record<FluidId, FluidFlow> }> = [];
  const lastHistoryAt = -Infinity;

  let nextId = 1000;
  const rovers: Rover[] = [];

  function allocId(): number {
    return nextId++;
  }

  function spawnRoverAt(kind: RoverKind, x: number, z: number, heading: number): Rover {
    const def = ROVERS[kind];
    const r: Rover = {
      id: allocId(),
      kind,
      label: def.label,
      x,
      y: world.heightAt(x, z),
      z,
      heading,
      battery: def.maxBatteryKWh,
      cargo: emptyAmounts(),
      phase: 'idle',
      command: { type: 'idle' },
      pending: [],
      goal: 'idle',
      gx: x,
      gz: z,
      gid: 0,
      recharge: false,
      lowBatteryNotified: false,
      chargeSat: 1,
      autoTask: false,
      condition: 100,
      parts: freshRoverParts(),
      rules: defaultRoverRules(),
      routePaused: false,
      blockNotified: false,
      sheltered: false,
      lightsOn: true,
      lightsActive: false,
      navPath: [],
      navI: 0,
    };
    rovers.push(r);
    return r;
  }

  spawnRoverAt('mining', SPAWN_X + 9, SPAWN_Z, Math.PI);
  spawnRoverAt('utility', SPAWN_X - 9, SPAWN_Z + 4, Math.PI);

  // capacities
  let cap = BASE_STORAGE_PER_RESOURCE;
  const fluid = { ...POD_FLUID_CAPACITY };
  // No buildings online yet, so cap is base only
  const _storageCapacity = cap;
  // ...and the pod has no machine shop, so there is nowhere to rack a component.
  const _componentCapacity = BASE_COMPONENT_SLOTS;
  pools.capacity = fluid;

  // exploration
  let dropRng = mulberry32(seed ^ 0x2f6e2b1);
  let nextDropSol = DROP_FIRST_SOL_MIN + dropRng() * (DROP_FIRST_SOL_MAX - DROP_FIRST_SOL_MIN);

  const tutorial = emptyTutorialState();
  const objectives = emptyObjectiveState();
  const unlocks = emptyUnlocks();

  const supplies = diff.suppliesMul * suppliesMulFor(worldOptions.supplies);
  pools.amounts = {
    water: POD_STARTING_FLUIDS.water * supplies,
    oxygen: POD_STARTING_FLUIDS.oxygen * supplies,
    food: POD_STARTING_FLUIDS.food * supplies,
  };

  return {
    version: SAVE_VERSION,
    seed,
    difficulty,
    worldOptions,
    consumptionMul,
    world,
    clock,
    weather,
    alerts,
    domainEvents,
    rovers,
    buildings: [],
    colonist,
    storage,
    components,
    pools,
    water: emptyWaterState(),
    power,
    storedKWh,
    flows,
    lastFlows,
    flowWindow,
    history,
    lastHistoryAt,
    gameOver: null,
    dustTransmission: BASE_DUST_TRANSMISSION,
    nextDropSol,
    dropRng,
    tutorial,
    objectives,
    unlocks,
    lastDirectOrderSol: 0,
    simTime: 0,
    ticksRun: 0,
    remainder: 0,
    nextId,
    _storageCapacity,
    _componentCapacity,
    stormAnnounced: false,
  };
}

/**
 * Reset exploration schedule (used on new game and on restore).
 */
export function resetExplorationState(state: ColonyState, nextDropSol?: number): void {
  state.dropRng = mulberry32(state.seed ^ 0x2f6e2b1);
  state.nextDropSol =
    nextDropSol && nextDropSol > 0
      ? nextDropSol
      : DROP_FIRST_SOL_MIN + state.dropRng() * (DROP_FIRST_SOL_MAX - DROP_FIRST_SOL_MIN);
}

/**
 * Recompute bulk + fluid capacity from online buildings.
 */
export function recomputeCapacitiesState(state: ColonyState): void {
  let cap = BASE_STORAGE_PER_RESOURCE;
  let slots = BASE_COMPONENT_SLOTS;
  const fluid = { ...POD_FLUID_CAPACITY };
  for (const b of state.buildings) {
    if (b.state !== 'online' || b.damaged) continue;
    const def = effectiveBuildingDef(b);
    const mul = devLevelMul(b.level);
    cap += def.storagePerResourceKg * mul;
    slots += (def.componentSlots ?? 0) * mul;
    if (def.fluidCapacity) {
      for (const f of ALL_FLUIDS) {
        fluid[f] += (def.fluidCapacity[f] ?? 0) * mul;
      }
    }
  }
  state._storageCapacity = cap;
  // Rack space is an integer count of places to put a finished unit; a workshop
  // going offline or damaged takes its rack with it, and whatever was on it is
  // clamped away exactly the way an over-full silo is.
  state._componentCapacity = Math.floor(slots);
  for (const c of ALL_COMPONENTS) {
    if (state.components[c] > state._componentCapacity) {
      state.components[c] = state._componentCapacity;
    }
  }
  for (const r of ALL_RESOURCES) {
    if (state.storage[r] > cap) state.storage[r] = cap;
  }
  state.pools.capacity = fluid;
  for (const f of ALL_FLUIDS) {
    if (state.pools.amounts[f] > fluid[f]) state.pools.amounts[f] = fluid[f];
  }
  reconcileWater(state);
}

/**
 * Simple validation for ColonyState creation — used by tests.
 */
export function validateColonyState(state: unknown): string[] {
  const errors: string[] = [];
  if (!state || typeof state !== 'object') {
    errors.push('state must be object');
    return errors;
  }
  const s = state as Record<string, unknown>;
  if (!Number.isFinite(s.seed as number)) errors.push('seed must be finite');
  if (!Array.isArray((s as any).rovers)) errors.push('rovers must be array');
  if (!Array.isArray((s as any).buildings)) errors.push('buildings must be array');
  if (!(s as any).world) errors.push('world missing');
  if (!(s as any).clock) errors.push('clock missing');
  if (!(s as any).weather) errors.push('weather missing');
  return errors;
}
