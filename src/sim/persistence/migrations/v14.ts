/**
 * v14 → v15: engineering projects (Phase 2).
 *
 * Additive, and deliberately untrusting: a colony someone hand-edited to claim
 * five completed projects keeps only the ids this build actually ships, and an
 * unlock that is not in the registry is dropped rather than invented. The
 * direct-order marker defaults to the save's own sol, so an old colony does
 * not wake up with a ten-sol autonomy streak it never earned.
 */
import type { HistoricalSave } from '../SaveSchema';
import { emptyUnlocks } from '../../unlocks';
import { projectById } from '../../projects/catalog';

export function migrateV14Save(data: HistoricalSave): HistoricalSave {
  const unlocks = emptyUnlocks();
  const saved = (data as { unlocks?: { unlocks?: unknown } }).unlocks?.unlocks as
    | Record<string, unknown>
    | undefined;
  if (saved && typeof saved === 'object') {
    for (const id of Object.keys(unlocks) as (keyof typeof unlocks)[]) {
      const rec = saved[id as string] as { sol?: unknown; tick?: unknown; source?: unknown } | null;
      if (!rec || !Number.isFinite(rec.sol as number)) continue;
      unlocks[id] = {
        sol: Math.max(0, Number(rec.sol) || 0),
        tick: Math.max(0, Math.floor(Number(rec.tick) || 0)),
        source: typeof rec.source === 'string' ? rec.source : 'unknown',
      };
    }
  }

  const savedObjectives = (data as { objectives?: unknown }).objectives as
    | { active?: unknown; completed?: unknown }
    | undefined;

  // Only ids this build's catalogue knows, and never one already marked done.
  const active: string[] = [];
  const completed: Record<string, { sol: number; tick: number }> = {};
  if (savedObjectives && typeof savedObjectives === 'object') {
    const savedCompleted = (savedObjectives.completed ?? {}) as Record<string, unknown>;
    for (const [id, rec] of Object.entries(savedCompleted)) {
      if (!projectById(id)) continue;
      const r = rec as { sol?: unknown; tick?: unknown } | null;
      if (!r || !Number.isFinite(r.sol as number)) continue;
      completed[id] = {
        sol: Math.max(0, Number(r.sol) || 0),
        tick: Math.max(0, Math.floor(Number(r.tick) || 0)),
      };
    }
    if (Array.isArray(savedObjectives.active)) {
      for (const id of savedObjectives.active) {
        if (typeof id !== 'string' || !projectById(id)) continue;
        if (completed[id] || active.includes(id)) continue;
        active.push(id);
      }
    }
  }

  const savedSol = (data as { clock?: { sol?: unknown } }).clock?.sol;
  const sol = Number.isFinite(savedSol as number) ? Math.max(0, Number(savedSol)) : 0;

  return {
    ...data,
    version: 15,
    // Sanitised, not invented: whatever survives the filter is what the board
    // had. A colony with nothing on it is re-handed the opening project by the
    // restorer, which owns that rule in one place.
    objectives: { active, completed },
    unlocks: {
      unlocks,
      lastDirectOrderSol: Number.isFinite((data as { unlocks?: { lastDirectOrderSol?: unknown } }).unlocks?.lastDirectOrderSol as number)
        ? Math.max(0, Number((data as { unlocks?: { lastDirectOrderSol?: number } }).unlocks?.lastDirectOrderSol))
        : sol,
    },
  };
}
