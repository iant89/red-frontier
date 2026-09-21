/**
 * Phase 17 — History state.
 *
 * Owns the time-series sample shapes. Sampling behavior lives in
 * `sim/systems/HistorySystem.ts`. Live per-tick fluid accumulators stay in
 * ResourceState (`emptyFlows`).
 *
 * Phase 4 (commercial roadmap) extends this module two ways:
 *
 *   1. The vitals sample widens (ore/steel/components series, fleet
 *      utilization, per-fluid production/consumption rates) and a
 *      **sol-bucketed downsample** (`SolHistoryRow`) sits beside the live
 *      ring, so a 200-sol colony holds 240 rows instead of 300 000 samples.
 *
 *   2. The discrete **event journal** (`JournalEntry`) — the bounded,
 *      persisted, sol-stamped ring COMMERCIAL-ROADMAP-REVIEW.md §3.5 names
 *      as the one prerequisite for the colony report (P11) and the incident
 *      timeline (P12). This state module is the journal's named owner, as
 *      its own header has promised since Phase 17. Streaming events
 *      (per-tick production/consumption, per-move telemetry) are not
 *      journal entries — the flow windows and the vitals rings already own
 *      rates, and a ring of them would flush in seconds.
 */

import type { DomainEvent } from '../domainEvents';
import type { FluidId } from '../defs';

/** One point on the colony vitals chart (power + fluid pools). */
export interface HistorySample {
  t: number;
  genKw: number;
  loadKw: number;
  storedFrac: number;
  water: number;
  oxygen: number;
  food: number;
  /** Phase 4 — bulk mined material in storage, kg summed over the seams. */
  ore: number;
  /** Phase 4 — refined steel in storage, kg. */
  steel: number;
  /** Phase 4 — manufactured units on the rack (counted, not weighed). */
  components: number;
  /** Phase 4 — fraction of the fleet holding a live task, [0, 1]. */
  roverUtil: number;
  /** Phase 4 — trailing-sol production rate per fluid, kg/sol. */
  prod: Record<FluidId, number>;
  /** Phase 4 — trailing-sol consumption rate per fluid, kg/sol. */
  cons: Record<FluidId, number>;
}

/**
 * Phase 4 — one sol rolled into a single row. The dashboard's long view and
 * the future colony report (P11) read these; the live ring keeps its 120
 * samples either way. Rates and means are sol averages over the samples the
 * sol produced; `storedFracMin` is the sol's worst battery moment; the pool
 * and ledger columns are end-of-sol values.
 */
export interface SolHistoryRow {
  /** Whole sol number this row closes (1-based, the clock's `sol`). */
  sol: number;
  genKwAvg: number;
  loadKwAvg: number;
  storedFracMin: number;
  roverUtilAvg: number;
  water: number;
  oxygen: number;
  food: number;
  ore: number;
  steel: number;
  components: number;
  /** Sol totals per fluid, kg. */
  prod: Record<FluidId, number>;
  cons: Record<FluidId, number>;
}

/**
 * Transient within-sol accumulator — derived state (never saved, never
 * hashed): the same row is reproducible from the sol's samples, and a
 * restored colony recomputes its partial sol exactly the way it recomputes
 * its charts. `HistorySystem.clear` / `afterTimeJump` reset it.
 */
export interface SolAccumulator {
  count: number;
  genKw: number;
  loadKw: number;
  storedFracMin: number;
  roverUtil: number;
  prod: Record<FluidId, number>;
  cons: Record<FluidId, number>;
}

export function emptySolAccumulator(): SolAccumulator {
  return {
    count: 0,
    genKw: 0,
    loadKw: 0,
    storedFracMin: 1,
    roverUtil: 0,
    prod: { water: 0, oxygen: 0, food: 0 },
    cons: { water: 0, oxygen: 0, food: 0 },
  };
}

// ------------------------------------------------------------ journal ----

/**
 * Phase 4 — one journaled event: the domain event spread flat, stamped with
 * the absolute sol (`clock.solsElapsed`, fractional) at which it happened.
 * Plain JSON — the ring is saved whole.
 */
export type JournalEntry = { sol: number } & DomainEvent;

/**
 * Domain event types the journal deliberately skips: per-tick flow records
 * (rates live in the flow windows and history rings — a ring of thousands a
 * sol would flush the bound in seconds) and per-move telemetry (a haul loop
 * emits several a sol; the movements it fails to name teach nothing a report
 * would print). Everything else — milestones, failures, discoveries,
 * construction, rover incidents, storms, objectives, unlocks, autonomy
 * breaks, policy actions, tutorial beats — is exactly what P11/P12
 * aggregate, so it is kept.
 */
const JOURNAL_SKIP: ReadonlySet<DomainEvent['type']> = new Set([
  'resource/produced',
  'resource/consumed',
  'rover/moved',
]);

/** True when an event earns a permanent journal line. Exported for tests. */
export function journalWorthy(event: DomainEvent): boolean {
  return !JOURNAL_SKIP.has(event.type);
}

/** Bind one event into one stamped entry. */
export function journalEntry(event: DomainEvent, sol: number): JournalEntry {
  return { sol, ...event } as JournalEntry;
}

/**
 * Record one discrete domain event into the bounded journal (Phase 4 —
 * COMMERCIAL-ROADMAP-REVIEW §3.5's persisted, sol-stamped ring). Wired to
 * `DomainEventLog.sink` at state creation, so every system that pushes an
 * event journals it without knowing the journal exists. Streaming types
 * the skip list names never reach the ring. Entry order is push order;
 * sols are the clock's absolute fractional sols. Reads nothing back — the
 * ring is a report, never an input.
 */
export function pushJournal(journal: JournalEntry[], event: DomainEvent, sol: number, max: number): void {
  if (!journalWorthy(event)) return;
  journal.push(journalEntry(event, sol));
  while (journal.length > max) journal.shift();
}
