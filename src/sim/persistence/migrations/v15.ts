/**
 * v15 → v16: the autonomy stat (Phase 3, AUTONOMY.md §10.3).
 *
 * Additive and without retroactive credit: an old colony's open window begins
 * at the sol it was saved on (or at its Phase 2 direct-order marker if that is
 * later — the streak it was already showing carries over), `best` and
 * `lifetimeSols` start at zero, the rung starts at `manual` and is re-earned
 * on the first tick. A hand-edited `autonomy` block is sanitised field by
 * field, never trusted wholesale.
 */
import type { HistoricalSave } from '../SaveSchema';
import { emptyAutonomyState } from '../../state/AutonomyState';
import { sanitiseAutonomy } from '../autonomySave';

export function migrateV15Save(data: HistoricalSave): HistoricalSave {
  const clock = (data as { clock?: { sol?: unknown; frac?: unknown } }).clock ?? {};
  const sol = Number.isFinite(clock.sol as number) ? Math.max(0, Number(clock.sol)) : 0;
  const frac = Number.isFinite(clock.frac as number) ? Math.min(1, Math.max(0, Number(clock.frac))) : 0;
  const marker = (data as { unlocks?: { lastDirectOrderSol?: unknown } }).unlocks?.lastDirectOrderSol;
  const startedAt = Number.isFinite(marker as number) ? Math.min(sol + frac, Math.max(0, Number(marker))) : sol + frac;

  const saved = (data as { autonomy?: unknown }).autonomy;
  const autonomy = sanitiseAutonomy(saved, emptyAutonomyState(startedAt), sol + frac);

  return { ...data, version: 16, autonomy };
}
