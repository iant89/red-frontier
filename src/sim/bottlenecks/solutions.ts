/**
 * Phase 5 — the solution tables. Data, not logic: the analyzer measures and
 * picks from these rows; a balance pass rewrites a label, never a branch.
 *
 * Rule (COMMERCIAL-ROADMAP.md Phase 5): the game lists *possible* solutions.
 * It never picks one, never issues the command. The roadmap's own mock —
 * "Increase mining / Reduce consumption / Build storage / Repair Rover 3" —
 * is deliberately echoed in the water column here.
 */

import type { BottleneckKind, BottleneckSolution } from './types';

/**
 * The standing suggestions for each kind, in display order after the
 * concrete echoes (repair this, switch that back on) the analyzer raises
 * from actionable factors. `id` is the solution's stable key; the analyzer
 * drops a row whose `suppressed` comment no longer matches reality — that is
 * all the logic the table itself carries.
 */
export const STATIC_SOLUTIONS: Record<BottleneckKind, ReadonlyArray<Omit<BottleneckSolution, 'entityId'>>> = {
  water: [
    { key: 'haul-ice', label: 'Increase mining — haul more ice; the tap starts at the seam' },
    { key: 'build-storage', label: 'Build storage — a Water Tank forgives a bad sol' },
    { key: 'cut-consumption', label: 'Reduce consumption — pause the thirstiest machine' },
  ],
  oxygen: [
    { key: 'add-generator', label: 'Add an Oxygen Generator — one colonist outbreathes one machine' },
    { key: 'add-tank', label: 'Build storage — tankage turns a brownout into a bad night, not a wake' },
    { key: 'fix-power', label: 'Fix the grid — a starved generator breathes nothing' },
  ],
  power: [
    { key: 'add-generation', label: 'Add a Solar Array — cheap kW, but only while the sun is up' },
    { key: 'add-battery', label: 'Add a Battery Bank — the night is the bill the sol leaves' },
    { key: 'shed-load', label: 'Reduce consumption — shed the heaviest machine until the reserve recovers' },
  ],
};

/** Factor keys whose presence promotes a matching static row or a concrete echo. */
export const EXTRA_SOLUTIONS = {
  /** Raised when no producer of the fluid stands at all. */
  buildProducer: {
    water: { key: 'build-producer', label: 'Build a Water Extractor — nothing else makes the first drop' },
    oxygen: { key: 'build-producer', label: 'Build an Oxygen Generator — the pod is a battery, not a lung' },
    power: { key: 'build-producer', label: 'Build a Solar Array — the pod alone cannot carry a colony' },
  },
  /** Raised for the water chain when ice is the limiting feed. */
  feedWater: { key: 'fix-feed', label: 'Fix water first — oxygen is electrolysed out of it' },
  /** Raised for power when every generator is solar and the night still bites. */
  baseload: { key: 'baseload', label: 'An RTG never sleeps — baseload for the night and the storm' },
} as const;
