/**
 * v17 → v18: the long records (Phase 4 — sol history rows + event journal).
 *
 * Additive: an old colony has no downsampled rows and no log yet; both start
 * empty and start accumulating from the restore forward. A hand-edited
 * `history` block is sanitised field by field (rings re-bounded, streaming
 * events refused) so the restore path and the migration share one trust
 * posture.
 */
import type { HistoricalSave } from '../SaveSchema';
import { sanitiseHistory } from '../historySave';

export function migrateV17Save(data: HistoricalSave): HistoricalSave {
  const history = sanitiseHistory((data as { history?: unknown }).history);
  return { ...data, version: 18, history };
}
