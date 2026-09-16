/**
 * Performance instrumentation — refactor roadmap Milestone 1 (§58)
 * and Phase 0 baseline diagnostics.
 *
 * Development-only diagnostics capable of reporting:
 *   - simulation tick
 *   - simulation time
 *   - real elapsed time
 *   - entities (rovers + buildings + deposits + pois)
 *   - rovers, buildings, active tasks
 *   - pathfinding operations
 *   - command count
 *   - worker messages
 *   - view generation time
 *   - simulation step time
 *
 * Design:
 *   - Process-wide enable switch, default off (like invariant checks).
 *   - Counters are cheap integers; timing uses performance.now().
 *   - Tree-shakes out of the app bundle when not imported — tests and
 *     dev tooling import it, the game does not.
 *   - `Simulation`, `World`, `NavGrid`, `applyCommand`, hosts and
 *     `workerRuntime` call into the singleton when enabled.
 */

export interface ProfilerSnapshot {
  /** Wall-clock since reset (ms). */
  realMs: number;
  /** Simulation ticks executed since reset. */
  ticks: number;
  /** Simulation time (game seconds) at snapshot moment. */
  simTime: number;
  /** Simulation time (sols) derived from simTime. */
  simSols: number;
  /** Entity counts. */
  entities: number;
  rovers: number;
  buildings: number;
  deposits: number;
  pois: number;
  /** Rovers with active work (non-idle command or queued tasks). */
  activeTasks: number;
  /** Counters since reset. */
  pathfinds: number;
  commands: number;
  workerMessages: number;
  viewGenerations: number;
  /** Timing (ms). */
  stepTimeMs: number;
  viewTimeMs: number;
  /** Averages. */
  avgStepMs: number;
  avgViewMs: number;
  /** Derived rates. */
  ticksPerSec: number;
  pathfindsPerTick: number;
}

export interface ProfilerReport extends ProfilerSnapshot {
  /** Human-readable one-line summary. */
  summary: string;
  /** Multi-line table for dev panel / logs. */
  table: string;
}

class SimProfiler {
  private enabled = false;
  private t0 = 0;

  private ticks = 0;
  private pathfinds = 0;
  private commands = 0;
  private workerMessages = 0;
  private viewGenerations = 0;

  private stepTimeMs = 0;
  private viewTimeMs = 0;

  private lastStepMs = 0;
  private lastViewMs = 0;

  enable(): void {
    this.enabled = true;
    if (this.t0 === 0) this.t0 = now();
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.t0 = now();
    this.ticks = 0;
    this.pathfinds = 0;
    this.commands = 0;
    this.workerMessages = 0;
    this.viewGenerations = 0;
    this.stepTimeMs = 0;
    this.viewTimeMs = 0;
    this.lastStepMs = 0;
    this.lastViewMs = 0;
  }

  /** Called from Simulation.step for each batch of ticks. */
  recordStep(ticks: number, durationMs: number): void {
    if (!this.enabled) return;
    this.ticks += ticks;
    this.stepTimeMs += durationMs;
    this.lastStepMs = durationMs;
  }

  recordPathfinding(): void {
    if (!this.enabled) return;
    this.pathfinds++;
  }

  recordCommand(): void {
    if (!this.enabled) return;
    this.commands++;
  }

  recordWorkerMessage(): void {
    if (!this.enabled) return;
    this.workerMessages++;
  }

  recordViewGeneration(durationMs: number): void {
    if (!this.enabled) return;
    this.viewGenerations++;
    this.viewTimeMs += durationMs;
    this.lastViewMs = durationMs;
  }

  /** Build a snapshot from live sim state + internal counters. */
  snapshot(sim?: {
    simTime: number;
    rovers: { command: { type: string }; pending: unknown[] }[];
    buildings: unknown[];
    world: { deposits: unknown[]; pois: unknown[] };
  }): ProfilerSnapshot {
    const realMs = this.t0 ? now() - this.t0 : 0;
    const rovers = sim?.rovers.length ?? 0;
    const buildings = sim?.buildings.length ?? 0;
    const deposits = sim?.world.deposits.length ?? 0;
    const pois = sim?.world.pois.length ?? 0;
    const entities = rovers + buildings + deposits + pois;
    const activeTasks = sim
      ? sim.rovers.filter((r) => r.command.type !== 'idle' || r.pending.length > 0).length
      : 0;

    const ticks = this.ticks;
    const avgStep = ticks > 0 ? this.stepTimeMs / ticks : 0;
    const avgView = this.viewGenerations > 0 ? this.viewTimeMs / this.viewGenerations : 0;
    const ticksPerSec = realMs > 0 ? (ticks / realMs) * 1000 : 0;
    const pathfindsPerTick = ticks > 0 ? this.pathfinds / ticks : 0;

    return {
      realMs,
      ticks,
      simTime: sim?.simTime ?? 0,
      simSols: sim ? sim.simTime / 240 : 0, // SOL_SECONDS = 240 game seconds per sol
      entities,
      rovers,
      buildings,
      deposits,
      pois,
      activeTasks,
      pathfinds: this.pathfinds,
      commands: this.commands,
      workerMessages: this.workerMessages,
      viewGenerations: this.viewGenerations,
      stepTimeMs: this.stepTimeMs,
      viewTimeMs: this.viewTimeMs,
      avgStepMs: avgStep,
      avgViewMs: avgView,
      ticksPerSec,
      pathfindsPerTick,
    };
  }

  report(sim?: {
    simTime: number;
    rovers: { command: { type: string }; pending: unknown[] }[];
    buildings: unknown[];
    world: { deposits: unknown[]; pois: unknown[] };
  }): ProfilerReport {
    const snap = this.snapshot(sim);
    const summary = `tick ${snap.ticks} · ${snap.simTime.toFixed(1)}s sim · ${snap.realMs.toFixed(0)}ms real · ${snap.rovers} rovers ${snap.buildings} bldgs ${snap.activeTasks} active · ${snap.pathfinds} pathfinds · ${snap.commands} cmds · step ${snap.avgStepMs.toFixed(3)}ms avg · view ${snap.avgViewMs.toFixed(3)}ms avg`;
    const table = [
      '┌─────────────────────────────┐',
      '│ SIMULATION PROFILER         │',
      '├─────────────────────────────┤',
      `│ Tick:             ${String(snap.ticks).padStart(10)} │`,
      `│ Sim Time:         ${snap.simTime.toFixed(1).padStart(8)}s │`,
      `│ Real:             ${snap.realMs.toFixed(0).padStart(8)}ms │`,
      `│ Entities:         ${String(snap.entities).padStart(8)} │`,
      `│ Rovers:           ${String(snap.rovers).padStart(8)} │`,
      `│ Buildings:        ${String(snap.buildings).padStart(8)} │`,
      `│ Active tasks:     ${String(snap.activeTasks).padStart(8)} │`,
      `│ Pathfinds:        ${String(snap.pathfinds).padStart(8)} │`,
      `│ Commands:         ${String(snap.commands).padStart(8)} │`,
      `│ Worker msgs:      ${String(snap.workerMessages).padStart(8)} │`,
      `│ View gens:        ${String(snap.viewGenerations).padStart(8)} │`,
      `│ Step total:       ${snap.stepTimeMs.toFixed(1).padStart(8)}ms │`,
      `│ View total:       ${snap.viewTimeMs.toFixed(1).padStart(8)}ms │`,
      `│ Avg step:         ${snap.avgStepMs.toFixed(3).padStart(8)}ms │`,
      `│ Avg view:         ${snap.avgViewMs.toFixed(3).padStart(8)}ms │`,
      '└─────────────────────────────┘',
    ].join('\n');
    return { ...snap, summary, table };
  }

  get lastStep(): number {
    return this.lastStepMs;
  }

  get lastView(): number {
    return this.lastViewMs;
  }
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// Singleton — process-wide, like invariant checks.
const profiler = new SimProfiler();

export function getProfiler(): SimProfiler {
  return profiler;
}

export function setProfilerEnabled(on: boolean): void {
  if (on) {
    profiler.enable();
  } else {
    profiler.disable();
  }
}

export function profilerEnabled(): boolean {
  return profiler.isEnabled();
}

export function resetProfiler(): void {
  profiler.reset();
}
