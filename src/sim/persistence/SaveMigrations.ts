/**
 * SaveMigrations — orchestrates historical save migrations.
 *
 * Phase 3: gameplay code must not depend on migration logic. This module owns
 * the chain v3→v13 and is the only place that knows about old versions.
 */

import { migrateV12Save } from './migrations/v12';
import { migrateV13Save } from './migrations/v13';
import { migrateV14Save } from './migrations/v14';
import { migrateV15Save } from './migrations/v15';
import { migrateV16Save } from './migrations/v16';
import { migrateV17Save } from './migrations/v17';
import { CURRENT_SAVE_VERSION } from './SaveSchema';
import { migrateV3Save } from './migrations/v3';
import { migrateV4Save } from './migrations/v4';
import { migrateV5Save } from './migrations/v5';
import { migrateV6Save } from './migrations/v6';
import { migrateV7Save } from './migrations/v7';
import { migrateV8Save } from './migrations/v8';
import { migrateV9Save } from './migrations/v9';
import { migrateV10Save } from './migrations/v10';
import { migrateV11Save } from './migrations/v11';

export type MigratableSave = Record<string, unknown> & { version: number };

/**
 * Migrate any supported historical save (v3..v17) to current (v18).
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
  if (current.version === 10) current = migrateV10Save(current) as MigratableSave;
  if (current.version === 11) current = migrateV11Save(current) as MigratableSave;

  if (current.version === 12) current = migrateV12Save(current) as MigratableSave;
  if (current.version === 13) current = migrateV13Save(current) as MigratableSave;
  if (current.version === 14) current = migrateV14Save(current) as MigratableSave;
  if (current.version === 15) current = migrateV15Save(current) as MigratableSave;
  if (current.version === 16) current = migrateV16Save(current) as MigratableSave;
  if (current.version === 17) current = migrateV17Save(current) as MigratableSave;

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
  migrateV14Save,
  migrateV15Save,
  migrateV16Save,
  migrateV17Save,
  migrateV4Save,
  migrateV5Save,
  migrateV6Save,
  migrateV7Save,
  migrateV8Save,
  migrateV9Save,
  migrateV10Save,
  migrateV11Save,
};
