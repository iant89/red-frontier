/**
 * Phase 2 — Building state (extracted from Simulation.ts).
 */

import type { ResourceAmounts, BuildingKind, RoverKind } from '../defs';
import { ALL_RESOURCES } from '../defs';

export interface Building {
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
