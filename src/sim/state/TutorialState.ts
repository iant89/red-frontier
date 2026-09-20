/**
 * TutorialState — Phase 1 First 30 Minutes
 *
 * Tracks first-time milestones, funnel events, and hint dismissal.
 * Deterministic, saved, no DOM.
 *
 * Per COMMERCIAL-ROADMAP-REVIEW.md §5 P1:
 * - Situation → warning → player discovers fix, NOT click-here chain
 * - Forecast utility powers warnings ("Your water reserve will run dry in 1.8 sols.")
 * - Funnel instrumentation: milestone events for "where do new players quit"
 */

export type MilestoneId =
  | 'first-move'
  | 'first-resource-found'
  | 'first-mine'
  | 'first-haul'
  | 'first-build'
  | 'first-power'
  | 'first-water'
  | 'first-oxygen'
  | 'first-food'
  | 'first-automation'
  | 'first-storm-survived'
  | 'first-objective';

export type WarningId =
  | 'water-low'
  | 'water-critical'
  | 'oxygen-low'
  | 'oxygen-critical'
  | 'food-low'
  | 'power-low'
  | 'battery-low'
  | 'panels-dirty'
  | 'rover-stranded'
  | 'storm-inbound'
  | 'building-damaged';

export type HintId =
  | 'welcome'
  | 'move-rover'
  | 'find-resources'
  | 'extract'
  | 'bring-home'
  | 'build'
  | 'power'
  | 'life-support'
  | 'automate'
  | 'storm'
  | 'objective'
  | 'why-water'
  | 'why-oxygen'
  | 'why-power'
  | 'why-rover'
  | 'why-automation';

export interface MilestoneRecord {
  completed: boolean;
  sol: number;
  tick: number;
}

export interface FunnelEvent {
  id: string; // milestone or warning id
  type: 'milestone' | 'warning' | 'hint';
  sol: number;
  tick: number;
  at: number; // simTime seconds
}

export interface WarningRecord {
  lastSeenTick: number;
  lastSeenSol: number;
  count: number;
  active: boolean;
}

export interface TutorialState {
  milestones: Record<MilestoneId, MilestoneRecord>;
  warnings: Record<WarningId, WarningRecord>;
  seenHints: Record<string, boolean>;
  dismissedHints: Record<string, boolean>;
  funnel: FunnelEvent[];
  stats: {
    moves: number;
    mines: number;
    hauls: number;
    builds: number;
    automations: number;
    stormsSurvived: number;
  };
  // Transient UI state, not saved/hashed — derived each tick
  _activeWarnings?: WarningId[];
  _nextHint?: HintId | null;
}

export const ALL_MILESTONES: MilestoneId[] = [
  'first-move',
  'first-resource-found',
  'first-mine',
  'first-haul',
  'first-build',
  'first-power',
  'first-water',
  'first-oxygen',
  'first-food',
  'first-automation',
  'first-storm-survived',
  'first-objective',
];

export const ALL_WARNINGS: WarningId[] = [
  'water-low',
  'water-critical',
  'oxygen-low',
  'oxygen-critical',
  'food-low',
  'power-low',
  'battery-low',
  'panels-dirty',
  'rover-stranded',
  'storm-inbound',
  'building-damaged',
];

export const ALL_HINTS: HintId[] = [
  'welcome',
  'move-rover',
  'find-resources',
  'extract',
  'bring-home',
  'build',
  'power',
  'life-support',
  'automate',
  'storm',
  'objective',
  'why-water',
  'why-oxygen',
  'why-power',
  'why-rover',
  'why-automation',
];

export function emptyMilestones(): Record<MilestoneId, MilestoneRecord> {
  const m = {} as Record<MilestoneId, MilestoneRecord>;
  for (const id of ALL_MILESTONES) {
    m[id] = { completed: false, sol: 0, tick: 0 };
  }
  return m;
}

export function emptyWarnings(): Record<WarningId, WarningRecord> {
  const w = {} as Record<WarningId, WarningRecord>;
  for (const id of ALL_WARNINGS) {
    w[id] = { lastSeenTick: -1e12, lastSeenSol: -1e12, count: 0, active: false };
  }
  return w;
}

export function emptyTutorialState(): TutorialState {
  return {
    milestones: emptyMilestones(),
    warnings: emptyWarnings(),
    seenHints: {},
    dismissedHints: {},
    funnel: [],
    stats: {
      moves: 0,
      mines: 0,
      hauls: 0,
      builds: 0,
      automations: 0,
      stormsSurvived: 0,
    },
  };
}

export function isTutorialComplete(state: TutorialState): boolean {
  // Core 10 steps (excluding objective which needs project system)
  const core: MilestoneId[] = [
    'first-move',
    'first-resource-found',
    'first-mine',
    'first-haul',
    'first-build',
    'first-power',
    'first-water',
    'first-oxygen',
    'first-automation',
    'first-storm-survived',
  ];
  return core.every(id => state.milestones[id]?.completed);
}
