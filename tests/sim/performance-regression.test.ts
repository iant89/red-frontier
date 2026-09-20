/**
 * @suite sim/performance-regression
 * @group integration
 * @covers src/sim/debug/Benchmark.ts src/sim/Simulation.ts src/sim/host/projection.ts src/sim/host/mirror.ts
 * @desc Performance regression thresholds (Phase 28): validates simulation tick,
 * pathfinding, view creation, and worker transport scaling across fleet sizes
 * (10, 25, 50, 100 rovers). Ensures no O(N^2) loops or serialization bottlenecks emerge.
 */

import assert from 'node:assert/strict';
import { benchmarkFleet } from '../../src/sim/debug/Benchmark';
import { Simulation } from '../../src/sim/Simulation';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { SIM_TICK } from '../../src/sim/config';
import { group, test, finish } from '../harness';

group('Fleet scaling performance thresholds');

test('10 rovers: baseline interactive performance', () => {
  const m = benchmarkFleet(10, 20);
  assert.equal(m.roverCount, 10);
  assert.ok(m.avgTickMs < 5, `10-rover avg tick should be <5ms, got ${m.avgTickMs.toFixed(2)}ms`);
  assert.ok(m.viewGenMs < 8, `10-rover view gen should be <8ms, got ${m.viewGenMs.toFixed(2)}ms`);
  assert.ok(m.payloadBytes < 35 * 1024, `10-rover payload should be <35KB, got ${(m.payloadBytes / 1024).toFixed(1)}KB`);
});

test('25 rovers: small fleet scales comfortably', () => {
  const m = benchmarkFleet(25, 20);
  assert.equal(m.roverCount, 25);
  assert.ok(m.avgTickMs < 8, `25-rover avg tick should be <8ms, got ${m.avgTickMs.toFixed(2)}ms`);
  assert.ok(m.viewGenMs < 8, `25-rover view gen should be <8ms, got ${m.viewGenMs.toFixed(2)}ms`);
  assert.ok(m.payloadBytes < 55 * 1024, `25-rover payload should be <55KB, got ${(m.payloadBytes / 1024).toFixed(1)}KB`);
});

test('50 rovers: medium fleet scales without runaway tick time', () => {
  const m = benchmarkFleet(50, 20);
  assert.equal(m.roverCount, 50);
  assert.ok(m.avgTickMs < 12, `50-rover avg tick should be <12ms, got ${m.avgTickMs.toFixed(2)}ms`);
  assert.ok(m.viewGenMs < 10, `50-rover view gen should be <10ms, got ${m.viewGenMs.toFixed(2)}ms`);
  assert.ok(m.payloadBytes < 90 * 1024, `50-rover payload should be <90KB, got ${(m.payloadBytes / 1024).toFixed(1)}KB`);
});

test('100 rovers: large fleet stays well within 50ms SIM_TICK budget', () => {
  const m = benchmarkFleet(100, 25);
  assert.equal(m.roverCount, 100);
  assert.ok(m.avgTickMs < 20, `100-rover avg tick should be <20ms, got ${m.avgTickMs.toFixed(2)}ms`);
  assert.ok(m.maxTickMs < 45, `100-rover peak tick should be <45ms, got ${m.maxTickMs.toFixed(2)}ms`);
  assert.ok(m.payloadBytes < 160 * 1024, `100-rover payload should be <160KB, got ${(m.payloadBytes / 1024).toFixed(1)}KB`);
  const transportMs = m.cloneMs + m.applyMs;
  assert.ok(transportMs < 15, `100-rover worker transport should be <15ms, got ${transportMs.toFixed(2)}ms`);
});

group('Throughput & determinism');

test('pathfinding throughput scales cleanly under multi-rover load', () => {
  const m = benchmarkFleet(50, 10);
  assert.ok(m.avgPathfindMs < 3, `Pathfind query should average <3ms, got ${m.avgPathfindMs.toFixed(2)}ms`);
});

test('benchmark execution remains bit-for-bit deterministic', () => {
  function runDeterministic(seed: number): string {
    const sim = new Simulation({ seed, nearDeposits: 0.2 });
    for (let i = sim.rovers.length; i < 20; i++) {
      sim.devSpawnRover(i % 2 === 0 ? 'mining' : 'utility', i * 3, i * 3);
    }
    for (let i = 0; i < sim.rovers.length; i++) {
      sim.issueMove(sim.rovers[i].id, 50, -50);
    }
    for (let t = 0; t < 25; t++) {
      sim.step(SIM_TICK);
    }
    return hashSimulation(sim);
  }

  const hashA = runDeterministic(99);
  const hashB = runDeterministic(99);
  assert.equal(hashA, hashB, 'identical benchmark runs must hash identically');
});

await finish('sim/performance-regression');
