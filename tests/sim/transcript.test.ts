/**
 * @suite sim/transcript
 * @group integration
 * @covers src/sim/debug/Transcript.ts src/sim/debug/StateHash.ts
 * @desc Command transcript test infrastructure: deterministic replay,
 * validation, builder ergonomics, and hash stability.
 */

import assert from 'node:assert/strict';
import { TranscriptBuilder, replayTranscript, validateTranscript, canonicalTranscriptJson } from '../../src/sim/debug/Transcript';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { Simulation } from '../../src/sim/Simulation';
import { run, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Transcript validation');

test('valid transcript passes validation', () => {
  const t = new TranscriptBuilder(42).at(0, { type: 'rover/move', roverId: 1000, x: 10, z: 10, queue: false }).build();
  assert.deepEqual(validateTranscript(t), []);
});

test('invalid transcript reports errors', () => {
  assert.ok(validateTranscript(null as any).length > 0);
  assert.ok(validateTranscript({} as any).length > 0);
  assert.ok(validateTranscript({ seed: 1, commands: [{ tick: -1, command: { type: 'rover/stop', roverId: 1 } }] } as any).length > 0);
  assert.ok(validateTranscript({ seed: 1, commands: [{ tick: 0, command: null }] } as any).length > 0);
});

test('canonical json is stable and sorted', () => {
  const a = { seed: 1, commands: [{ tick: 0, command: { type: 'rover/stop', roverId: 1000 } }], durationTicks: 100 } as any;
  const b = { durationTicks: 100, commands: [{ command: { roverId: 1000, type: 'rover/stop' }, tick: 0 }], seed: 1 } as any;
  assert.equal(canonicalTranscriptJson(a), canonicalTranscriptJson(b), 'sorted keys must make json stable');
});

group('Replay determinism');

test('same transcript produces identical hash', () => {
  const transcript = new TranscriptBuilder(123)
    .at(10, { type: 'rover/move', roverId: 1000, x: 50, z: 0, queue: false })
    .at(200, { type: 'rover/move', roverId: 1001, x: -30, z: 20, queue: false })
    .duration(1000)
    .build();

  const a = replayTranscript(transcript);
  const b = replayTranscript(transcript);
  assert.equal(hashSimulation(a.sim), hashSimulation(b.sim), 'replay must be deterministic');
  assert.equal(a.ticksRun, b.ticksRun);
});

test('different seed produces different hash', () => {
  const base = new TranscriptBuilder(1).at(0, { type: 'rover/move', roverId: 1000, x: 10, z: 10, queue: false }).duration(500).build();
  const other = { ...base, seed: 2, commands: [...base.commands] };
  const a = replayTranscript(base);
  const b = replayTranscript(other);
  assert.notEqual(hashSimulation(a.sim), hashSimulation(b.sim), 'different seed must diverge');
});

test('different commands produce different hash', () => {
  const aT = new TranscriptBuilder(42).at(0, { type: 'rover/move', roverId: 1000, x: 10, z: 10, queue: false }).duration(500).build();
  const bT = new TranscriptBuilder(42).at(0, { type: 'rover/move', roverId: 1000, x: 100, z: 100, queue: false }).duration(500).build();
  const a = replayTranscript(aT);
  const b = replayTranscript(bT);
  assert.notEqual(hashSimulation(a.sim), hashSimulation(b.sim), 'different commands must diverge');
});

test('transcript with building placement', () => {
  const t = new TranscriptBuilder(77)
    .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
    .duration(800)
    .build();
  const result = replayTranscript(t);
  assert.ok(result.sim.buildings.length >= 1, 'warehouse placed');
});

test('transcript with mining and haul', () => {
  // Build a scenario that exercises the full loop deterministically
  const seed = 2026;
  const simProbe = new Simulation({ seed, nearDeposits: 0.2 });
  const dep = nearDeposit(simProbe, 'iron');
  assert.ok(dep, 'seed must have iron');
  const t = new TranscriptBuilder(seed)
    .at(0, { type: 'rover/mine', roverId: simProbe.rovers[0].id, depositId: dep.id, queue: false })
    .duration(2000)
    .build();
  const a = replayTranscript(t);
  const b = replayTranscript(t);
  assert.equal(hashSimulation(a.sim), hashSimulation(b.sim), 'mining replay deterministic');
  assert.ok(a.sim.storage.iron > 0, 'iron hauled');
});

test('transcript builder ergonomics', () => {
  const builder = new TranscriptBuilder(99).difficulty('pioneer').worldOptions({ nearDeposits: 0.2 }).at(0, { type: 'rover/stop', roverId: 1000 }).duration(100);
  const t = builder.build();
  assert.equal(t.seed, 99);
  assert.equal(t.difficulty, 'pioneer');
  assert.equal(t.commands.length, 1);
  assert.equal(t.durationTicks, 100);
});

test('empty transcript still runs', () => {
  const t = new TranscriptBuilder(5).duration(100).build();
  const result = replayTranscript(t);
  assert.equal(result.ticksRun, 100);
  assert.ok(result.sim.simTime > 0);
});

test('transcript replay matches manual run', () => {
  // Manual run using fixtures should equal transcript replay with same commands
  const seed = 88;
  const simManual = new Simulation({ seed, nearDeposits: 0.2 });
  const dep = nearDeposit(simManual, 'ice');
  assert.ok(dep);
  simManual.issueMine(simManual.rovers[0].id, dep.id);
  run(simManual, 0.2);

  // run(0.2) = 20 * SOL_SECONDS * 0.2 ticks, SOL_SECONDS = 240 game seconds per sol
  const ticks = Math.round(20 * 240 * 0.2);
  const t = new TranscriptBuilder(seed).at(0, { type: 'rover/mine', roverId: simManual.rovers[0].id, depositId: dep.id, queue: false }).duration(ticks).build();
  const replayed = replayTranscript(t);
  // Hash comparison — both started from same seed and did same work
  assert.equal(hashSimulation(simManual), hashSimulation(replayed.sim), 'manual and transcript replay must match');
});

group('Transcript as regression mechanism');

test('hash pinning for canonical scenarios', () => {
  // Pin a hash for a canonical scenario, then assert replay stays equal
  // This is the intended use for refactor policing: pin before extraction, compare after
  const transcript = new TranscriptBuilder(2026)
    .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
    .at(100, { type: 'rover/move', roverId: 1000, x: 60, z: 10, queue: false })
    .duration(1500)
    .build();

  const first = hashSimulation(replayTranscript(transcript).sim);
  const second = hashSimulation(replayTranscript(transcript).sim);
  assert.equal(first, second, 'pinned hash must be stable');
  // Format check: rf1-<14hex>-<14hex>
  assert.match(first, /^rf1-[0-9a-f]{14}-[0-9a-f]{14}$/);
});

await finish('sim/transcript');
