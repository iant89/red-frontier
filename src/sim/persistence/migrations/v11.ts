/** v11 → v12: preserve old reserves and shared plumbing until commissioned. */
import type { HistoricalSave } from '../SaveSchema';
export function migrateV11Save(data: HistoricalSave): HistoricalSave {
  return {
    ...data,
    version: 12,
    water: { active: false, links: [], tanks: {} },
  };
}
