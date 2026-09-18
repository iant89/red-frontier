/**
 * Phase 2 — Resource state helpers.
 * Pure data transformations for storage and fluid pools.
 */

import type { ResourceId, ResourceAmounts, FluidId } from '../defs';
import { ALL_RESOURCES, ALL_FLUIDS } from '../defs';

export interface FluidFlow {
  produced: number;
  consumed: number;
}

export function storageTotal(storage: ResourceAmounts): number {
  let t = 0;
  for (const r of ALL_RESOURCES) t += storage[r];
  return t;
}

export function storageRoom(storage: ResourceAmounts, capacityPerResource: number, res: ResourceId): number {
  return Math.max(0, capacityPerResource - storage[res]);
}

export function storageFull(storage: ResourceAmounts, capacityPerResource: number): boolean {
  for (const r of ALL_RESOURCES) {
    if (storageRoom(storage, capacityPerResource, r) > 0.01) return false;
  }
  return true;
}

export function fullResources(storage: ResourceAmounts, capacityPerResource: number): ResourceId[] {
  return ALL_RESOURCES.filter((r) => storageRoom(storage, capacityPerResource, r) <= 0.01);
}
