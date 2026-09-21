/**
 * @suite sim/autonomy
 * @group unit
 * @covers src/sim/systems/AutonomySystem.ts src/sim/state/AutonomyState.ts src/sim/persistence/autonomySave.ts src/sim/persistence/migrations/v15.ts
 * @desc Phase 3 (AUTONOMY.md): one measured stat with three faces. The streak
 * ends on accepted orders and on breakers — once per episode — coverage
 * attributes rover work, resilience lists single points, the ladder is read
 * off all three, and a v15 save gets a window with no retroactive credit.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  AutonomySystem,
  AUTONOMY_TUNING,
  autonomySnapshot,
  classifyCommand,
  currentStreak,
  resilience,
} from '../../src/sim/systems/AutonomySystem';
import {
  coverageOf,
  emptyAutonomyState,
  identityFor,
  RUNG_ORDER,
} from '../../src/sim/state/AutonomyState';
import { applyCommand } from '../../src/sim/host';
import { PLAYER_COMMAND_TYPES, DEV_COMMAND_TYPES } from '../../src/sim/host/protocol';
import { sanitiseAutonomy } from '../../src/sim/persistence/autonomySave';
import { migrateV15Save } from '../../src/sim/persistence/migrations/v15';
import { snapshotColony, restoreColony } from '../../src/sim/persistence/ColonyPersistence';
import { createColonyState } from '../../src/sim/state/ColonyState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { CURRENT_SAVE_VERSION } from '../../src/sim/persistence/SaveSchema';
import { SIM_TICK, SOL_SECONDS } from '../../src/sim/config';
import { group, test, finish } from '../harness';
import { buildOnline, nearDeposit, run } from '../fixtures/sim';

/** Tick once at the fixed step. */
function tick(sim: Simulation, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(SIM_TICK);
}

// ------------------------------------------------------- classification ----

group('Command classification (AUTONOMY.md §4.2)');

test('every protocol command is classified, and the table matches the spec', () => {
  const intervention = new Set([
    'rover/move', 'rover/mine', 'rover/unload', 'rover/wait', 'rover/stop', 'rover/construct',
    'rover/clean', 'rover/repair', 'rover/recover', 'rover/salvage',
    'building/place', 'building/toggle', 'building/demolish', 'building/maintain', 'building/assemble', 'building/recipe',
    'water/connect', 'water/disconnect', 'water/commission',
    'colonist/order', 'engineering/upgrade', 'engineering/cancel',
  ]);
  for (const type of PLAYER_COMMAND_TYPES) {
    const expected = intervention.has(type) ? 'intervention' : 'policy';
    assert.equal(classifyCommand(type), expected, `${type} is ${expected}`);
  }
  for (const type of DEV_COMMAND_TYPES) {
    assert.equal(classifyCommand(type), 'ignored', `${type} is never counted`);
  }
  // A policy doing the work is the fantasy working (P3's own commands).
  assert.equal(classifyCommand('policy/stockpile'), 'policy');
  // An unknown player command is an order until a table says otherwise.
  assert.equal(classifyCommand('colonist/dance'), 'intervention');
});

test('an accepted order ends the window; a refused one does not; a policy never does', () => {
  const sim = new Simulation({ seed: 3 });
  run(sim, 1);
  const before = currentStreak(sim.state);
  assert.ok(before >= 0.9);

  const ack = applyCommand(sim, { type: 'rover/rule', roverId: sim.rovers[0].id, rule: 'autoHaul', on: false } as any);
  assert.equal(ack.ok, true);
  assert.ok(currentStreak(sim.state) >= before, 'setting a rule is policy, not steering');

  const refused = applyCommand(sim, { type: 'building/place', kind: 'warehouse', x: 0, z: 0 });
  assert.equal(refused.ok, false, 'the pad is not a legal site');
  assert.ok(currentStreak(sim.state) >= before, 'a refused order steered nothing');

  applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 30, z: 30, queue: false });
  assert.equal(currentStreak(sim.state), 0, 'an accepted order ends it');
  const a = sim.state.autonomy;
  assert.equal(a.lastBreak?.reason, 'intervention');
  assert.match(a.lastBreak?.detail ?? '', /ordered a rover to move/);
  assert.ok(a.best >= before, 'the record keeps the window that just ended');
  assert.ok(
    sim.alerts.history().some((e) => /Intervention logged — ordered a rover to move\. Streak ended at/.test(e.text)),
    'and the log teaches why',
  );
});

test('dev commands never break the window', () => {
  const sim = new Simulation({ seed: 4 });
  run(sim, 1);
  const before = currentStreak(sim.state);
  applyCommand(sim, { type: 'dev/storm/force', kind: 'regional' } as any);
  applyCommand(sim, { type: 'dev/storm/clear' } as any);
  assert.ok(currentStreak(sim.state) >= before);
  assert.equal(sim.state.autonomy.lastBreak, null);
});

// -------------------------------------------------------------- breakers ----

group('Breakers end the streak without a click (§4.3), once per episode');

test('B1: a life-support fluid going critical breaks the window exactly once', () => {
  const sim = new Simulation({ seed: 5 });
  run(sim, 0.5);
  // Raise the crit the way the alert system does, so B1 is the breaker under
  // test rather than B4 (a pool that small would also breach its runway).
  sim.alerts.raise('oxygen-low', 'crit', 'Oxygen critical', 'test', sim.simTime, sim.clock.format());
  AutonomySystem.tick(sim.state, false);
  const a = sim.state.autonomy;
  assert.equal(a.lastBreak?.reason, 'life-support-critical');
  assert.match(a.lastBreak?.detail ?? '', /Oxygen/);
  const at = a.lastBreak!.at;
  const streakBefore = currentStreak(sim.state);
  for (let i = 0; i < 50; i++) {
    sim.alerts.raise('oxygen-low', 'crit', 'Oxygen critical', 'test', sim.simTime, sim.clock.format());
    AutonomySystem.tick(sim.state, false);
  }
  assert.equal(sim.state.autonomy.lastBreak?.at, at, 'a sustained episode is one break, not a hundred');
  assert.ok(currentStreak(sim.state) >= streakBefore, 'and the new window is not reset behind it');
  // A real critical pool through the full tick also breaks — by whichever
  // breaker sees it first — and stays broken once.
  const sim2 = new Simulation({ seed: 5 });
  run(sim2, 0.5);
  sim2.state.pools.amounts.oxygen = 0.4;
  tick(sim2, 40);
  assert.ok(sim2.state.autonomy.lastBreak, 'a critical pool breaks the window');
  assert.ok(sim2.alerts.list().some((x) => x.key === 'oxygen-low' && x.severity === 'crit'));
  const count = () => sim2.drainDomainEvents().filter((e) => e.type === 'autonomy/break').length;
  count();
  tick(sim2, 200);
  assert.equal(count(), 0, 'no further breaks while the same episode holds');
});

test('B2: the colonist reaching critical health breaks the window', () => {
  const sim = new Simulation({ seed: 6 });
  run(sim, 0.5);
  sim.devSetColonistHealth(20);
  tick(sim, 20);
  assert.equal(sim.state.autonomy.lastBreak?.reason, 'colonist-critical');
});

test('B3: life-support power shedding breaks the window; ordinary industry shedding does not', () => {
  const sim = new Simulation({ seed: 7 });
  run(sim, 0.3);
  // Industry shedding at night is the designed rhythm: the `brownout` (warn)
  // alert must never end a window. Only `brownout-critical` — tiers 0–1 shed.
  sim.alerts.raise('brownout', 'warn', 'Industry shed', 'test', sim.simTime, sim.clock.format());
  AutonomySystem.tick(sim.state, false);
  assert.equal(sim.state.autonomy.lastBreak, null, 'industry shedding is fine');
  sim.alerts.raise('brownout-critical', 'crit', 'Grid brownout', 'test', sim.simTime, sim.clock.format());
  AutonomySystem.tick(sim.state, false);
  const brk = sim.state.autonomy.lastBreak as { reason: string; detail: string } | null;
  assert.equal(brk?.reason, 'power-critical');
  assert.match(brk?.detail ?? '', /Life-support power was shed/);
});

test('B4: a fluid projected to run dry inside a sol breaks the window (anti-coasting)', () => {
  const sim = new Simulation({ seed: 8 });
  run(sim, 1);
  // Drain water fast: shrink the pool so the trailing net burn projects < 1 sol.
  sim.state.pools.amounts.water = 0.3;
  tick(sim, 5);
  assert.equal(sim.state.autonomy.lastBreak?.reason, 'runway-critical');
  assert.match(sim.state.autonomy.lastBreak?.detail ?? '', /Water would run dry in/);
});

test('a developer time-jump restarts the window rather than crediting it', () => {
  const sim = new Simulation({ seed: 9 });
  run(sim, 0.5);
  sim.devSetTime(20, 0.5);
  assert.ok(currentStreak(sim.state) < 0.01, 'the window opens at the sol jumped to');
  assert.equal(sim.state.autonomy.lastBreak, null, 'and it was not a break — nothing failed');
});

// -------------------------------------------------------------- coverage ----

group('Coverage attributes the work (§5)');

test('coverageOf is a clamped ratio; idle time counts as nothing', () => {
  assert.equal(coverageOf([{ autoSec: 0, orderSec: 0 }]), 0);
  assert.equal(coverageOf([{ autoSec: 3, orderSec: 1 }]), 0.75);
  assert.equal(coverageOf([{ autoSec: 1, orderSec: 0 }, { autoSec: 0, orderSec: 1 }]), 0.5);
});

test('an ordered haul reads as order work; the rover then working on its own reads as auto', () => {
  const sim = new Simulation({ seed: 10 });
  buildOnline(sim, 'warehouse');
  const dep = nearDeposit(sim, 'ice');
  applyCommand(sim, { type: 'rover/mine', roverId: sim.rovers[0].id, depositId: dep.id, queue: false });
  run(sim, 0.3);
  const a = sim.state.autonomy;
  assert.ok(a.coverageBuckets[0].orderSec > 0, 'the ordered trip is order work');
  assert.ok(a.coverage < 0.5, 'so coverage is low');
  // Hand the rover back to the flight software: it finishes the loop on its own.
  sim.rovers[0].autoTask = true;
  run(sim, 0.3);
  assert.ok(sim.state.autonomy.coverageBuckets[0].autoSec > 0, 'self-directed work is counted too');
  assert.equal(sim.state.autonomy.everAutoTask, true, 'and the ASSISTED gate is unlocked for good');
});

test('buckets roll on the sol boundary and the window is three sols deep', () => {
  const sim = new Simulation({ seed: 11 });
  sim.state.autonomy.coverageBuckets[0].autoSec = 42;
  run(sim, 1.05);
  const b = sim.state.autonomy.coverageBuckets;
  assert.equal(b.length, 3);
  assert.equal(b[1].autoSec, 42, 'yesterday moved down one');
  run(sim, 2.1);
  assert.equal(sim.state.autonomy.coverageBuckets.some((x) => x.autoSec === 42), false, 'and fell off after three sols');
});

// ------------------------------------------------------------ resilience ----

group('Resilience lists single points of failure (§6)');

test('a landing-day colony has every chain but the fleet below its gate', () => {
  const sim = new Simulation({ seed: 12 });
  assert.deepEqual(resilience(sim.state), ['power', 'water', 'oxygen', 'food', 'spares', 'recovery']);
});

test('a second producer clears a chain; a demolished one puts it back', () => {
  const sim = new Simulation({ seed: 13 });
  buildOnline(sim, 'extractor');
  assert.ok(resilience(sim.state).includes('water'), 'one extractor is a single point');
  const second = buildOnline(sim, 'extractor');
  assert.ok(!resilience(sim.state).includes('water'), 'two are not');
  sim.demolish(second.id);
  assert.ok(resilience(sim.state).includes('water'), 'and losing one brings it back');
});

// ---------------------------------------------------------------- ladder ----

group('The ladder is read, not declared (§7)');

test('rungs promote in order and the identity chip follows', () => {
  assert.deepEqual(RUNG_ORDER, ['manual', 'assisted', 'automated', 'redundant', 'autonomous']);
  assert.equal(identityFor('manual'), 'operator');
  assert.equal(identityFor('assisted'), 'operator');
  assert.equal(identityFor('automated'), 'engineer');
  assert.equal(identityFor('redundant'), 'engineer');
  assert.equal(identityFor('autonomous'), 'architect');
});

test('MANUAL until a rover works on its own; ASSISTED after', () => {
  const sim = new Simulation({ seed: 14 });
  run(sim, 0.2);
  assert.equal(sim.state.autonomy.rung, 'manual');
  buildOnline(sim, 'warehouse');
  buildOnline(sim, 'extractor'); // a standing ice order the flight software fills by itself
  run(sim, 1.5);
  assert.equal(sim.state.autonomy.everAutoTask, true);
  assert.equal(sim.state.autonomy.rung, 'assisted');
  assert.ok(sim.alerts.history().some((e) => /ASSISTED — the flight software/.test(e.text)));
});

test('AUTOMATED needs coverage, a finalised sol-long window and the producers through a sol', () => {
  const sim = new Simulation({ seed: 15 });
  const a = sim.state.autonomy;
  a.everAutoTask = true;
  a.coverage = 0.9;
  a.best = 1.2;
  a.producersOnlineSols = 0;
  a.singlePoints = ['water'];
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'assisted', 'producers have not been up a sol');
  a.producersOnlineSols = 1.1;
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'automated');
  a.coverage = 0.5;
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'assisted', 'coverage below the gate');
  a.coverage = 0.9;
  a.best = 0.5;
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'assisted', 'no sol-long window yet');
});

test('REDUNDANT when nothing is a single point; AUTONOMOUS at ten sols; losing a chain drops a rung', () => {
  const sim = new Simulation({ seed: 16 });
  const a = sim.state.autonomy;
  a.everAutoTask = true;
  a.coverage = 0.9;
  a.best = 1.2;
  a.producersOnlineSols = 2;
  a.singlePoints = ['water'];
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'automated');
  a.singlePoints = [];
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'redundant');
  a.startedAt = sim.state.clock.solsElapsed - AUTONOMY_TUNING.autonomousStreakSols;
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'autonomous', 'ten sols hands-off while redundant');
  assert.equal(AUTONOMY_TUNING.autonomousStreakSols, 10, 'the rung gate is fixed across difficulties');
  a.singlePoints = ['oxygen'];
  assert.equal(AutonomySystem.evaluateRung(sim.state), 'automated', 'losing redundancy drops it, streak or not');
});

test('a promotion and a demotion are each announced once, in the teaching tone', () => {
  const sim = new Simulation({ seed: 17 });
  const a = sim.state.autonomy;
  a.everAutoTask = true;
  a.coverage = 0.9;
  a.best = 1.2;
  a.producersOnlineSols = 2;
  // Two of everything the resilience table asks for.
  for (const k of ['extractor', 'extractor', 'oxygenator', 'oxygenator', 'greenhouse', 'greenhouse', 'solar', 'garage', 'workshop'] as const) {
    buildOnline(sim, k);
  }
  sim.state.components.motor = 1;
  sim.state.components.circuitBoard = 1;
  const drained = sim.drainDomainEvents.bind(sim);
  drained();
  tick(sim, 1);
  a.producersOnlineSols = 2; // the tick above counted one step; keep the gate held
  const ev = drained().filter((e) => e.type === 'autonomy/rung');
  assert.equal(ev.length, 1);
  assert.equal((ev[0] as { to: string }).to, 'redundant');
  assert.equal((ev[0] as { identity: string }).identity, 'engineer');
  assert.ok(sim.alerts.history().some((e) => /REDUNDANT reached — no single machine/.test(e.text)));
  assert.equal(sim.state.autonomy.bestRung, 'redundant');

  const garage = sim.buildings.find((b) => b.kind === 'garage')!;
  sim.demolish(garage.id);
  tick(sim, 1);
  assert.equal(sim.state.autonomy.rung, 'automated');
  assert.equal(sim.state.autonomy.bestRung, 'redundant', 'the record is monotone');
  assert.ok(
    sim.alerts.history().some((e) => /Recovery redundancy lost — the colony is AUTOMATED until/.test(e.text)),
    'the demotion names what was lost',
  );
});

// ----------------------------------------------------------- persistence ----

group('Persistence — save v16, no retroactive credit');

test('the schema is at least v16 and the block round-trips', () => {
  assert.ok(CURRENT_SAVE_VERSION >= 16);
  const sim = new Simulation({ seed: 18 });
  run(sim, 1.5);
  applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 30, z: 30, queue: false });
  run(sim, 0.4);
  const saved = snapshotColony(sim.state);
  assert.ok(saved.autonomy);
  assert.equal((saved.autonomy as { _holding?: unknown })._holding, undefined, 'the edge memory is transient');

  const copy = createColonyState({ seed: 18 });
  restoreColony(copy, JSON.parse(JSON.stringify(saved)));
  assert.equal(copy.autonomy.startedAt, sim.state.autonomy.startedAt);
  assert.equal(copy.autonomy.best, sim.state.autonomy.best);
  assert.equal(copy.autonomy.lastBreak?.reason, 'intervention');
  assert.deepEqual(copy.autonomy.coverageBuckets, sim.state.autonomy.coverageBuckets);
});

test('a v15 save gets a window at its own time, or at its Phase 2 marker if that is later', () => {
  const sim = new Simulation({ seed: 19 });
  run(sim, 4);
  const v15 = JSON.parse(JSON.stringify(snapshotColony(sim.state)));
  delete v15.autonomy;
  v15.version = 15;
  v15.unlocks.lastDirectOrderSol = 2;
  const migrated = migrateV15Save(v15) as { version: number; autonomy: { startedAt: number; best: number; rung: string; lifetimeSols: number } };
  assert.equal(migrated.version, 16);
  assert.equal(migrated.autonomy.startedAt, 2, 'the streak it was already showing carries over');
  assert.equal(migrated.autonomy.best, 0, 'but no record is invented');
  assert.equal(migrated.autonomy.lifetimeSols, 0);
  assert.equal(migrated.autonomy.rung, 'manual', 'the rung is re-earned on the first tick');

  const copy = createColonyState({ seed: 19 });
  restoreColony(copy, migrated as any);
  assert.equal(copy.autonomy.startedAt, 2);
});

test('a hostile autonomy block is clamped, not trusted', () => {
  const base = emptyAutonomyState(5);
  const out = sanitiseAutonomy(
    {
      startedAt: 999, // in the future
      best: -3,
      coverage: 7,
      rung: 'god',
      bestRung: 'assisted',
      coverageBuckets: [{ autoSec: 'x', orderSec: -1 }, null, {}, {}, {}],
      singlePoints: ['water', 42, 'oxygen'],
      lastBreak: { reason: 'cheated', streak: 1 },
      lifetimeSols: 'many',
    },
    base,
    6,
  );
  assert.equal(out.startedAt, 6, 'no window starts in the future');
  assert.equal(out.best, 0);
  assert.equal(out.coverage, 1);
  assert.equal(out.rung, 'manual');
  assert.equal(out.bestRung, 'assisted', 'bestRung keeps a valid value');
  assert.equal(out.coverageBuckets.length, 3);
  assert.deepEqual(out.coverageBuckets[0], { autoSec: 0, orderSec: 0 });
  assert.deepEqual(out.singlePoints, ['water', 'oxygen']);
  assert.equal(out.lastBreak, null, 'an unknown reason is dropped');
  assert.equal(out.lifetimeSols, 0);
  assert.equal(sanitiseAutonomy('nope', base, 6), base);
});

// ----------------------------------------------------------- determinism ----

group('Determinism and invariants');

test('two colonies handed the same commands hold the same stat, and it is hashed', () => {
  const mk = () => {
    const sim = new Simulation({ seed: 20 });
    run(sim, 0.5);
    applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 25, z: 25, queue: false });
    run(sim, 0.5);
    return sim;
  };
  const a = mk();
  const b = mk();
  assert.deepEqual(autonomySnapshot(a.state), autonomySnapshot(b.state));
  assert.equal(hashSimulation(a), hashSimulation(b));
  b.state.autonomy.best += 1;
  assert.notEqual(hashSimulation(a), hashSimulation(b), 'the record is part of the authoritative state');
});

test('0 ≤ current ≤ elapsed, best ≥ any finalised window, coverage ∈ [0,1], lifetime ≈ elapsed', () => {
  const sim = new Simulation({ seed: 22 });
  buildOnline(sim, 'warehouse');
  const elapsed0 = sim.state.clock.solsElapsed;
  for (let i = 0; i < 6; i++) {
    run(sim, 0.5);
    if (i === 2) applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 25, z: 25, queue: false });
    const a = sim.state.autonomy;
    const elapsed = sim.state.clock.solsElapsed - elapsed0;
    assert.ok(currentStreak(sim.state) >= 0 && currentStreak(sim.state) <= elapsed + 1e-6);
    assert.ok(a.coverage >= 0 && a.coverage <= 1);
    for (const b of a.coverageBuckets) assert.ok(b.autoSec >= 0 && b.orderSec >= 0);
    assert.ok(Math.abs(a.lifetimeSols - elapsed) < 0.02, `lifetime ${a.lifetimeSols} tracks elapsed ${elapsed}`);
  }
  assert.ok(sim.state.autonomy.best >= 1.4, 'the window before the order was recorded');
  assert.ok(SOL_SECONDS > 0);
});

await finish('sim/autonomy');
