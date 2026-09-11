/**
 * The authoritative simulation.
 *
 * Framework-agnostic by construction: no DOM, no three.js, no wall clock. The
 * renderer and HUD only ever *read* from here. That constraint is what will let
 * this module move onto a Worker without touching a line of rendering code.
 *
 * Tick order follows TDD §4:
 *   1. clock / day-night      5. life support & colonist
 *   2. weather (P3)           6. jobs & tasks
 *   3. power network          7. movement
 *   4. production             8. construction
 *                             9. failure checks → alerts → history
 */

import { World } from './World';
import type { Deposit } from './World';
import { clamp } from '../lib/rng';
import {
  SIM_TICK,
  SPAWN_X,
  SPAWN_Z,
  BASE_STORAGE_PER_RESOURCE,
  ROVER_CHARGE_THRESHOLD,
  ROVER_CHARGE_RATE_KW,
  GARAGE_CHARGE_RATE_KW,
  ROVER_CHARGE_TIER,
  HOURS_PER_SEC,
  SOLS_PER_SEC,
  SOL_SECONDS,
  POD_POWER_KW,
  POD_BATTERY_KWH,
  POD_LIFE_SUPPORT_KW,
  POD_RADIUS,
  COLONIST_SPEED,
  COLONIST_BUILD_POWER,
  COLONIST_O2_PER_SOL,
  COLONIST_WATER_PER_SOL,
  COLONIST_FOOD_PER_SOL,
  SUIT_O2_CAPACITY,
  HISTORY_SAMPLES,
  HISTORY_INTERVAL_S,
  BASE_DUST_TRANSMISSION,
  SAVE_VERSION,
  BUILDING_MAX_HEALTH,
  DAMAGED_HEALTH,
  REPAIR_RESTART_HEALTH,
  ROVER_REPAIR_RATE,
  ROVER_CLEAN_RATE,
  PANEL_DIRT_PER_SOL,
  AUTO_CLEAN_THRESHOLD,
  STORM_SHELTER_INTENSITY,
  STORM_EVA_INTENSITY,
  STORM_WORK_MUL,
  CLEANLINESS_FLOOR,
  ROVER_CONDITION_SLOW,
  ROVER_CONDITION_ALERT,
  ROVER_WEAR_WORK_S,
  ROVER_WEAR_MOVE_S,
  ROVER_WEAR_STORM_S,
  GARAGE_SERVICE_RATE,
  RECOVER_TRANSFER_KW,
  RECOVER_MIN_GIVE_KWH,
  ROUTE_RESUME_ROOM_KG,
  LIGHTS_AUTO_IRRADIANCE,
  LIGHTS_AUTO_VISIBILITY,
  START_SOL_FRAC,
  DEV_MAX_BUILDING_LEVEL,
  devLevelMul,
} from './config';
import type { PowerTier } from './config';
import type {
  ResourceId,
  ResourceAmounts,
  FluidId,
  RoverKind,
  BuildingKind,
} from './defs';
import {
  RESOURCES,
  ROVERS,
  BUILDINGS,
  ALL_RESOURCES,
  ALL_FLUIDS,
  FLUIDS,
  emptyAmounts,
  emptyFluids,
  POD_FLUID_CAPACITY,
  POD_STARTING_FLUIDS,
} from './defs';
import {
  DIFFICULTIES,
  DEFAULT_WORLD_OPTIONS,
  stormMulFor,
  suppliesMulFor,
  richnessMulFor,
} from './difficulty';
import type { DifficultyId, WorldOptions } from './difficulty';
import { SolClock } from './clock';
import type { SunState } from './clock';
import { Weather, stormLabel } from './weather';
import type { StormKind, StormKindReal } from './weather';
import { resolvePower, idlePower, type PowerDemand, type PowerResult } from './power';
import {
  makePools,
  makeColonist,
  applyColonistNeeds,
  addFluid,
  takeFluid,
  fluidHeadroom,
  colonistStatusText,
  type Colonist,
  type ColonistOrder,
  type FluidPools,
} from './lifesupport';
import { AlertBus, type Severity } from './alerts';

// --------------------------------------------------------------- types ----

/**
 * A rover task (GDD §5: first-class, queueable, repeatable). `command` is the
 * task currently being executed; `pending` holds the rest of the queue. A
 * `mine` task with `repeat` set is a *haul route*: mine → depot → seam, over
 * and over, until the seam runs dry or the player stops it.
 */
export type RoverTask =
  | { type: 'idle' }
  | { type: 'moveTo'; x: number; z: number }
  | { type: 'mine'; depositId: number; repeat?: boolean }
  | { type: 'construct'; buildingId: number }
  | { type: 'clean'; buildingId: number }
  | { type: 'repair'; buildingId: number }
  | { type: 'recover'; roverId: number; give?: number; given?: number }
  | { type: 'unload' }
  | { type: 'wait'; seconds: number };

/** Kept as an alias so older call sites read naturally. */
export type RoverCommand = RoverTask;

/**
 * Player-authored automation (GDD §5: "IF battery < 20% → return to charger…"
 * and friends). The behaviours themselves are simulation rules; these switches
 * and thresholds are the player's levers over them, per rover.
 */
export interface RoverRules {
  /** Head home to charge below this battery fraction (percent). */
  chargeFloorPct: number;
  /** Fetch what the build queue is short of when idle. */
  autoHaul: boolean;
  /** Volunteer for automatic repair / panel-cleaning dispatches. */
  autoService: boolean;
  /** Recall to a charger when a storm crosses the shelter threshold. */
  stormShelter: boolean;
  /** Volunteer to jump-start stranded rovers. */
  autoRescue: boolean;
}

export function defaultRoverRules(): RoverRules {
  return {
    chargeFloorPct: Math.round(ROVER_CHARGE_THRESHOLD * 100),
    autoHaul: true,
    autoService: true,
    stormShelter: true,
    autoRescue: true,
  };
}

export interface Rover {
  id: number;
  kind: RoverKind;
  label: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  battery: number; // kWh
  cargo: ResourceAmounts;
  phase: RoverPhase;
  /** The task at the head of the queue (what the rover is doing now). */
  command: RoverTask;
  /** The rest of the queue — executed in order as tasks complete. */
  pending: RoverTask[];
  goal: RoverGoal;
  gx: number;
  gz: number;
  gid: number;
  recharge: boolean;
  lowBatteryNotified: boolean;
  statusText: string;
  /** Fraction of requested charge power actually delivered last tick. */
  chargeSat: number;
  /** True when the sim assigned this task, not the player. */
  autoTask: boolean;
  /** Drivetrain condition 0..100. Low condition slows work; garages fix it. */
  condition: number;
  /** The player's automation levers for this rover. */
  rules: RoverRules;
  /** A repeat route is parked at the depot waiting for silo space. */
  routePaused: boolean;
  /** "Still holds cargo" warned once per stuck episode, not per tick. */
  blockNotified: boolean;
  /** Forced back to base by storm weather; released when the storm passes. */
  sheltered: boolean;
  /**
   * Player switch for the position lights & headlights. When on, the sim
   * lights them automatically at night or in low visibility (and bills the
   * rover's battery for it). The yellow emergency strobe of a disabled rover
   * ignores this switch entirely.
   */
  lightsOn: boolean;
  /** Runtime: headlights + rear strobe are lit right now and drawing power. */
  lightsActive: boolean;
  /** Runtime nav waypoints (not saved — recomputed on the next setTravel). */
  navPath: Array<{ x: number; z: number }>;
  navI: number;
}

export type RoverGoal =
  | 'idle'
  | 'move'
  | 'mine'
  | 'toDepot'
  | 'unload'
  | 'toSite'
  | 'build'
  | 'toCharge'
  | 'charge'
  | 'toService'
  | 'service'
  | 'toRecover'
  | 'recover';

export type RoverPhase = 'idle' | 'moving' | 'working' | 'charging' | 'disabled';

export interface Building {
  id: number;
  kind: BuildingKind;
  x: number;
  z: number;
  rot: number;
  state: 'site' | 'building' | 'online';
  remainingCost: ResourceAmounts;
  needsMaterials: boolean;
  progress: number;
  buildTime: number;
  workerId: number | null;
  /** Player switch. A disabled building draws nothing and produces nothing. */
  enabled: boolean;
  // ---- runtime, recomputed every tick (not authoritative between ticks) ----
  /** 0..1 — how much of its requested power it received. */
  powerSat: number;
  /** 0..1 — how hard the process is actually running. */
  throughput: number;
  /** Instantaneous generation (kW). */
  genKw: number;
  /** Instantaneous load (kW). */
  loadKw: number;
  /** Why it isn't running, for the inspector. */
  idleReason: string;
  // ---- Prototype 3: weather exposure --------------------------------------
  /** Structural health 0..100. Storms chew it down; rovers repair it up. */
  health: number;
  /** Panel cleanliness 0..1 — dust on the glass, solar output pays for it. */
  cleanliness: number;
  /** Tripped offline by damage; a rover repair brings it back online. */
  damaged: boolean;
  // ---- Prototype 4: rover garage ------------------------------------------
  /** What the assembly line is building right now, if anything. */
  assembly: { kind: RoverKind; progress: number } | null;
  // ---- Developer mode (runtime only) ---------------------------------------
  /**
   * Developer-mode upgrade level. 1 is the honest baseline; higher levels
   * scale output and capacity through {@link devLevelMul}. Deliberately
   * excluded from snapshot()/restore() — a dev-mode boost never touches the
   * save file, and a loaded colony comes back at level 1.
   */
  level: number;
}

export type { Colonist } from './lifesupport';

export interface HistorySample {
  t: number;
  genKw: number;
  loadKw: number;
  storedFrac: number;
  water: number;
  oxygen: number;
  food: number;
}

export interface FluidFlow {
  produced: number;
  consumed: number;
}

const ARRIVE_EPS = 0.6;

function cargoMass(r: Rover): number {
  let t = 0;
  for (const k of ALL_RESOURCES) t += r.cargo[k];
  return t;
}

function remainingCostTotal(b: Building): number {
  let t = 0;
  for (const k of ALL_RESOURCES) t += b.remainingCost[k];
  return t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Human-readable state for the inspector. */
export function roverStatusText(r: Rover): string {
  if (r.phase === 'disabled') return 'Disabled — out of power';
  if (r.sheltered) return 'Sheltering from storm';
  if (r.routePaused) return 'Route paused — silo full';
  if (r.command.type === 'wait') return `Waiting (${Math.max(0, Math.ceil(r.command.seconds))} s)`;
  switch (r.goal) {
    case 'idle':
      return r.phase === 'charging' ? 'Charging' : 'Idle';
    case 'move':
      return 'Moving';
    case 'mine':
      return r.command.type === 'mine' && r.command.repeat ? 'Hauling route' : 'Mining';
    case 'toDepot':
    case 'unload':
      return 'Hauling to storage';
    case 'toSite':
      return 'Heading to build site';
    case 'build':
      return 'Building';
    case 'toCharge':
      return 'Returning to charge';
    case 'charge':
      return 'Charging';
    case 'toService':
    case 'service':
      return r.command.type === 'repair' ? 'Repairing' : 'Cleaning panels';
    case 'toRecover':
      return 'Responding to stranded rover';
    case 'recover':
      return 'Jump-starting a stranded rover';
    default:
      return r.phase;
  }
}

// ---------------------------------------------------------- simulation ----

export class Simulation {
  world: World;
  version = SAVE_VERSION;
  simTime = 0; // game seconds
  seed: number;
  /** Difficulty preset chosen in the mission wizard. */
  difficulty: DifficultyId = 'pioneer';
  /** Advanced world options chosen in the mission wizard. */
  worldOptions: WorldOptions = { ...DEFAULT_WORLD_OPTIONS };
  /** Multiplier on the colonist's per-sol consumption (difficulty). */
  consumptionMul = 1;
  private nextId = 1000;

  clock = new SolClock();
  alerts = new AlertBus();

  rovers: Rover[] = [];
  buildings: Building[] = [];
  colonist: Colonist;

  /** Bulk solids in colony storage. */
  storage: ResourceAmounts = emptyAmounts();
  /** Life-support fluids. */
  pools: FluidPools = makePools();

  /** Result of the most recent power resolve — read by the HUD. */
  power: PowerResult = idlePower(POD_BATTERY_KWH, POD_BATTERY_KWH * 0.6);
  /** Energy stored in the grid (kWh). Authoritative; `power` mirrors it. */
  storedKWh = POD_BATTERY_KWH * 0.6;

  /** Per-fluid production/consumption over the last tick, in kg per sol. */
  flows: Record<FluidId, FluidFlow> = {
    water: { produced: 0, consumed: 0 },
    oxygen: { produced: 0, consumed: 0 },
    food: { produced: 0, consumed: 0 },
  };

  history: HistorySample[] = [];
  private lastHistoryAt = -Infinity;

  /** Set once the mission has ended, with the reason. */
  gameOver: { reason: string; sol: number } | null = null;

  /**
   * Atmospheric dust transmission, 1 = clear. Driven by the weather system
   * every tick; solar generation, greenhouse light and the renderer all read
   * it (TDD §12's single authoritative environment).
   */
  dustTransmission = BASE_DUST_TRANSMISSION;

  /** Wind, dust and storms (Prototype 3). */
  weather = new Weather(0);
  private stormAnnounced = false;

  constructor(params: {
    seed: number;
    nearDeposits?: number;
    difficulty?: DifficultyId;
    worldHalf?: number;
    region?: string | null;
    worldOptions?: Partial<WorldOptions>;
  }) {
    this.seed = params.seed;
    this.difficulty = params.difficulty ?? 'pioneer';
    this.worldOptions = { ...DEFAULT_WORLD_OPTIONS, ...(params.worldOptions ?? {}) };
    const diff = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pioneer;
    this.consumptionMul = diff.consumptionMul;
    this.world = new World({
      seed: params.seed,
      nearDeposits: params.nearDeposits ?? this.worldOptions.nearDeposits ?? 0.2,
      worldHalf: params.worldHalf,
      region: params.region ?? null,
      richness: richnessMulFor(this.worldOptions.richness),
    });
    this.weather = new Weather(params.seed ^ 0x77e711e);
    this.weather.frequencyMul = diff.stormMul * stormMulFor(this.worldOptions.stormLevel);
    this.weather.damageMul = diff.damageMul;
    this.colonist = makeColonist(
      1,
      'Cmdr. Vega',
      SPAWN_X,
      this.world.heightAt(SPAWN_X, SPAWN_Z),
      SPAWN_Z + 3,
    );
    this.spawnStart();
    this.recomputeCapacities();
    const supplies = diff.suppliesMul * suppliesMulFor(this.worldOptions.supplies);
    this.pools.amounts = {
      water: POD_STARTING_FLUIDS.water * supplies,
      oxygen: POD_STARTING_FLUIDS.oxygen * supplies,
      food: POD_STARTING_FLUIDS.food * supplies,
    };
  }

  // ------------------------------------------------------------ setup ----
  private spawnStart(): void {
    this.spawnRoverAt('mining', SPAWN_X + 9, SPAWN_Z, Math.PI);
    this.spawnRoverAt('utility', SPAWN_X - 9, SPAWN_Z + 4, Math.PI);
  }

  /** Spawn a rover of `kind` at world position. Used at start and by the garage line. */
  private spawnRoverAt(kind: RoverKind, x: number, z: number, heading: number): Rover {
    const def = ROVERS[kind];
    const r: Rover = {
      id: this.allocId(),
      kind,
      label: def.label,
      x,
      y: this.world.heightAt(x, z),
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
      statusText: 'Idle',
      chargeSat: 1,
      autoTask: false,
      condition: 100,
      rules: defaultRoverRules(),
      routePaused: false,
      blockNotified: false,
      sheltered: false,
      lightsOn: true,
      lightsActive: false,
      navPath: [],
      navI: 0,
    };
    this.rovers.push(r);
    return r;
  }

  private allocId(): number {
    return this.nextId++;
  }

  // ------------------------------------------------- derived capacities ----

  /** Recompute bulk + fluid capacity from whatever is online. */
  recomputeCapacities(): void {
    let cap = BASE_STORAGE_PER_RESOURCE;
    const fluid = { ...POD_FLUID_CAPACITY };
    for (const b of this.buildings) {
      if (!this.runnable(b)) continue;
      const def = BUILDINGS[b.kind];
      const mul = devLevelMul(b.level);
      cap += def.storagePerResourceKg * mul;
      if (def.fluidCapacity) {
        for (const f of ALL_FLUIDS) {
          fluid[f] += (def.fluidCapacity[f] ?? 0) * mul;
        }
      }
    }
    this._storageCapacity = cap;
    for (const r of ALL_RESOURCES) {
      if (this.storage[r] > cap) this.storage[r] = cap;
    }
    this.pools.capacity = fluid;
    // Trim anything that no longer fits (a building was destroyed / disabled).
    for (const f of ALL_FLUIDS) {
      if (this.pools.amounts[f] > fluid[f]) this.pools.amounts[f] = fluid[f];
    }
  }

  private _storageCapacity = BASE_STORAGE_PER_RESOURCE;

  /** Capacity **per resource type** (kg). */
  storageCapacity(): number {
    return this._storageCapacity;
  }

  /** Free space for one specific resource (kg). */
  storageRoom(res: ResourceId): number {
    return Math.max(0, this._storageCapacity - this.storage[res]);
  }

  storageTotal(): number {
    let t = 0;
    for (const r of ALL_RESOURCES) t += this.storage[r];
    return t;
  }

  /** Total capacity across every silo — used for the HUD's aggregate bar. */
  storageTotalCapacity(): number {
    return this._storageCapacity * ALL_RESOURCES.length;
  }

  /** True only when *every* silo is full (nothing can be unloaded at all). */
  storageFull(): boolean {
    for (const r of ALL_RESOURCES) {
      if (this.storageRoom(r) > 0.01) return false;
    }
    return true;
  }

  /** Resources whose silo is full — the useful warning. */
  fullResources(): ResourceId[] {
    return ALL_RESOURCES.filter((r) => this.storageRoom(r) <= 0.01);
  }

  /** Total grid battery capacity (kWh), pod included. */
  batteryCapacity(): number {
    let cap = POD_BATTERY_KWH;
    for (const b of this.buildings) {
      if (this.runnable(b) && b.enabled) {
        cap += BUILDINGS[b.kind].batteryKWh * devLevelMul(b.level);
      }
    }
    return cap;
  }

  get sun(): SunState {
    return this.clock.sun;
  }

  // ------------------------------------------------------- UI queries ----
  defsFor(kind: RoverKind) {
    return ROVERS[kind];
  }

  roverById(id: number): Rover | undefined {
    return this.rovers.find((r) => r.id === id);
  }

  buildingById(id: number): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  onlineBuildings(): Building[] {
    return this.buildings.filter((b) => b.state === 'online');
  }

  /**
   * Rovers with nothing to do: no task, no queue, not charging up after a
   * low-battery return, not storm-sheltering, not stranded. The `.` hotkey
   * and the HUD's idle button cycle through these.
   */
  idleRovers(): Rover[] {
    return this.rovers.filter(
      (r) =>
        r.phase !== 'disabled' &&
        !r.recharge &&
        !r.sheltered &&
        r.command.type === 'idle' &&
        r.pending.length === 0,
    );
  }

  onlineWarehouses(): Building[] {
    return this.buildings.filter(
      (b) => this.runnable(b) && BUILDINGS[b.kind].storagePerResourceKg > 0,
    );
  }

  /** Every pressurised volume the colonist could shelter in (pod is id 0). */
  shelters(): Array<{ id: number; x: number; z: number; radius: number; recycles: boolean }> {
    const out = [
      { id: 0, x: SPAWN_X, z: SPAWN_Z, radius: POD_RADIUS, recycles: false },
    ];
    for (const b of this.buildings) {
      if (!this.runnable(b)) continue;
      const def = BUILDINGS[b.kind];
      if (!def.pressurized) continue;
      out.push({
        id: b.id,
        x: b.x,
        z: b.z,
        radius: def.radius,
        recycles: b.kind === 'habitat' && b.enabled,
      });
    }
    return out;
  }

  depositAt(x: number, z: number): { d: Deposit; reach: number } | null {
    let best: Deposit | null = null;
    let bestDist = Infinity;
    for (const d of this.world.deposits) {
      if (d.amount <= 0) continue;
      const dist = Math.hypot(d.x - x, d.z - z);
      if (dist <= d.radius + 3 && dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (!best) return null;
    return { d: best, reach: best.radius + 2.4 };
  }

  buildingAt(x: number, z: number): { b: Building; reach: number } | null {
    let best: Building | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings) {
      const rad = BUILDINGS[b.kind].radius;
      const dist = Math.hypot(b.x - x, b.z - z);
      if (dist <= rad + 4 && dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    if (!best) return null;
    return { b: best, reach: BUILDINGS[best.kind].radius + 3 };
  }

  nearDepot(x: number, z: number): boolean {
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < 14) return true;
    for (const w of this.onlineWarehouses()) {
      if (Math.hypot(w.x - x, w.z - z) < BUILDINGS[w.kind].radius + 5) return true;
    }
    return false;
  }

  /** Somewhere a rover can draw charge: the pod, or any online habitat. */
  nearCharger(x: number, z: number): boolean {
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < POD_RADIUS + 6) return true;
    for (const b of this.buildings) {
      if (!this.runnable(b) || !b.enabled) continue;
      if (!BUILDINGS[b.kind].providesCharge) continue;
      if (Math.hypot(b.x - x, b.z - z) < BUILDINGS[b.kind].radius + 5) return true;
    }
    return false;
  }

  private nearestChargerPoint(x: number, z: number): { x: number; z: number } {
    let best = { x: SPAWN_X, z: SPAWN_Z };
    let bestD = Math.hypot(SPAWN_X - x, SPAWN_Z - z);
    for (const b of this.buildings) {
      if (!this.runnable(b) || !b.enabled) continue;
      if (!BUILDINGS[b.kind].providesCharge) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bestD) {
        bestD = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }

  // --------------------------------------- P4 logistics & wear helpers ----

  /** Energy (kWh) a rover of `def` burns driving between two points. */
  private travelKWh(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    def: { cruiseSpeed: number; movePowerKw: number },
  ): number {
    // Planner heuristic — actual drain is tick-by-tick along the nav path.
    // A* here would re-plan every rover every tick (home-cost + auto-haul).
    return (Math.hypot(x2 - x1, z2 - z1) / def.cruiseSpeed) * def.movePowerKw * HOURS_PER_SEC;
  }

  /** Charger output at a position — garages charge twice as fast (GDD §4). */
  private chargeRateKwAt(x: number, z: number): number {
    for (const b of this.buildings) {
      if (b.kind !== 'garage' || !this.runnable(b) || !b.enabled) continue;
      if (Math.hypot(b.x - x, b.z - z) < BUILDINGS.garage.radius + 5) {
        return GARAGE_CHARGE_RATE_KW * devLevelMul(b.level);
      }
    }
    return ROVER_CHARGE_RATE_KW;
  }

  /**
   * How hard a worn rover can still work, 0.5..1 (GDD §5: rovers fail *soft*).
   * Above `ROVER_CONDITION_SLOW` it's business as usual; at zero condition the
   * drivetrain still turns at half rate — stranded-not-destroyed, always.
   */
  private roverWorkMul(r: Rover): number {
    return 0.5 + 0.5 * clamp(r.condition / ROVER_CONDITION_SLOW, 0, 1);
  }

  /**
   * Claim a deposit for a rover (TDD §8: reservations stop two rovers being
   * scheduled onto one seam). Auto tasks never steal; a player order may bump
   * an auto reservation, cancelling that rover's run so it re-plans.
   */
  private claimDeposit(r: Rover, depositId: number, force = false): void {
    const dep = this.world.deposits.find((d) => d.id === depositId);
    if (!dep) return;
    const holder = dep.reservedBy;
    if (holder == null || holder === r.id) {
      dep.reservedBy = r.id;
      return;
    }
    if (!force) return;
    const other = this.roverById(holder);
    if (other && other.autoTask && other.command.type === 'mine' && other.command.depositId === depositId) {
      this.finishTask(other);
      this.event('info', `${other.label} re-planned — ${r.label} took over that seam.`);
    }
    dep.reservedBy = r.id;
  }

  private releaseDeposit(r: Rover, depositId: number): void {
    const dep = this.world.deposits.find((d) => d.id === depositId);
    if (dep && dep.reservedBy === r.id) dep.reservedBy = null;
  }

  /** Drop everything this rover's active task holds a claim on. */
  private releaseReservations(r: Rover): void {
    if (r.command.type === 'mine') this.releaseDeposit(r, r.command.depositId);
  }

  /** True when some rover is already executing a RECOVER for this one. */
  private rescueTargeted(roverId: number): boolean {
    return this.rovers.some(
      (r) => r.command.type === 'recover' && r.command.roverId === roverId,
    );
  }

  // -------------------------------------------------- player commands ----

  /**
   * Hand a rover a task. A plain order replaces everything the rover was doing
   * (explicit player intent always wins, TDD §8); a *queued* order (Shift) is
   * appended behind the player tasks already on its queue. Ordering over an
   * automatic task always replaces it — automation only ever fills idle time.
   */
  private giveTask(r: Rover, task: RoverTask, queued: boolean): void {
    const busy = r.command.type !== 'idle' || r.pending.length > 0;
    if (queued && busy && !r.autoTask) {
      r.pending.push(task);
      return;
    }
    this.releaseReservations(r);
    r.pending = [];
    r.command = task;
    r.autoTask = false;
    r.recharge = false;
    r.routePaused = false;
    r.blockNotified = false;
  }

  /** The scheduler's counterpart to {@link giveTask} — always replaces. */
  private autoAssign(r: Rover, task: RoverTask): void {
    this.releaseReservations(r);
    r.pending = [];
    r.command = task;
    r.autoTask = true;
    r.routePaused = false;
  }

  /**
   * Complete the active task: release what it held, promote the next queued
   * task (if any), and drop back to idle + automation.
   */
  private finishTask(r: Rover): void {
    if (r.command.type === 'mine') this.releaseDeposit(r, r.command.depositId);
    const next = r.pending.shift();
    if (next) {
      r.command = next;
    } else {
      r.command = { type: 'idle' };
      if (cargoMass(r) <= 0.01) r.autoTask = false;
    }
    r.goal = 'idle';
    r.phase = 'idle';
    r.routePaused = false;
    r.blockNotified = false;
  }

  issueMove(roverId: number, x: number, z: number, queued = false): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    this.giveTask(r, { type: 'moveTo', x, z }, queued);
  }

  issueMine(roverId: number, depositId: number, queued = false): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const dep = this.world.deposits.find((d) => d.id === depositId);
    if (!dep || dep.amount <= 0) {
      this.event('info', 'Deposit is depleted.');
      return;
    }
    this.giveTask(r, { type: 'mine', depositId }, queued);
    // A player order outranks any auto-run holding the seam.
    this.claimDeposit(r, depositId, true);
  }

  /**
   * Drive to the nearest depot and pour out whatever fits (GDD §5 UNLOAD).
   * Queued behind a mining run it closes the loop explicitly; ordered plain
   * it interrupts the rover now. An empty hold is a no-op with a log line.
   */
  issueUnload(roverId: number, queued = false): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    if (!queued && cargoMass(r) <= 0.01) {
      this.event('info', `${r.label}'s hold is already empty.`);
      return;
    }
    this.giveTask(r, { type: 'unload' }, queued);
  }

  /** Hold position for a while (GDD §5 WAIT — usually queued between jobs). */
  issueWait(roverId: number, seconds: number, queued = false): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    this.giveTask(r, { type: 'wait', seconds: Math.max(0, seconds) }, queued);
  }

  issueConstruct(roverId: number, buildingId: number, queued = false): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const b = this.buildingById(buildingId);
    if (!b || b.state === 'online') return;
    if (!BUILDINGS[b.kind].buildableBy.includes(r.kind)) {
      this.event('warn', `${r.label} can't build a ${BUILDINGS[b.kind].label}.`);
      return;
    }
    this.giveTask(r, { type: 'construct', buildingId }, queued);
  }

  stopRover(roverId: number): void {
    const r = this.roverById(roverId);
    if (!r) return;
    this.releaseReservations(r);
    r.command = { type: 'idle' };
    r.pending = [];
    r.recharge = false;
    r.autoTask = false;
    r.goal = 'idle';
    r.phase = 'idle';
    r.routePaused = false;
  }

  /** Convert the active mining task into a repeating haul route (or back). */
  setRepeatRoute(roverId: number, on: boolean): void {
    const r = this.roverById(roverId);
    if (!r) return;
    if (r.command.type !== 'mine') {
      this.event('info', `${r.label} isn't working a seam — select a deposit to route it.`);
      return;
    }
    r.command.repeat = on || undefined;
    // Taking ownership of a route pulls the rover out of the auto pool.
    if (on) r.autoTask = false;
    this.event(
      on ? 'ok' : 'info',
      on
        ? `${r.label} set on a haul route — it will loop the seam until it's dry.`
        : `${r.label}'s haul route ended; this trip finishes the job.`,
    );
  }

  /** Flip one of the player-authored automation rules (GDD §5). */
  setRoverRule(
    roverId: number,
    rule: 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue',
    on: boolean,
  ): void {
    const r = this.roverById(roverId);
    if (!r) return;
    r.rules[rule] = on;
    if (!on && rule === 'autoHaul' && r.autoTask) {
      this.finishTask(r);
    }
    const names: Record<string, string> = {
      autoHaul: 'auto-haul',
      autoService: 'auto-maintenance',
      stormShelter: 'storm sheltering',
      autoRescue: 'auto-rescue',
    };
    this.event('info', `${r.label} ${names[rule]} ${on ? 'enabled' : 'disabled'}.`);
  }

  /** Set the rover's return-to-charge battery floor (percent, 10–60). */
  setChargeFloor(roverId: number, pct: number): void {
    const r = this.roverById(roverId);
    if (!r) return;
    r.rules.chargeFloorPct = Math.max(10, Math.min(60, Math.round(pct)));
  }

  /**
   * Flip the position-lights switch (headlights + rear strobe). When on,
   * the sim lights them automatically at night or in low visibility — and
   * bills the battery for every hour they stay lit.
   */
  setRoverLights(roverId: number, on: boolean): void {
    const r = this.roverById(roverId);
    if (!r || r.lightsOn === on) return;
    r.lightsOn = on;
    this.event(
      'info',
      on
        ? `${r.label} lights armed — they come on at night and in blowing dust.`
        : `${r.label} lights switched off — it will run dark to save power.`,
    );
  }

  /**
   * The sim's one judgement call about visibility: it is dark (sun weaker
   * than the auto threshold) or the dust has closed visibility in. Both
   * inputs are authoritative sim state, so this is deterministic.
   */
  lightsNeeded(): boolean {
    return (
      this.clock.sun.irradiance < LIGHTS_AUTO_IRRADIANCE ||
      this.weather.visibility < LIGHTS_AUTO_VISIBILITY
    );
  }

  /**
   * Light a rover's position lights if the switch is on and they are needed,
   * and pay for them out of the rover's own battery. A disabled rover is
   * skipped by the caller — its yellow emergency strobe costs nothing here.
   * Returns false if the lights drank the last of the battery (stranded).
   */
  private tickRoverLights(r: Rover): boolean {
    r.lightsActive = r.lightsOn && this.lightsNeeded() && r.battery > 0;
    if (!r.lightsActive) return true;
    const hours = SIM_TICK * HOURS_PER_SEC;
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].lightsPowerKw * hours);
    // Sitting out a long night with the lights on can strand a rover too.
    if (r.battery <= 0) {
      this.disable(r);
      return false;
    }
    return true;
  }

  /**
   * Start assembling a rover on a garage's line. Materials leave storage up
   * front; the build itself runs on garage power and pauses in a brownout.
   */
  assembleRover(buildingId: number, kind: RoverKind): boolean {
    const b = this.buildingById(buildingId);
    if (!b || b.kind !== 'garage' || !this.runnable(b) || !b.enabled) {
      this.event('warn', 'Rovers are assembled at an online Rover Garage.');
      return false;
    }
    if (b.assembly) {
      this.event('info', `The garage line is already building a ${ROVERS[b.assembly.kind].label}.`);
      return false;
    }
    const def = ROVERS[kind];
    if (!this.hasMaterials(def.cost)) {
      this.event('warn', `Not enough materials for a ${def.label} — needs ${this.missingList(def.cost)}.`);
      return false;
    }
    this.consumeMaterials(def.cost);
    b.assembly = { kind, progress: 0 };
    this.event(
      'info',
      `${def.label} assembly started — about ${Math.round(def.buildTime)} s on the line.`,
    );
    return true;
  }

  /** Send a rover out to jump-start a stranded one (TDD §8's RECOVER task). */
  issueRecover(roverId: number, strandedId: number, queued = false): boolean {
    const r = this.roverById(roverId);
    const s = this.roverById(strandedId);
    if (!r || r.phase === 'disabled' || !s) return false;
    if (r.id === s.id) return false;
    if (s.phase !== 'disabled') {
      this.event('info', `${s.label} is running fine — no rescue needed.`);
      return false;
    }
    if (this.weather.shelterRovers()) {
      this.event('warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    this.giveTask(r, { type: 'recover', roverId: strandedId }, queued);
    this.event('info', `${r.label} dispatched to jump-start ${s.label}.`);
    return true;
  }

  /** Turn a building on or off (load shedding by hand). */
  setBuildingEnabled(buildingId: number, enabled: boolean): void {
    const b = this.buildingById(buildingId);
    if (!b) return;
    if (b.enabled === enabled) return;
    b.enabled = enabled;
    this.recomputeCapacities();
    this.event(
      enabled ? 'ok' : 'info',
      `${BUILDINGS[b.kind].label} ${enabled ? 'switched on' : 'switched off'}.`,
    );
  }

  demolish(buildingId: number): void {
    const idx = this.buildings.findIndex((b) => b.id === buildingId);
    if (idx < 0) return;
    const b = this.buildings[idx];
    // Return whatever was already delivered to the site back to storage.
    if (b.state !== 'online') {
      const def = BUILDINGS[b.kind];
      let refunded = 0;
      for (const res of ALL_RESOURCES) {
        const committed = def.cost[res] - b.remainingCost[res];
        if (committed <= 0) continue;
        /**
         * Refund the full amount even if it overfills the silo. This material
         * *came out* of that silo, so putting it back can never be an exploit —
         * and quietly destroying a player's resources on cancel is far worse
         * than a temporarily over-full store, which drains as it gets used.
         */
        this.storage[res] += committed;
        refunded += committed;
      }
      this.event(
        'info',
        `${def.label} site cancelled${refunded > 1 ? ` — ${Math.round(refunded)} kg recovered` : ''}.`,
      );
      this.alerts.clear(`mats-${b.id}`, this.simTime, this.clock.format());
    } else {
      this.event('warn', `${BUILDINGS[b.kind].label} dismantled.`);
    }
    for (const r of this.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        this.finishTask(r);
      }
    }
    this.buildings.splice(idx, 1);
    this.recomputeCapacities();
  }

  /**
   * Send a rover to clean a building's exposed surfaces. Fails (with a log
   * line) if there is nothing to clean or the storm makes it unsafe.
   */
  issueClean(roverId: number, buildingId: number, queued = false): boolean {
    const r = this.roverById(roverId);
    const b = this.buildingById(buildingId);
    if (!r || r.phase === 'disabled' || !b || b.state !== 'online') return false;
    if (BUILDINGS[b.kind].generation !== 'solar') {
      this.event('info', `${BUILDINGS[b.kind].label} has no panels to clean.`);
      return false;
    }
    if (b.cleanliness > 0.995) {
      this.event('info', `The ${BUILDINGS[b.kind].label} array is already clean.`);
      return false;
    }
    if (this.weather.shelterRovers()) {
      this.event('warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    this.giveTask(r, { type: 'clean', buildingId }, queued);
    return true;
  }

  /** Send a rover to repair a damaged (or battered) building. */
  issueRepair(roverId: number, buildingId: number, queued = false): boolean {
    const r = this.roverById(roverId);
    const b = this.buildingById(buildingId);
    if (!r || r.phase === 'disabled' || !b) return false;
    if (b.state !== 'online' || b.health >= BUILDING_MAX_HEALTH - 0.5) {
      this.event('info', `${b ? BUILDINGS[b.kind].label : 'That building'} needs no repairs.`);
      return false;
    }
    if (this.weather.shelterRovers()) {
      this.event('warn', 'Too dangerous to work outside — wait for the storm to pass.');
      return false;
    }
    this.giveTask(r, { type: 'repair', buildingId }, queued);
    return true;
  }

  /**
   * Convenience dispatch used by the building inspector: pick the nearest idle
   * rover and send it to service this building (repair first, then clean).
   */
  dispatchMaintenance(buildingId: number): boolean {
    const b = this.buildingById(buildingId);
    if (!b || b.state !== 'online') return false;
    const needsRepair = b.damaged || b.health < BUILDING_MAX_HEALTH - 0.5;
    const needsClean = BUILDINGS[b.kind].generation === 'solar' && b.cleanliness < 0.995;
    if (!needsRepair && !needsClean) return false;
    const crew = this.rovers
      .filter(
        (r) =>
          r.phase !== 'disabled' &&
          !r.recharge &&
          !r.sheltered &&
          r.command.type === 'idle',
      )
      .sort(
        (a, c) =>
          Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z) || a.id - c.id,
      );
    const rover = crew[0];
    if (!rover) {
      this.event('warn', 'No free rover — one has to be idle to dispatch.');
      return false;
    }
    const ok = needsRepair
      ? this.issueRepair(rover.id, b.id)
      : this.issueClean(rover.id, b.id);
    if (ok) {
      const job = needsRepair ? 'repair' : 'clean';
      this.event('info', `${rover.label} dispatched to ${job} the ${BUILDINGS[b.kind].label}.`);
    }
    return ok;
  }

  /**
   * What maintenance a building currently needs, if any — the single source of
   * truth the HUD and the tap-to-order gesture both read.
   */
  needsMaintenance(buildingId: number): 'repair' | 'clean' | null {
    const b = this.buildingById(buildingId);
    if (!b || b.state !== 'online') return null;
    if (b.health < BUILDING_MAX_HEALTH - 0.5) return 'repair';
    if (BUILDINGS[b.kind].generation === 'solar' && b.cleanliness < 0.995) return 'clean';
    return null;
  }

  orderColonist(order: ColonistOrder): void {
    const c = this.colonist;
    if (c.dead) return;
    if (order.type === 'moveTo') {
      /**
       * Refuse an EVA the suit cannot survive. The colonist carries a fixed
       * oxygen reserve, so there is a hard radius beyond which walking out is
       * simply suicide — the sim should say so rather than let the player
       * discover it by killing their only human.
       */
      const from = this.nearestShelter(order.x, order.z);
      const legDist = Math.hypot(order.x - from.x, order.z - from.z);
      const solsOfSuit = c.suitO2 / COLONIST_O2_PER_SOL;
      const reach = solsOfSuit * SOL_SECONDS * COLONIST_SPEED * 0.45;
      if (legDist > reach) {
        this.event(
          'warn',
          `Too far for an EVA — ${c.name}'s suit holds about ${Math.round(reach)} m of round trip.`,
        );
        return;
      }
      // A dust storm is the other hard no: visibility gone, grit in the seals.
      if (this.weather.blocksEVA()) {
        this.event('warn', 'EVA refused — the storm is too severe to go outside.');
        return;
      }
      c.gx = order.x;
      c.gz = order.z;
    }
    c.order = order;
  }

  // -------------------------------------------------------- placement ----
  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    if (!this.world.inBounds(x, z)) return 'Outside the playable region.';
    const def = BUILDINGS[kind];
    if (!this.world.canDrive(x, z)) return 'No safe approach — drop-off or unreachable.';
    const slope = this.world.slopeAt(x, z);
    const maxSlope = def.pressurized ? 0.15 : 0.24;
    if (slope > maxSlope || !this.world.canBuild(x, z)) return 'Terrain too steep here.';
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < def.radius + POD_RADIUS + 1.5)
      return 'Too close to the landing pod.';
    for (const b of this.buildings) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < def.radius + BUILDINGS[b.kind].radius + 1.5)
        return 'Too close to an existing structure.';
    }
    for (const dep of this.world.deposits) {
      if (dep.amount <= 0) continue;
      if (Math.hypot(dep.x - x, dep.z - z) < dep.radius + def.radius + 2)
        return 'Cannot build on a resource deposit.';
    }
    return null;
  }

  placeBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    const err = this.canPlace(kind, x, z);
    if (err) {
      this.event('warn', err);
      return null;
    }
    const def = BUILDINGS[kind];
    const b: Building = {
      id: this.allocId(),
      kind,
      x,
      z,
      rot: 0,
      state: 'site',
      remainingCost: { ...def.cost },
      needsMaterials: false,
      progress: 0,
      buildTime: def.buildTime,
      workerId: null,
      enabled: true,
      powerSat: 1,
      throughput: 0,
      genKw: 0,
      loadKw: 0,
      idleReason: '',
      health: BUILDING_MAX_HEALTH,
      cleanliness: 1,
      damaged: false,
      assembly: null,
      level: 1,
    };
    this.buildings.push(b);
    this.event('info', `${def.label} sited — assigning a builder.`);
    return b;
  }

  // ------------------------------------------------------- developer mode ----
  /**
   * Runtime-only backdoors for the developer panel. They mutate ordinary
   * entity state — a fabricated rover is a real rover from then on — but add
   * nothing to the save file: upgrade levels are never snapshotted, and the
   * panel's own switches live outside the sim entirely.
   */

  /** Fab a rover of `kind` out of thin air at world position. */
  devSpawnRover(kind: RoverKind, x: number, z: number): Rover {
    const r = this.spawnRoverAt(kind, x, z, Math.atan2(SPAWN_X - x, SPAWN_Z - z));
    this.event('ok', `${r.label} #${r.id} rolled out of nowhere — charged and ready (developer).`);
    return r;
  }

  /**
   * Fab a building instantly: placed for free, fully assembled and online.
   * Siting is still honest — the terrain and clearance checks apply, so a
   * bad spot returns null with the reason in the log.
   */
  devSpawnBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    const err = this.canPlace(kind, x, z);
    if (err) {
      this.event('warn', err);
      return null;
    }
    const def = BUILDINGS[kind];
    const b: Building = {
      id: this.allocId(),
      kind,
      x,
      z,
      rot: 0,
      state: 'building',
      remainingCost: emptyAmounts(),
      needsMaterials: false,
      progress: 1,
      buildTime: def.buildTime,
      workerId: null,
      enabled: true,
      powerSat: 1,
      throughput: 0,
      genKw: 0,
      loadKw: 0,
      idleReason: '',
      health: BUILDING_MAX_HEALTH,
      cleanliness: 1,
      damaged: false,
      assembly: null,
      level: 1,
    };
    this.buildings.push(b);
    // completeBuilding flips it online, recomputes capacities and logs the
    // "+storage / +kW" extras exactly like an ordinary finish.
    this.completeBuilding(b);
    return b;
  }

  /** Survey a fresh resource deposit in at world position. */
  devSpawnDeposit(resource: ResourceId, x: number, z: number, amountKg: number): Deposit {
    const d = this.world.addDeposit(resource, x, z, Math.max(10, amountKg));
    this.event(
      'ok',
      `${RESOURCES[resource].label} deposit surveyed in — ${Math.round(d.amount)} kg (developer).`,
    );
    return d;
  }

  /**
   * Complete a construction site instantly, for free. Any rover walking a
   * construct task to it is released exactly like a demolition release.
   */
  devCompleteBuilding(id: number): boolean {
    const b = this.buildingById(id);
    if (!b || b.state === 'online') return false;
    b.remainingCost = emptyAmounts();
    b.needsMaterials = false;
    this.alerts.clear(`mats-${b.id}`, this.simTime, this.clock.format());
    for (const r of this.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        this.finishTask(r);
      }
    }
    b.workerId = null;
    b.progress = 1;
    this.completeBuilding(b);
    return true;
  }

  /**
   * Set a building's developer upgrade level (1..DEV_MAX, clamped). Returns
   * the level it landed on. Never persisted — see the field's comment.
   */
  devSetBuildingLevel(id: number, level: number): number {
    const b = this.buildingById(id);
    if (!b) return 1;
    const next = clamp(Math.round(level), 1, DEV_MAX_BUILDING_LEVEL);
    if (next !== b.level) {
      b.level = next;
      this.recomputeCapacities();
    }
    return b.level;
  }

  /*
   * ---------------------------------------------------------- dev edits ----
   *
   * The writes the developer panel performs, as sim methods rather than field
   * pokes from UI code (TDD §22). They exist for one reason: once the sim can
   * live behind a worker, the panel has no objects to poke, so every edit has
   * to arrive as a command and land here. Keeping the *rules* on this side also
   * means the clamping is the sim's, not a copy in the panel that could drift.
   *
   * None of these are persisted — like the upgrade `level` they touch, they are
   * edits to live state that `snapshot()` deliberately never learns about.
   */

  /** Push the airborne dust reading to `frac`; it relaxes back on its own. */
  devSetDust(frac: number): void {
    this.weather.dust = clamp(frac, 0, 1);
  }

  /** Conjure a storm of `kind`, arriving within seconds. */
  devForceStorm(kind: StormKindReal): void {
    this.weather.debugScheduleStorm(kind, this.simTime, 4);
  }

  /** Dismiss every storm, on the map and on the forecast board. */
  devClearStorms(): void {
    this.weather.debugClearStorms();
  }

  /** Suspend the storm scheduler, or let the rolls run again. */
  devSetStormScheduler(on: boolean): void {
    if (on) this.weather.debugResumeRolls(this.simTime);
    else this.weather.debugSuppressRolls();
  }

  /** Set a rover's charge as a fraction of its pack (0..1). */
  devSetRoverBatteryFrac(roverId: number, frac: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    r.battery = clamp(frac, 0, 1) * ROVERS[r.kind].maxBatteryKWh;
    return true;
  }

  /** Drivetrain condition, 0..100. */
  devSetRoverCondition(roverId: number, pct: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    r.condition = clamp(pct, 0, 100);
    return true;
  }

  /**
   * Set one cargo slot to `kg`, clamped into the hopper's free room. Returns
   * the load that actually landed, so the panel can echo the truth.
   */
  devSetRoverCargo(roverId: number, res: ResourceId, kg: number): number {
    const r = this.roverById(roverId);
    if (!r) return 0;
    let others = 0;
    for (const k of ALL_RESOURCES) if (k !== res) others += r.cargo[k];
    r.cargo[res] = Math.min(Math.max(0, kg), Math.max(0, ROVERS[r.kind].capacityKg - others));
    return r.cargo[res];
  }

  /** Empty the hopper. */
  devClearRoverCargo(roverId: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    for (const k of ALL_RESOURCES) r.cargo[k] = 0;
    return true;
  }

  /**
   * Structural health 0..100, crossing the sim's damage thresholds honestly:
   * dropping to `DAMAGED_HEALTH` takes a structure offline, and only climbing
   * back to `REPAIR_RESTART_HEALTH` restarts it — the same pair of numbers a
   * rover's repair work is judged against.
   */
  devSetBuildingHealth(buildingId: number, pct: number): boolean {
    const b = this.buildingById(buildingId);
    if (!b) return false;
    b.health = clamp(pct, 0, 100);
    if (b.health <= DAMAGED_HEALTH) b.damaged = true;
    else if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) b.damaged = false;
    this.recomputeCapacities();
    return true;
  }

  /** Panel cleanliness 0..1 (meaningful on solar, harmless elsewhere). */
  devSetBuildingCleanliness(buildingId: number, frac: number): boolean {
    const b = this.buildingById(buildingId);
    if (!b) return false;
    b.cleanliness = clamp(frac, 0, 1);
    return true;
  }

  /** Set the damaged flag directly, leaving health alone. */
  devSetBuildingDamaged(buildingId: number, on: boolean): boolean {
    const b = this.buildingById(buildingId);
    if (!b || b.damaged === on) return false;
    b.damaged = on;
    this.recomputeCapacities();
    return true;
  }

  /** The colonist's health, 0..100. A dead crew is not revivable. */
  devSetColonistHealth(pct: number): boolean {
    if (this.colonist.dead) return false;
    this.colonist.health = clamp(pct, 0, 100);
    return true;
  }

  /** Top the suit tank back up. */
  devRefillSuit(): void {
    this.colonist.suitO2 = SUIT_O2_CAPACITY;
  }

  /**
   * Jump the mission calendar: set the sol and the time-of-day fraction
   * (0 = midnight, 0.25 = sunrise, 0.5 = noon). simTime is re-synced so the
   * weather scheduler and history windows stay coherent after the jump.
   */
  devSetTime(sol: number, frac: number): void {
    const target = Math.max(0, Math.floor(sol));
    const f = clamp(frac, 0, 0.9999);
    this.clock.restore({ sol: target, frac: f });
    this.simTime = Math.max(0, (target + f - START_SOL_FRAC) * SOL_SECONDS);
    this.weather.time = this.simTime;
    // History windows are wall-clock comparisons — let them re-anchor at the
    // new time rather than starving until simTime catches back up.
    this.lastHistoryAt = -Infinity;
    this.lastFlows = {
      water: { produced: 0, consumed: 0 },
      oxygen: { produced: 0, consumed: 0 },
      food: { produced: 0, consumed: 0 },
    };
    this.flowWindow = [];
  }

  // -------------------------------------------------------- main loop ----

  /**
   * Delivered-time remainder, always held in [0, SIM_TICK). Each call fires the
   * whole ticks it completes and subtracts *exactly* that much, so the
   * accumulator telescopes: 60 seconds delivered in 3 600 ragged browser
   * frames runs exactly as many ticks as 60 seconds delivered in one call, and
   * the error in the remainder can never compound the way a naive
   * "ticks owed = floor(total / step)" comparison does once `total` grows into
   * the tens of thousands (a restored colony used to drift by one tick against
   * the original for exactly that reason).
   */
  private remainder = 0;
  private ticksRun = 0;

  /** Advance simulation by `frameDt` game seconds (fixed substeps applied). */
  step(frameDt: number): number {
    if (frameDt <= 0 || !Number.isFinite(frameDt)) return 0;
    this.remainder += frameDt;

    // The epsilon absorbs representation error so that a delivery which is
    // mathematically a whole number of ticks always yields that many ticks.
    let owed = Math.floor(this.remainder / SIM_TICK + 1e-9);

    // Bound catch-up so a backgrounded tab can't produce a multi-second freeze.
    const maxTicks = 400;
    if (owed > maxTicks) {
      owed = maxTicks;
      this.remainder = 0; // drop the backlog rather than fast-forwarding time
    } else {
      this.remainder -= owed * SIM_TICK;
    }

    let ticks = 0;
    while (ticks < owed) {
      this.tick();
      this.ticksRun++;
      ticks++;
    }
    return ticks;
  }

  private tick(): void {
    if (this.gameOver) return;

    this.simTime += SIM_TICK;

    // 1. clock & sun
    const newSol = this.clock.advance(SIM_TICK);
    if (newSol) {
      this.event('info', `A new sol begins. Sol ${this.clock.sol + 1}.`);
    }

    // 2. weather (TDD §4's tick order puts it right after the clock)
    this.tickWeather();

    // 3 & 4. power network, then production scaled by what it delivered.
    this.tickPower();
    this.tickGarages();

    // 5. life support & the human
    this.tickLifeSupport();

    // 6/7/8. logistics, jobs, movement, construction
    this.tickSiteLogistics();
    this.assignBuilders();
    this.assignMaintenance();
    this.assignRescues();
    this.assignSupplyRuns();
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      if (!this.tickRoverLights(r)) continue; // the lights drank the last of it
      this.updateRover(r);
    }
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      this.moveRover(r);
    }
    this.tickColonistMovement();

    // 9. failure checks, alerts, history
    this.evaluateAlerts();
    this.recordHistory();
  }

  // ------------------------------------------------------------ weather ----

  /**
   * Advance the weather, then let it work on the colony: solar panels gather
   * dust, wind chews on exposed structures, and storms interrupt work.
   */
  private tickWeather(): void {
    const wx = this.weather;
    wx.tick(SIM_TICK, this.simTime, this.clock.sol);
    this.dustTransmission = wx.solarTransmission;

    // ---- forecast announcements ------------------------------------------
    const fc = wx.forecast();
    if (fc) {
      const mins = Math.max(1, Math.round((fc.arrivesIn / 60)));
      this.alerts.raise(
        'storm-inbound',
        fc.kind === 'severe' || fc.kind === 'planetary' ? 'crit' : 'warn',
        `${stormLabel(fc.kind)} forecast`,
        `Winds arrive in about ${mins} min. Charge batteries, shelter the crews, clean the arrays.`,
        this.simTime,
        this.clock.format(),
      );
    }

    // ---- storm arrival / passing ------------------------------------------
    if (wx.current() && !this.stormAnnounced) {
      this.stormAnnounced = true;
      this.alerts.clear('storm-inbound', this.simTime, this.clock.format());
      const active = wx.current()!;
      const sev: Severity =
        active.kind === 'severe' || active.kind === 'planetary'
          ? 'crit'
          : active.kind === 'devil'
            ? 'info'
            : 'warn';
      this.event(
        sev,
        `${stormLabel(active.kind)} on site — solar output falling, crews recalled.`,
      );
    }
    if (!wx.current() && this.stormAnnounced) {
      this.stormAnnounced = false;
      this.event('ok', 'The storm has passed. Dust is settling; solar recovers as the air clears.');
    }

    // ---- dust settles on the panels ---------------------------------------
    // Ambient dust grinds in slowly; a storm sandblasts the array.
    const sols = SIM_TICK * SOLS_PER_SEC;
    const dirt = wx.dust * PANEL_DIRT_PER_SOL * sols;
    for (const b of this.buildings) {
      if (b.state !== 'online') continue;
      const def = BUILDINGS[b.kind];
      if (def.generation !== 'solar') continue;
      if (b.cleanliness > CLEANLINESS_FLOOR) {
        b.cleanliness = Math.max(CLEANLINESS_FLOOR, b.cleanliness - dirt);
      }
    }

    // ---- wind damage --------------------------------------------------------
    const rate = wx.damageRate();
    if (rate > 0) {
      for (const b of this.buildings) {
        if (b.state !== 'online' || b.damaged) continue;
        const def = BUILDINGS[b.kind];
        const before = b.health;
        b.health = Math.max(0, b.health - rate * def.exposure * SIM_TICK);
        if (b.health <= DAMAGED_HEALTH && before > DAMAGED_HEALTH) {
          this.tripDamaged(b);
        }
      }
    }
  }

  /** Storm damage has tripped a building offline until it is repaired. */
  private tripDamaged(b: Building): void {
    b.damaged = true;
    const def = BUILDINGS[b.kind];
    this.event('crit', `${def.label} damaged by the storm — offline until repaired.`);
    this.recomputeCapacities();
    // Any builder pointed at it can do nothing; release the crew.
    for (const r of this.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        this.finishTask(r);
        b.workerId = null;
      }
    }
  }

  /** Whether a building is online *and* structurally sound enough to run. */
  private runnable(b: Building): boolean {
    return b.state === 'online' && !b.damaged;
  }

  // ------------------------------------------------------------ power ----

  /**
   * Resolve generation, demand and storage for this tick, then run every
   * building's process at whatever fraction of power it actually received.
   */
  private tickPower(): void {
    const hours = SIM_TICK * HOURS_PER_SEC;
    const sun = this.clock.sun;

    // ---- generation -------------------------------------------------------
    let genKw = POD_POWER_KW;
    for (const b of this.buildings) {
      b.genKw = 0;
      if (b.state !== 'online' || !b.enabled || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      if (!def.generation || def.powerProduceKw <= 0) continue;
      /**
       * TDD §11/§12's solar chain: irradiance x atmospheric dust x panel
       * cleanliness. The RTG doesn't care what the sky is doing — that is the
       * point of it.
       */
      const out =
        (def.generation === 'solar'
          ? def.powerProduceKw * sun.irradiance * this.dustTransmission * b.cleanliness
          : def.powerProduceKw) * devLevelMul(b.level);
      b.genKw = out;
      genKw += out;
    }

    // ---- demand -----------------------------------------------------------
    const demands: PowerDemand[] = [];
    // The pod's own scrubbers and heaters are the highest priority load there is.
    demands.push({ id: -1, tier: 0, kw: POD_LIFE_SUPPORT_KW });

    const desired = new Map<number, number>();
    for (const b of this.buildings) {
      b.loadKw = 0;
      b.throughput = 0;
      b.idleReason = '';
      if (b.state !== 'online') {
        b.powerSat = 1;
        continue;
      }
      const def = BUILDINGS[b.kind];
      if (b.damaged) {
        b.powerSat = 1;
        b.idleReason = 'Damaged — needs repair';
        continue;
      }
      if (!b.enabled) {
        b.powerSat = 1;
        b.idleReason = 'Switched off';
        continue;
      }
      // How hard would this building *like* to run, ignoring power?
      const want = this.desiredThroughput(b);
      desired.set(b.id, want);
      const load = def.idlePowerKw + (def.powerDrawKw - def.idlePowerKw) * want;
      if (load > 0) demands.push({ id: b.id, tier: def.tier, kw: load });
    }

    // Rover charging is the lowest-priority load on the grid.
    for (const r of this.rovers) {
      const def = ROVERS[r.kind];
      const wantsCharge =
        r.phase !== 'disabled' &&
        r.battery < def.maxBatteryKWh - 1e-6 &&
        (r.phase === 'charging' || r.goal === 'charge') &&
        this.nearCharger(r.x, r.z);
      if (!wantsCharge) {
        r.chargeSat = 0;
        continue;
      }
      const needKWh = def.maxBatteryKWh - r.battery;
      const kw = Math.min(this.chargeRateKwAt(r.x, r.z), hours > 0 ? needKWh / hours : 0);
      if (kw > 0) demands.push({ id: r.id, tier: ROVER_CHARGE_TIER, kw });
    }

    // ---- resolve ----------------------------------------------------------
    const capacity = this.batteryCapacity();
    this.storedKWh = Math.min(this.storedKWh, capacity);
    const result = resolvePower(genKw, demands, this.storedKWh, capacity, hours);
    this.power = result;
    this.storedKWh = result.storedKWh;

    // ---- apply ------------------------------------------------------------
    for (const b of this.buildings) {
      if (b.state !== 'online' || !b.enabled || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      const sat = result.satisfaction.get(b.id) ?? 1;
      b.powerSat = sat;
      const want = desired.get(b.id) ?? 0;
      const actual = want * sat;
      b.throughput = actual;
      b.loadKw = (def.idlePowerKw + (def.powerDrawKw - def.idlePowerKw) * want) * sat;
      if (def.process) {
        if (actual > 1e-6) this.runProcess(b, actual, hours);
        else if (!b.idleReason) {
          b.idleReason = sat < 0.99 ? 'No power' : this.processBlockReason(b);
        }
      }
    }

    for (const r of this.rovers) {
      const def = ROVERS[r.kind];
      const sat = result.satisfaction.get(r.id);
      if (sat === undefined) continue;
      r.chargeSat = sat;
      const needKWh = def.maxBatteryKWh - r.battery;
      const kw = Math.min(this.chargeRateKwAt(r.x, r.z), hours > 0 ? needKWh / hours : 0);
      r.battery = Math.min(def.maxBatteryKWh, r.battery + kw * sat * hours);
    }
  }

  /**
   * Rover garages (P4): service the drivetrains of anything parked in the bay
   * and advance the assembly line. Both scale with the power the garage
   * actually received — a brownout slows the line to a crawl.
   */
  private tickGarages(): void {
    for (const b of this.buildings) {
      if (b.kind !== 'garage' || !this.runnable(b) || !b.enabled) continue;
      const reach = BUILDINGS.garage.radius + 5;
      const service =
        GARAGE_SERVICE_RATE * devLevelMul(b.level) * SIM_TICK * (0.3 + 0.7 * b.powerSat);
      for (const r of this.rovers) {
        if (r.phase === 'disabled' || r.condition >= 100) continue;
        if (Math.hypot(b.x - r.x, b.z - r.z) <= reach) {
          r.condition = Math.min(100, r.condition + service);
        }
      }
      if (b.assembly) {
        const def = ROVERS[b.assembly.kind];
        b.assembly.progress += (SIM_TICK * b.powerSat) / def.buildTime;
        if (b.assembly.progress >= 1) {
          const kind = b.assembly.kind;
          b.assembly = null;
          // Roll out beside the bay, facing in — deterministic per garage.
          const ang = ((b.id * 2.3999) % (Math.PI * 2)) + this.simTime * 0.05;
          const ox = Math.cos(ang) * (BUILDINGS.garage.radius + 4.5);
          const oz = Math.sin(ang) * (BUILDINGS.garage.radius + 4.5);
          this.spawnRoverAt(kind, b.x + ox, b.z + oz, Math.atan2(-ox, -oz));
          this.event('ok', `${def.label} rolled out of the garage — charged and ready for orders.`);
        }
      }
    }
  }

  /**
   * How hard a process wants to run this tick, 0..1, considering only its
   * inputs and its output headroom — power is applied separately.
   */
  private desiredThroughput(b: Building): number {
    const def = BUILDINGS[b.kind];
    if (!def.process) return def.powerDrawKw > 0 ? 1 : 0;
    const hours = SIM_TICK * HOURS_PER_SEC;
    const p = def.process;
    // An upgraded line moves mul× the mass per hour, so its *want* is gated
    // against the multiplied rates too — the gate and the flow must agree.
    const mul = devLevelMul(b.level);
    let factor = 1;

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const rate = p.solidIn[res];
        if (!rate) continue;
        const need = rate * mul * hours;
        factor = Math.min(factor, need > 0 ? this.storage[res] / need : 1);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidIn[f];
        if (!rate) continue;
        const need = rate * mul * hours;
        factor = Math.min(factor, need > 0 ? this.pools.amounts[f] / need : 1);
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidOut[f];
        if (!rate) continue;
        const make = rate * mul * hours;
        factor = Math.min(factor, make > 0 ? fluidHeadroom(this.pools, f) / make : 1);
      }
    }
    if (p.needsLight) {
      // Crops slow to a crawl in the dark rather than stopping dead — grow
      // lamps keep a trickle going, which is what the power draw is for.
      // The panels' own dust film does not matter here (the crops are inside),
      // but the sky's ambient dust absolutely does.
      const light = 0.15 + 0.85 * clamp(this.clock.sun.irradiance * this.dustTransmission, 0, 1);
      factor = Math.min(factor, light);
    }
    return clamp(factor, 0, 1);
  }

  /** Why a process with power is still not running. */
  private processBlockReason(b: Building): string {
    if (b.damaged) return 'Damaged — needs repair';
    const def = BUILDINGS[b.kind];
    const p = def.process;
    if (!p) return '';
    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        if (p.solidIn[res] && this.storage[res] <= 1e-6) {
          return `Out of ${RESOURCES[res].label}`;
        }
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        if (p.fluidIn[f] && this.pools.amounts[f] <= 1e-6) {
          return `Out of ${FLUIDS[f].label}`;
        }
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        if (p.fluidOut[f] && fluidHeadroom(this.pools, f) <= 1e-6) {
          return `${FLUIDS[f].label} tanks full`;
        }
      }
    }
    if (p.needsLight && this.clock.sun.irradiance < 0.02) return 'Waiting for daylight';
    return 'Idle';
  }

  /** Move mass through a process at `rate` (0..1) for `hours` Mars hours. */
  private runProcess(b: Building, rate: number, hours: number): void {
    const p = BUILDINGS[b.kind].process!;
    const perSol = 1 / (hours <= 0 ? 1 : hours) / (SIM_TICK * SOLS_PER_SEC ? 1 : 1);
    void perSol;

    // A developer-mode upgraded line converts more mass for the same power.
    const mul = devLevelMul(b.level);

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const r = p.solidIn[res];
        if (!r) continue;
        const take = r * mul * rate * hours;
        this.storage[res] = Math.max(0, this.storage[res] - take);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidIn[f];
        if (!r) continue;
        const got = takeFluid(this.pools, f, r * mul * rate * hours);
        this.flows[f].consumed += got;
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidOut[f];
        if (!r) continue;
        const made = addFluid(this.pools, f, r * mul * rate * hours);
        this.flows[f].produced += made;
      }
    }
  }

  // ----------------------------------------------------- life support ----

  private tickLifeSupport(): void {
    // Difficulty appetite: a Survivor crew burns through stores faster.
    const sols = SIM_TICK * SOLS_PER_SEC * this.consumptionMul;
    const c = this.colonist;
    if (c.dead) return;

    // Which shelter (if any) is the colonist inside?
    let inside = false;
    let shelterId = -1;
    let recycles = false;
    for (const s of this.shelters()) {
      if (Math.hypot(s.x - c.x, s.z - c.z) <= s.radius + 1.5) {
        inside = true;
        shelterId = s.id;
        recycles = s.recycles;
        break;
      }
    }
    const wasInside = c.inside;
    c.inside = inside;
    c.shelterId = inside ? shelterId : -1;
    if (wasInside && !inside) {
      this.event('info', `${c.name} has gone EVA. Suit O₂ reserve: ${(c.suitO2 * 60 / COLONIST_O2_PER_SOL / 24.66).toFixed(0)} min.`);
    } else if (!wasInside && inside) {
      this.event('ok', `${c.name} is back inside and repressurised.`);
    }

    const before = { ...this.pools.amounts };
    const outcome = applyColonistNeeds(c, this.pools, sols, recycles);
    void before;

    this.flows.oxygen.consumed += COLONIST_O2_PER_SOL * sols * outcome.met.oxygen;
    this.flows.water.consumed += COLONIST_WATER_PER_SOL * sols * outcome.met.water;
    this.flows.food.consumed += COLONIST_FOOD_PER_SOL * sols * outcome.met.food;
    this.flows.water.produced += outcome.reclaimed;

    if (c.dead && !this.gameOver) {
      this.endMission(`${c.name} did not survive.`);
    }
  }

  private endMission(reason: string): void {
    this.gameOver = { reason, sol: this.clock.sol + 1 };
    this.alerts.raise(
      'mission-over',
      'crit',
      'Mission lost',
      reason,
      this.simTime,
      this.clock.format(),
    );
  }

  // --------------------------------------------------- colonist motion ----

  private tickColonistMovement(): void {
    const c = this.colonist;
    if (c.dead) {
      c.activity = 'incapacitated';
      return;
    }

    // Out of suit oxygen? Override any order and run for the nearest airlock.
    const suitCritical = !c.inside && c.suitO2 <= SUIT_O2_CAPACITY * 0.25;
    if (suitCritical && c.order.type !== 'shelter') {
      c.order = { type: 'shelter' };
      this.event('crit', `${c.name}'s suit reserve is critical — aborting EVA.`);
    }

    // A storm rolling in does the same: nobody is outside in a severe storm.
    if (!c.inside && this.weather.blocksEVA() && c.order.type !== 'shelter') {
      c.order = { type: 'shelter' };
      this.event('crit', `${c.name} recalled — the storm is too severe to stay outside.`);
    }

    let tx = c.x;
    let tz = c.z;
    let arriveActivity: Colonist['activity'] = 'sheltered';

    switch (c.order.type) {
      case 'shelter': {
        const s = this.nearestShelter(c.x, c.z);
        tx = s.x;
        tz = s.z;
        arriveActivity = 'sheltered';
        break;
      }
      case 'moveTo':
        tx = c.order.x;
        tz = c.order.z;
        // Standing at the destination is a valid state: the colonist waits
        // there (on suit reserves) until told otherwise or the suit forces an
        // abort. Silently drifting home would make EVA orders feel ignored.
        arriveActivity = 'walking';
        break;
      case 'assist': {
        const b = this.buildingById(c.order.buildingId);
        if (!b || b.state === 'online') {
          c.order = { type: 'shelter' };
          return;
        }
        tx = b.x;
        tz = b.z;
        arriveActivity = 'assisting';
        break;
      }
    }

    const dx = tx - c.x;
    const dz = tz - c.z;
    const dist = Math.hypot(dx, dz);
    const arriveAt =
      c.order.type === 'assist'
        ? BUILDINGS[
            this.buildingById((c.order as { buildingId: number }).buildingId)?.kind ?? 'habitat'
          ].radius + 3
        : c.order.type === 'shelter'
          ? 1.5
          : ARRIVE_EPS;

    if (dist > arriveAt) {
      const stepLen = COLONIST_SPEED * SIM_TICK;
      const ux = dx / dist;
      const uz = dz / dist;
      c.x += ux * Math.min(stepLen, dist);
      c.z += uz * Math.min(stepLen, dist);
      c.heading = lerpAngle(c.heading, Math.atan2(ux, uz), 0.2);
      c.activity = c.order.type === 'shelter' ? 'returning' : 'walking';
    } else {
      c.activity = arriveActivity;
      // Assisting the build crew: a real, if modest, contribution.
      if (c.order.type === 'assist') {
        const b = this.buildingById(c.order.buildingId);
        if (b && b.state === 'building' && remainingCostTotal(b) <= 0) {
          b.progress = Math.min(
            1,
            b.progress + (COLONIST_BUILD_POWER * SIM_TICK) / b.buildTime,
          );
          if (b.progress >= 1) this.completeBuilding(b);
        }
      }
    }
    c.y = this.world.heightAt(c.x, c.z);
  }

  private nearestShelter(x: number, z: number): { x: number; z: number } {
    const list = this.shelters();
    let best = list[0];
    let bestD = Infinity;
    for (const s of list) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return { x: best.x, z: best.z };
  }

  // -------------------------------------------------- task assignment ----

  /**
   * Materials flow from storage into construction sites on their own, without
   * a rover standing there (TDD §7's "Materials Reserved" stage).
   *
   * Decoupling delivery from assembly is what makes the build queue feel alive:
   * a site quietly accumulates the regolith it needs while a rover is still off
   * fetching iron, and a builder is only ever dispatched to a site that is
   * fully stocked. Without this split the builder ping-pongs — dispatched,
   * partially stocked, stalled, released, dispatched again.
   *
   * Older sites are served first so the queue drains in the order the player
   * placed it, rather than starving the first thing they asked for.
   */
  private tickSiteLogistics(): void {
    for (const b of this.buildings) {
      if (b.state === 'online') continue;
      if (remainingCostTotal(b) <= 0) {
        b.needsMaterials = false;
        continue;
      }
      const took = this.commitAvailableMaterials(b);
      if (took > 0 && b.state === 'site') {
        this.event('info', `Materials delivered to the ${BUILDINGS[b.kind].label} site.`);
      }
      const left = remainingCostTotal(b);
      b.needsMaterials = left > 0;
      if (left > 0) {
        this.alerts.raise(
          `mats-${b.id}`,
          'warn',
          `${BUILDINGS[b.kind].label} awaiting materials`,
          `Still needs ${this.missingList(b.remainingCost)}.`,
          this.simTime,
          this.clock.format(),
          b.id,
        );
      } else {
        this.alerts.clear(`mats-${b.id}`, this.simTime, this.clock.format());
        this.event('ok', `${BUILDINGS[b.kind].label} site fully stocked — ready to assemble.`);
      }
    }
  }

  /** True if any of this rover's cargo would currently fit in storage. */
  private canDeliverAny(r: Rover): boolean {
    for (const res of ALL_RESOURCES) {
      if (r.cargo[res] > 0.01 && this.storageRoom(res) > 0.01) return true;
    }
    return false;
  }

  private assignBuilders(): void {
    const sites = this.buildings.filter((b) => b.state !== 'online');
    for (const b of sites) {
      if (b.workerId !== null) {
        // Release a worker that wandered off (recharging, reassigned, etc).
        const w = this.roverById(b.workerId);
        if (
          !w ||
          w.phase === 'disabled' ||
          !(w.command.type === 'construct' && w.command.buildingId === b.id)
        ) {
          b.workerId = null;
        } else {
          continue;
        }
      }
      // Only fully-stocked sites get a builder; delivery is someone else's job.
      if (remainingCostTotal(b) > 0) continue;

      const capable = this.rovers
        .filter(
          (r) =>
            r.phase !== 'disabled' &&
            !r.recharge &&
            // Construction outranks an automatic supply run, never a player order.
            (r.command.type === 'idle' || r.autoTask) &&
            /**
             * Don't pull a rover off a delivery it can still complete — but a
             * rover sitting on cargo the silos have no room for is *stuck*, not
             * busy, and must stay eligible for work. Otherwise a full silo
             * quietly disqualifies the whole fleet and construction deadlocks.
             */
            (cargoMass(r) <= 0.01 || !this.canDeliverAny(r)) &&
            BUILDINGS[b.kind].buildableBy.includes(r.kind),
        )
        .sort(
          (a, c) =>
            Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z) ||
            a.id - c.id,
        );
      const worker = capable[0];
      if (!worker) continue;
      this.autoAssign(worker, { type: 'construct', buildingId: b.id });
      b.workerId = worker.id;
    }
  }

  /**
   * Automation: an idle rover with nothing better to do goes and fetches what
   * the stalled construction queue is actually short of.
   *
   * This is the GDD's automation pillar in its smallest honest form — the
   * player stops being a dispatcher for routine hauling and starts being a
   * systems architect. Explicit player orders always win; this only ever fills
   * genuine idle time.
   */
  private assignSupplyRuns(): void {
    let idle = this.rovers.filter(
      (r) => r.phase !== 'disabled' && !r.recharge && r.command.type === 'idle',
    );
    if (idle.length === 0) return;

    /**
     * TDD §8 puts construction above production logistics. If a site is
     * waiting on a builder and could actually make progress, hold one capable
     * rover back — otherwise a standing haul order (ice, typically) keeps every
     * rover permanently on the road and nothing ever gets built.
     */
    const waitingSite = this.buildings.find(
      (b) => b.state !== 'online' && b.workerId === null && remainingCostTotal(b) <= 0,
    );
    if (waitingSite) {
      const reserved = idle.find(
        (r) =>
          BUILDINGS[waitingSite.kind].buildableBy.includes(r.kind) &&
          (cargoMass(r) <= 0.01 || !this.canDeliverAny(r)),
      );
      if (reserved) idle = idle.filter((r) => r !== reserved);
      if (idle.length === 0) return;
    }

    /**
     * Same idea, storm edition: a damaged structure or a buried solar array
     * outranks a routine haul. Hold one rover back so assignMaintenance has
     * someone to send, instead of the fleet grinding every panel into the
     * dirt while it chases ice.
     */
    if (this.maintenancePending()) {
      idle = idle.slice(1);
      if (idle.length === 0) return;
    }

    // What is the build queue short of, in priority order?
    const shortfall = emptyAmounts();
    for (const b of this.buildings) {
      if (b.state === 'online') continue;
      for (const res of ALL_RESOURCES) {
        const need = b.remainingCost[res] - this.storage[res];
        if (need > 0) shortfall[res] += need;
      }
    }
    /**
     * Ice is a standing order, not a build cost. The extractor burns it
     * continuously, so the colony wants a buffer on hand at all times — and it
     * wants one *before* the extractor exists, so that the moment it comes
     * online there is something to feed it. Weighted by how thin the water
     * reserve actually is.
     */
    const wantsIce =
      this.buildings.some((b) => b.kind === 'extractor') ||
      this.pools.amounts.water < this.pools.capacity.water * 0.5;
    if (wantsIce) {
      const target = this.storageCapacity() * 0.6;
      if (this.storage.ice < target) {
        const urgency =
          this.pools.capacity.water > 0
            ? 1 + 3 * (1 - clamp(this.pools.amounts.water / this.pools.capacity.water, 0, 1))
            : 1;
        shortfall.ice += (target - this.storage.ice) * urgency;
      }
    }

    const wanted = ALL_RESOURCES.filter(
      (r) => shortfall[r] > 1 && this.storageRoom(r) > 1,
    ).sort((a, b) => shortfall[b] - shortfall[a]);

    if (wanted.length === 0) return;

    for (const rover of idle) {
      // Only send rovers that can carry a useful load.
      if (!rover.rules.autoHaul) continue;
      let picked: Deposit | null = null;
      let pickedRes: ResourceId | null = null;
      let bestScore = Infinity;
      // Fallback: a seam another auto-rover is already working. Reservations
      // steer the fleet apart; they must never idle a capable rover — sharing
      // a seam is always physically possible.
      let shared: Deposit | null = null;
      let sharedRes: ResourceId | null = null;
      let sharedScore = Infinity;
      for (const res of wanted) {
        for (const d of this.world.deposits) {
          if (d.resource !== res || d.amount <= 0) continue;
          // Prefer close deposits, and rate the scarcest resource highest.
          const dist = Math.hypot(d.x - rover.x, d.z - rover.z);
          const score = dist / (1 + shortfall[res] / 100);
          // TDD §8 reservations: prefer a seam nobody else is working — but
          // only a worked-out scrap heap is *held* against a second rover; a
          // rich seam can host whoever's nearby.
          const held =
            d.reservedBy != null &&
            d.reservedBy !== rover.id &&
            d.amount <= ROVERS[rover.kind].capacityKg * 2.5;
          if (held) {
            if (score < sharedScore) {
              sharedScore = score;
              shared = d;
              sharedRes = res;
            }
          } else if (score < bestScore) {
            bestScore = score;
            picked = d;
            pickedRes = res;
          }
        }
      }
      /**
       * Can this rover physically get there, dig a worthwhile load, *and get
       * home*? A naive range heuristic (battery x constant) happily dispatched
       * both rovers to a seam beyond round-trip range and stranded the entire
       * fleet — found by the weather suite. Energy maths instead of vibes:
       * travel is (2d/speed) seconds of move power, and the low-battery
       * reserve that aborts the dig must still cover the ride home.
       */
      const rd = ROVERS[rover.kind];
      const canMakeRun = (dep: Deposit, res: ResourceId): boolean => {
        const oneWayKWh = this.travelKWh(rover.x, rover.z, dep.x, dep.z, rd);
        const roundTripKWh = oneWayKWh * 2;
        const loadTimeS = 60 / (RESOURCES[res].mineRateKg * rd.mineSpeedMul);
        const digKWh = rd.workPowerKw * HOURS_PER_SEC * loadTimeS;
        // The reserve must cover the ride home from the deposit, whichever of
        // the fixed floor or the dynamic floor is higher.
        const reserveKWh = Math.max(
          rd.maxBatteryKWh * (rover.rules.chargeFloorPct / 100),
          oneWayKWh * 1.15,
        );
        return roundTripKWh + digKWh <= rover.battery - reserveKWh;
      };
      // Prefer an unclaimed seam; if that one is out of energy range, a
      // shared seam beats idling the rover.
      let target: Deposit | null = null;
      let targetRes: ResourceId | null = null;
      if (picked && pickedRes && !canMakeRun(picked, pickedRes)) {
        picked = null;
        pickedRes = null;
      }
      if (picked && pickedRes) {
        target = picked;
        targetRes = pickedRes;
      } else if (shared && sharedRes && canMakeRun(shared, sharedRes)) {
        target = shared;
        targetRes = sharedRes;
      }
      if (!target || !targetRes) continue;
      this.autoAssign(rover, { type: 'mine', depositId: target.id });
      this.claimDeposit(rover, target.id);
      shortfall[targetRes] -= rd.capacityKg;
      if (shortfall[targetRes] <= 1) {
        const i = wanted.indexOf(targetRes);
        if (i >= 0) wanted.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------ rover logic ----
  private updateRover(r: Rover): void {
    const def = ROVERS[r.kind];

    // ---- storm recall (TDD §8: "IF storm warning → return to shelter") ----
    // The rover's own command is preserved underneath; when the storm passes
    // it simply picks the job back up. The player may turn the rule off — a
    // daredevil rover keeps working at storm rate and pays for it in wear.
    const storm = this.weather.shelterRovers();
    const mustShelter = r.rules.stormShelter && storm && !this.nearCharger(r.x, r.z);
    if (mustShelter && !r.sheltered) {
      r.sheltered = true;
      this.event('warn', `${r.label} is running for shelter — the storm is on it.`);
    } else if (!storm && r.sheltered) {
      r.sheltered = false;
      r.recharge = false; // release the shelter-charge and resume the job
    }
    if (r.sheltered) {
      r.recharge = true; // reuse the return-to-charge behaviour as the recall path
      this.doRecharge(r);
      return;
    }

    // ---- grit in the actuator seals ---------------------------------------
    // Anyone outside in a blowing storm — daredevils with the shelter rule
    // off, or rovers caught in transit — grinds condition away.
    if (this.weather.stormIntensity > 0.4 && !this.nearCharger(r.x, r.z)) {
      r.condition = Math.max(
        0,
        r.condition - ROVER_WEAR_STORM_S * this.weather.stormIntensity * SIM_TICK,
      );
    }

    /**
     * The low-battery floor is not a fixed fraction for field work: a rover
     * far from base must turn around while it still holds the power to get
     * home. A fixed 20 % reserve is 16 kWh on a mining rover — but the ride
     * back from a distant seam can cost 19, which is how rovers used to dig
     * themselves into stranded, battery-flat graves. The player chooses the
     * fraction (GDD §5's first automation rule); the ride-home maths clamps
     * it from below. An *idle* rover below its floor heads in too — the rule
     * is about the battery, not the to-do list.
     */
    const floorPct = r.rules.chargeFloorPct / 100;
    const homePt = this.nearestChargerPoint(r.x, r.z);
    const homeCost = this.travelKWh(r.x, r.z, homePt.x, homePt.z, def) * 1.15;
    const floor = Math.max(
      def.maxBatteryKWh * floorPct,
      Math.min(homeCost, def.maxBatteryKWh * 0.9),
    );
    const idle = r.command.type === 'idle' && r.pending.length === 0;
    if (!r.recharge && (!idle || r.battery <= floor)) {
      const low = r.battery <= floor && r.goal !== 'charge' && r.goal !== 'toCharge';
      if (low) {
        r.recharge = true;
        if (!r.lowBatteryNotified) {
          r.lowBatteryNotified = true;
          this.event('warn', `${r.label} is low on power — returning to charge.`);
        }
      } else if (r.battery > def.maxBatteryKWh * (floorPct + 0.25)) {
        r.lowBatteryNotified = false;
      }
    }

    if (r.recharge) {
      this.doRecharge(r);
      return;
    }

    const cmd = r.command;
    switch (cmd.type) {
      case 'idle':
        this.goIdle(r);
        break;
      case 'moveTo':
        this.doMoveTo(r, cmd.x, cmd.z);
        break;
      case 'mine': {
        const dep = this.world.deposits.find((d) => d.id === cmd.depositId);
        if (!dep || dep.amount <= 0) {
          if (cargoMass(r) > 0.01) {
            this.beginUnload(r);
          } else {
            this.finishTask(r);
            this.event('info', `${r.label}: deposit exhausted.`);
          }
          break;
        }
        this.doMine(r, dep);
        break;
      }
      case 'construct': {
        const b = this.buildingById(cmd.buildingId);
        if (!b || b.state === 'online') {
          if (b) b.workerId = null;
          this.finishTask(r);
          break;
        }
        this.doBuild(r, b);
        break;
      }
      case 'clean':
      case 'repair': {
        const b = this.buildingById(cmd.buildingId);
        if (!b || b.state !== 'online') {
          this.finishTask(r);
          break;
        }
        this.doService(r, b, cmd.type);
        break;
      }
      case 'recover': {
        this.doRecover(r, cmd);
        break;
      }
      case 'unload': {
        this.doUnload(r);
        break;
      }
      case 'wait': {
        r.goal = 'idle';
        r.phase = 'idle';
        r.statusText = roverStatusText(r);
        cmd.seconds -= SIM_TICK;
        if (cmd.seconds <= 0) this.finishTask(r);
        break;
      }
    }
  }

  private doMoveTo(r: Rover, x: number, z: number): void {
    const dist = Math.hypot(x - r.x, z - r.z);
    if (dist > ARRIVE_EPS) {
      if (r.goal !== 'move' || r.phase !== 'moving') this.setTravel(r, x, z, 'move');
    } else {
      this.finishTask(r);
      r.statusText = 'Idle';
    }
  }

  private goIdle(r: Rover): void {
    r.goal = 'idle';
    r.phase = 'idle';
    r.statusText = 'Idle';

    if (cargoMass(r) <= 0.01) {
      r.autoTask = false;
    }

    // Holding cargo the silos had no room for? Keep offering it — construction
    // and processing free up space continuously, so mass is never stranded.
    if (cargoMass(r) > 0.01 && this.canDeliverAny(r)) {
      if (this.nearDepot(r.x, r.z)) {
        for (const res of ALL_RESOURCES) {
          if (r.cargo[res] <= 0) continue;
          const room = this.storageRoom(res);
          if (room <= 0.01) continue;
          const take = Math.min(r.cargo[res], room);
          r.cargo[res] -= take;
          this.storage[res] += take;
        }
      } else {
        this.beginUnload(r);
        return;
      }
    }
    // Parked at a charger, an idle rover tops itself up (grid permitting —
    // the actual energy transfer happens in tickPower).
    if (this.nearCharger(r.x, r.z) && r.battery < ROVERS[r.kind].maxBatteryKWh - 1e-6) {
      r.phase = 'charging';
      r.statusText = 'Charging';
    }
  }

  private doRecharge(r: Rover): void {
    const def = ROVERS[r.kind];
    // A rover that limps home with a full hold empties it while it charges:
    // every charger sits on a depot, so there is no detour involved. Whatever
    // the silos have room for goes in now; whatever doesn't rides back out.
    this.unloadWhileCharging(r);
    if (r.battery >= def.maxBatteryKWh * 0.98 && !r.sheltered) {
      r.recharge = false;
      r.phase = 'idle';
      r.goal = 'idle';
      return;
    }
    if (r.sheltered && this.nearCharger(r.x, r.z)) {
      // Storm shelter: parked and plugged in until the sky clears, however
      // full the battery is.
      r.goal = 'charge';
      r.phase = 'charging';
      r.statusText = 'Sheltering from storm';
      return;
    }
    if (this.nearCharger(r.x, r.z)) {
      r.goal = 'charge';
      r.phase = 'charging';
      r.statusText = 'Charging';
    } else if (r.goal !== 'toCharge') {
      const pt = this.nearestChargerPoint(r.x, r.z);
      this.setTravel(r, pt.x, pt.z, 'toCharge');
    }
  }

  /**
   * Pour whatever fits out of a recharging rover's hold. Runs every tick the
   * rover spends heading in or plugged in, so cargo that arrives while the
   * silo is full still drains away the moment consumption frees some room —
   * the rover always rolls back out to its job as empty as the colony allows.
   */
  private unloadWhileCharging(r: Rover): void {
    if (cargoMass(r) <= 0.01 || !this.nearDepot(r.x, r.z)) return;
    let moved = 0;
    let blocked = false;
    for (const res of ALL_RESOURCES) {
      if (r.cargo[res] <= 0) continue;
      const room = this.storageRoom(res);
      if (room <= 0.01) {
        blocked = true;
        continue;
      }
      const take = Math.min(r.cargo[res], room);
      r.cargo[res] -= take;
      this.storage[res] += take;
      moved += take;
    }
    if (moved > 0.01) {
      this.event('ok', `${r.label} delivered ${Math.round(moved)} kg to storage.`);
      r.blockNotified = false;
    }
    if (blocked && cargoMass(r) > 0.01 && !r.blockNotified) {
      this.event('warn', `${r.label} still holds cargo — those silos are full.`);
      r.blockNotified = true;
    }
  }

  private setTravel(r: Rover, tx: number, tz: number, goal: RoverGoal): void {
    // Keep an in-flight path: callers (beginUnload, doMine) used to rewrite
    // gx/gz every tick, which was fine for a straight line and fatal once
    // the first A* waypoint is the current cell centre.
    if (
      r.phase === 'moving' &&
      r.goal === goal &&
      r.navPath.length > 0 &&
      Math.hypot((r.navPath[r.navPath.length - 1]?.x ?? tx) - tx, (r.navPath[r.navPath.length - 1]?.z ?? tz) - tz) < 2
    ) {
      return;
    }
    r.goal = goal;
    r.phase = 'moving';
    r.navPath = this.world.findPath(r.x, r.z, tx, tz) ?? [{ x: tx, z: tz }];
    r.navI = 0;
    const last = r.navPath[r.navPath.length - 1] ?? { x: tx, z: tz };
    r.gx = last.x;
    r.gz = last.z;
    r.statusText = roverStatusText(r);
  }

  private moveRover(r: Rover): void {
    if (r.phase !== 'moving' || r.goal === 'idle') return;
    const def = ROVERS[r.kind];
    const hours = SIM_TICK * HOURS_PER_SEC;
    const dest = r.navPath[r.navI] ?? { x: r.gx, z: r.gz };
    const dx = dest.x - r.x;
    const dz = dest.z - r.z;
    const dist = Math.hypot(dx, dz);
    const step = def.cruiseSpeed * SIM_TICK;
    if (dist <= step + ARRIVE_EPS) {
      r.x = dest.x;
      r.z = dest.z;
      if (r.navI + 1 < r.navPath.length) {
        r.navI++;
        r.y = this.world.heightAt(r.x, r.z);
        return;
      }
      r.x = r.gx;
      r.z = r.gz;
      r.phase = 'working';
      this.onArrive(r);
      return;
    }
    const ux = dx / dist;
    const uz = dz / dist;
    r.x += ux * step;
    r.z += uz * step;
    r.heading = lerpAngle(r.heading, Math.atan2(ux, uz), 0.18);
    r.y = this.world.heightAt(r.x, r.z);
    r.battery = Math.max(0, r.battery - def.movePowerKw * hours);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_MOVE_S * SIM_TICK);
    if (r.battery <= 0) this.disable(r);
  }

  private onArrive(r: Rover): void {
    r.y = this.world.heightAt(r.x, r.z);
    switch (r.goal) {
      case 'toCharge':
        r.goal = 'charge';
        r.phase = 'charging';
        break;
      case 'toSite': {
        const b = this.buildingById(r.gid);
        if (b) {
          r.goal = 'build';
          r.phase = 'working';
        } else r.goal = 'idle';
        break;
      }
      case 'toService':
        r.goal = 'service';
        r.phase = 'working';
        break;
      case 'toDepot':
        this.tryUnload(r);
        break;
      case 'move': {
        if (r.command.type === 'moveTo') r.command = { type: 'idle' };
        r.goal = 'idle';
        r.phase = 'idle';
        break;
      }
      default:
        r.goal = 'idle';
        r.phase = 'idle';
    }
    r.statusText = roverStatusText(r);
  }

  private disable(r: Rover): void {
    r.phase = 'disabled';
    r.goal = 'idle';
    r.routePaused = false;
    r.lightsActive = false; // nothing left to power them; the yellow strobe takes over
    r.statusText = 'Disabled — out of power';
    this.releaseReservations(r);
    this.event('crit', `${r.label} is stranded — battery flat. Another rover can jump-start it.`);
  }

  // ------------------------------------------------------------ mining ----
  private doMine(r: Rover, dep: Deposit): void {
    const def = ROVERS[r.kind];
    const hours = SIM_TICK * HOURS_PER_SEC;
    const onRoute = r.command.type === 'mine' && !!r.command.repeat;

    /**
     * A haul route parks at the depot while the silo has no room for its
     * cargo, and sets out again the moment consumption frees some up. Without
     * this a full silo turns the route into a depot ping-pong.
     */
    const stuck = cargoMass(r) > 0.01 ? !this.canDeliverAny(r) : this.storageRoom(dep.resource) < ROUTE_RESUME_ROOM_KG;
    if (onRoute && stuck) {
      r.goal = 'idle';
      r.phase = 'idle';
      r.routePaused = true;
      r.statusText = roverStatusText(r);
      return;
    }
    r.routePaused = false;

    /**
     * Stop when the load is worth hauling home. For an automatic run that
     * means "as much as the colony can actually accept" — a 1.5 t rover should
     * not sit at a rock filling up when the silo can only take 150 kg.
     */
    const autoTarget = r.autoTask
      ? Math.max(60, Math.min(def.capacityKg, this.storageRoom(dep.resource)))
      : def.capacityKg;
    if (cargoMass(r) >= Math.min(def.capacityKg, autoTarget) - 1e-6) {
      this.beginUnload(r);
      return;
    }
    const reach = dep.radius + 2.6;
    const dist = Math.hypot(dep.x - r.x, dep.z - r.z);
    if (dist > reach) {
      if (r.goal !== 'mine' || r.phase !== 'moving') this.setTravel(r, dep.x, dep.z, 'mine');
      return;
    }
    this.claimDeposit(r, dep.id);
    r.goal = 'mine';
    r.phase = 'working';
    r.statusText = onRoute ? 'Hauling route' : 'Mining';
    const rate =
      RESOURCES[dep.resource].mineRateKg *
      def.mineSpeedMul *
      this.weather.workMultiplier() *
      this.roverWorkMul(r);
    const gained = Math.min(rate * SIM_TICK, dep.amount, def.capacityKg - cargoMass(r));
    if (gained > 0) {
      dep.amount -= gained;
      r.cargo[dep.resource] += gained;
    }
    r.battery = Math.max(0, r.battery - def.workPowerKw * hours);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * SIM_TICK);
    if (r.battery <= 0) this.disable(r);
    if (dep.amount <= 0.01) {
      this.event('info', `${RESOURCES[dep.resource].label} deposit exhausted.`);
    }
  }

  private beginUnload(r: Rover): void {
    let best = { x: SPAWN_X, z: SPAWN_Z };
    let bestD = Math.hypot(SPAWN_X - r.x, SPAWN_Z - r.z);
    for (const w of this.onlineWarehouses()) {
      const d = Math.hypot(w.x - r.x, w.z - r.z);
      if (d < bestD) {
        bestD = d;
        best = { x: w.x, z: w.z };
      }
    }
    this.setTravel(r, best.x, best.z, 'toDepot');
  }

  private tryUnload(r: Rover): void {
    if (!this.nearDepot(r.x, r.z)) {
      this.setTravel(r, SPAWN_X, SPAWN_Z, 'toDepot');
      return;
    }
    let moved = 0;
    let blocked = false;
    for (const res of ALL_RESOURCES) {
      if (r.cargo[res] <= 0) continue;
      const room = this.storageRoom(res);
      if (room <= 0.01) {
        blocked = true;
        continue;
      }
      const take = Math.min(r.cargo[res], room);
      r.cargo[res] -= take;
      this.storage[res] += take;
      moved += take;
    }
    if (moved > 0.01) {
      this.event('ok', `${r.label} delivered ${Math.round(moved)} kg to storage.`);
      r.blockNotified = false;
    }
    if (blocked && cargoMass(r) > 0.01 && !r.blockNotified) {
      this.event('warn', `${r.label} still holds cargo — those silos are full.`);
      r.blockNotified = true;
    }
    const cmd = r.command;
    if (cmd.type === 'mine') {
      const dep = this.world.deposits.find((d) => d.id === cmd.depositId);
      const seamDry = !dep || dep.amount <= 0.01;
      if (cmd.repeat && !seamDry) {
        // The route loops: straight back out to the seam (or, if the silo is
        // full, doMine parks the rover here until there is room again).
        r.goal = 'idle';
        r.phase = 'idle';
        r.statusText = roverStatusText(r);
        return;
      }
      if (!r.autoTask && !seamDry) {
        // A plain player-ordered mining run keeps going until the seam is dry.
        r.goal = 'idle';
        r.phase = 'idle';
        r.statusText = roverStatusText(r);
        return;
      }
      if (cmd.repeat && seamDry) {
        this.event('ok', `${r.label}'s haul route complete — the seam is worked out.`);
      }
    }
    // Automatic runs are single-trip: dropping the load returns the rover to
    // the pool so the scheduler can re-decide what the colony needs *now*.
    this.finishTask(r);
    r.statusText = roverStatusText(r);
  }

  // ------------------------------------------------- cleaning & repair ----
  /**
   * Storm-era maintenance (GDD §5's CLEAN and REPAIR tasks). Cleaning scrubs
   * dust off a solar array; repair restores structural health and re-commissions
   * a building the storm tripped offline. Both are deliberately slow rover
   * work — the recovery should cost the player something, not a click.
   */
  private doService(r: Rover, b: Building, kind: 'clean' | 'repair'): void {
    const def = BUILDINGS[b.kind];
    const dist = Math.hypot(b.x - r.x, b.z - r.z);
    const siteReach = def.radius + 4;
    const hours = SIM_TICK * HOURS_PER_SEC;
    if (dist > siteReach) {
      r.gid = b.id;
      if (r.goal !== 'toService' || r.phase === 'idle') {
        this.setTravel(r, b.x, b.z, 'toService');
      }
      return;
    }
    r.gid = b.id;
    r.goal = 'service';
    r.phase = 'working';
    r.statusText = kind === 'repair' ? 'Repairing' : 'Cleaning panels';

    // A worn rover works slower — and the work wears it further.
    const mul = this.roverWorkMul(r);
    if (kind === 'repair') {
      b.health = Math.min(BUILDING_MAX_HEALTH, b.health + ROVER_REPAIR_RATE * mul * SIM_TICK);
      if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) {
        b.damaged = false;
        this.event('ok', `${def.label} repaired and back online.`);
        this.recomputeCapacities();
      }
    } else {
      b.cleanliness = Math.min(1, b.cleanliness + ROVER_CLEAN_RATE * mul * SIM_TICK);
    }
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].workPowerKw * hours * 0.5);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * 0.5 * SIM_TICK);
    if (r.battery <= 0) this.disable(r);

    const done =
      kind === 'repair'
        ? b.health >= BUILDING_MAX_HEALTH - 0.5
        : b.cleanliness >= 0.999;
    if (done) {
      this.event(
        'ok',
        kind === 'repair'
          ? `${r.label} finished repairing the ${def.label}.`
          : `${r.label} cleaned the ${def.label} array — output restored.`,
      );
      this.finishTask(r);
    }
  }

  /**
   * The RECOVER task (TDD §8): drive out to a battery-flat rover, hook up the
   * jumper cables, and give it enough charge to get home — while keeping
   * enough to get the rescuer back too. Pure energy maths, no vibes.
   */
  private doRecover(
    r: Rover,
    cmd: { type: 'recover'; roverId: number; give?: number; given?: number },
  ): void {
    const s = this.roverById(cmd.roverId);
    if (!s || s.phase !== 'disabled') {
      // Already rescued (or gone) — nothing to do.
      this.finishTask(r);
      return;
    }
    const dist = Math.hypot(s.x - r.x, s.z - r.z);
    if (dist > 6) {
      if (r.goal !== 'toRecover' || r.phase === 'idle') {
        this.setTravel(r, s.x, s.z, 'toRecover');
      }
      return;
    }
    r.gid = s.id;
    r.goal = 'recover';
    r.phase = 'working';
    r.statusText = 'Jump-starting';

    if (cmd.give === undefined) {
      // First hookup: size the transfer honestly.
      const sDef = ROVERS[s.kind];
      const home = this.nearestChargerPoint(s.x, s.z);
      const need = Math.max(
        this.travelKWh(s.x, s.z, home.x, home.z, sDef) * 1.25,
        sDef.maxBatteryKWh * 0.15,
      );
      const rDef = ROVERS[r.kind];
      const rHome = this.nearestChargerPoint(s.x, s.z); // the rescuer walks back from there
      const reserve = Math.max(
        rDef.maxBatteryKWh * (r.rules.chargeFloorPct / 100),
        this.travelKWh(s.x, s.z, rHome.x, rHome.z, rDef) * 1.15,
      );
      const spare = r.battery - reserve;
      if (spare < Math.min(need, RECOVER_MIN_GIVE_KWH)) {
        this.event(
          'warn',
          `${r.label} can't spare enough charge to jump-start ${s.label} — charge up first.`,
        );
        this.finishTask(r);
        return;
      }
      cmd.give = Math.min(need, spare);
      cmd.given = 0;
    }

    // Trickle the cables over a couple of seconds so it reads as work.
    const step = Math.min(RECOVER_TRANSFER_KW * SIM_TICK, cmd.give - (cmd.given ?? 0));
    const got = Math.min(step, Math.max(0, r.battery));
    r.battery -= got;
    s.battery += got;
    cmd.given = (cmd.given ?? 0) + got;
    r.statusText = `Jump-starting (${cmd.given.toFixed(0)}/${cmd.give.toFixed(0)} kWh)`;

    if (cmd.given >= cmd.give - 1e-6) {
      s.phase = 'idle';
      s.goal = 'idle';
      s.command = { type: 'idle' };
      s.pending = [];
      s.recharge = true;
      s.lowBatteryNotified = true; // it *is* low; don't warn again on the way in
      s.statusText = 'Returning to charge';
      this.event(
        'ok',
        `${r.label} jump-started ${s.label} — ${cmd.given.toFixed(1)} kWh handed over. Both heading in to charge.`,
      );
      r.recharge = true;
      this.finishTask(r);
    }
  }

  /**
   * The UNLOAD task: drive in and pour out whatever the silos have room for.
   * tryUnload does the pouring (and the log lines); a non-mine command falls
   * straight through to finishTask there. Cargo that doesn't fit — full silos
   * — rides on: the idle fallback keeps offering it as room frees up.
   */
  private doUnload(r: Rover): void {
    if (cargoMass(r) <= 0.01) {
      this.finishTask(r);
      return;
    }
    if (this.nearDepot(r.x, r.z)) {
      this.tryUnload(r);
    } else if (r.goal !== 'toDepot' || r.phase === 'idle') {
      this.beginUnload(r);
    }
  }

  /** True when a rover is already en route to (or working on) this building. */
  private servicingRover(buildingId: number): boolean {
    return this.rovers.some(
      (r) =>
        (r.command.type === 'repair' || r.command.type === 'clean') &&
        r.command.buildingId === buildingId,
    );
  }

  /** True when a repair or cleaning job is waiting for a free rover. */
  private maintenancePending(): boolean {
    for (const b of this.buildings) {
      if (b.state !== 'online' || this.servicingRover(b.id)) continue;
      if (b.damaged) return true;
      if (
        BUILDINGS[b.kind].generation === 'solar' &&
        b.cleanliness < AUTO_CLEAN_THRESHOLD
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Automation for the storm economy: idle rovers repair damaged structures
   * first (survival-critical, TDD §8's ordering), then scrub the dirtiest
   * array once it drops past the cleanliness threshold. As with hauling, this
   * only ever fills genuine idle time — explicit player orders always win.
   */
  private assignMaintenance(): void {
    if (this.weather.shelterRovers()) return; // everyone should be heading in

    const jobs: Array<{ b: Building; kind: 'clean' | 'repair' }> = [];
    for (const b of this.buildings) {
      if (b.state !== 'online') continue;
      if (b.damaged) jobs.push({ b, kind: 'repair' });
    }
    jobs.sort((a, c) => a.b.health - c.b.health || a.b.id - c.b.id);
    const dirty = this.buildings
      .filter(
        (b) =>
          b.state === 'online' &&
          !b.damaged &&
          BUILDINGS[b.kind].generation === 'solar' &&
          b.cleanliness < AUTO_CLEAN_THRESHOLD,
      )
      .sort((a, c) => a.cleanliness - c.cleanliness || a.id - c.id);
    for (const b of dirty) jobs.push({ b, kind: 'clean' });
    if (jobs.length === 0) return;

    const pool = this.rovers.filter(
      (r) =>
        r.phase !== 'disabled' &&
        !r.recharge &&
        !r.sheltered &&
        r.command.type === 'idle',
    );
    if (pool.length === 0) return;

    for (const { b, kind } of jobs) {
      if (this.servicingRover(b.id)) continue;
      // Repairs ignore the auto-maintenance opt-out (they are too important to
      // skip); routine cleaning respects it like any other automatic chore.
      const idx = pool.findIndex((r) => kind === 'repair' || r.rules.autoService);
      if (idx < 0) return;
      const rover = pool[idx];
      pool.splice(idx, 1);
      this.autoAssign(rover, { type: kind, buildingId: b.id });
    }
  }

  /**
   * Automation for the fleet's own survival (T4's "recover"): when a rover is
   * stranded and nobody is already on the way, an idle volunteer with enough
   * spare charge — after its own ride home — jumps in. Explicit player orders
   * always win; this only fills idle time.
   */
  private assignRescues(): void {
    if (this.weather.shelterRovers()) return; // nobody drives into a storm
    const stranded = this.rovers.filter(
      (s) => s.phase === 'disabled' && !this.rescueTargeted(s.id),
    );
    if (stranded.length === 0) return;

    for (const s of stranded) {
      const pool = this.rovers.filter(
        (r) =>
          r.phase !== 'disabled' &&
          !r.recharge &&
          !r.sheltered &&
          r.command.type === 'idle' &&
          r.pending.length === 0 &&
          r.rules.autoRescue &&
          r.id !== s.id,
      );
      if (pool.length === 0) continue;
      pool.sort(
        (a, c) =>
          Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(c.x - s.x, c.z - s.z) || a.id - c.id,
      );
      for (const cand of pool) {
        const rDef = ROVERS[cand.kind];
        const sDef = ROVERS[s.kind];
        const home = this.nearestChargerPoint(s.x, s.z);
        const need = Math.max(
          this.travelKWh(s.x, s.z, home.x, home.z, sDef) * 1.25,
          sDef.maxBatteryKWh * 0.15,
        );
        const reserve = Math.max(
          rDef.maxBatteryKWh * (cand.rules.chargeFloorPct / 100),
          this.travelKWh(s.x, s.z, home.x, home.z, rDef) * 1.15,
        );
        const outAndBack = this.travelKWh(cand.x, cand.z, s.x, s.z, rDef);
        if (cand.battery - reserve - outAndBack < Math.max(need, RECOVER_MIN_GIVE_KWH)) continue;
        this.autoAssign(cand, { type: 'recover', roverId: s.id });
        this.event('info', `${cand.label} is heading out to jump-start ${s.label}.`);
        break;
      }
    }
  }

  // ------------------------------------------------------ construction ----
  private doBuild(r: Rover, b: Building): void {
    const dist = Math.hypot(b.x - r.x, b.z - r.z);
    const siteReach = BUILDINGS[b.kind].radius + 4;
    const hours = SIM_TICK * HOURS_PER_SEC;
    if (dist > siteReach) {
      r.gid = b.id;
      if (r.goal !== 'toSite' || r.phase === 'idle') {
        this.setTravel(r, b.x, b.z, 'toSite');
      }
      return;
    }
    r.gid = b.id;
    r.goal = 'build';
    r.phase = 'working';
    r.statusText = 'Building';

    const def = BUILDINGS[b.kind];

    // Materials are delivered by tickSiteLogistics; a builder only assembles.
    if (remainingCostTotal(b) > 0) {
      if (b.workerId === r.id) b.workerId = null;
      this.finishTask(r);
      return;
    }
    if (b.state === 'site') {
      b.state = 'building';
      this.event('info', `${r.label} began assembling the ${def.label}.`);
    }

    // A workshop within range lends tools and speeds the job up.
    let mul = 1;
    for (const w of this.buildings) {
      if (w.kind !== 'workshop' || w.state !== 'online' || !w.enabled) continue;
      if (Math.hypot(w.x - b.x, w.z - b.z) < 70) {
        mul = 1.35;
        break;
      }
    }

    const work =
      ROVERS[r.kind].buildPower *
      mul *
      this.weather.workMultiplier() *
      this.roverWorkMul(r);
    const before = b.progress;
    b.progress = Math.min(1, b.progress + (work * SIM_TICK) / b.buildTime);
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].workPowerKw * hours * 0.6);
    r.condition = Math.max(0, r.condition - ROVER_WEAR_WORK_S * 0.7 * SIM_TICK);
    if (r.battery <= 0) this.disable(r);
    if (before < 1 && b.progress >= 1) {
      this.completeBuilding(b);
      this.finishTask(r);
    }
  }

  private completeBuilding(b: Building): void {
    if (b.state === 'online') return;
    b.state = 'online';
    b.progress = 1;
    b.workerId = null;
    this.recomputeCapacities();
    const def = BUILDINGS[b.kind];
    const extras: string[] = [];
    if (def.storagePerResourceKg) extras.push(`+${def.storagePerResourceKg} kg per silo`);
    if (def.batteryKWh) extras.push(`grid +${def.batteryKWh} kWh`);
    if (def.powerProduceKw) extras.push(`+${def.powerProduceKw} kW peak`);
    this.event('ok', `${def.label} is online${extras.length ? ` — ${extras.join(', ')}` : ''}.`);
  }

  /**
   * Pour whatever is available in storage into a site's remaining cost.
   * Returns the mass committed this tick.
   */
  private commitAvailableMaterials(b: Building): number {
    let took = 0;
    for (const res of ALL_RESOURCES) {
      const need = b.remainingCost[res];
      if (need <= 0) continue;
      const give = Math.min(need, this.storage[res]);
      if (give <= 0) continue;
      this.storage[res] -= give;
      b.remainingCost[res] = Math.max(0, need - give);
      took += give;
    }
    return took;
  }

  private hasMaterials(amounts: ResourceAmounts): boolean {
    for (const res of ALL_RESOURCES) {
      if (amounts[res] > 0 && this.storage[res] < amounts[res]) return false;
    }
    return true;
  }

  private consumeMaterials(amounts: ResourceAmounts): void {
    for (const res of ALL_RESOURCES) {
      this.storage[res] = Math.max(0, this.storage[res] - amounts[res]);
    }
  }

  private missingList(amounts: ResourceAmounts): string {
    const parts: string[] = [];
    for (const res of ALL_RESOURCES) {
      if (amounts[res] > 0.01) {
        parts.push(`${Math.ceil(amounts[res])} kg ${RESOURCES[res].label}`);
      }
    }
    return parts.join(', ') || 'materials';
  }

  // ------------------------------------------------------------ alerts ----

  /** Sols of reserve left for a fluid at the trailing-sol net rate. */
  solsOfReserve(f: FluidId): number {
    return this.reserveSols(f);
  }

  private evaluateAlerts(): void {
    const t = this.simTime;
    const stamp = this.clock.format();
    const A = this.alerts;

    // ---- power ------------------------------------------------------------
    const p = this.power;
    if (p.firstShedTier !== null && p.firstShedTier <= 1) {
      A.raise(
        'brownout-critical',
        'crit',
        'Grid brownout',
        `Life-support tiers are being shed. Generation ${p.generationKw.toFixed(1)} kW vs ${p.demandKw.toFixed(1)} kW demand.`,
        t,
        stamp,
      );
    } else {
      A.clear('brownout-critical', t, stamp, 'Critical loads are powered again.');
      if (p.brownout) {
        A.raise(
          'brownout',
          'warn',
          'Power deficit',
          `Non-essential loads throttled. ${p.generationKw.toFixed(1)} kW generated, ${p.demandKw.toFixed(1)} kW requested.`,
          t,
          stamp,
        );
      } else {
        A.clear('brownout', t, stamp);
      }
    }

    const cap = p.capacityKWh;
    const frac = cap > 0 ? p.storedKWh / cap : 0;
    if (frac < 0.1 && p.batteryFlowKw < 0) {
      A.raise(
        'battery-low',
        'warn',
        'Batteries nearly flat',
        `${p.storedKWh.toFixed(0)} kWh left, draining at ${(-p.batteryFlowKw).toFixed(1)} kW.`,
        t,
        stamp,
      );
    } else if (frac > 0.25 || p.batteryFlowKw >= 0) {
      A.clear('battery-low', t, stamp);
    }

    // ---- life support -----------------------------------------------------
    for (const f of ALL_FLUIDS) {
      const amount = this.pools.amounts[f];
      const reserve = this.reserveSols(f);
      const info = FLUIDS[f];
      const key = `${f}-low`;
      const critSols = f === 'oxygen' ? 0.5 : f === 'water' ? 1 : 2;
      const warnSols = f === 'oxygen' ? 1.5 : f === 'water' ? 3 : 6;

      if (amount <= 1e-6) {
        A.raise(
          key,
          'crit',
          `${info.label} exhausted`,
          f === 'oxygen'
            ? 'The colonist is breathing suit reserves. Restore oxygen production now.'
            : `No ${info.label.toLowerCase()} left in the colony.`,
          t,
          stamp,
        );
      } else if (reserve < critSols) {
        A.raise(
          key,
          'crit',
          `${info.label} critical`,
          `${amount.toFixed(1)} kg left — about ${reserve.toFixed(1)} sol${reserve >= 2 ? 's' : ''} at the current rate.`,
          t,
          stamp,
        );
      } else if (reserve < warnSols) {
        A.raise(
          key,
          'warn',
          `${info.label} reserve falling`,
          `${amount.toFixed(1)} kg left — about ${reserve.toFixed(1)} sols at the current rate.`,
          t,
          stamp,
        );
      } else {
        A.clear(key, t, stamp);
      }
    }

    // ---- the human --------------------------------------------------------
    const c = this.colonist;
    if (!c.dead) {
      if (c.health < 35) {
        A.raise(
          'colonist-health',
          'crit',
          `${c.name} is failing`,
          `Health ${c.health.toFixed(0)}%. Restore life support immediately.`,
          t,
          stamp,
          c.id,
        );
      } else if (c.health < 70) {
        A.raise(
          'colonist-health',
          'warn',
          `${c.name} is unwell`,
          `Health ${c.health.toFixed(0)}%.`,
          t,
          stamp,
          c.id,
        );
      } else {
        A.clear('colonist-health', t, stamp, `${c.name} has recovered.`);
      }

      if (!c.inside && c.suitO2 < SUIT_O2_CAPACITY * 0.35) {
        A.raise(
          'suit-o2',
          'crit',
          'Suit oxygen low',
          `${c.name} must reach a pressurised volume.`,
          t,
          stamp,
          c.id,
        );
      } else {
        A.clear('suit-o2', t, stamp);
      }
    }

    // ---- stranded & worn rovers -------------------------------------------
    for (const r of this.rovers) {
      const key = `rover-dead-${r.id}`;
      if (r.phase === 'disabled') {
        A.raise(
          key,
          'warn',
          `${r.label} stranded`,
          'Battery flat, out in the field — another rover can jump-start it.',
          t,
          stamp,
          r.id,
        );
      } else {
        A.clear(key, t, stamp);
      }
      const wkey = `rover-wear-${r.id}`;
      if (r.condition < ROVER_CONDITION_ALERT) {
        A.raise(
          wkey,
          'warn',
          `${r.label} needs service`,
          `Drivetrain at ${Math.round(r.condition)}% — work rate reduced. Park it at a Rover Garage.`,
          t,
          stamp,
          r.id,
        );
      } else {
        A.clear(wkey, t, stamp, `${r.label} is back in shape.`);
      }
    }

    // ---- storage ----------------------------------------------------------
    const full = this.fullResources();
    if (full.length > 0) {
      A.raise(
        'storage-full',
        'warn',
        full.length === ALL_RESOURCES.length ? 'All silos full' : 'Silo full',
        `${full.map((r) => RESOURCES[r].label).join(', ')} at capacity — build a Warehouse to keep hauling.`,
        t,
        stamp,
      );
    } else {
      A.clear('storage-full', t, stamp);
    }

    // ---- weather ------------------------------------------------------------
    const wx = this.weather;
    const active = wx.current();
    if (active) {
      const sev: Severity =
        active.kind === 'severe' || active.kind === 'planetary'
          ? 'crit'
          : active.kind === 'devil'
            ? 'info'
            : 'warn';
      const drop = Math.round((1 - this.dustTransmission) * 100);
      A.raise(
        'storm-active',
        sev,
        stormLabel(active.kind),
        `Solar −${drop}% from dust · visibility ${Math.round(wx.visibility * 100)}% · winds ${Math.round(wx.windSpeed)} m/s.`,
        t,
        stamp,
      );
    } else {
      A.clear('storm-active', t, stamp, 'Storm passed — skies are settling.');
    }

    // ---- storm damage & dirty panels ---------------------------------------
    const hurt = this.buildings.filter((b) => b.damaged);
    if (hurt.length > 0) {
      A.raise(
        'building-damaged',
        'crit',
        hurt.length === 1 ? `${BUILDINGS[hurt[0].kind].label} damaged` : `${hurt.length} structures damaged`,
        hurt.length === 1
          ? 'Offline until a rover repairs it.'
          : `${hurt.map((b) => BUILDINGS[b.kind].label).join(', ')} — dispatch rovers to repair.`,
        t,
        stamp,
        hurt[0].id,
      );
    } else {
      A.clear('building-damaged', t, stamp, 'All structures repaired.');
    }

    const panels = this.buildings.filter(
      (b) => this.runnable(b) && BUILDINGS[b.kind].generation === 'solar',
    );
    if (panels.length > 0) {
      const worst = Math.min(...panels.map((b) => b.cleanliness));
      const dirty = panels.filter((b) => b.cleanliness < 0.6).length;
      if (worst < 0.6) {
        A.raise(
          'panels-dirty',
          'warn',
          'Solar arrays dusted',
          `Output down ${Math.round((1 - worst) * 100)}% on the dirtiest array${dirty > 1 ? ` (${dirty} arrays need cleaning)` : ''} — send a rover to clean.`,
          t,
          stamp,
          panels.sort((a, b) => a.cleanliness - b.cleanliness)[0].id,
        );
      } else {
        A.clear('panels-dirty', t, stamp, 'Arrays are clean again.');
      }
    } else {
      A.clear('panels-dirty', t, stamp);
    }
  }

  // ----------------------------------------------------------- history ----
  private recordHistory(): void {
    if (this.simTime - this.lastHistoryAt < HISTORY_INTERVAL_S) {
      // Flows are per-tick accumulators; reset them after they've been read.
      this.resetFlows();
      return;
    }
    this.lastHistoryAt = this.simTime;
    this.history.push({
      t: this.simTime,
      genKw: this.power.generationKw,
      loadKw: this.power.servedKw,
      storedFrac: this.power.capacityKWh > 0 ? this.power.storedKWh / this.power.capacityKWh : 0,
      water: this.pools.amounts.water,
      oxygen: this.pools.amounts.oxygen,
      food: this.pools.amounts.food,
    });
    while (this.history.length > HISTORY_SAMPLES) this.history.shift();
    this.resetFlows();
  }

  /**
   * Flows accumulate within a tick and are read by the HUD as a rate. We keep
   * the previous tick's totals around so the UI never samples a zeroed frame.
   */
  private resetFlows(): void {
    this.flowWindow.push({
      t: this.simTime,
      f: {
        water: { ...this.flows.water },
        oxygen: { ...this.flows.oxygen },
        food: { ...this.flows.food },
      },
    });
    // Keep exactly one trailing sol of samples.
    const cutoff = this.simTime - SOL_SECONDS;
    while (this.flowWindow.length > 1 && this.flowWindow[0].t < cutoff) {
      this.flowWindow.shift();
    }

    this.lastFlows = {
      water: { ...this.flows.water },
      oxygen: { ...this.flows.oxygen },
      food: { ...this.flows.food },
    };
    this.flows = {
      water: { produced: 0, consumed: 0 },
      oxygen: { produced: 0, consumed: 0 },
      food: { produced: 0, consumed: 0 },
    };
  }

  lastFlows: Record<FluidId, FluidFlow> = {
    water: { produced: 0, consumed: 0 },
    oxygen: { produced: 0, consumed: 0 },
    food: { produced: 0, consumed: 0 },
  };

  /**
   * Rolling totals over the trailing sol, per fluid. Instantaneous rates are
   * useless to the player here: a greenhouse runs at 100 % at noon and 15 % at
   * midnight, so a raw reading would swing from "food surplus" to "starving"
   * twice a sol. Averaging over a full sol answers the question the player is
   * actually asking — *am I gaining or losing ground?*
   */
  private flowWindow: Array<{ t: number; f: Record<FluidId, FluidFlow> }> = [];

  /** Net rate of a fluid in kg/sol, averaged over the trailing sol. */
  netRatePerSol(f: FluidId): number {
    if (this.flowWindow.length === 0) return 0;
    const span = this.simTime - this.flowWindow[0].t;
    if (span <= 1e-6) return 0;
    let produced = 0;
    let consumed = 0;
    for (const w of this.flowWindow) {
      produced += w.f[f].produced;
      consumed += w.f[f].consumed;
    }
    return (produced - consumed) / (span * SOLS_PER_SEC);
  }

  /** Instantaneous rate for the current tick — used for live throughput read-outs. */
  instantRatePerSol(f: FluidId): number {
    const sols = SIM_TICK * SOLS_PER_SEC;
    if (sols <= 0) return 0;
    const fl = this.lastFlows[f];
    return (fl.produced - fl.consumed) / sols;
  }

  reserveSols(f: FluidId): number {
    const net = this.netRatePerSol(f);
    if (net >= -1e-9) return Infinity;
    return this.pools.amounts[f] / -net;
  }

  // ------------------------------------------------------------ events ----
  private event(severity: Severity, text: string): void {
    this.alerts.event(severity, text, this.simTime, this.clock.format());
  }

  drainEvents() {
    return this.alerts.drain();
  }

  // ------------------------------------------------------- persistence ----
  snapshot(): object {
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      difficulty: this.difficulty,
      worldHalf: this.world.half,
      region: this.world.region,
      worldOptions: { ...this.worldOptions },
      simTime: this.simTime,
      ticksRun: this.ticksRun,
      clock: this.clock.snapshot(),
      storage: { ...this.storage },
      fluids: { ...this.pools.amounts },
      storedKWh: this.storedKWh,
      gameOver: this.gameOver,
      colonist: {
        id: this.colonist.id,
        name: this.colonist.name,
        x: this.colonist.x,
        z: this.colonist.z,
        heading: this.colonist.heading,
        health: this.colonist.health,
        suitO2: this.colonist.suitO2,
        inside: this.colonist.inside,
        shelterId: this.colonist.shelterId,
        order: { ...this.colonist.order },
        dead: this.colonist.dead,
      },
      deposits: this.world.deposits.map((d) => ({
        id: d.id,
        resource: d.resource,
        x: d.x,
        z: d.z,
        amount: d.amount,
        maxAmount: d.maxAmount,
        radius: d.radius,
        // Scheduler claims are authoritative: they steer the next dispatch.
        reservedBy: d.reservedBy ?? null,
      })),
      rovers: this.rovers.map((r) => ({
        id: r.id,
        kind: r.kind,
        x: r.x,
        y: r.y,
        z: r.z,
        heading: r.heading,
        battery: r.battery,
        cargo: { ...r.cargo },
        command: { ...r.command },
        pending: r.pending.map((task) => ({ ...task })),
        condition: r.condition,
        rules: { ...r.rules },
        autoTask: r.autoTask,
        recharge: r.recharge,
        lowBatteryNotified: r.lowBatteryNotified,
        blockNotified: r.blockNotified,
        sheltered: r.sheltered,
        lightsOn: r.lightsOn,
      })),
      buildings: this.buildings.map((b) => ({
        id: b.id,
        kind: b.kind,
        x: b.x,
        z: b.z,
        rot: b.rot,
        state: b.state,
        remainingCost: { ...b.remainingCost },
        needsMaterials: b.needsMaterials,
        progress: b.progress,
        buildTime: b.buildTime,
        workerId: b.workerId,
        enabled: b.enabled,
        health: b.health,
        cleanliness: b.cleanliness,
        damaged: b.damaged,
        assembly: b.assembly ? { ...b.assembly } : null,
      })),
      weather: this.weather.snapshot(),
      alerts: this.alerts.snapshot(),
    };
  }

  /** Restore state from an earlier snapshot(). Mutates this sim in place. */
  restore(data: any): void {
    if (!data || typeof data !== 'object') throw new Error('empty save');
    // TDD §15: migrate what we understand, refuse what we don't.
    if (data.version === 3) data = migrateV3Save(data);
    if (data.version === 4) data = migrateV4Save(data);
    if (data.version === 5) data = migrateV5Save(data);
    if (data.version !== SAVE_VERSION) {
      throw new Error(`unsupported save version ${data.version}`);
    }
    this.seed = data.seed;
    this.difficulty = DIFFICULTIES[data.difficulty as DifficultyId]
      ? (data.difficulty as DifficultyId)
      : 'pioneer';
    this.worldOptions = { ...DEFAULT_WORLD_OPTIONS, ...(data.worldOptions ?? {}) };
    this.consumptionMul = (DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pioneer).consumptionMul;
    this.simTime = data.simTime || 0;
    // The tick counter is authoritative; the delivery remainder restarts at
    // zero (where it sits within a frame either way, and it never changes how
    // many ticks a given total of delivered time produces).
    this.ticksRun = data.ticksRun ?? Math.floor(this.simTime / SIM_TICK + 1e-9);
    this.remainder = 0;
    this.clock.restore(data.clock);
    this.weather = new Weather(this.seed ^ 0x77e711e);
    this.weather.time = this.simTime;
    if (data.weather) this.weather.restore(data.weather);
    this.dustTransmission = this.weather.solarTransmission;
    this.stormAnnounced = !!this.weather.current();
    this.storage = { ...emptyAmounts(), ...(data.storage ?? {}) };
    this.gameOver = data.gameOver ?? null;

    // The terrain must match the original exactly (seed + region + size);
    // deposits themselves are restored from the save below.
    this.world = new World({
      seed: data.seed,
      nearDeposits: 0.2,
      worldHalf: Number.isFinite(data.worldHalf) ? data.worldHalf : 640,
      region: typeof data.region === 'string' ? data.region : null,
    });
    this.world.deposits = (data.deposits ?? []).map((d: any) => ({
      id: d.id,
      resource: d.resource,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
      reservedBy: Number.isFinite(d.reservedBy) ? d.reservedBy : null,
    }));

    this.rovers = (data.rovers ?? []).map((r: any) => {
      const command = coerceTask(r.command) ?? { type: 'idle' as const };
      const pending = Array.isArray(r.pending)
        ? (r.pending as any[]).map(coerceTask).filter((t): t is RoverTask => t !== null)
        : [];
      return {
        id: r.id,
        kind: r.kind,
        label: ROVERS[r.kind as RoverKind]?.label ?? 'Rover',
        x: r.x,
        y: this.world.heightAt(r.x, r.z),
        z: r.z,
        heading: r.heading,
        battery: r.battery,
        cargo: { ...emptyAmounts(), ...(r.cargo ?? {}) },
        phase: 'idle' as RoverPhase,
        command,
        pending,
        goal: 'idle' as RoverGoal,
        gx: r.x,
        gz: r.z,
        gid: 0,
        recharge: !!r.recharge,
        lowBatteryNotified: !!r.lowBatteryNotified,
        statusText: 'Idle',
        chargeSat: 0,
        autoTask: !!r.autoTask,
        condition: typeof r.condition === 'number' ? r.condition : 100,
        rules: { ...defaultRoverRules(), ...(r.rules ?? {}) },
        routePaused: false,
        blockNotified: !!r.blockNotified,
        sheltered: !!r.sheltered,
        lightsOn: r.lightsOn !== false,
        lightsActive: false,
        navPath: [],
        navI: 0,
      };
    });

    this.buildings = (data.buildings ?? []).map((b: any) => ({
      id: b.id,
      kind: b.kind,
      x: b.x,
      z: b.z,
      rot: b.rot ?? 0,
      state: b.state,
      remainingCost: { ...emptyAmounts(), ...(b.remainingCost ?? {}) },
      needsMaterials: !!b.needsMaterials,
      progress: b.progress ?? 0,
      buildTime: b.buildTime ?? BUILDINGS[b.kind as BuildingKind].buildTime,
      workerId: b.workerId ?? null,
      enabled: b.enabled !== false,
      powerSat: 1,
      throughput: 0,
      genKw: 0,
      loadKw: 0,
      idleReason: '',
      health: b.health ?? BUILDING_MAX_HEALTH,
      cleanliness: b.cleanliness ?? 1,
      damaged: !!b.damaged,
      assembly:
        b.assembly && ROVERS[b.assembly.kind as RoverKind]
          ? { kind: b.assembly.kind, progress: b.assembly.progress ?? 0 }
          : null,
      // Developer-mode upgrades are runtime-only by design: a loaded colony
      // always comes back at base level, whatever the live game had.
      level: 1,
    }));

    /**
     * Rovers resume *at rest*: the in-flight phase is not saved, so re-derive
     * the one resting state the power grid needs to see. A rover parked at a
     * charger with room in its battery was plugged in when the save closed,
     * and must still read as charging when it reopens — otherwise the first
     * tick after a load silently skips a charge the live colony got, and a
     * reloaded save drifts from the original by exactly that one tick.
     */
    for (const r of this.rovers) {
      if (r.battery <= 0) continue; // a flat rover stays dark (it re-strands itself)
      if (r.battery >= ROVERS[r.kind].maxBatteryKWh - 1e-6) continue;
      if (this.nearCharger(r.x, r.z)) {
        r.phase = 'charging';
        r.statusText = 'Charging';
      }
    }

    this.recomputeCapacities();
    this.pools.amounts = { ...emptyFluids(), ...(data.fluids ?? {}) };
    for (const f of ALL_FLUIDS) {
      this.pools.amounts[f] = clamp(this.pools.amounts[f], 0, this.pools.capacity[f]);
    }

    const cd = data.colonist ?? {};
    this.colonist = makeColonist(
      cd.id ?? 1,
      cd.name ?? 'Cmdr. Vega',
      cd.x ?? SPAWN_X,
      0,
      cd.z ?? SPAWN_Z,
    );
    this.colonist.y = this.world.heightAt(this.colonist.x, this.colonist.z);
    this.colonist.heading = cd.heading ?? 0;
    this.colonist.health = cd.health ?? 100;
    this.colonist.suitO2 = cd.suitO2 ?? SUIT_O2_CAPACITY;
    this.colonist.inside = cd.inside ?? true;
    this.colonist.shelterId = cd.shelterId ?? 0;
    this.colonist.order = (cd.order as ColonistOrder) ?? { type: 'shelter' };
    this.colonist.dead = !!cd.dead;

    this.storedKWh = clamp(data.storedKWh ?? 0, 0, this.batteryCapacity());
    this.power = idlePower(this.batteryCapacity(), this.storedKWh);

    this.alerts.reset();
    if (data.alerts) this.alerts.restore(data.alerts);
    this.history = [];
    this.flowWindow = [];
    this.lastHistoryAt = -Infinity;

    let maxId = this.nextId;
    for (const e of [...this.rovers, ...this.buildings]) maxId = Math.max(maxId, e.id + 1);
    for (const d of this.world.deposits) maxId = Math.max(maxId, d.id + 1);
    this.nextId = maxId;
  }
}

// ------------------------------------------------- save helpers (P4) ----

/**
 * Validate one task out of a (possibly untrusted) save: shape-check every
 * field and drop anything malformed rather than executing it (TDD §24).
 */
function coerceTask(t: any): RoverTask | null {
  if (!t || typeof t.type !== 'string') return null;
  switch (t.type) {
    case 'moveTo':
      return Number.isFinite(t.x) && Number.isFinite(t.z)
        ? { type: 'moveTo', x: t.x, z: t.z }
        : null;
    case 'mine':
      return Number.isFinite(t.depositId)
        ? { type: 'mine', depositId: t.depositId, ...(t.repeat ? { repeat: true } : {}) }
        : null;
    case 'construct':
    case 'clean':
    case 'repair':
      return Number.isFinite(t.buildingId) ? { type: t.type, buildingId: t.buildingId } : null;
    case 'recover':
      return Number.isFinite(t.roverId)
        ? {
            type: 'recover',
            roverId: t.roverId,
            ...(Number.isFinite(t.give) ? { give: t.give, given: t.given ?? 0 } : {}),
          }
        : null;
    case 'unload':
      return { type: 'unload' };
    case 'wait':
      return { type: 'wait', seconds: Math.max(0, Number(t.seconds) || 0) };
    default:
      return null;
  }
}

/**
 * v3 → v4 (Prototype 4). What changed: rovers grew a task queue, drivetrain
 * condition and automation rules; buildings (garages) grew an assembly slot.
 * Old rovers had a single `command` — it becomes the one task in the queue —
 * and the old `autoHaul` flag carries over as the matching rule. From there
 * the v4 → v5 step adds the position-lights switch.
 */
function migrateV3Save(data: any): any {
  const d: any = { ...data, version: 4 };
  d.rovers = (data.rovers ?? []).map((r: any) => {
    const rules = defaultRoverRules();
    rules.autoHaul = r.autoHaul !== false;
    return { ...r, pending: [], condition: 100, rules };
  });
  d.buildings = (data.buildings ?? []).map((b: any) => ({ ...b, assembly: null }));
  return migrateV4Save(d);
}

/**
 * v4 → v5. Rovers grew position lights: a player switch that the sim honours
 * automatically at night and in blowing dust. Every existing rover is
 * assumed to have shipped with the switch armed.
 */function migrateV4Save(data: any): any {
  const d: any = { ...data, version: 5 };
  d.rovers = (data.rovers ?? []).map((r: any) => ({ ...r, lightsOn: r.lightsOn !== false }));
  return migrateV5Save(d);
}

/**
 * v5 → v6. Colonies gained a difficulty, a world size, a chosen landing
 * region and advanced world options. Older saves predate the mission wizard,
 * so they land on the classic defaults: Pioneer, medium claim, random site.
 */
function migrateV5Save(data: any): any {
  return {
    ...data,
    version: SAVE_VERSION,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS },
  };
}

export { colonistStatusText };
