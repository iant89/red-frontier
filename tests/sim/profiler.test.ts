/**
 * @suite sim/profiler
 * @group unit
 * @covers src/sim/debug/Profiler.ts
 * @desc Performance instrumentation: counters and timing, development-only
 * diagnostics that report tick, sim time, entities, active tasks, pathfinding,
 * commands, worker messages, view generation and step time.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { getProfiler, resetProfiler, setProfilerEnabled } from '../../src/sim/debug/Profiler';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 1): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

group('Profiler counters');

test('profiler is enabled in tests', () => {
  assert.ok(getProfiler().isEnabled(), 'harness must enable profiler');
});

test('step counting and timing', () => {
  resetProfiler();
  const sim = fresh(11);
  const before = getProfiler().snapshot(sim);
  run(sim, 0.1);
  const after = getProfiler().snapshot(sim);
  assert.ok(after.ticks > before.ticks, 'ticks must advance');
  assert.ok(after.stepTimeMs >= 0, 'step time must be recorded');
  assert.ok(after.simTime > 0, 'simTime must be present');
  assert.ok(after.realMs >= 0, 'realMs must be present');
  assert.equal(after.rovers, sim.rovers.length);
  assert.equal(after.buildings, sim.buildings.length);
});

test('entity and active task counts', () => {
  resetProfiler();
  const sim = fresh(12);
  sim.issueMove(sim.rovers[0].id, 30, 20);
  const snap = getProfiler().snapshot(sim);
  assert.ok(snap.entities >= snap.rovers + snap.buildings, 'entities includes deposits/pois');
  assert.equal(snap.activeTasks, 1, 'one rover has active task');
  assert.ok(snap.deposits > 0, 'deposits counted');
  assert.ok(snap.pois > 0, 'pois counted');
});

test('pathfinding counter increments on findPath', () => {
  resetProfiler();
  const sim = fresh(13);
  const before = getProfiler().snapshot().pathfinds;
  sim.world.findPath(0, 0, 100, 100);
  sim.world.findPath(0, 0, -100, 50);
  const after = getProfiler().snapshot().pathfinds;
  assert.equal(after - before, 2, 'two pathfinds recorded');
});

test('command counter increments via applyCommand', async () => {
  resetProfiler();
  const { applyCommand } = await import('../../src/sim/host/applyCommand');
  const sim = fresh(14);
  const before = getProfiler().snapshot().commands;
  applyCommand(sim, { type: 'rover/move', roverId: sim.rovers[0].id, x: 10, z: 10, queue: false });
  applyCommand(sim, { type: 'rover/stop', roverId: sim.rovers[0].id });
  const after = getProfiler().snapshot().commands;
  assert.equal(after - before, 2, 'two commands recorded');
});

test('view generation timing', async () => {
  resetProfiler();
  const { projectView } = await import('../../src/sim/host/projection');
  const sim = fresh(15);
  const before = getProfiler().snapshot().viewGenerations;
  projectView(sim, 'in-process', {}, []);
  const after = getProfiler().snapshot();
  assert.equal(after.viewGenerations, before + 1, 'one view generation');
  assert.ok(after.viewTimeMs >= 0, 'view time recorded');
});

test('worker message counter', () => {
  resetProfiler();
  const before = getProfiler().snapshot().workerMessages;
  getProfiler().recordWorkerMessage();
  getProfiler().recordWorkerMessage();
  const after = getProfiler().snapshot().workerMessages;
  assert.equal(after - before, 2, 'worker messages counted');
});

test('report formatting', () => {
  resetProfiler();
  const sim = fresh(16);
  run(sim, 0.05);
  const rep = getProfiler().report(sim);
  assert.ok(rep.summary.includes('tick'), 'summary contains tick');
  assert.ok(rep.table.includes('SIMULATION PROFILER'), 'table header present');
  assert.ok(rep.table.includes('Tick:'), 'table contains tick line');
  assert.ok(rep.table.includes('Step total:'), 'table contains step time');
});

test('reset clears counters', () => {
  const sim = fresh(17);
  run(sim, 0.05);
  getProfiler().recordPathfinding();
  getProfiler().recordCommand();
  resetProfiler();
  const snap = getProfiler().snapshot(sim);
  assert.equal(snap.ticks, 0);
  assert.equal(snap.pathfinds, 0);
  assert.equal(snap.commands, 0);
  assert.equal(snap.stepTimeMs, 0);
});

test('profiler is observationally inert', () => {
  // Same seed + commands + time must produce identical snapshot with profiler on vs off
  const runWith = (enabled: boolean): string => {
    setProfilerEnabled(enabled);
    resetProfiler();
    const sim = fresh(1234);
    run(sim, 0.1);
    return JSON.stringify(sim.snapshot());
  };
  const on = runWith(true);
  const off = runWith(false);
  setProfilerEnabled(true);
  resetProfiler();
  assert.equal(on, off, 'profiler must not change simulation');
});

await finish('sim/profiler');
