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
import { SolClock } from './clock';
import type { SunState } from './clock';
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
  command: RoverCommand;
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
  /** Player opt-out from automatic supply runs. */
  autoHaul: boolean;
}

export type RoverCommand =
  | { type: 'idle' }
  | { type: 'moveTo'; x: number; z: number }
  | { type: 'mine'; depositId: number }
  | { type: 'construct'; buildingId: number };

export type RoverGoal =
  | 'idle'
  | 'move'
  | 'mine'
  | 'toDepot'
  | 'unload'
  | 'toSite'
  | 'build'
  | 'toCharge'
  | 'charge';

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
  switch (r.goal) {
    case 'idle':
      return r.phase === 'charging' ? 'Charging' : 'Idle';
    case 'move':
      return 'Moving';
    case 'mine':
      return 'Mining';
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

  /** Atmospheric dust transmission, 1 = clear. Weather (P3) will drive this. */
  dustTransmission = BASE_DUST_TRANSMISSION;

  constructor(params: { seed: number; nearDeposits?: number }) {
    this.seed = params.seed;
    this.world = new World({
      seed: params.seed,
      nearDeposits: params.nearDeposits ?? 0.2,
    });
    this.colonist = makeColonist(
      1,
      'Cmdr. Vega',
      SPAWN_X,
      this.world.heightAt(SPAWN_X, SPAWN_Z),
      SPAWN_Z + 3,
    );
    this.spawnStart();
    this.recomputeCapacities();
    this.pools.amounts = { ...POD_STARTING_FLUIDS };
  }

  // ------------------------------------------------------------ setup ----
  private spawnStart(): void {
    this.spawnRover('mining', 9, 0, Math.PI);
    this.spawnRover('utility', -9, 4, Math.PI);
  }

  private spawnRover(kind: RoverKind, ox: number, oz: number, heading: number): void {
    const def = ROVERS[kind];
    const x = SPAWN_X + ox;
    const z = SPAWN_Z + oz;
    this.rovers.push({
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
      goal: 'idle',
      gx: x,
      gz: z,
      gid: 0,
      recharge: false,
      lowBatteryNotified: false,
      statusText: 'Idle',
      chargeSat: 1,
      autoTask: false,
      autoHaul: true,
    });
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
      if (b.state !== 'online') continue;
      const def = BUILDINGS[b.kind];
      cap += def.storagePerResourceKg;
      if (def.fluidCapacity) {
        for (const f of ALL_FLUIDS) {
          fluid[f] += def.fluidCapacity[f] ?? 0;
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
      if (b.state === 'online' && b.enabled) cap += BUILDINGS[b.kind].batteryKWh;
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

  onlineWarehouses(): Building[] {
    return this.buildings.filter(
      (b) => b.state === 'online' && BUILDINGS[b.kind].storagePerResourceKg > 0,
    );
  }

  /** Every pressurised volume the colonist could shelter in (pod is id 0). */
  shelters(): Array<{ id: number; x: number; z: number; radius: number; recycles: boolean }> {
    const out = [
      { id: 0, x: SPAWN_X, z: SPAWN_Z, radius: POD_RADIUS, recycles: false },
    ];
    for (const b of this.buildings) {
      if (b.state !== 'online') continue;
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
      if (b.state !== 'online' || !b.enabled) continue;
      if (!BUILDINGS[b.kind].providesCharge) continue;
      if (Math.hypot(b.x - x, b.z - z) < BUILDINGS[b.kind].radius + 5) return true;
    }
    return false;
  }

  private nearestChargerPoint(x: number, z: number): { x: number; z: number } {
    let best = { x: SPAWN_X, z: SPAWN_Z };
    let bestD = Math.hypot(SPAWN_X - x, SPAWN_Z - z);
    for (const b of this.buildings) {
      if (b.state !== 'online' || !b.enabled) continue;
      if (!BUILDINGS[b.kind].providesCharge) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bestD) {
        bestD = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }

  // -------------------------------------------------- player commands ----
  issueMove(roverId: number, x: number, z: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    r.autoTask = false;
    r.command = { type: 'moveTo', x, z };
    r.recharge = false;
  }

  issueMine(roverId: number, depositId: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const dep = this.world.deposits.find((d) => d.id === depositId);
    if (!dep || dep.amount <= 0) {
      this.event('info', 'Deposit is depleted.');
      return;
    }
    r.autoTask = false;
    r.command = { type: 'mine', depositId };
    r.recharge = false;
  }

  issueConstruct(roverId: number, buildingId: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const b = this.buildingById(buildingId);
    if (!b || b.state === 'online') return;
    if (!BUILDINGS[b.kind].buildableBy.includes(r.kind)) {
      this.event('warn', `${r.label} can't build a ${BUILDINGS[b.kind].label}.`);
      return;
    }
    r.autoTask = false;
    r.command = { type: 'construct', buildingId };
    r.recharge = false;
  }

  stopRover(roverId: number): void {
    const r = this.roverById(roverId);
    if (!r) return;
    r.command = { type: 'idle' };
    r.recharge = false;
    r.autoTask = false;
  }

  /** Toggle whether this rover accepts automatic supply runs. */
  setRoverAutoHaul(roverId: number, on: boolean): void {
    const r = this.roverById(roverId);
    if (!r) return;
    r.autoHaul = on;
    if (!on && r.autoTask) {
      r.command = { type: 'idle' };
      r.autoTask = false;
    }
    this.event('info', `${r.label} auto-haul ${on ? 'enabled' : 'disabled'}.`);
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
        r.command = { type: 'idle' };
        r.goal = 'idle';
        r.phase = 'idle';
      }
    }
    this.buildings.splice(idx, 1);
    this.recomputeCapacities();
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
      c.gx = order.x;
      c.gz = order.z;
    }
    c.order = order;
  }

  // -------------------------------------------------------- placement ----
  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    if (!this.world.inBounds(x, z)) return 'Outside the playable region.';
    const def = BUILDINGS[kind];
    const slope = this.world.slopeAt(x, z);
    const maxSlope = def.pressurized ? 0.15 : 0.24;
    if (slope > maxSlope) return 'Terrain too steep here.';
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
    };
    this.buildings.push(b);
    this.event('info', `${def.label} sited — assigning a builder.`);
    return b;
  }

  // -------------------------------------------------------- main loop ----

  /**
   * Total game time handed to the sim, and how much of it has been consumed as
   * whole ticks. Deriving the tick count from these two totals — rather than
   * accumulating a remainder — means floating-point error cannot compound:
   * 60 seconds delivered in 3 600 ragged browser frames runs exactly as many
   * ticks as 60 seconds delivered in one call. Determinism §4 depends on it.
   */
  private elapsed = 0;
  private ticksRun = 0;

  /** Advance simulation by `frameDt` game seconds (fixed substeps applied). */
  step(frameDt: number): number {
    if (frameDt <= 0 || !Number.isFinite(frameDt)) return 0;
    this.elapsed += frameDt;

    // The epsilon absorbs representation error so that a total which is
    // mathematically a whole number of ticks always yields that many ticks.
    const due = Math.floor(this.elapsed / SIM_TICK + 1e-9);
    let owed = due - this.ticksRun;

    // Bound catch-up so a backgrounded tab can't produce a multi-second freeze.
    const maxTicks = 400;
    if (owed > maxTicks) {
      this.ticksRun = due - maxTicks;
      owed = maxTicks;
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

    // 2. weather — reserved for Prototype 3.

    // 3 & 4. power network, then production scaled by what it delivered.
    this.tickPower();

    // 5. life support & the human
    this.tickLifeSupport();

    // 6/7/8. logistics, jobs, movement, construction
    this.tickSiteLogistics();
    this.assignBuilders();
    this.assignSupplyRuns();
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
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
      if (b.state !== 'online' || !b.enabled) continue;
      const def = BUILDINGS[b.kind];
      if (!def.generation || def.powerProduceKw <= 0) continue;
      const out =
        def.generation === 'solar'
          ? def.powerProduceKw * sun.irradiance * this.dustTransmission
          : def.powerProduceKw;
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
      const kw = Math.min(ROVER_CHARGE_RATE_KW, hours > 0 ? needKWh / hours : 0);
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
      if (b.state !== 'online' || !b.enabled) continue;
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
      const kw = Math.min(ROVER_CHARGE_RATE_KW, hours > 0 ? needKWh / hours : 0);
      r.battery = Math.min(def.maxBatteryKWh, r.battery + kw * sat * hours);
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
    let factor = 1;

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const rate = p.solidIn[res];
        if (!rate) continue;
        const need = rate * hours;
        factor = Math.min(factor, need > 0 ? this.storage[res] / need : 1);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidIn[f];
        if (!rate) continue;
        const need = rate * hours;
        factor = Math.min(factor, need > 0 ? this.pools.amounts[f] / need : 1);
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const rate = p.fluidOut[f];
        if (!rate) continue;
        const make = rate * hours;
        factor = Math.min(factor, make > 0 ? fluidHeadroom(this.pools, f) / make : 1);
      }
    }
    if (p.needsLight) {
      // Crops slow to a crawl in the dark rather than stopping dead — grow
      // lamps keep a trickle going, which is what the power draw is for.
      const light = 0.15 + 0.85 * clamp(this.clock.sun.irradiance, 0, 1);
      factor = Math.min(factor, light);
    }
    return clamp(factor, 0, 1);
  }

  /** Why a process with power is still not running. */
  private processBlockReason(b: Building): string {
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

    if (p.solidIn) {
      for (const res of ALL_RESOURCES) {
        const r = p.solidIn[res];
        if (!r) continue;
        const take = r * rate * hours;
        this.storage[res] = Math.max(0, this.storage[res] - take);
      }
    }
    if (p.fluidIn) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidIn[f];
        if (!r) continue;
        const got = takeFluid(this.pools, f, r * rate * hours);
        this.flows[f].consumed += got;
      }
    }
    if (p.fluidOut) {
      for (const f of ALL_FLUIDS) {
        const r = p.fluidOut[f];
        if (!r) continue;
        const made = addFluid(this.pools, f, r * rate * hours);
        this.flows[f].produced += made;
      }
    }
  }

  // ----------------------------------------------------- life support ----

  private tickLifeSupport(): void {
    const sols = SIM_TICK * SOLS_PER_SEC;
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
      worker.command = { type: 'construct', buildingId: b.id };
      worker.autoTask = true;
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
      if (rover.autoHaul === false) continue;
      let picked: Deposit | null = null;
      let pickedRes: ResourceId | null = null;
      let bestScore = Infinity;
      for (const res of wanted) {
        for (const d of this.world.deposits) {
          if (d.resource !== res || d.amount <= 0) continue;
          // Prefer close deposits, and rate the scarcest resource highest.
          const dist = Math.hypot(d.x - rover.x, d.z - rover.z);
          const score = dist / (1 + shortfall[res] / 100);
          if (score < bestScore) {
            bestScore = score;
            picked = d;
            pickedRes = res;
          }
        }
      }
      if (!picked || !pickedRes) continue;
      // Don't send a rover across the planet on a whim.
      const reach = ROVERS[rover.kind].maxBatteryKWh * 8;
      if (Math.hypot(picked.x - rover.x, picked.z - rover.z) > reach) continue;
      rover.command = { type: 'mine', depositId: picked.id };
      rover.autoTask = true;
      shortfall[pickedRes] -= ROVERS[rover.kind].capacityKg;
      if (shortfall[pickedRes] <= 1) {
        const i = wanted.indexOf(pickedRes);
        if (i >= 0) wanted.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------ rover logic ----
  private updateRover(r: Rover): void {
    const def = ROVERS[r.kind];

    if (!r.recharge && r.command.type !== 'idle') {
      const low =
        r.battery <= def.maxBatteryKWh * ROVER_CHARGE_THRESHOLD &&
        r.goal !== 'charge' &&
        r.goal !== 'toCharge';
      if (low) {
        r.recharge = true;
        if (!r.lowBatteryNotified) {
          r.lowBatteryNotified = true;
          this.event('warn', `${r.label} is low on power — returning to charge.`);
        }
      } else if (r.battery > def.maxBatteryKWh * (ROVER_CHARGE_THRESHOLD + 0.25)) {
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
            r.command = { type: 'idle' };
            r.goal = 'idle';
            r.phase = 'idle';
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
          r.command = { type: 'idle' };
          r.goal = 'idle';
          r.phase = 'idle';
          if (b) b.workerId = null;
          break;
        }
        this.doBuild(r, b);
        break;
      }
    }
  }

  private doMoveTo(r: Rover, x: number, z: number): void {
    const dist = Math.hypot(x - r.x, z - r.z);
    if (dist > ARRIVE_EPS) {
      this.setTravel(r, x, z, 'move');
    } else {
      r.command = { type: 'idle' };
      r.goal = 'idle';
      r.phase = 'idle';
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
    if (r.battery >= def.maxBatteryKWh * 0.98) {
      r.recharge = false;
      r.phase = 'idle';
      r.goal = 'idle';
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

  private setTravel(r: Rover, tx: number, tz: number, goal: RoverGoal): void {
    r.gx = tx;
    r.gz = tz;
    r.goal = goal;
    r.phase = 'moving';
    r.statusText = roverStatusText(r);
  }

  private moveRover(r: Rover): void {
    if (r.phase !== 'moving' || r.goal === 'idle') return;
    const def = ROVERS[r.kind];
    const hours = SIM_TICK * HOURS_PER_SEC;
    const dx = r.gx - r.x;
    const dz = r.gz - r.z;
    const dist = Math.hypot(dx, dz);
    const step = def.cruiseSpeed * SIM_TICK;
    if (dist <= step + ARRIVE_EPS) {
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
    r.statusText = 'Disabled — out of power';
    this.event('crit', `${r.label} is stranded — battery flat.`);
  }

  // ------------------------------------------------------------ mining ----
  private doMine(r: Rover, dep: Deposit): void {
    const def = ROVERS[r.kind];
    const hours = SIM_TICK * HOURS_PER_SEC;

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
      this.setTravel(r, dep.x, dep.z, 'mine');
      return;
    }
    r.goal = 'mine';
    r.phase = 'working';
    r.statusText = 'Mining';
    const rate = RESOURCES[dep.resource].mineRateKg * def.mineSpeedMul;
    const gained = Math.min(rate * SIM_TICK, dep.amount, def.capacityKg - cargoMass(r));
    if (gained > 0) {
      dep.amount -= gained;
      r.cargo[dep.resource] += gained;
    }
    r.battery = Math.max(0, r.battery - def.workPowerKw * hours);
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
    }
    if (blocked && cargoMass(r) > 0.01) {
      this.event('warn', `${r.label} still holds cargo — those silos are full.`);
    }
    const cmd = r.command;
    if (cmd.type === 'mine' && !r.autoTask) {
      // A player-ordered mining run keeps going until the seam is dry.
      const dep = this.world.deposits.find((d) => d.id === cmd.depositId);
      if (!dep || dep.amount <= 0) r.command = { type: 'idle' };
    } else {
      // Automatic runs are single-trip: dropping the load returns the rover to
      // the pool so the scheduler can re-decide what the colony needs *now*.
      r.command = { type: 'idle' };
      r.autoTask = false;
    }
    r.goal = 'idle';
    r.phase = 'idle';
    r.statusText = roverStatusText(r);
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
      r.command = { type: 'idle' };
      r.goal = 'idle';
      r.phase = 'idle';
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

    const work = ROVERS[r.kind].buildPower * mul;
    const before = b.progress;
    b.progress = Math.min(1, b.progress + (work * SIM_TICK) / b.buildTime);
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].workPowerKw * hours * 0.6);
    if (r.battery <= 0) this.disable(r);
    if (before < 1 && b.progress >= 1) {
      this.completeBuilding(b);
      r.command = { type: 'idle' };
      r.goal = 'idle';
      r.phase = 'idle';
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

    // ---- stranded rovers --------------------------------------------------
    for (const r of this.rovers) {
      const key = `rover-dead-${r.id}`;
      if (r.phase === 'disabled') {
        A.raise(key, 'warn', `${r.label} stranded`, 'Battery flat, out in the field.', t, stamp, r.id);
      } else {
        A.clear(key, t, stamp);
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
      simTime: this.simTime,
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
        autoHaul: r.autoHaul,
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
      })),
      alerts: this.alerts.snapshot(),
    };
  }

  /** Restore state from an earlier snapshot(). Mutates this sim in place. */
  restore(data: any): void {
    if (!data || typeof data !== 'object') throw new Error('empty save');
    if (data.version !== SAVE_VERSION) {
      throw new Error(`unsupported save version ${data.version}`);
    }
    this.seed = data.seed;
    this.simTime = data.simTime || 0;
    this.clock.restore(data.clock);
    this.storage = { ...emptyAmounts(), ...(data.storage ?? {}) };
    this.gameOver = data.gameOver ?? null;

    this.world = new World({ seed: data.seed, nearDeposits: 0.2 });
    this.world.deposits = (data.deposits ?? []).map((d: any) => ({
      id: d.id,
      resource: d.resource,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
    }));

    this.rovers = (data.rovers ?? []).map((r: any) => ({
      id: r.id,
      kind: r.kind,
      label: ROVERS[r.kind as RoverKind].label,
      x: r.x,
      y: this.world.heightAt(r.x, r.z),
      z: r.z,
      heading: r.heading,
      battery: r.battery,
      cargo: { ...emptyAmounts(), ...(r.cargo ?? {}) },
      phase: 'idle' as RoverPhase,
      command: { ...r.command } as RoverCommand,
      goal: 'idle' as RoverGoal,
      gx: r.x,
      gz: r.z,
      gid: 0,
      recharge: false,
      lowBatteryNotified: false,
      statusText: 'Idle',
      chargeSat: 0,
      autoTask: false,
      autoHaul: r.autoHaul !== false,
    }));

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
    }));

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

export { colonistStatusText };
