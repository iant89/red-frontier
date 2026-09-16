/**
 * v2 migration — no longer supported.
 */
export function migrateV2Save(_data: Record<string, unknown>): Record<string, unknown> {
  throw new Error('unsupported save version 2');
}
