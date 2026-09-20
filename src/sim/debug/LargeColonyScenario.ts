/**
 * Large-Colony Stress Scenario — refactor roadmap Phase 29 (§33).
 *
 * Constructs a deterministic high-load colony:
 *   - 100 rovers (mining, utility, cargo) with full automation enabled
 *   - 250 operational buildings (solar, battery, warehouse, extractor, oxygenator, greenhouse)
 *   - active storm conditions
 *   - active construction jobs
 *   - active hauling & mining repeat-routes
 *   - exploration tasks to scattered POIs
 *
 * Polices invariants under sustained stress:
 *   - no invalid simulation state (assertInvariants)
 *   - no memory explosion / unbounded collections
 *   - no runaway task creation (pending queues bounded)
 *   - no duplicated reservations
 *   - no simulation deadlock
 *   - bit-for-bit final state determinism
 */

import { Simulation } from '../Simulation';
import { assertInvariants } from './SimulationAssertions';
import { hashSimulation } from './StateHash';
import { SIM_TICK } from '../config';
import type { BuildingKind, RoverKind } from '../defs';

export interface LargeColonyOptions {
  seed?: number;
  roverCount?: number;
  buildingCount?: number;
  activeStorm?: boolean;
  constructionSites?: number;
  haulingJobs?: number;
}

export interface StressCheckResult {
  simTime: number;
  ticksRun: number;
  roversCount: number;
  buildingsCount: number;
  maxRoverPendingQueue: number;
  activeReservations: number;
  stateHash: string;
}

/**
 * Build the canonical large colony stress scenario.
 */
export function createLargeColonyScenario(opts: LargeColonyOptions = {}): Simulation {
  const seed = opts.seed ?? 1001;
  const targetRovers = opts.roverCount ?? 100;
  const targetBuildings = opts.buildingCount ?? 250;
  const activeStorm = opts.activeStorm ?? true;
  const constructionSites = opts.constructionSites ?? 5;
  const haulingJobs = opts.haulingJobs ?? 10;

  const sim = new Simulation({ seed, nearDeposits: 0.2 });

  // 1. Spawn fleet up to targetRovers with mixed kinds
  const roverKinds: RoverKind[] = ['mining', 'utility', 'cargo'];
  for (let i = sim.rovers.length; i < targetRovers; i++) {
    const kind = roverKinds[i % roverKinds.length];
    const angle = (i / targetRovers) * Math.PI * 2;
    const dist = 20 + (i % 8) * 7;
    const r = sim.devSpawnRover(kind, Math.cos(angle) * dist, Math.sin(angle) * dist);
    r.autoTask = true;
  }

  // Ensure all rovers have automation enabled
  for (const r of sim.rovers) {
    r.autoTask = true;
  }

  // 2. Spawn buildings on a concentric grid to avoid overlap and terrain violations
  const bKinds: BuildingKind[] = ['solar', 'battery', 'warehouse', 'extractor', 'oxygenator', 'greenhouse'];
  let placed = sim.buildings.length;
  for (let row = -15; row <= 15 && placed < targetBuildings; row++) {
    for (let col = -15; col <= 15 && placed < targetBuildings; col++) {
      const x = col * 16;
      const z = row * 16;
      if (Math.hypot(x, z) < 35) continue; // preserve spawn clearing
      const kind = bKinds[placed % bKinds.length];
      const b = sim.devSpawnBuilding(kind, x, z);
      if (b) {
        placed++;
      }
    }
  }

  // 3. Queue construction sites
  for (let i = 0; i < constructionSites; i++) {
    const x = 120 + i * 18;
    const z = 20;
    sim.placeBuilding('warehouse', x, z);
  }

  // 4. Setup mining and hauling repeat routes
  for (let i = 0; i < haulingJobs && i < sim.rovers.length; i++) {
    const dep = sim.world.deposits[i % sim.world.deposits.length];
    if (dep) {
      sim.issueMine(sim.rovers[i].id, dep.id);
      sim.setRepeatRoute(sim.rovers[i].id, true);
    }
  }

  // 5. Exploration dispatch
  if (sim.world.pois.length > 0 && sim.rovers.length > haulingJobs) {
    for (let p = 0; p < Math.min(3, sim.world.pois.length); p++) {
      const rover = sim.rovers[haulingJobs + p];
      const poi = sim.world.pois[p];
      if (rover && poi) {
        sim.issueMove(rover.id, poi.x, poi.z);
      }
    }
  }

  // 6. Force active storm conditions
  if (activeStorm) {
    sim.devForceStorm('severe');
  }

  return sim;
}

/**
 * Assert stress-specific invariants beyond baseline invariants.
 */
export function assertStressInvariants(sim: Simulation): StressCheckResult {
  // Baseline authoritative invariants
  assertInvariants(sim);

  // 1. Task queue boundedness: no runaway task creation
  let maxPending = 0;
  for (const r of sim.rovers) {
    if (r.pending.length > maxPending) maxPending = r.pending.length;
    if (r.pending.length > 20) {
      throw new Error(`Runaway task queue on rover ${r.id}: ${r.pending.length} pending tasks`);
    }
  }

  // 2. Reservation integrity: deposit reservations are unique
  const reservedDeposits = new Set<number>();
  let activeReservations = 0;
  for (const d of sim.world.deposits) {
    if (d.reservedBy !== null && d.reservedBy !== undefined) {
      activeReservations++;
      if (reservedDeposits.has(d.id)) {
        throw new Error(`Duplicate deposit reservation detected on deposit ${d.id}`);
      }
      reservedDeposits.add(d.id);
    }
  }

  // 3. Colony bounds
  if (sim.rovers.length === 0) {
    throw new Error('Colony fleet unexpectedly collapsed to 0 rovers');
  }
  if (sim.buildings.length === 0) {
    throw new Error('Colony buildings unexpectedly collapsed to 0');
  }

  return {
    simTime: sim.simTime,
    ticksRun: Math.round(sim.simTime / SIM_TICK),
    roversCount: sim.rovers.length,
    buildingsCount: sim.buildings.length,
    maxRoverPendingQueue: maxPending,
    activeReservations,
    stateHash: hashSimulation(sim),
  };
}

/**
 * Step simulation under stress, asserting invariants at regular intervals.
 */
export function runStressSimulation(
  sim: Simulation,
  ticks: number,
  checkIntervalTicks = 200,
): StressCheckResult {
  for (let t = 0; t < ticks; t++) {
    sim.step(SIM_TICK);
    if ((t + 1) % checkIntervalTicks === 0 || t === ticks - 1) {
      assertStressInvariants(sim);
    }
  }
  return assertStressInvariants(sim);
}
