/**
 * Phase 5 — the shape of a Bottleneck report.
 *
 * Raw simulation information, turned into an engineering decision without
 * making the decision for the player: what is short, how short, when it
 * breaks, what is causing it, and what the player's hands could do about it.
 *
 * The review's constraint (COMMERCIAL-ROADMAP-REVIEW.md §5 P5):
 *
 *   > one pure "analyzer" module in sim/ (testable without UI): inputs =
 *   > history + current state; outputs = ranked bottlenecks with contributing
 *   > factors and *static* solution suggestions per bottleneck type. 3
 *   > bottleneck types at first (water, power, oxygen), not a general solver.
 *
 * And the roadmap's principle, enforced by keeping description (the P4
 * dashboard) and advice (this panel) separate:
 *
 *   > The game should NOT automatically solve the problem. It should provide
 *   > enough information for the player to make the decision.
 *
 * Data shape rules: everything here is plain JSON — the snapshot crosses the
 * worker boundary whole. No Map, no Infinity (projected shortage is `null`
 * when nothing is draining). Copy lives beside the data it describes, the
 * same convention project labels keep in `sim/projects/catalog.ts`.
 */

/** The three systems the analyzer watches. Scoped on purpose — not a general solver. */
export const BOTTLENECK_KINDS = ['water', 'oxygen', 'power'] as const;
export type BottleneckKind = (typeof BOTTLENECK_KINDS)[number];

/** How loud the panel should be. Mirrors the forecast warning tiers. */
export type BottleneckSeverity = 'watch' | 'warning' | 'critical';

/**
 * One measured reason the shortage is happening — never a guess. Each factor
 * is written as one clause ("Water Extractor #1004 damaged — tripped
 * offline") and links back to the entity it names when there is one, so the
 * panel can focus the machine the way an alert does.
 */
export interface BottleneckFactor {
  /** Stable within a kind: `no-producer`, `producer/1004`, `feed/empty`, … */
  key: string;
  label: string;
  entityId: number | null;
}

/**
 * One thing the player's hands could do. Static per kind (a data table, like
 * project copy), with concrete echoes raised from actionable factors —
 * "Repair Water Extractor #1004" beside "Build storage". The sim names them;
 * it never issues the command itself.
 */
export interface BottleneckSolution {
  /** Stable within a kind: `haul-ice`, `repair/1004`, `build-tank`, … */
  key: string;
  label: string;
  entityId: number | null;
}

/** One bottleneck, ranked: the measurable shortage and its story. */
export interface BottleneckReport {
  kind: BottleneckKind;
  /** Roadmap-mock headline: "WATER BOTTLENECK". */
  title: string;
  severity: BottleneckSeverity;
  /** Trailing-sol rates in `unit` per sol (kg/sol for fluids, kWh/sol for power). */
  productionPerSol: number;
  consumptionPerSol: number;
  unit: 'kg' | 'kWh';
  /**
   * Sols until the reserve is gone at the current net rate — the mock's
   * "Projected shortage: 3.2 sols". `null` when nothing is draining.
   */
  projectedShortageSols: number | null;
  /** Measured causes, worst first, capped — see the analyzer's factor cap. */
  factors: BottleneckFactor[];
  /** Player actions, concrete echoes first, capped with the factors. */
  solutions: BottleneckSolution[];
}

/** The whole advisory picture: a ranked list, worst first. */
export interface BottleneckSnapshot {
  /** Active bottlenecks only — a healthy colony carries none. */
  bottlenecks: BottleneckReport[];
  /** The one to look at first (`bottlenecks[0]`), or null when clear. */
  next: BottleneckReport | null;
}
