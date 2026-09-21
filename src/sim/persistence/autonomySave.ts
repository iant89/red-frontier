/**
 * The autonomy block's one sanitiser, shared by the v15 migration and the
 * restorer so a hostile or hand-edited save is clamped the same way on both
 * paths (SAVE-COMPATIBILITY.md: sanitise, don't trust).
 */
import type { AutonomyBreakReason, AutonomyRung, AutonomyState, CoverageBucket } from '../state/AutonomyState';
import { COVERAGE_WINDOW_SOLS, RUNG_ORDER, emptyCoverageBuckets, rungIndex } from '../state/AutonomyState';

const REASONS: ReadonlySet<string> = new Set<AutonomyBreakReason>([
  'intervention',
  'life-support-critical',
  'colonist-critical',
  'power-critical',
  'runway-critical',
]);

function num(v: unknown, fallback: number, lo = 0, hi = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(v as number)) return fallback;
  const n = Number(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function rung(v: unknown, fallback: AutonomyRung): AutonomyRung {
  return typeof v === 'string' && (RUNG_ORDER as string[]).includes(v) ? (v as AutonomyRung) : fallback;
}

/**
 * @param saved   whatever the file carried under `autonomy` (may be anything)
 * @param base    defaults for this colony (window start already decided)
 * @param now     the save's absolute sols — no window may start in the future
 */
export function sanitiseAutonomy(saved: unknown, base: AutonomyState, now: number): AutonomyState {
  if (!saved || typeof saved !== 'object') return base;
  const s = saved as Record<string, unknown>;
  const out: AutonomyState = { ...base };

  out.startedAt = num(s.startedAt, base.startedAt, 0, Math.max(0, now));
  out.best = num(s.best, 0);
  out.lifetimeSols = num(s.lifetimeSols, 0);
  out.coverage = num(s.coverage, 0, 0, 1);
  out.producersOnlineSols = num(s.producersOnlineSols, 0);
  out.everAutoTask = s.everAutoTask === true;
  out.rung = rung(s.rung, 'manual');
  out.bestRung = rung(s.bestRung, out.rung);
  if (rungIndex(out.bestRung) < rungIndex(out.rung)) out.bestRung = out.rung;

  const buckets: CoverageBucket[] = [];
  if (Array.isArray(s.coverageBuckets)) {
    for (const b of s.coverageBuckets.slice(0, COVERAGE_WINDOW_SOLS)) {
      const bb = (b ?? {}) as Record<string, unknown>;
      buckets.push({ autoSec: num(bb.autoSec, 0), orderSec: num(bb.orderSec, 0) });
    }
  }
  while (buckets.length < COVERAGE_WINDOW_SOLS) buckets.push({ autoSec: 0, orderSec: 0 });
  out.coverageBuckets = buckets.length ? buckets : emptyCoverageBuckets();

  out.singlePoints = Array.isArray(s.singlePoints)
    ? (s.singlePoints.filter((x) => typeof x === 'string') as string[]).slice(0, 16)
    : [];

  const lb = s.lastBreak as Record<string, unknown> | null | undefined;
  out.lastBreak =
    lb && typeof lb === 'object' && typeof lb.reason === 'string' && REASONS.has(lb.reason)
      ? {
          at: num(lb.at, 0),
          reason: lb.reason as AutonomyBreakReason,
          streak: num(lb.streak, 0),
          detail: typeof lb.detail === 'string' ? lb.detail.slice(0, 200) : '',
        }
      : null;

  return out;
}
