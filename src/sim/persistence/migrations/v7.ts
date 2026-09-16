/**
 * v7 → v8. The weather block gains lightning state (a seeded strike RNG and a
 * difficulty-scaled frequency multiplier). Both are optional on restore with
 * seed-derived / difficulty-derived defaults, so the migration itself only has
 * to bump the version — an older save keeps its sky and simply gains the new
 * storm hazard.
 */
import { CURRENT_SAVE_VERSION } from '../SaveSchema';

export function migrateV7Save(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: CURRENT_SAVE_VERSION };
}
