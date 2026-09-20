/**
 * Simulation fleet performance benchmarking and regression suite — Phase 28.
 *
 * Provides standardized instrumentation for fleet scaling (10, 25, 50, 100, 250 rovers),
 * measuring:
 *   - simulation tick duration (avg & peak)
 *   - pathfinding throughput
 *   - view projection time
 *   - worker transport overhead (structured clone & mirror apply)
 *   - payload serialization size
 */

import { Simulation } from '../Simulation';
import { projectView } from '../host/projection';
import { ColonyMirror } from '../host/mirror';
import { SIM_TICK } from '../config';
import type { RoverKind } from '../defs';

export interface FleetPerformanceMetrics {
  roverCount: number;
  ticks: number;
  avgTickMs: number;
  maxTickMs: number;
  avgPathfindMs: number;
  viewGenMs: number;
  cloneMs: number;
  applyMs: number;
  payloadBytes: number;
}

/**
 * Run a deterministic fleet scaling benchmark.
 */
export function benchmarkFleet(roverCount: number, ticks = 30, seed = 42): FleetPerformanceMetrics {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  const kinds: RoverKind[] = ['mining', 'utility', 'cargo'];

  for (let i = sim.rovers.length; i < roverCount; i++) {
    const kind = kinds[i % kinds.length];
    const angle = (i / roverCount) * Math.PI * 2;
    const dist = 15 + (i % 6) * 7;
    sim.devSpawnRover(kind, Math.cos(angle) * dist, Math.sin(angle) * dist);
  }

  // Issue dynamic orders so rovers are actively moving, pathfinding, and checking avoidance
  for (let i = 0; i < sim.rovers.length; i++) {
    const r = sim.rovers[i];
    const tx = ((i * 17) % 180) - 90;
    const tz = ((i * 31) % 180) - 90;
    sim.issueMove(r.id, tx, tz);
  }

  // 1. Measure tick durations
  let totalTickMs = 0;
  let maxTickMs = 0;
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now();
    sim.step(SIM_TICK);
    const dt = performance.now() - t0;
    totalTickMs += dt;
    if (dt > maxTickMs) maxTickMs = dt;
  }
  const avgTickMs = totalTickMs / ticks;

  // 2. Measure pathfinding throughput
  const pathfinds = 15;
  const t0Path = performance.now();
  for (let p = 0; p < pathfinds; p++) {
    const fromX = ((p * 23) % 100) - 50;
    const fromZ = ((p * 29) % 100) - 50;
    const toX = ((p * 37) % 180) - 90;
    const toZ = ((p * 41) % 180) - 90;
    sim.world.findPath(fromX, fromZ, toX, toZ);
  }
  const avgPathfindMs = (performance.now() - t0Path) / pathfinds;

  // 3. Measure view projection
  const t0View = performance.now();
  const view = projectView(sim, 'worker', {}, [], []);
  const viewGenMs = performance.now() - t0View;

  // 4. Measure worker transport (structured clone & mirror apply)
  const t0Clone = performance.now();
  const cloned = structuredClone(view);
  const cloneMs = performance.now() - t0Clone;

  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    view,
  );
  const t0Apply = performance.now();
  mirror.apply(cloned);
  const applyMs = performance.now() - t0Apply;

  const payloadBytes = JSON.stringify(view).length;

  return {
    roverCount,
    ticks,
    avgTickMs,
    maxTickMs,
    avgPathfindMs,
    viewGenMs,
    cloneMs,
    applyMs,
    payloadBytes,
  };
}
