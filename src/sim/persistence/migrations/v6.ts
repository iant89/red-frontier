/**
 * v6 → v7. Colonies gained an explorable planet: scattered points of interest
 * (GDD §06) and Earth cargo missions on a schedule (GDD §10).
 *
 * Neither has a v6 equivalent, so an older save simply has not found anything
 * yet: the sites are regenerated from the seed on restore (`World` scatters them
 * in its constructor and `restore` only replaces the list when the save carries
 * one), and the drop schedule is re-rolled from the launch window. A colony
 * saved before the feature existed therefore behaves exactly as it did, plus a
 * planet with somewhere to go.
 */
export function migrateV6Save(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: 7 };
}
