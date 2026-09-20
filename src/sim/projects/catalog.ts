/**
 * Phase 2 — the Engineering Projects table.
 *
 * This file is the whole of the project *content*. `ObjectiveSystem` is a
 * hundred lines of evaluation and bookkeeping; everything a player reads — the
 * ask, the numbers, the reward — is authored here. Adding a project is adding a
 * record; adding a chapter (Phase 9) is a list of records with a shared `after`
 * chain.
 *
 * Two rules kept from the review:
 *
 *  - **Honest to today's entities** (§5 P2). Every requirement names something
 *    that already exists in the build — Battery Bank, Weather Radar Station,
 *    per-rover rules, `rover/repeatRoute`. The first projects are completable
 *    with the shipping building set, which is also what protects the demo
 *    cutline.
 *  - **The flagship comes last** (§3.2). "Survive 10 sols without manual
 *    intervention" is unfair before the colony is legible, so
 *    `autonomousColony` sits at the end of the chain rather than on the board
 *    at sol 1.
 */

import type { ProjectDef, ProjectId } from './types';

export const PROJECTS: ProjectDef[] = [
  {
    id: 'establishSurvival',
    title: 'Establish Survival',
    blurb: 'Bring oxygen, water and food under colony control and keep the lights on through a night.',
    why: 'The lander’s reserves are a countdown, not a plan. Everything after this project is a colony; everything before it is a camping trip.',
    after: [],
    requirements: [
      { type: 'buildingOnline', building: 'oxygenator', count: 1, label: 'Oxygen generator online' },
      { type: 'buildingOnline', building: 'extractor', count: 1, label: 'Water extractor online' },
      { type: 'buildingOnline', building: 'greenhouse', count: 1, label: 'Food production online' },
      { type: 'buildingOnline', building: 'battery', count: 1, label: 'Battery bank online' },
      { type: 'powerStable', minStoredFrac: 0.15, label: 'Stable power (grid covers demand)' },
    ],
    rewards: ['stableOperations'],
  },
  {
    id: 'surviveFirstStorm',
    title: 'Survive the First Storm',
    blurb: 'See it coming, bank enough charge to ride it out, and give the fleet somewhere to be.',
    why: 'A storm is not an event you react to — it is a forecast you prepare against. Dust dims the sun for a sol; the colony that planned for that is the colony that has air.',
    after: ['establishSurvival'],
    requirements: [
      { type: 'buildingOnline', building: 'weatherStation', count: 1, label: 'Weather radar online' },
      { type: 'batteryCapacity', kWh: 400, label: 'Emergency battery reserve' },
      { type: 'buildingOnline', building: 'garage', count: 1, label: 'Shelter for the fleet' },
      { type: 'fluidAmount', fluid: 'water', kg: 80, label: 'Emergency water reserve' },
    ],
    rewards: ['stormForecasting'],
  },
  {
    id: 'industrialize',
    title: 'Industrialize',
    blurb: 'Stop carrying ore by hand: refine it, machine it, and put the fleet on a loop.',
    why: 'Steel is made, not dug, and a machine is built from parts that a machine made. This is where the colony stops being a set of orders and starts being a process.',
    after: ['establishSurvival'],
    requirements: [
      { type: 'buildingOnline', building: 'refinery', count: 1, label: 'Refinery online' },
      { type: 'buildingOnline', building: 'workshop', count: 1, label: 'Workshop online' },
      { type: 'storage', resource: 'iron', kg: 300, label: 'Ore in the silo (mining operation)' },
      { type: 'repeatRoute', count: 1, label: 'Automated haul route running' },
    ],
    rewards: ['advancedAutomation'],
  },
  {
    id: 'remoteOperations',
    title: 'Remote Operations',
    blurb: 'Field a fleet that can work far from the pod, power that does not sleep, and supplies to spare.',
    why: 'Distance is the last constraint that matters. Once a rover can work a week’s drive out and come back, the map stops being a horizon.',
    after: ['industrialize'],
    requirements: [
      { type: 'roverCount', count: 3, label: 'Fleet of three rovers' },
      { type: 'buildingOnline', building: 'rtg', count: 1, label: 'Remote power (RTG online)' },
      { type: 'buildingOnline', building: 'garage', count: 1, label: 'Field support bay online' },
      { type: 'fluidAmount', fluid: 'water', kg: 100, label: 'Emergency water reserve' },
      { type: 'fluidAmount', fluid: 'food', kg: 120, label: 'Emergency rations' },
    ],
    rewards: ['remoteExploration'],
  },
  {
    id: 'autonomousColony',
    title: 'Autonomous Colony',
    blurb: 'Survive ten sols without issuing a single manual order.',
    why: 'The defining challenge of Red Frontier. A policy doing the work is the fantasy working — and until the colony can run a week unattended, you are the machine.',
    after: ['remoteOperations'],
    requirements: [
      { type: 'solsWithoutOrder', sols: 10, label: 'Ten sols without a manual order' },
    ],
    rewards: ['autonomousColony'],
  },
];

const BY_ID = new Map<ProjectId, ProjectDef>(PROJECTS.map((p) => [p.id, p]));

export const PROJECT_IDS: ProjectId[] = PROJECTS.map((p) => p.id);

export function projectById(id: string): ProjectDef | undefined {
  return BY_ID.get(id as ProjectId);
}

/** The chain order used for display and for "what unlocks next". */
export function projectIndex(id: ProjectId): number {
  return PROJECT_IDS.indexOf(id);
}

/** The first project(s) a brand-new colony sees — the ones with no prerequisite. */
export function openingProjects(): ProjectId[] {
  return PROJECTS.filter((p) => p.after.length === 0).map((p) => p.id);
}
