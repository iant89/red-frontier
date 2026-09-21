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
import { applyCommand } from '../host/applyCommand';
import { Simulation } from '../Simulation';
import { SIM_TICK } from '../config';
import type { DifficultyId, WorldOptions } from '../difficulty';
import { DEFAULT_WORLD_OPTIONS } from '../difficulty';
import { hashSimulation } from './StateHash';

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

/** Apply a SimCommand via the sim's authoritative host applyCommand dispatch. */
function applyCommandForTranscript(sim: Simulation, cmd: SimCommand): void {
  applyCommand(sim, cmd);
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
 * TranscriptRecorder captures simulation commands in chronological order.
 * Suitable for session recording, bug reporting, and test fixture capture.
 */
export class TranscriptRecorder {
  private readonly transcript: Transcript;
  private recording = true;

  constructor(seed: number, options?: {
    difficulty?: DifficultyId;
    worldHalf?: number;
    region?: string | null;
    worldOptions?: Partial<WorldOptions>;
    durationTicks?: number;
  }) {
    this.transcript = { seed, commands: [] };
    if (options?.difficulty !== undefined) this.transcript.difficulty = options.difficulty;
    if (options?.worldHalf !== undefined) this.transcript.worldHalf = options.worldHalf;
    if (options?.region !== undefined) this.transcript.region = options.region;
    if (options?.worldOptions !== undefined) this.transcript.worldOptions = options.worldOptions;
    if (options?.durationTicks !== undefined) this.transcript.durationTicks = options.durationTicks;
  }

  record(tick: number, command: SimCommand): this {
    if (!this.recording) return this;
    this.transcript.commands.push({ tick, command });
    return this;
  }

  duration(ticks: number): this {
    this.transcript.durationTicks = ticks;
    return this;
  }

  pause(): void {
    this.recording = false;
  }

  resume(): void {
    this.recording = true;
  }

  isRecording(): boolean {
    return this.recording;
  }

  toTranscript(durationTicks?: number): Transcript {
    const res: Transcript = {
      seed: this.transcript.seed,
      commands: [...this.transcript.commands],
    };
    if (this.transcript.difficulty !== undefined) res.difficulty = this.transcript.difficulty;
    if (this.transcript.worldHalf !== undefined) res.worldHalf = this.transcript.worldHalf;
    if (this.transcript.region !== undefined) res.region = this.transcript.region;
    if (this.transcript.worldOptions !== undefined) res.worldOptions = { ...this.transcript.worldOptions };
    const dur = durationTicks ?? this.transcript.durationTicks;
    if (dur !== undefined) res.durationTicks = dur;
    return res;
  }

  toJSON(pretty = false): string {
    return encodeTranscript(this.toTranscript(), pretty);
  }
}

/**
 * Pinned canonical scenarios for regression testing and desync validation.
 */
export const CANONICAL_SCENARIOS = {
  foundation: {
    name: 'colony-foundation',
    description: 'Initial colony setup with warehouse, solar arrays, and rover deployment',
    expectedHash: 'rf1-15e9be8bf9161d-09402e342d2a89',
    build: () =>
      new TranscriptBuilder(101)
        .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
        .at(0, { type: 'building/place', kind: 'solar', x: -40, z: 0 })
        .at(50, { type: 'rover/move', roverId: 1000, x: 40, z: 20, queue: false })
        .at(50, { type: 'rover/move', roverId: 1001, x: -40, z: 20, queue: false })
        .duration(800)
        .build(),
  },
  logistics: {
    name: 'logistics-haul-loop',
    description: 'Iron mining with automated repeat-route hauling to silos',
    expectedHash: 'rf1-05c3508397bd14-0d1d9e636ee1fc',
    build: () =>
      new TranscriptBuilder(2026)
        .at(0, { type: 'rover/mine', roverId: 1000, depositId: 1, queue: false })
        .at(200, { type: 'rover/repeatRoute', roverId: 1000, on: true })
        .duration(2000)
        .build(),
  },
  severeStorm: {
    name: 'severe-storm-protocol',
    description: 'Severe storm onset, rover shelter rules, colonist EVA recall, and storm clearance',
    expectedHash: 'rf1-021426e5bff21f-003ef287f463b8',
    build: () =>
      new TranscriptBuilder(303)
        .at(0, { type: 'dev/storm/force', kind: 'severe' })
        .at(200, { type: 'rover/rule', roverId: 1000, rule: 'stormShelter', on: true })
        .at(400, { type: 'colonist/order', order: { type: 'shelter' } })
        .at(600, { type: 'dev/storm/clear' })
        .duration(1200)
        .build(),
  },
} as const;

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

/**
 * Replay a transcript and compute the final deterministic StateHash.
 */
export function replayAndHash(transcript: Transcript): { hash: string; result: ReplayResult } {
  const result = replayTranscript(transcript);
  const hash = hashSimulation(result.sim);
  return { hash, result };
}

/**
 * Serialize a transcript into formatted or canonical JSON.
 */
export function encodeTranscript(transcript: Transcript, pretty = false): string {
  return pretty ? JSON.stringify(JSON.parse(canonicalTranscriptJson(transcript)), null, 2) : canonicalTranscriptJson(transcript);
}

/**
 * Deserialize and validate a JSON string into a Transcript.
 * Throws an Error if the shape is invalid.
 */
export function decodeTranscript(raw: string): Transcript {
  const parsed = JSON.parse(raw);
  const errors = validateTranscript(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid transcript JSON:\n  ${errors.join('\n  ')}`);
  }
  return parsed as Transcript;
}
