/** v13 → v14: tutorial state added, empty on old colonies. */
import type { HistoricalSave } from '../SaveSchema';
export function migrateV13Save(data: HistoricalSave): HistoricalSave {
  return { ...data, version: 14, tutorial: (data as any).tutorial ?? null };
}
