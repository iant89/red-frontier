/**
 * @suite sim/event-journal
 * @group unit
 * @covers src/sim/state/HistoryState.ts src/sim/domainEvents.ts src/sim/persistence/historySave.ts src/sim/persistence/migrations/v17.ts src/sim/persistence/ColonyPersistence.ts src/sim/persistence/SaveValidator.ts src/sim/debug/StateHash.ts
 * @desc Phase 4 (COMMERCIAL-ROADMAP P4, review §3.5): the persisted, bounded,
 * sol-stamped event journal — the one prerequisite the colony report (P11) and
 * incident timeline (P12) build on. Streaming events never enter the ring;
 * the ring survives a save round-trip; a hostile history block is sanitised;
 * the journal is hashed so two runs that remember different events differ.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { pushJournal, journalWorthy } from '../../src/sim/state/HistoryState';
import type { JournalEntry } from '../../src/sim/state/HistoryState';
import type { DomainEvent } from '../../src/sim/domainEvents';
import { EVENT_JOURNAL_MAX } from '../../src/sim/config';
import { snapshotColony } from '../../src/sim/persistence/ColonyPersistence';
import { sanitiseHistory } from '../../src/sim/persistence/historySave';
import { migrateV17Save } from '../../src/sim/persistence/migrations/v17';
import { migrateSave } from '../../src/sim/persistence/SaveMigrations';
import { validateCurrentSaveShape } from '../../src/sim/persistence/SaveValidator';
import { hashSimulationSection } from '../../src/sim/debug/StateHash';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 31): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

// ==================================================== the ring itself ====

group('pushJournal — what earns a line');

test('discrete events enter the ring stamped with the absolute sol', () => {
  const journal: JournalEntry[] = [];
  pushJournal(journal, { type: 'storm/started', kind: 'dustStorm' }, 3.25, EVENT_JOURNAL_MAX);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].type, 'storm/started');
  assert.equal(journal[0].sol, 3.25);
  assert.equal((journal[0] as { kind?: string }).kind, 'dustStorm', 'event payload survives the stamp');
});

test('streaming events never enter: produced/consumed/moved', () => {
  const journal: JournalEntry[] = [];
  const streaming: DomainEvent[] = [
    { type: 'resource/produced', resource: 'water', amount: 3, buildingId: 1 },
    { type: 'resource/consumed', resource: 'iron', amount: 1, buildingId: 2 },
    { type: 'rover/moved', roverId: 7, x: 1, z: 2 },
  ];
  for (const e of streaming) assert.equal(journalWorthy(e), false, `${e.type} skipped`);
  for (const e of streaming) pushJournal(journal, e, 1, EVENT_JOURNAL_MAX);
  assert.equal(journal.length, 0, 'a busy colony does not flush the ring with rates');
});

test('the ring is bounded, keeping the newest entries', () => {
  const journal: JournalEntry[] = [];
  for (let i = 0; i < EVENT_JOURNAL_MAX + 10; i++) {
    pushJournal(journal, { type: 'storm/ended' }, i, EVENT_JOURNAL_MAX);
  }
  assert.equal(journal.length, EVENT_JOURNAL_MAX);
  assert.equal(journal[0].sol, 10, 'oldest entries fall off the front');
  assert.equal(journal[journal.length - 1].sol, EVENT_JOURNAL_MAX + 9);
});

// ==================================================== live wiring ====

group('DomainEventLog sink — systems journal without knowing');

test('pushing a domain event journals it with the clock solsElapsed', () => {
  const sim = fresh();
  assert.equal(sim.journal.length, 0);
  sim.state.domainEvents.push({ type: 'poi/discovered', poiId: 5, kind: 'crashSite' });
  assert.equal(sim.journal.length, 1, 'sink saw the push');
  assert.equal(sim.journal[0].sol, sim.clock.solsElapsed, 'stamped with absolute fractional sols');
  assert.equal((sim.journal[0] as { poiId?: number }).poiId, 5);
  assert.equal(sim.state.domainEvents.length, 1, 'the drain queue is untouched by the sink');
});

test('real ticks journal real events (storm start lands in the ring)', () => {
  const sim = fresh();
  sim.state.domainEvents.push({ type: 'storm/started', kind: 'dustStorm' });
  run(sim, 0.02); // a stretch of ordinary ticks — no journal flood
  assert.equal(
    sim.journal.filter((e) => e.type === 'storm/started').length,
    1,
    'ordinary ticking does not invent entries',
  );
});

// ==================================================== save round trip ====

group('Persistence — v18 block, round trip, v17 migration, hostile rows');

test('journal and sol rows survive a save/restore round trip', () => {
  const sim = fresh();
  sim.state.domainEvents.push({ type: 'objective/completed', project: 'establishSurvival', sol: 2 });
  run(sim, 0.75); // close sol 1 into a sol row
  assert.ok(sim.solHistory.length >= 1, 'a sol row closed while running');
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));

  const restored = fresh(99);
  restored.restore(snap);
  assert.equal(restored.journal.length, sim.journal.length, 'journal count survives');
  assert.equal(restored.journal[0].type, 'objective/completed');
  assert.equal(restored.solHistory.length, sim.solHistory.length, 'sol rows survive');
  assert.equal(restored.solHistory[0].sol, sim.solHistory[0].sol);
  assert.deepEqual(restored.solHistory[0].prod, sim.solHistory[0].prod, 'per-fluid totals survive');

  // The sink still journals into the *restored* ring, not the pre-restore one.
  restored.state.domainEvents.push({ type: 'storm/ended' });
  assert.equal(
    restored.journal[restored.journal.length - 1].type,
    'storm/ended',
    'restore does not unwire the sink',
  );
});

test('a v17 save migrates with empty rings; junk rows are sanitised en route', () => {
  const sim = fresh();
  const v17 = JSON.parse(JSON.stringify(snapshotColony(sim.state)));
  v17.version = 17;
  delete v17.history;
  const migrated = migrateV17Save(v17) as { version: number; history: { sols: unknown[]; journal: unknown[] } };
  assert.equal(migrated.version, 18);
  assert.deepEqual(migrated.history, { sols: [], journal: [] }, 'old colonies start a fresh log');

  v17.history = {
    sols: [
      { sol: 2, genKwAvg: 4, loadKwAvg: 3, storedFracMin: 0.5, roverUtilAvg: 0.25, water: 9, oxygen: 8, food: 7, ore: 6, steel: 5, components: 4, prod: { water: 1, oxygen: 1, food: 0 }, cons: { water: 2, oxygen: 0, food: 1 } },
      { sol: 'x', genKwAvg: 1 }, // hostile: bad sol number
      'garbage',
    ],
    journal: [
      { type: 'storm/ended', sol: 4 },
      { type: 'resource/produced', resource: 'water', amount: 9, sol: 4 }, // streaming → refused
      { type: 42, sol: 1 }, // hostile: no type
      { sol: 'x' },
    ],
  };
  const m2 = migrateV17Save(v17) as unknown as { history: { sols: Array<{ sol: number }>; journal: Array<{ type: string }> } };
  assert.equal(m2.history.sols.length, 1, 'only the well-formed row survives');
  assert.equal(m2.history.sols[0].sol, 2);
  assert.deepEqual(
    m2.history.journal.map((j) => j.type),
    ['storm/ended'],
    'streaming and shapeless entries are refused at the gate',
  );
});

test('migrateSave walks a v17 colony to current', () => {
  const sim = fresh();
  const v17 = JSON.parse(JSON.stringify(snapshotColony(sim.state)));
  v17.version = 17;
  delete v17.history;
  const migrated = migrateSave(v17);
  assert.equal(migrated.version, 18);
});

test('sanitiseHistory re-bounds oversized rings, keeping the newest', () => {
  const sols = Array.from({ length: 400 }, (_, i) => ({
    sol: i + 1, genKwAvg: 0, loadKwAvg: 0, storedFracMin: 0, roverUtilAvg: 0,
    water: 0, oxygen: 0, food: 0, ore: 0, steel: 0, components: 0,
    prod: { water: 0, oxygen: 0, food: 0 }, cons: { water: 0, oxygen: 0, food: 0 },
  }));
  const journal = Array.from({ length: 700 }, (_, i) => ({ type: 'storm/ended', sol: i }));
  const out = sanitiseHistory({ sols, journal });
  assert.equal(out.sols.length, 240, 'sol rows bounded');
  assert.equal(out.sols[out.sols.length - 1].sol, 400, 'newest sols kept');
  assert.equal(out.journal.length, EVENT_JOURNAL_MAX, 'journal bounded');
  assert.equal(out.journal[out.journal.length - 1].sol, 699, 'newest events kept');
});

test('validator warns on a malformed history block but never on a missing one', () => {
  const sim = fresh();
  const snap = JSON.parse(JSON.stringify(snapshotColony(sim.state)));
  const ok = validateCurrentSaveShape(snap);
  assert.ok(!ok.some((w) => w.includes('history')), 'clean v18 save: no warning');
  snap.history = 'oops';
  const bad = validateCurrentSaveShape(snap);
  assert.ok(bad.some((w) => w.includes('history')), 'hostile block named');
  snap.history = { sols: 4 };
  const bad2 = validateCurrentSaveShape(snap);
  assert.ok(bad2.some((w) => w.includes('history.sols')), 'hostile rows named');
});

// ==================================================== determinism ====

group('State hash — the long records are pinned');

test('identical runs hash equal; a different journal hashes differently', () => {
  const a = fresh();
  const b = fresh();
  run(a, 0.05);
  run(b, 0.05);
  assert.equal(hashSimulationSection(a, 'core'), hashSimulationSection(b, 'core'), 'same seed, same ticks');
  b.state.domainEvents.push({ type: 'storm/started', kind: 'dustStorm' });
  assert.notEqual(
    hashSimulationSection(a, 'core'),
    hashSimulationSection(b, 'core'),
    'the journal is hashed — two runs that remember different events differ',
  );
});

test('sol rows participate in the hash once a sol closes', () => {
  const a = fresh();
  const b = fresh();
  run(a, 0.75); // both past sol 1's roll
  run(b, 0.75);
  assert.ok(a.solHistory.length >= 1 && b.solHistory.length >= 1, 'both closed their first sol');
  assert.equal(hashSimulationSection(a, 'core'), hashSimulationSection(b, 'core'), 'same run, same rows');
  b.solHistory[0].genKwAvg += 1;
  assert.notEqual(
    hashSimulationSection(a, 'core'),
    hashSimulationSection(b, 'core'),
    'the long record is hashed — two colonies that remember their sols differently differ',
  );
});

finish();
