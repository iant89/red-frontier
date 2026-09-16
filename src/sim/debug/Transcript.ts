/**
 * Command transcript test infrastructure — refactor roadmap Milestone 1 (§58)
 * and Phase 26 (Deterministic Replay Testing).
 *
 * A transcript is the minimal deterministic input to a colony:
 *   seed + difficulty + worldOptions + a time-ordered list of commands.
 *
 * Replay: create a Simulation with the seed, deliver commands at their tick,
 * advance for a fixed duration, then hash or snapshot. Same transcript must
 * always produce same final hash (replay determinism).
 *
 * This is intentionally plain data (JSON-serializable) so it can be:
 *   - checked into tests as fixtures
 *   - emitted from bug reports
 *   - used for desync detection
 *   - fed into StateHash for regression policing
 *
 * Format:
 * {
 *   seed: number,
 *   difficulty?: DifficultyId,
 *   worldHalf?: number,
 *   region?: string | null,
 *   worldOptions?: Partial<WorldOptions>,
 *   commands: Array<{ tick: number, command: SimCommand }>,
 *   durationTicks?: number   // how long to run after last command, default 1200
 * }
 *
 * Ticks are Simulation ticks (SIM_TICK = 1/20 sec). Commands are SimCommand
 * values, validated by the host's decodeCommand.
 */

import type { SimCommand } from '../host/protocol';
import { Simulation } from '../Simulation';
import { SIM_TICK } from '../config';
import type { DifficultyId, WorldOptions } from '../difficulty';
import { DEFAULT_WORLD_OPTIONS } from '../difficulty';

export interface TranscriptCommand {
  /** Tick at which to deliver this command (0 = before first tick). */
  tick: number;
  command: SimCommand;
}

export interface Transcript {
  seed: number;
  difficulty?: DifficultyId;
  worldHalf?: number;
  region?: string | null;
  worldOptions?: Partial<WorldOptions>;
  commands: TranscriptCommand[];
  /** How many ticks to run total (including before/after commands). Default: last command tick + 1200. */
  durationTicks?: number;
}

/** Result of a replay. */
export interface ReplayResult {
  sim: Simulation;
  ticksRun: number;
  finalTick: number;
}

/**
 * Replay a transcript into a fresh Simulation.
 * Returns the simulation and tick counts.
 */
export function replayTranscript(transcript: Transcript): ReplayResult {
  const sim = new Simulation({
    seed: transcript.seed,
    difficulty: transcript.difficulty ?? 'pioneer',
    worldHalf: transcript.worldHalf,
    region: transcript.region ?? null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS, ...(transcript.worldOptions ?? {}) },
  });

  const sorted = [...transcript.commands].sort((a, b) => a.tick - b.tick);
  const lastCmdTick = sorted.length > 0 ? sorted[sorted.length - 1].tick : 0;
  const duration = transcript.durationTicks ?? lastCmdTick + 1200;

  let cmdIdx = 0;
  // Deliver tick-0 commands before any tick
  while (cmdIdx < sorted.length && sorted[cmdIdx].tick <= 0) {
    applyCommandForTranscript(sim, sorted[cmdIdx].command);
    cmdIdx++;
  }

  for (let tick = 0; tick < duration; tick++) {
    while (cmdIdx < sorted.length && sorted[cmdIdx].tick === tick) {
      applyCommandForTranscript(sim, sorted[cmdIdx].command);
      cmdIdx++;
    }
    sim.step(SIM_TICK);
    // Commands scheduled between ticks (should be none if tick granularity used,
    // but support tick+0.5 etc by delivering any commands whose tick <= current+1)
    while (cmdIdx < sorted.length && sorted[cmdIdx].tick <= tick + 1 && sorted[cmdIdx].tick > tick) {
      // For fractional ticks, deliver at next tick boundary
      if (sorted[cmdIdx].tick <= tick + 1) {
        applyCommandForTranscript(sim, sorted[cmdIdx].command);
        cmdIdx++;
      } else {
        break;
      }
    }
  }

  // Deliver any remaining commands that were beyond duration (should not happen, but be safe)
  while (cmdIdx < sorted.length) {
    applyCommandForTranscript(sim, sorted[cmdIdx].command);
    cmdIdx++;
  }

  return { sim, ticksRun: duration, finalTick: duration };
}

/** Apply a SimCommand via the sim's own methods (mirrors applyCommand but without host validation). */
function applyCommandForTranscript(sim: Simulation, cmd: SimCommand): void {
  // We reuse the same dispatch as host/applyCommand to keep behavior identical
  // Import dynamically to avoid circular deps — but we can inline the minimal set
  // needed for transcripts, or import the module. For simplicity, use direct calls
  // for common commands; fall back to generic apply if available.
  // To avoid async import, we directly call sim methods for the command types we know.

  switch (cmd.type) {
    case 'rover/move':
      sim.issueMove(cmd.roverId, cmd.x, cmd.z, cmd.queue);
      break;
    case 'rover/mine':
      sim.issueMine(cmd.roverId, cmd.depositId, cmd.queue);
      break;
    case 'rover/unload':
      sim.issueUnload(cmd.roverId, cmd.queue);
      break;
    case 'rover/wait':
      sim.issueWait(cmd.roverId, cmd.seconds, cmd.queue);
      break;
    case 'rover/construct':
      sim.issueConstruct(cmd.roverId, cmd.buildingId, cmd.queue);
      break;
    case 'rover/clean':
      sim.issueClean(cmd.roverId, cmd.buildingId, cmd.queue);
      break;
    case 'rover/repair':
      sim.issueRepair(cmd.roverId, cmd.buildingId, cmd.queue);
      break;
    case 'rover/recover':
      sim.issueRecover(cmd.roverId, cmd.strandedId, cmd.queue);
      break;
    case 'rover/salvage':
      sim.issueSalvage(cmd.roverId, cmd.poiId, cmd.queue);
      break;
    case 'rover/stop':
      sim.stopRover(cmd.roverId);
      break;
    case 'rover/repeatRoute':
      sim.setRepeatRoute(cmd.roverId, cmd.on);
      break;
    case 'rover/rule':
      sim.setRoverRule(cmd.roverId, cmd.rule, cmd.on);
      break;
    case 'rover/chargeFloor':
      sim.setChargeFloor(cmd.roverId, cmd.pct);
      break;
    case 'rover/lights':
      sim.setRoverLights(cmd.roverId, cmd.on);
      break;
    case 'building/place': {
      const err = sim.canPlace(cmd.kind, cmd.x, cmd.z);
      if (!err) sim.placeBuilding(cmd.kind, cmd.x, cmd.z);
      break;
    }
    case 'building/toggle':
      sim.setBuildingEnabled(cmd.buildingId, cmd.enabled);
      break;
    case 'building/demolish':
      sim.demolish(cmd.buildingId);
      break;
    case 'building/maintain':
      sim.dispatchMaintenance(cmd.buildingId);
      break;
    case 'building/assemble':
      sim.assembleRover(cmd.buildingId, cmd.kind);
      break;
    case 'colonist/order':
      sim.orderColonist(cmd.order);
      break;
    case 'dev/time':
      sim.devSetTime(cmd.sol, cmd.frac);
      break;
    case 'dev/storm/force':
      sim.devForceStorm(cmd.kind);
      break;
    case 'dev/storm/clear':
      sim.devClearStorms();
      break;
    case 'dev/storm/scheduler':
      sim.devSetStormScheduler(cmd.on);
      break;
    case 'dev/dust':
      sim.devSetDust(cmd.frac);
      break;
    case 'dev/lightning/strike':
      sim.devForceLightningStrike();
      break;
    case 'dev/spawn/rover':
      sim.devSpawnRover(cmd.kind, cmd.x, cmd.z);
      break;
    case 'dev/spawn/building':
      sim.devSpawnBuilding(cmd.kind, cmd.x, cmd.z);
      break;
    case 'dev/spawn/deposit':
      sim.devSpawnDeposit(cmd.resource, cmd.x, cmd.z, cmd.kg);
      break;
    case 'dev/building/complete':
      sim.devCompleteBuilding(cmd.buildingId);
      break;
    case 'dev/building/level':
      sim.devSetBuildingLevel(cmd.buildingId, cmd.level);
      break;
    case 'dev/building/health':
      sim.devSetBuildingHealth(cmd.buildingId, cmd.pct);
      break;
    case 'dev/building/damaged':
      sim.devSetBuildingDamaged(cmd.buildingId, cmd.on);
      break;
    case 'dev/building/cleanliness':
      sim.devSetBuildingCleanliness(cmd.buildingId, cmd.frac);
      break;
    case 'dev/rover/battery':
      sim.devSetRoverBatteryFrac(cmd.roverId, cmd.frac);
      break;
    case 'dev/rover/cargo':
      sim.devSetRoverCargo(cmd.roverId, cmd.resource, cmd.kg);
      break;
    case 'dev/rover/cargoClear':
      sim.devClearRoverCargo(cmd.roverId);
      break;
    case 'dev/rover/condition':
      sim.devSetRoverCondition(cmd.roverId, cmd.pct);
      break;
    case 'dev/colonist/health':
      sim.devSetColonistHealth(cmd.pct);
      break;
    case 'dev/colonist/suit':
      sim.devRefillSuit();
      break;
  }
}

/**
 * Create a transcript builder for tests — ergonomic helper to collect commands.
 */
export class TranscriptBuilder {
  private transcript: Transcript;

  constructor(seed: number) {
    this.transcript = { seed, commands: [] };
  }

  at(tick: number, command: SimCommand): this {
    this.transcript.commands.push({ tick, command });
    return this;
  }

  duration(ticks: number): this {
    this.transcript.durationTicks = ticks;
    return this;
  }

  difficulty(id: DifficultyId): this {
    this.transcript.difficulty = id;
    return this;
  }

  worldOptions(opts: Partial<WorldOptions>): this {
    this.transcript.worldOptions = { ...(this.transcript.worldOptions ?? {}), ...opts };
    return this;
  }

  build(): Transcript {
    return { ...this.transcript, commands: [...this.transcript.commands] };
  }
}

/**
 * Validate a transcript's shape (plain data, not simulation validity).
 * Returns array of errors, empty if valid.
 */
export function validateTranscript(t: unknown): string[] {
  const errors: string[] = [];
  if (!t || typeof t !== 'object') {
    errors.push('transcript must be an object');
    return errors;
  }
  const tr = t as Record<string, unknown>;
  if (!Number.isFinite(tr.seed as number)) errors.push('seed must be finite number');
  if (!Array.isArray(tr.commands)) {
    errors.push('commands must be an array');
  } else {
    for (let i = 0; i < (tr.commands as unknown[]).length; i++) {
      const c = (tr.commands as any[])[i];
      if (!c || typeof c !== 'object') {
        errors.push(`commands[${i}] must be object`);
        continue;
      }
      if (!Number.isFinite(c.tick) || c.tick < 0) errors.push(`commands[${i}].tick must be >=0`);
      if (!c.command || typeof c.command !== 'object') errors.push(`commands[${i}].command must be object`);
    }
  }
  if (tr.durationTicks !== undefined && (!Number.isFinite(tr.durationTicks as number) || (tr.durationTicks as number) < 0)) {
    errors.push('durationTicks must be >=0 if present');
  }
  return errors;
}

/**
 * Canonical JSON for transcript (sorted keys) — stable hashing.
 */
export function canonicalTranscriptJson(t: Transcript): string {
  return JSON.stringify(t, (_key, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
