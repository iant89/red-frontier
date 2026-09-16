/**
 * v1 migration — no longer supported. Historical saves older than v3 are
 * rejected as unsupported. This file exists to document the boundary.
 */
export function migrateV1Save(_data: Record<string, unknown>): Record<string, unknown> {
  throw new Error('unsupported save version 1');
}
