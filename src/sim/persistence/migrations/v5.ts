/**
 * v5 → v6. Colonies gained a difficulty, a world size, a chosen landing
 * region and advanced world options. Older saves predate the mission wizard,
 * so they land on the classic defaults: Pioneer, medium claim, random site.
 */
import { DEFAULT_WORLD_OPTIONS } from '../../difficulty';

export function migrateV5Save(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    version: 6,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS },
  };
}
