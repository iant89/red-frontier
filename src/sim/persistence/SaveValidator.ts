/**
 * SaveValidator — validates untrusted save data at the boundary.
 *
 * Phase 3: persistence extraction. Uses `unknown` at the boundary, never `any`
 * for external input. Gameplay code should not depend on this.
 */

import type { RoverTask } from '../state/RoverState';
import { CURRENT_SAVE_VERSION } from './SaveSchema';

/**
 * Validate that `data` is a non-null object. Throws with "empty save" if not,
 * matching legacy behavior expected by save-validation tests.
 */
export function assertIsObject(data: unknown): asserts data is Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    throw new Error('empty save');
  }
}

/**
 * Extract and validate save version. Throws "unsupported save version" if missing
 * or outside supported range.
 *
 * Supported range: 3..CURRENT_SAVE_VERSION inclusive. Older than 3 is considered
 * unsupported (no migration path kept).
 */
export function extractVersion(data: Record<string, unknown>): number {
  const v = (data as { version?: unknown }).version;
  if (!Number.isFinite(v as number)) {
    throw new Error(`unsupported save version ${String(v)}`);
  }
  const version = v as number;
  if (version < 3 || version > CURRENT_SAVE_VERSION) {
    throw new Error(`unsupported save version ${version}`);
  }
  return version;
}

/**
 * Validate one task out of a (possibly untrusted) save: shape-check every
 * field and drop anything malformed rather than executing it (TDD §24).
 *
 * This is the same logic that lived in Simulation.ts `coerceTask`, now owned
 * by persistence.
 */
export function coerceTask(t: unknown): RoverTask | null {
  if (!t || typeof (t as { type?: unknown }).type !== 'string') return null;
  const task = t as Record<string, unknown>;
  switch (task.type) {
    case 'moveTo':
      return Number.isFinite(task.x as number) && Number.isFinite(task.z as number)
        ? { type: 'moveTo', x: task.x as number, z: task.z as number }
        : null;
    case 'mine':
      return Number.isFinite(task.depositId as number)
        ? {
            type: 'mine',
            depositId: task.depositId as number,
            ...((task as { repeat?: unknown }).repeat ? { repeat: true as const } : {}),
          }
        : null;
    case 'construct':
    case 'clean':
    case 'repair':
      return Number.isFinite(task.buildingId as number)
        ? { type: task.type as 'construct' | 'clean' | 'repair', buildingId: task.buildingId as number }
        : null;
    case 'recover':
      return Number.isFinite(task.roverId as number)
        ? {
            type: 'recover',
            roverId: task.roverId as number,
            ...(Number.isFinite(task.give as number) ? { give: task.give as number, given: (task.given as number) ?? 0 } : {}),
          }
        : null;
    case 'salvage':
      return Number.isFinite(task.poiId as number) ? { type: 'salvage', poiId: task.poiId as number } : null;
    case 'unload':
      return { type: 'unload' };
    case 'wait':
      return { type: 'wait', seconds: Math.max(0, Number(task.seconds) || 0) };
    default:
      return null;
  }
}

/**
 * Lightweight validation of current save after migration — checks required top-level
 * arrays exist (coerced to empty if missing by restore, but we validate shape here).
 * Returns list of warnings; throws only on version mismatch (already handled).
 */
export function validateCurrentSaveShape(data: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (!Array.isArray((data as { rovers?: unknown }).rovers)) {
    warnings.push('missing rovers array — will default to empty');
  }
  if (!Array.isArray((data as { buildings?: unknown }).buildings)) {
    warnings.push('missing buildings array — will default to empty');
  }
  if (!Array.isArray((data as { deposits?: unknown }).deposits)) {
    warnings.push('missing deposits array — will default to empty');
  }
  if (typeof (data as { seed?: unknown }).seed !== 'number') {
    warnings.push('missing or invalid seed');
  }
  return warnings;
}
