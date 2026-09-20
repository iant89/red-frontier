/** v12 → v13: permanent refits/paint default empty; no free upgraded hardware. */
import type { HistoricalSave } from '../SaveSchema';
export function migrateV12Save(data: HistoricalSave): HistoricalSave {
  return { ...data, version: 13 };
}
