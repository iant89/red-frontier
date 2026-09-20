/** v10 → v11: installed part health and Repair Bay jobs are additive.
 * Restore supplies healthy parts and an empty bay for existing colonies. */
import type { HistoricalSave } from '../SaveSchema';
export function migrateV10Save(data: HistoricalSave): HistoricalSave {
  return { ...data, version: 11 };
}
