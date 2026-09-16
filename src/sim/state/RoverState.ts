/**
 * Phase 2 — Rover state (extracted from Simulation.ts).
 * Pure data + tiny helpers; no simulation tick logic.
 * Simulation.ts re-exports these for backward compat.
 */

import type { ResourceAmounts, RoverKind } from '../defs';
import { ALL_RESOURCES } from '../defs';
import { ROVER_CHARGE_THRESHOLD } from '../config';

export type RoverTask =
  | { type: 'idle' }
  | { type: 'moveTo'; x: number; z: number }
  | { type: 'mine'; depositId: number; repeat?: boolean }
  | { type: 'construct'; buildingId: number }
  | { type: 'clean'; buildingId: number }
  | { type: 'repair'; buildingId: number }
  | { type: 'recover'; roverId: number; give?: number; given?: number }
  | { type: 'salvage'; poiId: number }
  | { type: 'unload' }
  | { type: 'wait'; seconds: number };

export type RoverCommand = RoverTask;

export interface RoverRules {
  chargeFloorPct: number;
  autoHaul: boolean;
  autoService: boolean;
  stormShelter: boolean;
  autoRescue: boolean;
}

export function defaultRoverRules(): RoverRules {
  return {
    chargeFloorPct: Math.round(ROVER_CHARGE_THRESHOLD * 100),
    autoHaul: true,
    autoService: true,
    stormShelter: true,
    autoRescue: true,
  };
}

export type RoverGoal =
  | 'idle'
  | 'move'
  | 'mine'
  | 'toDepot'
  | 'unload'
  | 'toSite'
  | 'build'
  | 'toCharge'
  | 'charge'
  | 'toService'
  | 'service'
  | 'toSalvage'
  | 'salvage'
  | 'toRecover'
  | 'recover';

export type RoverPhase = 'idle' | 'moving' | 'working' | 'charging' | 'disabled';

export interface Rover {
  id: number;
  kind: RoverKind;
  label: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  battery: number;
  cargo: ResourceAmounts;
  phase: RoverPhase;
  command: RoverTask;
  pending: RoverTask[];
  goal: RoverGoal;
  gx: number;
  gz: number;
  gid: number;
  recharge: boolean;
  lowBatteryNotified: boolean;
  statusText: string;
  chargeSat: number;
  autoTask: boolean;
  condition: number;
  rules: RoverRules;
  routePaused: boolean;
  blockNotified: boolean;
  sheltered: boolean;
  lightsOn: boolean;
  lightsActive: boolean;
  navPath: Array<{ x: number; z: number }>;
  navI: number;
}

export function cargoMass(r: Pick<Rover, 'cargo'>): number {
  let t = 0;
  for (const k of ALL_RESOURCES) t += r.cargo[k];
  return t;
}

export function roverStatusText(r: Pick<Rover, 'phase' | 'sheltered' | 'routePaused' | 'command' | 'goal'>): string {
  if (r.phase === 'disabled') return 'Disabled — out of power';
  if (r.sheltered) return 'Sheltering from storm';
  if (r.routePaused) return 'Route paused — silo full';
  if (r.command.type === 'wait') return `Waiting (${Math.max(0, Math.ceil(r.command.seconds))} s)`;
  switch (r.goal) {
    case 'idle':
      return r.phase === 'charging' ? 'Charging' : 'Idle';
    case 'move':
      return 'Moving';
    case 'mine':
      return r.command.type === 'mine' && (r.command as any).repeat ? 'Hauling route' : 'Mining';
    case 'toDepot':
    case 'unload':
      return 'Hauling to storage';
    case 'toSite':
      return 'Heading to build site';
    case 'build':
      return 'Building';
    case 'toCharge':
      return 'Returning to charge';
    case 'charge':
      return 'Charging';
    case 'toService':
    case 'service':
      return r.command.type === 'repair' ? 'Repairing' : 'Cleaning panels';
    case 'toRecover':
      return 'Responding to stranded rover';
    case 'recover':
      return 'Jump-starting a stranded rover';
    case 'toSalvage':
      return 'Heading to the site';
    case 'salvage':
      return 'Salvaging';
    default:
      return r.phase;
  }
}
