/**
 * v16 → v17: colony standing orders (Phase 3, slice 2).
 *
 * Additive: an old colony has no policies armed. A hand-edited `policies`
 * block is sanitised field by field; `held` ids that name no building in the
 * save are dropped so the night-power policy never "restores" a ghost.
 */
import type { HistoricalSave } from '../SaveSchema';
import { sanitisePolicies } from '../policySave';

export function migrateV16Save(data: HistoricalSave): HistoricalSave {
  const buildings = (data as { buildings?: Array<{ id?: unknown }> }).buildings ?? [];
  const ids = new Set<number>();
  for (const b of buildings) if (Number.isInteger(b?.id)) ids.add(b.id as number);
  const policies = sanitisePolicies((data as { policies?: unknown }).policies, ids);
  return { ...data, version: 17, policies };
}
