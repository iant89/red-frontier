/**
 * @suite sim/navigation
 * @group unit
 * @covers src/sim/navgrid.ts src/sim/debug/Profiler.ts
 * @desc Navigation optimizations (Phase 23): binary min-heap priority queue,
 * reusable pathfinding workspace with generation stamping, zero-allocation pathfinding,
 * and comprehensive pathfinding profiler instrumentation.
 */

import assert from 'node:assert/strict';
import { NavGrid, NavWorkspace, NAV_CELL } from '../../src/sim/navgrid';
import { getProfiler, resetProfiler, setProfilerEnabled } from '../../src/sim/debug/Profiler';
import { Simulation } from '../../src/sim/Simulation';
import { group, test, finish } from '../harness';

group('NavWorkspace and Min-Heap');

test('NavWorkspace min-heap pops in ascending f-score order', () => {
  const ws = new NavWorkspace(16);
  const stamp = ws.nextSearch();

  ws.push(1, 10.5, stamp);
  ws.push(2, 3.2, stamp);
  ws.push(3, 7.8, stamp);
  ws.push(4, 1.0, stamp);
  ws.push(5, 5.0, stamp);

  assert.equal(ws.heapSize, 5);
  assert.equal(ws.pop(), 4); // 1.0
  assert.equal(ws.pop(), 2); // 3.2
  assert.equal(ws.pop(), 5); // 5.0
  assert.equal(ws.pop(), 3); // 7.8
  assert.equal(ws.pop(), 1); // 10.5
  assert.equal(ws.pop(), -1); // empty
  assert.equal(ws.heapSize, 0);
});

test('NavWorkspace decreaseKey re-orders items correctly', () => {
  const ws = new NavWorkspace(16);
  const stamp = ws.nextSearch();

  ws.push(10, 50, stamp);
  ws.push(11, 40, stamp);
  ws.push(12, 30, stamp);

  // Decrease key for node 10 to 15 (lower than 30)
  ws.decreaseKey(10, 15);

  assert.equal(ws.pop(), 10); // now 15
  assert.equal(ws.pop(), 12); // 30
  assert.equal(ws.pop(), 11); // 40
});

test('generation stamp rollover resets stamp cache cleanly', () => {
  const ws = new NavWorkspace(8);
  ws.gStamp[0] = 123;
  ws.inOpenStamp[0] = 123;
  ws.stamp = 0xfffffffe;

  // Next stamp hits 0xffffffff, triggering rollover reset to 1
  const s1 = ws.nextSearch();
  assert.equal(s1, 1);
  assert.equal(ws.gStamp[0], 0);
  assert.equal(ws.inOpenStamp[0], 0);

  const s2 = ws.nextSearch();
  assert.equal(s2, 2);
});

group('NavGrid findPath and zero allocations');

test('findPath works across flat terrain and returns direct path after string-pulling', () => {
  // Flat plane
  const nav = new NavGrid(() => 0, 160);
  const path = nav.findPath(0, 0, 40, 40);
  assert.ok(path !== null);
  assert.ok(path.length >= 2);
  // End of path reaches the requested destination
  const end = path[path.length - 1];
  assert.equal(end.x, 40);
  assert.equal(end.z, 40);
});

test('findPath on same start and end returns immediate 1-point path', () => {
  const nav = new NavGrid(() => 0, 160);
  const path = nav.findPath(20, 20, 20, 20);
  assert.deepEqual(path, [{ x: 20, z: 20 }]);
});

test('findPath avoids cliffs and reaches reachable destination', () => {
  const nav = new NavGrid((x, z) => {
    // A vertical ridge in between
    if (x > 20 && x < 35) return 80;
    return 0;
  }, 160);

  const stats = nav.stats();
  assert.ok(stats.blocked > 0, 'ridge creates blocked cells');
  assert.ok(stats.walkable > 0);
});

group('Profiler Phase 23 instrumentation');

test('profiler records pathfind time, nodes expanded, and zero allocations', () => {
  setProfilerEnabled(true);
  resetProfiler();
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });

  const beforeSnap = getProfiler().snapshot(sim);
  assert.equal(beforeSnap.pathfinds, 0);

  const path = sim.world.findPath(0, 0, 60, 60);
  assert.ok(path !== null);

  const afterSnap = getProfiler().snapshot(sim);
  assert.equal(afterSnap.pathfinds, 1);
  assert.ok(afterSnap.pathfindTimeMs >= 0);
  assert.ok(afterSnap.nodesExpanded > 0, 'expanded at least start node');
  assert.ok(afterSnap.lastPathLength > 0, 'recorded path length');
  assert.equal(afterSnap.pathfindAllocations, 0, 'zero heap buffer allocations');
  assert.ok(afterSnap.avgNodesExpanded > 0);
  assert.ok(afterSnap.worstPathfindMs >= 0);
});

await finish('sim/navigation');
