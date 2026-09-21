/**
 * AutonomyState — Phase 3, the one stat behind five features (AUTONOMY.md).
 *
 * "How much can this colony do without me?" answered three ways from one
 * mechanism: a **streak** (behaviour — how long it has run hands-off), a
 * **coverage** fraction (attribution — who did the work) and a **resilience**
 * list (structure — what single machine could still end it). The ladder
 * MANUAL → ASSISTED → AUTOMATED → REDUNDANT → AUTONOMOUS is read off those
 * three and never declared.
 *
 * Saved, hashed, deterministic. `current` streak is not stored — it is
 * `clock.solsElapsed − startedAt`, computed where it is read, so it cannot
 * drift from the clock.
 */

export type AutonomyBreakReason =
  | 'intervention'
  | 'life-support-critical'
  | 'colonist-critical'
  | 'power-critical'
  | 'runway-critical';

export type AutonomyRung = 'manual' | 'assisted' | 'automated' | 'redundant' | 'autonomous';

export const RUNG_ORDER: AutonomyRung[] = ['manual', 'assisted', 'automated', 'redundant', 'autonomous'];

/** The roadmap's identity labels, mapped onto the ladder (AUTONOMY.md §7). */
export type AutonomyIdentity = 'operator' | 'engineer' | 'architect';

export function identityFor(rung: AutonomyRung): AutonomyIdentity {
  switch (rung) {
    case 'autonomous':
      return 'architect';
    case 'automated':
    case 'redundant':
      return 'engineer';
    default:
      return 'operator';
  }
}

export function rungIndex(r: AutonomyRung): number {
  return RUNG_ORDER.indexOf(r);
}

/** A sol's worth of attributed rover work, in sim seconds. */
export interface CoverageBucket {
  autoSec: number;
  orderSec: number;
}

export interface AutonomyBreak {
  /** Absolute sols when the window ended. */
  at: number;
  reason: AutonomyBreakReason;
  /** How long the window that just ended had run. */
  streak: number;
  /** One teaching line — what ended it, in the player's terms. */
  detail: string;
}

export interface AutonomyState {
  /** Absolute sols (`clock.solsElapsed`) when the open window began. */
  startedAt: number;
  /** Longest finalised window, in sols. Monotone. */
  best: number;
  /** Highest rung ever held. Monotone. */
  bestRung: AutonomyRung;
  /** Total hands-off sols accrued across the run. */
  lifetimeSols: number;
  /** Current rung — can drop (lose redundancy) but never below `assisted` once earned. */
  rung: AutonomyRung;
  /** Trailing-window fraction of rover work that was self-directed, [0, 1]. */
  coverage: number;
  /** `COVERAGE_WINDOW_SOLS` sol-buckets, newest first. */
  coverageBuckets: CoverageBucket[];
  /**
   * Consecutive sols the three fluid producers (extractor, oxygenator,
   * greenhouse) have all been online — the AUTOMATED gate's "through a full
   * sol" clause. Resets to 0 the tick any of them is not.
   */
  producersOnlineSols: number;
  /** True once any rover has ever worked a self-chosen task — the ASSISTED gate. */
  everAutoTask: boolean;
  lastBreak: AutonomyBreak | null;
  /** Critical chains below their redundancy gate, e.g. `['water', 'fleet']`. */
  singlePoints: string[];
  /**
   * Transient — which breaker conditions were holding on the previous tick, so
   * a four-hour critical episode is one break, not a hundred. Not saved: a
   * restored colony that is still critical is re-broken once, honestly.
   */
  _holding?: Partial<Record<AutonomyBreakReason, boolean>>;
}

export const COVERAGE_WINDOW_SOLS = 3;

export function emptyCoverageBuckets(): CoverageBucket[] {
  const out: CoverageBucket[] = [];
  for (let i = 0; i < COVERAGE_WINDOW_SOLS; i++) out.push({ autoSec: 0, orderSec: 0 });
  return out;
}

export function emptyAutonomyState(startedAt = 0): AutonomyState {
  return {
    startedAt: Math.max(0, startedAt),
    best: 0,
    bestRung: 'manual',
    lifetimeSols: 0,
    rung: 'manual',
    coverage: 0,
    coverageBuckets: emptyCoverageBuckets(),
    producersOnlineSols: 0,
    everAutoTask: false,
    lastBreak: null,
    singlePoints: [],
  };
}

/** Coverage over the whole window; 0 when no attributable work happened. */
export function coverageOf(buckets: readonly CoverageBucket[]): number {
  let auto = 0;
  let order = 0;
  for (const b of buckets) {
    auto += b.autoSec;
    order += b.orderSec;
  }
  const total = auto + order;
  if (total <= 1e-9) return 0;
  const c = auto / total;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}
