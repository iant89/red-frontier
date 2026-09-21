/**
 * @suite sim/transcript
 * @group integration
 * @covers src/sim/debug/Transcript.ts src/sim/debug/StateHash.ts
 * @desc Command transcript test infrastructure: deterministic replay,
 * validation, builder ergonomics, and hash stability.
 */

import assert from 'node:assert/strict';
import {
  TranscriptBuilder,
  TranscriptRecorder,
  replayTranscript,
  replayAndHash,
  validateTranscript,
  canonicalTranscriptJson,
  encodeTranscript,
  decodeTranscript,
  CANONICAL_SCENARIOS,
} from '../../src/sim/debug/Transcript';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { assertInvariants } from '../../src/sim/debug/SimulationAssertions';
import { Simulation } from '../../src/sim/Simulation';
import { applyCommand } from '../../src/sim/host';
import { run, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Transcript validation and codec');

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

test('encodeTranscript and decodeTranscript round trip faithfully', () => {
  const original = new TranscriptBuilder(1234)
    .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
    .at(100, { type: 'rover/move', roverId: 1000, x: 50, z: -20, queue: false })
    .duration(500)
    .build();

  const json = encodeTranscript(original, true);
  const decoded = decodeTranscript(json);
  assert.deepEqual(decoded, original);
  assert.throws(() => decodeTranscript('{"seed": "not-a-number"}'), /Invalid transcript JSON/);
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
  assertInvariants(a.sim);
});

test('replayAndHash convenience helper matches direct hashSimulation', () => {
  const transcript = new TranscriptBuilder(999)
    .at(0, { type: 'rover/move', roverId: 1000, x: 20, z: 20, queue: false })
    .duration(300)
    .build();

  const { hash, result } = replayAndHash(transcript);
  assert.equal(hash, hashSimulation(result.sim));
  assert.match(hash, /^rf1-[0-9a-f]{14}-[0-9a-f]{14}$/);
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

test('timing deviation produces diverging hash', () => {
  const tA = new TranscriptBuilder(42)
    .at(50, { type: 'rover/move', roverId: 1000, x: 50, z: 50, queue: false })
    .duration(120)
    .build();
  const tB = new TranscriptBuilder(42)
    .at(90, { type: 'rover/move', roverId: 1000, x: 50, z: 50, queue: false })
    .duration(120)
    .build();
  const a = replayAndHash(tA);
  const b = replayAndHash(tB);
  assert.notEqual(a.hash, b.hash, 'command timing deviation must diverge state hash');
});

test('TranscriptRecorder records commands in order and exports valid json', () => {
  const recorder = new TranscriptRecorder(777, { difficulty: 'survivor' });
  recorder.record(0, { type: 'building/place', kind: 'warehouse', x: 10, z: 10 });
  recorder.pause();
  recorder.record(10, { type: 'rover/stop', roverId: 1000 }); // ignored while paused
  recorder.resume();
  recorder.record(20, { type: 'rover/move', roverId: 1000, x: 15, z: 15, queue: false });
  recorder.duration(100);
  const t = recorder.toTranscript();
  assert.equal(t.commands.length, 2);
  assert.equal(t.difficulty, 'survivor');
  assert.equal(recorder.isRecording(), true);
  const json = recorder.toJSON();
  const decoded = decodeTranscript(json);
  assert.deepEqual(decoded, t);
});

test('transcript with building placement', () => {
  const t = new TranscriptBuilder(77)
    .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
    .duration(800)
    .build();
  const result = replayTranscript(t);
  assert.ok(result.sim.buildings.length >= 1, 'warehouse placed');
  assertInvariants(result.sim);
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
  assertInvariants(a.sim);
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
  assertInvariants(result.sim);
});

test('transcript replay matches manual run', () => {
  // Manual run using fixtures should equal transcript replay with same commands
  const seed = 88;
  const simManual = new Simulation({ seed, nearDeposits: 0.2 });
  const dep = nearDeposit(simManual, 'ice');
  assert.ok(dep);
  // Through the command path, as the transcript is: an order is state now
  // (the autonomy window ends on it), so a direct method call would leave the
  // "manual" colony one break short of the replayed one.
  applyCommand(simManual, { type: 'rover/mine', roverId: simManual.rovers[0].id, depositId: dep.id, queue: false });
  run(simManual, 0.2);

  // run(0.2) = 20 * SOL_SECONDS * 0.2 ticks, SOL_SECONDS = 240 game seconds per sol
  const ticks = Math.round(20 * 240 * 0.2);
  const t = new TranscriptBuilder(seed).at(0, { type: 'rover/mine', roverId: simManual.rovers[0].id, depositId: dep.id, queue: false }).duration(ticks).build();
  const replayed = replayTranscript(t);
  // Hash comparison — both started from same seed and did same work
  assert.equal(hashSimulation(simManual), hashSimulation(replayed.sim), 'manual and transcript replay must match');
});

group('Transcript as regression mechanism (Phase 26)');

test('canonical scenario 1: colony foundation is pinned and deterministic', () => {
  const t = new TranscriptBuilder(101)
    .at(0, { type: 'building/place', kind: 'warehouse', x: 40, z: 0 })
    .at(0, { type: 'building/place', kind: 'solar', x: -40, z: 0 })
    .at(50, { type: 'rover/move', roverId: 1000, x: 40, z: 20, queue: false })
    .at(50, { type: 'rover/move', roverId: 1001, x: -40, z: 20, queue: false })
    .duration(800)
    .build();

  const { hash, result } = replayAndHash(t);
  assert.equal(hash, 'rf1-1f83a3df7f37fa-1d5fbdce97e309');
  assertInvariants(result.sim);
});

test('canonical scenario 2: logistics repeat-route haul loop is pinned and deterministic', () => {
  const t = new TranscriptBuilder(2026)
    .at(0, { type: 'rover/mine', roverId: 1000, depositId: 1, queue: false })
    .at(200, { type: 'rover/repeatRoute', roverId: 1000, on: true })
    .duration(2000)
    .build();

  const { hash, result } = replayAndHash(t);
  assert.equal(hash, 'rf1-1b4afed38428d3-0e5c578403db8a');
  assertInvariants(result.sim);
});

test('canonical scenario 3: severe storm protocol and shelter recall is pinned and deterministic', () => {
  const t = new TranscriptBuilder(303)
    .at(0, { type: 'dev/storm/force', kind: 'severe' })
    .at(200, { type: 'rover/rule', roverId: 1000, rule: 'stormShelter', on: true })
    .at(400, { type: 'colonist/order', order: { type: 'shelter' } })
    .at(600, { type: 'dev/storm/clear' })
    .duration(1200)
    .build();

  const { hash, result } = replayAndHash(t);
  assert.equal(hash, 'rf1-16382049630e68-10ce753abaa5a0');
  assertInvariants(result.sim);
});

test('CANONICAL_SCENARIOS definitions replay to exact pinned hashes', () => {
  for (const [key, scenario] of Object.entries(CANONICAL_SCENARIOS)) {
    const transcript = scenario.build();
    const { hash } = replayAndHash(transcript);
    assert.equal(hash, scenario.expectedHash, `Scenario ${scenario.name} (${key}) must match pinned hash`);
  }
});

await finish('sim/transcript');
