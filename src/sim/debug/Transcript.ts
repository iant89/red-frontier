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

/**
 * Apply a transcripted command through the same dispatch the hosts use. This
 * used to be a second copy of the `applyCommand` switch (kept inline over a
 * feared import cycle that does not exist — `applyCommand` only value-imports
 * the profiler); Phase 22 deleted the copy, so a replay and a live colony can
 * no longer disagree about what a command means. Acks are ignored on purpose:
 * a transcript is a script, not an interaction, so there is nobody to answer.
 */
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
