/**
 * The unlock registry — Phase 2's shared primitive.
 *
 * COMMERCIAL-ROADMAP-REVIEW.md §3.3: Phases 2 (Engineering Projects), 7 (POI
 * events) and 9 (Campaign) all *grant* something — "Storm Forecasting",
 * "Advanced Automation", "New Technology", chapter progression. Every blueprint
 * is available from sol 1 today and there is no gating concept anywhere in the
 * sim, so without one registry each of those phases invents its own gating and
 * they fight later. This module is the one saved set of ids they all read.
 *
 * What it deliberately is not:
 *
 *  - **Not a gate yet.** Nothing is locked behind an unlock in this phase. The
 *    roadmap's own review insists the first projects be completable with
 *    today's building set, so blueprint availability stays untouched. The
 *    first consumers are P3's policies (`advancedAutomation`) and P7's POI
 *    contents.
 *  - **Not research.** GDD §09's six-tier research tree is still deferred; a
 *    project granting an unlock needs no tech tree, and adding one later does
 *    not rework this file.
 *
 * Pure data + pure helpers: no DOM, no RNG, no tick. Deterministic by
 * construction, because the granted set is part of the hashed colony state.
 */

export type UnlockId =
  /** P2 — Establish Survival (colony enters stable operations). */
  | 'stableOperations'
  /** P2 — Survive the First Storm; the weather system reads it for lead time. */
  | 'stormForecasting'
  /** P2 — Industrialize; gates P3's colony-level standing orders. */
  | 'advancedAutomation'
  /** P2 — Remote Operations; gates P6's expedition planning. */
  | 'remoteExploration'
  /** P2 — Autonomous Colony: the flagship, and the campaign's end condition. */
  | 'autonomousColony';

export interface UnlockInfo {
  id: UnlockId;
  /** Player-facing name, shown in the projects panel when the reward lands. */
  title: string;
  /** One line on what it changes — or on what it *will* change, honestly. */
  blurb: string;
}

export const UNLOCKS: Record<UnlockId, UnlockInfo> = {
  stableOperations: {
    id: 'stableOperations',
    title: 'Stable Operations',
    blurb: 'Oxygen, water, food and power no longer depend on the lander’s reserves. The colony is self-sustaining on a good sol.',
  },
  stormForecasting: {
    id: 'stormForecasting',
    title: 'Storm Forecasting',
    blurb: 'Radar tracks storm cells and their drift, so warnings come with a track instead of a guess.',
  },
  advancedAutomation: {
    id: 'advancedAutomation',
    title: 'Advanced Automation',
    blurb: 'Colony-level standing orders: the fleet works to a policy you set instead of an order you click.',
  },
  remoteExploration: {
    id: 'remoteExploration',
    title: 'Remote Exploration',
    blurb: 'Expedition planning beyond the near horizon — range, fuel and supply stops before a rover leaves.',
  },
  autonomousColony: {
    id: 'autonomousColony',
    title: 'Autonomous Colony',
    blurb: 'The colony ran itself for ten sols. Nothing about Mars changed; everything about the colony did.',
  },
};

/** Stable display order — the panel lists earned unlocks in this order. */
export const ALL_UNLOCKS: UnlockId[] = [
  'stableOperations',
  'stormForecasting',
  'advancedAutomation',
  'remoteExploration',
  'autonomousColony',
];

/** When and why an unlock landed. Sol-stamped so reports (P11) can quote it. */
export interface UnlockRecord {
  sol: number;
  tick: number;
  /** What granted it: a project id today, later a POI id or a chapter. */
  source: string;
}

/**
 * The saved registry. Every id is present with `null` for locked, the way
 * `TutorialState.milestones` carries every milestone — so a hand-edited save
 * that omits a key is visibly incomplete rather than silently locked.
 */
export type UnlockRegistry = Record<UnlockId, UnlockRecord | null>;

export function emptyUnlocks(): UnlockRegistry {
  const reg = {} as UnlockRegistry;
  for (const id of ALL_UNLOCKS) reg[id] = null;
  return reg;
}

export function hasUnlock(reg: UnlockRegistry, id: UnlockId): boolean {
  return reg[id] != null;
}

/**
 * Grant an unlock. Returns true only when it is newly granted — a second grant
 * (a replayed project, a save edited twice) is a no-op, so the sol stamp is
 * always the first time the colony earned it.
 */
export function grantUnlock(
  reg: UnlockRegistry,
  id: UnlockId,
  source: string,
  sol: number,
  tick: number,
): boolean {
  if (!UNLOCKS[id]) return false;
  if (reg[id] != null) return false;
  reg[id] = { sol: Math.max(0, sol), tick: Math.max(0, Math.floor(tick)), source: String(source) };
  return true;
}

/** The ids that are unlocked, in {@link ALL_UNLOCKS} order. */
export function unlockedIds(reg: UnlockRegistry): UnlockId[] {
  return ALL_UNLOCKS.filter((id) => reg[id] != null);
}

/** Count of granted unlocks — the colony report's achievement line (P11). */
export function unlockCount(reg: UnlockRegistry): number {
  let n = 0;
  for (const id of ALL_UNLOCKS) if (reg[id] != null) n++;
  return n;
}
