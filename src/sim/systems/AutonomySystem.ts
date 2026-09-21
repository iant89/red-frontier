/**
 * AutonomySystem — Phase 3 (AUTONOMY.md).
 *
 * Pure, deterministic, no DOM. Ticked **after** `evaluateAlerts` (breakers B1–B3
 * read alert transitions) and **before** `ObjectiveSystem` (the flagship
 * project reads the streak this system maintains) and `HistorySystem`.
 *
 * Per tick, in order:
 *
 *   1. Attribute this tick's rover work to `auto` or `order` seconds
 *      (coverage, §5) and roll the sol buckets on a new sol.
 *   2. Evaluate the breakers (§4.3) — edge-triggered on the *transition* into
 *      each condition, plus the intervention flag the command dispatcher set —
 *      and end the open window at the first one that fires.
 *   3. Recompute resilience (§6) and the rung (§7); announce a promotion or a
 *      demotion once, in the teaching tone.
 *
 * What this file refuses to do: hold thresholds anywhere but `AUTONOMY_TUNING`,
 * or decide anything from wall-clock time.
 */

import type { ColonyState } from '../state/ColonyState';
import type { AutonomyBreak, AutonomyBreakReason, AutonomyIdentity, AutonomyRung } from '../state/AutonomyState';
import {
  COVERAGE_WINDOW_SOLS,
  coverageOf,
  emptyCoverageBuckets,
  identityFor,
  rungIndex,
} from '../state/AutonomyState';
import { ALL_FLUIDS, FLUIDS } from '../defs';
import type { FluidId } from '../defs';
import { SIM_TICK, SOL_SECONDS } from '../config';
import { HistorySystem } from './HistorySystem';

/** Every knob in one block (AUTONOMY.md §13). */
export const AUTONOMY_TUNING = {
  /** B4 — a fluid projected to run dry inside this many sols ends the window. */
  runwayFloorSols: 1.0,
  /** AUTOMATED — at least this fraction of recent rover work was self-directed. */
  automatedCoverage: 0.75,
  /** AUTOMATED — a finalised window at least this long has been achieved. */
  automatedBestSols: 1.0,
  /** AUTOMATED — all three fluid producers online for this many consecutive sols. */
  automatedProducerSols: 1.0,
  /** AUTONOMOUS — the open window has run this long. Fixed across difficulties. */
  autonomousStreakSols: 10.0,
} as const;

// ------------------------------------------------------ classification ----

/**
 * A command that directs a specific action *now* is intervention; one that
 * sets a persistent policy or configuration is not (AUTONOMY.md §4.2). An
 * explicit table, not a prefix rule: `rover/rule` is policy while `rover/move`
 * is an order, and P3's future `policy/*` commands fall outside it by default.
 */
const INTERVENTION_COMMANDS: ReadonlySet<string> = new Set([
  'rover/move',
  'rover/mine',
  'rover/unload',
  'rover/wait',
  'rover/stop',
  'rover/construct',
  'rover/clean',
  'rover/repair',
  'rover/recover',
  'rover/salvage',
  'building/place',
  'building/toggle',
  'building/demolish',
  'building/maintain',
  'building/assemble',
  'building/recipe',
  'water/connect',
  'water/disconnect',
  'water/commission',
  'colonist/order',
  'engineering/upgrade',
  'engineering/cancel',
]);

const POLICY_COMMANDS: ReadonlySet<string> = new Set([
  'rover/rule',
  'rover/repeatRoute',
  'rover/chargeFloor',
  'rover/lights',
  'engineering/paint',
  'tutorial/dismiss',
]);

export type CommandClass = 'intervention' | 'policy' | 'ignored';

export function classifyCommand(type: string): CommandClass {
  if (INTERVENTION_COMMANDS.has(type)) return 'intervention';
  if (type.startsWith('dev/')) return 'ignored';
  if (POLICY_COMMANDS.has(type) || type.startsWith('policy/')) return 'policy';
  // Unknown player commands are orders until a table says otherwise: the safe
  // default for a stat that must not be farmable.
  return 'intervention';
}

/** Short player-facing description of an order, for the break line. */
function describeOrder(type: string): string {
  const [family, verb] = type.split('/');
  switch (family) {
    case 'rover':
      return `ordered a rover to ${verb}`;
    case 'building':
      return (
        {
          place: 'sited a building',
          toggle: 'switched a building',
          demolish: 'demolished a building',
          maintain: 'dispatched maintenance',
          assemble: 'ordered a rover built',
          recipe: 'changed a production line',
        } as Record<string, string>
      )[verb] ?? 'worked on a building';
    case 'water':
      return verb === 'commission' ? 'commissioned the water network' : `${verb}ed a water link`;
    case 'colonist':
      return 'sent the colonist out';
    case 'engineering':
      return verb === 'cancel' ? 'cancelled an upgrade' : 'started an upgrade';
    default:
      return 'took the controls';
  }
}

// ------------------------------------------------------------ helpers ----

const PRODUCERS = ['extractor', 'oxygenator', 'greenhouse'] as const;

function onlineCount(state: ColonyState, kind: string): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.kind === kind && b.state === 'online' && !b.damaged && b.enabled) n++;
  }
  return n;
}

function fmtSols(n: number): string {
  return `${n.toFixed(1)} sol${Math.abs(n - 1) < 0.05 ? '' : 's'}`;
}

/** The critical chains and how many independent producers each has (§6). */
export function resilience(state: ColonyState): string[] {
  const below: string[] = [];
  let generators = 0;
  for (const b of state.buildings) {
    if (b.state !== 'online' || b.damaged || !b.enabled) continue;
    if (b.kind === 'solar' || b.kind === 'rtg' || b.kind === 'battery') generators++;
  }
  // The descent stage's own RTG is one independent source of power.
  if (generators + 1 < 2) below.push('power');
  if (onlineCount(state, 'extractor') < 2) below.push('water');
  if (onlineCount(state, 'oxygenator') < 2) below.push('oxygen');
  if (onlineCount(state, 'greenhouse') < 2) below.push('food');
  let fleet = 0;
  for (const r of state.rovers) if (r.phase !== 'disabled') fleet++;
  if (fleet < 2) below.push('fleet');
  if ((state.components.motor ?? 0) < 1 || (state.components.circuitBoard ?? 0) < 1) below.push('spares');
  if (onlineCount(state, 'garage') < 1) below.push('recovery');
  return below;
}

export function currentStreak(state: ColonyState): number {
  return Math.max(0, state.clock.solsElapsed - state.autonomy.startedAt);
}

/** The stat as plain data — the shape that crosses the host boundary. */
export interface AutonomySnapshot {
  current: number;
  best: number;
  lifetimeSols: number;
  rung: AutonomyRung;
  bestRung: AutonomyRung;
  identity: AutonomyIdentity;
  coverage: number;
  singlePoints: string[];
  lastBreak: AutonomyBreak | null;
}

export function autonomySnapshot(state: ColonyState): AutonomySnapshot {
  const a = state.autonomy;
  return {
    current: currentStreak(state),
    best: a.best,
    lifetimeSols: a.lifetimeSols,
    rung: a.rung,
    bestRung: a.bestRung,
    identity: identityFor(a.rung),
    coverage: a.coverage,
    singlePoints: [...a.singlePoints],
    lastBreak: a.lastBreak ? { ...a.lastBreak } : null,
  };
}

// ------------------------------------------------------------- system ----

export class AutonomySystem {
  static tick(state: ColonyState, newSol: boolean): void {
    const a = state.autonomy;

    // 1. Coverage — attribute this tick's work.
    if (newSol) {
      a.coverageBuckets.unshift({ autoSec: 0, orderSec: 0 });
      while (a.coverageBuckets.length > COVERAGE_WINDOW_SOLS) a.coverageBuckets.pop();
    }
    if (a.coverageBuckets.length === 0) a.coverageBuckets = emptyCoverageBuckets();
    const bucket = a.coverageBuckets[0];
    for (const r of state.rovers) {
      if (r.phase !== 'moving' && r.phase !== 'working') continue;
      if (r.autoTask) {
        bucket.autoSec += SIM_TICK;
        a.everAutoTask = true;
      } else {
        bucket.orderSec += SIM_TICK;
      }
    }
    a.coverage = coverageOf(a.coverageBuckets);

    // 2. Breakers — the streak ends at the first one, once per episode.
    const holding = (a._holding ??= {});
    const fire = (reason: AutonomyBreakReason, detail: string) => {
      AutonomySystem.break(state, reason, detail);
    };
    const edge = (reason: AutonomyBreakReason, now: boolean, detail: () => string) => {
      const was = holding[reason] === true;
      holding[reason] = now;
      if (now && !was) fire(reason, detail());
    };

    const A = state.alerts;
    let lifeCrit: FluidId | null = null;
    for (const f of ALL_FLUIDS) {
      const alert = A.list().find((x) => x.key === `${f}-low`);
      if (alert && alert.severity === 'crit') {
        lifeCrit = f;
        break;
      }
    }
    edge('life-support-critical', lifeCrit !== null, () => `${FLUIDS[lifeCrit!].label} reserve critical`);

    const colonist = A.list().find((x) => x.key === 'colonist-health');
    edge('colonist-critical', !!colonist && colonist.severity === 'crit', () => `${state.colonist.name} is failing`);

    edge('power-critical', A.isActive('brownout-critical'), () => 'Life-support power was shed');

    let runway: FluidId | null = null;
    for (const f of ALL_FLUIDS) {
      const sols = HistorySystem.reserveSols(state, f);
      if (sols < AUTONOMY_TUNING.runwayFloorSols) {
        runway = f;
        break;
      }
    }
    edge('runway-critical', runway !== null, () => {
      const sols = HistorySystem.reserveSols(state, runway!);
      return `${FLUIDS[runway!].label} would run dry in ${fmtSols(sols)}`;
    });

    // 3. Resilience and the ladder.
    a.singlePoints = resilience(state);

    const producersOnline = PRODUCERS.every((k) => onlineCount(state, k) >= 1);
    a.producersOnlineSols = producersOnline ? a.producersOnlineSols + SIM_TICK / SOL_SECONDS : 0;

    // Lifetime accrues every tick the window is open (it always is between breaks).
    a.lifetimeSols += SIM_TICK / SOL_SECONDS;

    const rung = AutonomySystem.evaluateRung(state);
    if (rung !== a.rung) AutonomySystem.setRung(state, rung);
  }

  /** The ladder, read off the three facets (§7). Pure. */
  static evaluateRung(state: ColonyState): AutonomyRung {
    const a = state.autonomy;
    if (!a.everAutoTask) return 'manual';
    const automated =
      a.coverage >= AUTONOMY_TUNING.automatedCoverage &&
      a.best >= AUTONOMY_TUNING.automatedBestSols &&
      a.producersOnlineSols >= AUTONOMY_TUNING.automatedProducerSols;
    if (!automated) return 'assisted';
    if (a.singlePoints.length > 0) return 'automated';
    if (currentStreak(state) >= AUTONOMY_TUNING.autonomousStreakSols) return 'autonomous';
    return 'redundant';
  }

  private static setRung(state: ColonyState, rung: AutonomyRung): void {
    const a = state.autonomy;
    const from = a.rung;
    a.rung = rung;
    if (rungIndex(rung) > rungIndex(a.bestRung)) a.bestRung = rung;
    const stamp = state.clock.format();
    const up = rungIndex(rung) > rungIndex(from);
    const label = rung.toUpperCase();
    let text: string;
    if (up) {
      text =
        rung === 'assisted'
          ? 'ASSISTED — the flight software is doing chores on its own.'
          : rung === 'automated'
            ? 'AUTOMATED — the colony worked a full sol without being told to.'
            : rung === 'redundant'
              ? 'REDUNDANT reached — no single machine can end this colony.'
              : `AUTONOMOUS — the colony ran itself for ${fmtSols(currentStreak(state))}. It no longer needs you.`;
    } else {
      const lost = a.singlePoints[0];
      text = lost
        ? `${chainLabel(lost)} redundancy lost — the colony is ${label} until it is restored.`
        : `The colony has dropped to ${label}.`;
    }
    state.alerts.event(up ? 'ok' : 'warn', text, state.simTime, stamp);
    state.domainEvents.push({
      type: 'autonomy/rung',
      from,
      to: rung,
      identity: identityFor(rung),
      sol: state.clock.sol,
    });
  }

  /** End the open window. Stores the reason, updates the records, starts a new one. */
  static break(state: ColonyState, reason: AutonomyBreakReason, detail: string): void {
    const a = state.autonomy;
    const now = state.clock.solsElapsed;
    const streak = Math.max(0, now - a.startedAt);
    if (streak > a.best) a.best = streak;
    a.lastBreak = { at: now, reason, streak, detail };
    a.startedAt = now;
    // A fresh window is not ten sols long; the rung re-evaluates next tick.
    const text =
      reason === 'intervention'
        ? `Intervention logged — ${detail}. Streak ended at ${fmtSols(streak)}.`
        : `${detail}. The colony ran itself for ${fmtSols(streak)}.`;
    // Landing-day noise: the first few orders finalise windows of seconds. Log
    // only windows a player would miss, so the colony log stays readable.
    if (streak >= 0.1) state.alerts.event('info', text, state.simTime, state.clock.format());
    state.domainEvents.push({ type: 'autonomy/break', reason, streak, sol: state.clock.sol });
  }

  /**
   * Command hook. Called by the dispatcher for every player command *after*
   * it was applied; only accepted interventions end the window (a refused
   * order steered nothing).
   */
  static noteCommand(state: ColonyState, type: string, accepted: boolean): void {
    if (!accepted) return;
    if (classifyCommand(type) !== 'intervention') return;
    AutonomySystem.break(state, 'intervention', describeOrder(type));
  }

  /** A time jump is not autonomy: restart the window at the new time. */
  static afterTimeJump(state: ColonyState): void {
    const a = state.autonomy;
    a.startedAt = state.clock.solsElapsed;
    a.producersOnlineSols = 0;
    a._holding = {};
  }
}

function chainLabel(chain: string): string {
  switch (chain) {
    case 'power':
      return 'Power';
    case 'water':
      return 'Water';
    case 'oxygen':
      return 'Oxygen';
    case 'food':
      return 'Food';
    case 'fleet':
      return 'Fleet';
    case 'spares':
      return 'Spare-parts';
    case 'recovery':
      return 'Recovery';
    default:
      return chain;
  }
}

