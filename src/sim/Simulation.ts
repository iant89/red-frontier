import { World } from './World';
import { clamp, lerp } from '../lib/rng';
import {
  SIM_TICK,
  SPAWN_X,
  SPAWN_Z,
  BASE_STORAGE_CAPACITY,
  ROVER_CHARGE_THRESHOLD,
  ROVER_CHARGE_RATE_KWH,
} from './config';
import type {
  ResourceId,
  ResourceAmounts,
  RoverKind,
  BuildingKind,
} from './defs';
import { RESOURCES, ROVERS, BUILDINGS, emptyAmounts } from './defs';

export interface Depot {
  x: number;
  z: number;
  label: string;
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
  command: RoverCommand;
  goal: RoverGoal;
  gx: number; // goal target x (travel destination)
  gz: number;
  gid: number; // goal target entity id
  recharge: boolean;
  lowBatteryNotified: boolean;
  statusText: string;
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

export type RoverPhase =
  | 'idle'
  | 'moving'
  | 'working'
  | 'charging'
  | 'disabled';

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
}

export interface SimEvent {
  severity: 'info' | 'ok' | 'warn' | 'crit';
  text: string;
  time: number;
}

const ARRIVE_EPS = 0.6;

function cargoMass(r: Rover): number {
  let t = 0;
  for (const k of Object.keys(r.cargo) as ResourceId[]) t += r.cargo[k];
  return t;
}

function remainingCostTotal(b: Building): number {
  let t = 0;
  for (const k of Object.keys(b.remainingCost) as ResourceId[]) t += b.remainingCost[k];
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
      return 'Idle';
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
    case 'charge':
      return 'Charging';
    default:
      return r.phase;
  }
}

export class Simulation {
  world: World;
  version = 1;
  simTime = 0; // seconds of simulation
  private nextId = 1000;
  seed: number;

  rovers: Rover[] = [];
  buildings: Building[] = [];
  storage: ResourceAmounts = emptyAmounts();

  events: SimEvent[] = [];
  private lowBatterySent = new Map<number, number>();

  constructor(params: { seed: number; nearDeposits?: number }) {
    this.seed = params.seed;
    this.world = new World({
      seed: params.seed,
      nearDeposits: params.nearDeposits ?? 0.2,
    });
    this.spawnStart();
  }

  // ---------- setup ----------
  private spawnStart(): void {
    // two rovers near the landing pad, full batteries
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
    });
  }

  private allocId(): number {
    return this.nextId++;
  }

  // ---------- queries for UI / renderer ----------
  storageCapacity(): number {
    let cap = BASE_STORAGE_CAPACITY;
    for (const b of this.buildings) {
      if (b.state === 'online') cap += BUILDINGS[b.kind].storageCapacityKg;
    }
    return cap;
  }

  storageTotal(): number {
    let t = 0;
    for (const r of Object.keys(this.storage) as ResourceId[]) t += this.storage[r];
    return t;
  }

  storageFull(): boolean {
    return this.storageTotal() >= this.storageCapacity() - 0.01;
  }

  defsFor(kind: RoverKind) {
    return ROVERS[kind];
  }

  roverById(id: number): Rover | undefined {
    return this.rovers.find((r) => r.id === id);
  }

  buildingById(id: number): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  onlineWarehouses(): Building[] {
    return this.buildings.filter(
      (b) => b.state === 'online' && BUILDINGS[b.kind].storageCapacityKg > 0,
    );
  }

  /** Nearest deposit whose footprint contains (x,z). */
  depositAt(x: number, z: number, maxReach = 8): { d: import('./World').Deposit; reach: number } | null {
    let best: import('./World').Deposit | null = null;
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

  buildingAt(x: number, z: number, maxReach = 6): { b: Building; reach: number } | null {
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

  /** Can a rover deposit cargo at (x,z)? */
  nearDepot(x: number, z: number): boolean {
    if (Math.hypot(SPAWN_X - x, SPAWN_Z - z) < 14) return true;
    for (const w of this.onlineWarehouses()) {
      if (Math.hypot(w.x - x, w.z - z) < BUILDINGS[w.kind].radius + 5) return true;
    }
    return false;
  }

  // ---------- player commands ----------
  issueMove(roverId: number, x: number, z: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    r.command = { type: 'moveTo', x, z };
    r.recharge = false;
  }

  issueMine(roverId: number, depositId: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const dep = this.world.deposits.find((d) => d.id === depositId);
    if (!dep || dep.amount <= 0) {
      this.push('info', 'Deposit is depleted.');
      return;
    }
    r.command = { type: 'mine', depositId };
    r.recharge = false;
  }

  issueConstruct(roverId: number, buildingId: number): void {
    const r = this.roverById(roverId);
    if (!r || r.phase === 'disabled') return;
    const b = this.buildingById(buildingId);
    if (!b || b.state === 'online') return;
    if (!BUILDINGS[b.kind].buildableBy.includes(r.kind)) {
      this.push('warn', `${r.label} can't build a ${BUILDINGS[b.kind].label}.`);
      return;
    }
    r.command = { type: 'construct', buildingId };
    r.recharge = false;
  }

  stopRover(roverId: number): void {
    const r = this.roverById(roverId);
    if (!r) return;
    r.command = { type: 'idle' };
    r.recharge = false;
  }

  // ---------- building placement ----------
  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    if (!this.world.inBounds(x, z)) return 'Outside the playable region.';
    const def = BUILDINGS[kind];
    const slope = this.world.slopeAt(x, z);
    const maxSlope = kind === 'habitat' ? 0.12 : 0.22;
    if (slope > maxSlope) return 'Terrain too steep here.';
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
      this.push('warn', err);
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
    };
    this.buildings.push(b);
    this.push('info', `Placed ${def.label} — assigning a builder.`);
    return b;
  }

  // ---------- main loop ----------
  private acc = 0;

  /** Advance simulation by frameDt real seconds (fixed substeps applied). */
  step(frameDt: number): number {
    if (frameDt <= 0) return 0;
    this.acc += frameDt;
    let ticks = 0;
    while (this.acc >= SIM_TICK) {
      this.tick();
      this.acc -= SIM_TICK;
      ticks++;
    }
    if (this.acc > SIM_TICK) this.acc = SIM_TICK;
    return ticks;
  }

  private tick(): void {
    this.simTime += SIM_TICK;
    // (future) weather → power → utilities ordering will slot here
    this.assignBuilders();
    this.assignIdleTasks();
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      this.updateRover(r);
    }
    this.drainRoverMoves();
  }

  /** Resolve rover movement that was queued this tick. */
  private drainRoverMoves(): void {
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      this.moveRover(r);
    }
  }

  // ---------- task assignment ----------
  private assignBuilders(): void {
    const sites = this.buildings.filter((b) => b.state !== 'online');
    for (const b of sites) {
      if (b.workerId !== null) continue;
      // find nearest idle, capable rover
      const capable = this.rovers
        .filter(
          (r) =>
            r.phase !== 'disabled' &&
            r.command.type === 'idle' &&
            BUILDINGS[b.kind].buildableBy.includes(r.kind),
        )
        .sort(
          (a, c) =>
            Math.hypot(a.x - b.x, a.z - b.z) -
            Math.hypot(c.x - b.x, c.z - b.z),
        );
      const worker = capable[0];
      if (!worker) continue;
      worker.command = { type: 'construct', buildingId: b.id };
      b.workerId = worker.id;
    }
  }

  private assignIdleTasks(): void {
    // reserved for future autonomous/hauling tasks
  }

  // ---------- rover logic ----------
  private updateRover(r: Rover): void {
    const def = ROVERS[r.kind];

    // low-battery behaviour: recharge before continuing meaningful work
    if (!r.recharge && r.command.type !== 'idle') {
      const low =
        r.battery <= def.maxBatteryKWh * ROVER_CHARGE_THRESHOLD &&
        r.goal !== 'charge' &&
        r.goal !== 'toCharge';
      if (low) {
        r.recharge = true;
        if (!r.lowBatteryNotified) {
          r.lowBatteryNotified = true;
          this.push('warn', `${r.label} is low on power — returning to charge.`);
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
          r.command = { type: 'idle' };
          r.goal = 'idle';
          r.phase = 'idle';
          this.push('info', `${r.label}: deposit exhausted.`);
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

  /** Simple move-to-waypoint command. */
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
    r.phase = r.goal === 'idle' ? 'idle' : r.phase;
    r.statusText = 'Idle';
    // passively trickle-charge if parked at base
    if (this.nearDepot(r.x, r.z) && r.battery < ROVERS[r.kind].maxBatteryKWh) {
      r.battery = Math.min(
        ROVERS[r.kind].maxBatteryKWh,
        r.battery + ROVER_CHARGE_RATE_KWH * SIM_TICK,
      );
      r.phase = 'charging';
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
    const atBase = Math.hypot(SPAWN_X - r.x, SPAWN_Z - r.z) < 3;
    if (!atBase && r.goal !== 'toCharge') {
      this.setTravel(r, SPAWN_X, SPAWN_Z, 'toCharge');
    } else if (atBase || r.goal === 'charge') {
      r.goal = 'charge';
      r.phase = 'charging';
      r.statusText = 'Charging';
      r.battery = Math.min(def.maxBatteryKWh, r.battery + ROVER_CHARGE_RATE_KWH * SIM_TICK);
    }
  }

  /** set rover travelling to (tx,tz) with given goal */
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
    const dx = r.gx - r.x;
    const dz = r.gz - r.z;
    const dist = Math.hypot(dx, dz);
    const step = def.cruiseSpeed * SIM_TICK;
    if (dist <= step + ARRIVE_EPS) {
      r.x = r.gx;
      r.z = r.gz;
      r.phase = 'working'; // arrived; handle in logic
      this.onArrive(r);
      return;
    }
    const ux = dx / dist;
    const uz = dz / dist;
    r.x += ux * step;
    r.z += uz * step;
    // smooth heading toward travel direction
    const targetHead = Math.atan2(ux, uz);
    r.heading = lerpAngle(r.heading, targetHead, 0.18);
    r.y = this.world.heightAt(r.x, r.z);
    r.battery = Math.max(0, r.battery - def.movePowerKw * SIM_TICK);
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
        // arrived at a plain move waypoint
        const cmd = r.command;
        if (cmd.type === 'moveTo') {
          r.command = { type: 'idle' };
          r.goal = 'idle';
          r.phase = 'idle';
        } else r.goal = 'idle';
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
    this.push('crit', `${r.label} is disabled — out of power.`);
  }

  // ----- mining command -----
  private doMine(r: Rover, dep: import('./World').Deposit): void {
    const def = ROVERS[r.kind];
    if (cargoMass(r) >= def.capacityKg * 0.995) {
      this.beginUnload(r);
      return;
    }
    const reach = dep.radius + 2.6;
    const dist = Math.hypot(dep.x - r.x, dep.z - r.z);
    if (dist > reach) {
      this.setTravel(r, dep.x, dep.z, 'mine');
      return;
    }
    // mining work
    r.goal = 'mine';
    r.phase = 'working';
    r.statusText = 'Mining';
    const rate =
      RESOURCES[dep.resource].mineRateKg * def.mineSpeedMul;
    const gained = Math.min(
      rate * SIM_TICK,
      dep.amount,
      def.capacityKg - cargoMass(r),
    );
    if (gained > 0) {
      dep.amount -= gained;
      r.cargo[dep.resource] += gained;
    }
    r.battery = Math.max(0, r.battery - def.workPowerKw * SIM_TICK);
    if (r.battery <= 0) this.disable(r);
    if (dep.amount <= 0.01) {
      this.push('info', `${r.label} depleted a ${RESOURCES[dep.resource].label} deposit.`);
    }
  }

  private beginUnload(r: Rover): void {
    // move to nearest depot and dump
    const w = this.onlineWarehouses()
      .map((b) => ({ x: b.x, z: b.z }))
      .filter((p) => Math.hypot(p.x - r.x, p.z - r.z) < 1e9)
      .sort(
        (a, b) =>
          Math.hypot(a.x - r.x, a.z - r.z) - Math.hypot(b.x - r.x, b.z - r.z),
      )[0];
    const depot = w ?? { x: SPAWN_X, z: SPAWN_Z };
    this.setTravel(r, depot.x, depot.z, 'toDepot');
  }

  private tryUnload(r: Rover): void {
    if (!this.nearDepot(r.x, r.z)) {
      this.setTravel(r, SPAWN_X, SPAWN_Z, 'toDepot');
      return;
    }
    // unload into colony storage respecting capacity
    let moved = 0;
    for (const res of Object.keys(r.cargo) as ResourceId[]) {
      if (r.cargo[res] <= 0) continue;
      const room = this.storageCapacity() - this.storageTotal();
      if (room <= 0.01) break;
      const take = Math.min(r.cargo[res], room);
      r.cargo[res] -= take;
      this.storage[res] += take;
      moved += take;
    }
    if (moved > 0.01) {
      this.push('ok', `${r.label} delivered ${Math.round(moved)} kg to storage.`);
    } else {
      this.push('warn', 'Storage is full — can’t unload.');
    }
    // continue mining deposit if command still mine, else idle
    const cmd = r.command;
    if (cmd.type === 'mine') {
      const dep = this.world.deposits.find((d) => d.id === cmd.depositId);
      if (!dep || dep.amount <= 0) {
        r.command = { type: 'idle' };
        r.goal = 'idle';
        r.phase = 'idle';
      } else {
        r.goal = 'idle';
        r.phase = 'idle';
      }
    } else {
      r.command = { type: 'idle' };
      r.goal = 'idle';
      r.phase = 'idle';
    }
    r.statusText = roverStatusText(r);
  }

  // ----- construct command -----
  private doBuild(r: Rover, b: Building): void {
    const dist = Math.hypot(b.x - r.x, b.z - r.z);
    const siteReach = BUILDINGS[b.kind].radius + 4;
    if (dist > siteReach) {
      if (r.goal !== 'toSite') {
        r.gid = b.id;
        this.setTravel(r, b.x, b.z, 'toSite');
      } else if (r.phase === 'idle') {
        // travelling handled by moveRover; if not moving, nudge to move
        this.setTravel(r, b.x, b.z, 'toSite');
      }
      return;
    }
    // at the site
    r.gid = b.id;
    r.goal = 'build';
    r.phase = 'working';
    r.statusText = 'Building';

    const def = BUILDINGS[b.kind];
    if (remainingCostTotal(b) > 0) {
      // try to commit materials from colony storage
      if (this.hasMaterials(b.remainingCost)) {
        this.consumeMaterials(b.remainingCost);
        for (const res of Object.keys(b.remainingCost) as ResourceId[]) {
          b.remainingCost[res] = 0;
        }
        b.state = 'building';
        b.needsMaterials = false;
        this.push('info', `${r.label} started building ${def.label}.`);
      } else {
        b.needsMaterials = true;
        if (!this.awaitingMats.has(b.id)) {
          this.awaitingMats.set(b.id, this.simTime);
          this.push('warn', `${def.label} is waiting for materials.`);
        }
        return;
      }
    }
    b.needsMaterials = false;
    // progress requires worker presence
    const work = ROVERS[r.kind].buildPower;
    const before = b.progress;
    b.progress = Math.min(1, b.progress + (work * SIM_TICK) / b.buildTime);
    r.battery = Math.max(0, r.battery - ROVERS[r.kind].workPowerKw * SIM_TICK * 0.6);
    if (r.battery <= 0) this.disable(r);
    if (before < 1 && b.progress >= 1) {
      this.finishBuilding(b, r);
    }
  }

  private awaitingMats = new Map<number, number>();

  private finishBuilding(b: Building, r: Rover): void {
    b.state = 'online';
    b.workerId = null;
    r.command = { type: 'idle' };
    r.goal = 'idle';
    r.phase = 'idle';
    const def = BUILDINGS[b.kind];
    this.push(
      'ok',
      `${def.label} is online${def.storageCapacityKg ? ` — storage +${def.storageCapacityKg} kg` : ''}.`,
    );
  }

  private hasMaterials(amounts: ResourceAmounts): boolean {
    for (const res of Object.keys(amounts) as ResourceId[]) {
      if (amounts[res] > 0 && this.storage[res] < amounts[res]) return false;
    }
    return true;
  }

  private consumeMaterials(amounts: ResourceAmounts): void {
    for (const res of Object.keys(amounts) as ResourceId[]) {
      this.storage[res] = Math.max(0, this.storage[res] - amounts[res]);
    }
  }

  // ---------- events ----------
  private push(severity: SimEvent['severity'], text: string): void {
    if (this.events.length > 40) this.events.shift();
    this.events.push({ severity, text, time: this.simTime });
  }

  drainEvents(): SimEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // ---------- persistence (plain serializable data, no renderer state) ----------
  snapshot(): object {
    return {
      version: this.version,
      seed: this.seed,
      simTime: this.simTime,
      storage: { ...this.storage },
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
      })),
    };
  }

  /** Restore state from an earlier snapshot(). Mutates this sim in place. */
  restore(data: any): void {
    if (!data || data.version !== this.version) throw new Error('unsupported save version');
    this.seed = data.seed;
    this.simTime = data.simTime || 0;
    this.storage = { ...(data.storage ?? emptyAmounts()) };

    // rebuild world from seed for the height field, then overwrite deposits
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
      cargo: { ...(r.cargo ?? emptyAmounts()) },
      phase: 'idle',
      command: { ...r.command } as RoverCommand,
      goal: 'idle',
      gx: r.x,
      gz: r.z,
      gid: 0,
      recharge: false,
      lowBatteryNotified: false,
      statusText: 'Idle',
    }));

    this.buildings = (data.buildings ?? []).map((b: any) => ({
      id: b.id,
      kind: b.kind,
      x: b.x,
      z: b.z,
      rot: b.rot ?? 0,
      state: b.state,
      remainingCost: { ...b.remainingCost },
      needsMaterials: b.needsMaterials,
      progress: b.progress,
      buildTime: b.buildTime,
      workerId: b.workerId,
    }));

    this.awaitingMats.clear();
    this.events = [];
    let maxId = this.nextId;
    for (const e of [...this.rovers, ...this.buildings]) maxId = Math.max(maxId, e.id + 1);
    for (const d of this.world.deposits) maxId = Math.max(maxId, d.id + 1);
    this.nextId = maxId;
  }
}
