/**
 * SaveMigrations — orchestrates historical save migrations.
 *
 * Phase 3: gameplay code must not depend on migration logic. This module owns
 * the chain v3→v10 and is the only place that knows about old versions.
 */

import { CURRENT_SAVE_VERSION } from './SaveSchema';
import { migrateV3Save } from './migrations/v3';
import { migrateV4Save } from './migrations/v4';
import { migrateV5Save } from './migrations/v5';
import { migrateV6Save } from './migrations/v6';
import { migrateV7Save } from './migrations/v7';
import { migrateV8Save } from './migrations/v8';
import { migrateV9Save } from './migrations/v9';

export type MigratableSave = Record<string, unknown> & { version: number };

/**
 * Migrate any supported historical save (v3..v9) to current (v10).
 * Assumes `data.version` has already been validated as number in supported range.
 */
export function migrateSave(data: Record<string, unknown>): MigratableSave {
  let current = { ...data } as MigratableSave;

  // Ensure version is a number (caller validated)
  if (current.version === 3) current = migrateV3Save(current) as MigratableSave;
  if (current.version === 4) current = migrateV4Save(current) as MigratableSave;
  if (current.version === 5) current = migrateV5Save(current) as MigratableSave;
  if (current.version === 6) current = migrateV6Save(current) as MigratableSave;
  if (current.version === 7) current = migrateV7Save(current) as MigratableSave;
  if (current.version === 8) current = migrateV8Save(current) as MigratableSave;
  if (current.version === 9) current = migrateV9Save(current) as MigratableSave;

  if (current.version !== CURRENT_SAVE_VERSION) {
    throw new Error(`unsupported save version ${current.version}`);
  }
  return current;
}

/**
 * For testing: migrate a specific version without version check loop.
 * Re-exports individual migrators.
 */
export {
  migrateV3Save,
  migrateV4Save,
  migrateV5Save,
  migrateV6Save,
  migrateV7Save,
  migrateV8Save,
  migrateV9Save,
};
