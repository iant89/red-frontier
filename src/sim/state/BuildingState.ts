/**
 * Phase 2 — Building state (extracted from Simulation.ts).
 */

import type { EngineeringState } from '../engineering/upgrades';
import type { RoverPartId, ComponentAmounts, ResourceAmounts, BuildingKind, RoverKind } from '../defs';
import { ALL_COMPONENTS, ALL_RESOURCES } from '../defs';

export interface PartReplacement {
  roverId: number;
  component: RoverPartId;
  progress: number;
}

export interface Building extends EngineeringState {
  id: number;
  kind: BuildingKind;
  x: number;
  z: number;
  rot: number;
  state: 'site' | 'building' | 'online';
  remainingCost: ResourceAmounts;
  needsMaterials: boolean;
  progress: number;
  buildTime: number;
  workerId: number | null;
  enabled: boolean;
  powerSat: number;
  throughput: number;
  genKw: number;
  loadKw: number;
  idleReason: string;
  health: number;
  cleanliness: number;
  damaged: boolean;
  assembly: { kind: RoverKind; progress: number } | null;
  level: number;
  /** Repair Bay job; parts are paid for atomically on completion, never per tick. */
  maintenance: PartReplacement | null;
  /**
   * Which recipe this building is running (P5): an index into
   * `RECIPES[kind]`, ignored by a kind with no recipe list. Persisted and
   * hashed — it changes what the building does, so it is colony state, not
   * runtime decoration.
   */
  recipe: number;
  /**
   * Fractional progress toward the next whole component of each type, kept on
   * the bench that is making it. A recipe's `componentOut` is a rate per Mars
   * hour, and a unit is only racked once it is finished — so the fraction lives
   * here rather than in the ledger, which counts whole things only. Keyed by
   * component, not by recipe: switching lines keeps whatever was half-made.
   */
  craft: ComponentAmounts;
}

/** A fresh bench: nothing half-made, first recipe selected. */
export function emptyCraft(): ComponentAmounts {
  const c = {} as ComponentAmounts;
  for (const k of ALL_COMPONENTS) c[k] = 0;
  return c;
}

export function remainingCostTotal(b: Pick<Building, 'remainingCost'>): number {
  let t = 0;
  for (const k of ALL_RESOURCES) t += b.remainingCost[k];
  return t;
}

export function lightningVulnerability(b: { kind: BuildingKind; generation?: 'solar' | 'baseload' }): number {
  if (b.generation === 'solar') return 1.9;
  switch (b.kind) {
    case 'battery':
    case 'oxygenator':
      return 1.5;
    case 'workshop':
      return 1.3;
    default:
      return 1;
  }
}
