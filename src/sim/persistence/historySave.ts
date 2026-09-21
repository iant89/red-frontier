/**
 * The history block's one sanitiser, shared by the v17 migration and the
 * restorer (SAVE-COMPATIBILITY.md: sanitise, don't trust). A missing or
 * hostile block is empty charts and an empty log — never a throw.
 *
 * Phase 4 (v18): `sols` is the bounded, downsampled sol history; `journal`
 * is the bounded, sol-stamped event ring. Both are inert data (nothing ticks
 * from them), so the checks are shape checks: finite numbers, plausible
 * ranges, the journal's streaming skip list re-applied, and each ring
 * truncated to its bound (keeping the most recent entries, which is what a
 * live ring would have kept).
 */
import type { HistorySave } from './SaveSchema';
import type { SolHistoryRow, JournalEntry } from '../state/HistoryState';
import { journalWorthy } from '../state/HistoryState';
import { ALL_FLUIDS } from '../defs';
import type { FluidId } from '../defs';
import type { DomainEvent } from '../domainEvents';
import { SOL_HISTORY_ROWS, EVENT_JOURNAL_MAX } from '../config';

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  if (!Number.isFinite(v as number)) return fallback;
  const n = Number(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function frac(v: unknown, fallback: number): number {
  return num(v, fallback, 0, 1);
}

function fluidRecord(v: unknown): Record<FluidId, number> {
  const out = { water: 0, oxygen: 0, food: 0 } as Record<FluidId, number>;
  if (!v || typeof v !== 'object') return out;
  const r = v as Record<string, unknown>;
  for (const f of ALL_FLUIDS) out[f] = num(r[f], 0, 0, Number.MAX_SAFE_INTEGER);
  return out;
}

function solRow(v: unknown): SolHistoryRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const sol = Number(r.sol);
  if (!Number.isInteger(sol) || sol < 1) return null;
  return {
    sol,
    genKwAvg: num(r.genKwAvg, 0, 0, Number.MAX_SAFE_INTEGER),
    loadKwAvg: num(r.loadKwAvg, 0, 0, Number.MAX_SAFE_INTEGER),
    storedFracMin: frac(r.storedFracMin, 0),
    roverUtilAvg: frac(r.roverUtilAvg, 0),
    water: num(r.water, 0, 0, Number.MAX_SAFE_INTEGER),
    oxygen: num(r.oxygen, 0, 0, Number.MAX_SAFE_INTEGER),
    food: num(r.food, 0, 0, Number.MAX_SAFE_INTEGER),
    ore: num(r.ore, 0, 0, Number.MAX_SAFE_INTEGER),
    steel: num(r.steel, 0, 0, Number.MAX_SAFE_INTEGER),
    components: num(r.components, 0, 0, Number.MAX_SAFE_INTEGER),
    prod: fluidRecord(r.prod),
    cons: fluidRecord(r.cons),
  };
}

function journalRow(v: unknown): JournalEntry | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.type !== 'string' || r.type.length === 0 || !r.type.includes('/')) return null;
  // The ring's own rule: streaming events are never entries. A hand-edited
  // save carrying them loses them here, exactly as if the live ring had
  // refused them.
  if (!journalWorthy({ type: r.type } as DomainEvent)) return null;
  const sol = Number(r.sol);
  if (!Number.isFinite(sol)) return null;
  return { ...r, sol: Math.max(0, sol) } as unknown as JournalEntry;
}

export function sanitiseHistory(saved: unknown): HistorySave {
  const out: HistorySave = { sols: [], journal: [] };
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, unknown>;

  if (Array.isArray(s.sols)) {
    for (const v of s.sols) {
      const row = solRow(v);
      if (row) out.sols.push(row);
    }
    out.sols.sort((a, b) => a.sol - b.sol);
    if (out.sols.length > SOL_HISTORY_ROWS) out.sols = out.sols.slice(-SOL_HISTORY_ROWS);
  }

  if (Array.isArray(s.journal)) {
    for (const v of s.journal) {
      const row = journalRow(v);
      if (row) out.journal.push(row);
    }
    if (out.journal.length > EVENT_JOURNAL_MAX) {
      out.journal = out.journal.slice(-EVENT_JOURNAL_MAX);
    }
  }

  return out;
}
