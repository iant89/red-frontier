/**
 * SaveCodec — decodeSave(unknown) → SaveState
 *
 * Phase 3: the untrusted boundary. Takes `unknown` JSON, validates, migrates,
 * and returns a typed current-schema save. Gameplay code should depend only on
 * SaveState, never on raw JSON.
 */

import type { SaveState } from './SaveSchema';
import { CURRENT_SAVE_VERSION } from './SaveSchema';
import { assertIsObject, extractVersion } from './SaveValidator';
import { migrateSave } from './SaveMigrations';

/**
 * Decode an untrusted save payload into a current-version SaveState.
 *
 * Throws:
 * - "empty save" if data is null, undefined, or not an object (legacy behavior)
 * - "unsupported save version X" if version missing or outside 3..8
 *
 * After version check, runs migrations v3..v7 → v8.
 * Returns the migrated object as SaveState (still loosely typed but version is 8).
 *
 * The caller (Simulation.restore) is responsible for applying safe defaults
 * for missing arrays / fields (storage, fluids, etc.) — this codec only ensures
 * version correctness and migration.
 */
export function decodeSave(data: unknown): SaveState {
  assertIsObject(data);
  const version = extractVersion(data);

  let migrated: Record<string, unknown>;
  if (version === CURRENT_SAVE_VERSION) {
    migrated = data as Record<string, unknown>;
  } else {
    migrated = migrateSave({ ...(data as Record<string, unknown>), version } as Record<string, unknown> & {
      version: number;
    }) as unknown as Record<string, unknown>;
  }

  // At this point version is CURRENT_SAVE_VERSION
  return migrated as unknown as SaveState;
}

/**
 * Encode helper — snapshot() already returns SaveState, but we expose a
 * canonical JSON round-trip for determinism tests.
 */
export function encodeSave(state: SaveState): string {
  return JSON.stringify(state);
}

export function decodeSaveJson(json: string): SaveState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('empty save');
  }
  return decodeSave(parsed);
}
