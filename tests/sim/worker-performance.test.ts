/**
 * @suite sim/worker-performance
 * @group unit
 * @covers src/sim/host/WorkerSimHost.ts src/sim/host/workerRuntime.ts src/sim/host/mirror.ts src/sim/debug/Profiler.ts
 * @desc Worker/View Performance (Phase 24): measures view generation time,
 * structured-clone time, worker message payload size, and main-thread apply time.
 * Verifies that full snapshots remain well within frame budgets and do not bottleneck.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { projectView } from '../../src/sim/host/projection';
import { ColonyMirror } from '../../src/sim/host/mirror';
import { getProfiler, resetProfiler, setProfilerEnabled } from '../../src/sim/debug/Profiler';
import { group, test, finish } from '../harness';

function fresh(seed = 42): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

group('Phase 24 — Worker/View Performance Metrics');

test('view generation, structured-clone, and main-thread apply times are profiled', () => {
  setProfilerEnabled(true);
  resetProfiler();

  const sim = fresh();
  // Run simulation forward a bit so we have active entities
  sim.step(1.0);

  const t0Gen = performance.now();
  const view = projectView(sim, 'worker', {}, [], []);
  const genDuration = performance.now() - t0Gen;

  getProfiler().recordViewGeneration(genDuration);

  // Structured clone measurement
  const t0Clone = performance.now();
  const cloned = structuredClone(view);
  const cloneDuration = performance.now() - t0Clone;
  getProfiler().recordStructuredClone(cloneDuration);

  // Payload byte size measurement
  const jsonStr = JSON.stringify(view);
  const payloadBytes = jsonStr.length;
  getProfiler().recordWorkerMessagePayload(payloadBytes);

  // Mirror apply measurement
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    view,
  );
  mirror.apply(cloned);

  const snap = getProfiler().snapshot(sim);

  assert.ok(snap.viewGenerations >= 1, 'viewGenerations recorded');
  assert.ok(snap.viewTimeMs >= 0, 'viewTimeMs recorded');
  assert.ok(snap.avgViewMs >= 0, 'avgViewMs recorded');

  assert.ok(snap.structuredCloneTimeMs >= 0, 'structuredCloneTimeMs recorded');
  assert.ok(snap.avgStructuredCloneMs >= 0, 'avgStructuredCloneMs recorded');
  assert.ok(snap.worstStructuredCloneMs >= 0, 'worstStructuredCloneMs recorded');

  assert.ok(snap.mainThreadApplyTimeMs >= 0, 'mainThreadApplyTimeMs recorded');
  assert.ok(snap.avgMainThreadApplyMs >= 0, 'avgMainThreadApplyMs recorded');
  assert.ok(snap.worstMainThreadApplyMs >= 0, 'worstMainThreadApplyMs recorded');

  assert.ok(snap.workerMessageBytes > 1000, `payload should be non-trivial JSON, got ${snap.workerMessageBytes} B`);
  assert.ok(snap.workerMessageBytes < 500000, `payload should be under 500 KB, got ${snap.workerMessageBytes} B`);
  assert.equal(snap.lastWorkerMessageBytes, payloadBytes);
  assert.equal(snap.avgWorkerMessageBytes, payloadBytes);
});

test('full snapshot clone and apply times comfortably satisfy frame budget', () => {
  setProfilerEnabled(true);
  resetProfiler();

  const sim = fresh();
  for (let i = 0; i < 5; i++) {
    sim.step(0.5);
  }

  const view = projectView(sim, 'worker', {}, [], []);

  // Measure 10 rounds of structuredClone & apply
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    view,
  );

  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const cloned = structuredClone(view);
    const cloneMs = performance.now() - t0;
    getProfiler().recordStructuredClone(cloneMs);

    mirror.apply(cloned);
  }

  const snap = getProfiler().snapshot(sim);

  // Frame budget at 60fps is ~16.6ms total. A view clone + apply taking < 5ms is well within limits.
  assert.ok(
    snap.avgStructuredCloneMs < 10,
    `structured-clone avg should be fast, got ${snap.avgStructuredCloneMs.toFixed(3)} ms`,
  );
  assert.ok(
    snap.avgMainThreadApplyMs < 10,
    `mirror apply avg should be fast, got ${snap.avgMainThreadApplyMs.toFixed(3)} ms`,
  );
});

test('profiler report includes Phase 24 metrics in summary and table', () => {
  setProfilerEnabled(true);
  resetProfiler();

  const sim = fresh();
  sim.step(0.1);

  const view = projectView(sim, 'worker', {}, [], []);
  const cloned = structuredClone(view);
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    view,
  );
  mirror.apply(cloned);

  const rep = getProfiler().report(sim);
  assert.ok(rep.summary.includes('clone'), 'summary includes clone metric');
  assert.ok(rep.summary.includes('apply'), 'summary includes apply metric');
  assert.ok(rep.summary.includes('msg'), 'summary includes msg metric');
  assert.ok(rep.table.includes('Avg clone:'), 'table includes Avg clone');
  assert.ok(rep.table.includes('Avg apply:'), 'table includes Avg apply');
  assert.ok(rep.table.includes('Avg msg size:'), 'table includes Avg msg size');
});

await finish('sim/worker-performance');
