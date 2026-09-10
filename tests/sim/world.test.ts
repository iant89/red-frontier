/**
 * @suite sim/world
 * @group unit
 * @covers src/sim/World.ts src/sim/terrain.ts src/lib/noise.ts
 * @desc Hierarchical Martian terrain: seed-stable height, a flat landing pad,
 * explicit craters, geological materials, non-uniform rocks.
 */

import assert from 'node:assert/strict';
import { World } from '../../src/sim/World';
import { Simulation } from '../../src/sim/Simulation';
import { findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Martian terrain');

test('the same seed produces the same height field', () => {
  const a = new World({ seed: 42, nearDeposits: 0.2 });
  const b = new World({ seed: 42, nearDeposits: 0.2 });
  const pts = [
    [0, 0],
    [40, -18],
    [-120, 80],
    [200, 200],
    [-260, 40],
  ];
  for (const [x, z] of pts) {
    assert.equal(a.heightAt(x, z), b.heightAt(x, z));
    assert.deepEqual(a.sampleSurface(x, z).mat, b.sampleSurface(x, z).mat);
  }
});

test('the landing pad is flat enough to build on', () => {
  const w = new World({ seed: 42, nearDeposits: 0.2 });
  assert.ok(Math.abs(w.heightAt(0, 0)) < 0.05, 'pad centre should sit at height 0');
  assert.ok(w.slopeAt(0, 0) < 0.08, 'pad centre must be nearly level');
  assert.ok(w.slopeAt(12, 8) < 0.12, 'inner pad should stay buildable');
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  const spot = findSpot(sim, 'habitat');
  assert.equal(sim.canPlace('habitat', spot.x, spot.z), null);
});

test('the world has real relief outside the pad — not a flat fBm pancake', () => {
  const w = new World({ seed: 7, nearDeposits: 0.2 });
  let min = Infinity;
  let max = -Infinity;
  const heights: number[] = [];
  for (let x = -280; x <= 280; x += 40) {
    for (let z = -280; z <= 280; z += 40) {
      const h = w.heightAt(x, z);
      heights.push(h);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  assert.ok(max - min > 4, `expected metres of crater/tilt relief, got ${(max - min).toFixed(2)}`);
  // Different seeds must not collapse to the same surface.
  const other = new World({ seed: 99, nearDeposits: 0.2 });
  let differ = 0;
  for (let i = 0; i < 8; i++) {
    const x = 80 + i * 17;
    const z = -60 - i * 11;
    if (Math.abs(w.heightAt(x, z) - other.heightAt(x, z)) > 0.4) differ++;
  }
  assert.ok(differ >= 3, 'different seeds should produce different geology');
});

test('craters are explicit bowls, not identical circles', () => {
  const w = new World({ seed: 11, nearDeposits: 0.2 });
  // Hunt for a point whose neighbourhood looks like a depression with a rim.
  let found = false;
  let ages = 0;
  let young = 0;
  let old = 0;
  for (let x = -300; x <= 300; x += 28) {
    for (let z = -300; z <= 300; z += 28) {
      const s = w.sampleSurface(x, z);
      if (s.crater > 0.55) {
        found = true;
        ages++;
        if (s.craterAge < 0.4) young++;
        if (s.craterAge > 0.6) old++;
      }
    }
  }
  assert.ok(found, 'expected to sample at least one crater interior');
  assert.ok(young > 0 && old > 0, 'craters must mix young and ancient preservation');
});

test('material weights come from geology and sum to one', () => {
  const w = new World({ seed: 3, nearDeposits: 0.2 });
  for (const [x, z] of [
    [0, 0],
    [90, -40],
    [-180, 210],
  ]) {
    const s = w.sampleSurface(x, z);
    const sum = s.mat.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-5, `weights at ${x},${z} sum to ${sum}`);
    for (const m of s.mat) assert.ok(m >= 0 && m <= 1);
  }
  // The pad is dusty, not a basalt slab.
  const pad = w.sampleSurface(0, 0);
  assert.ok(pad.mat[0] + pad.mat[1] > 0.5, 'landing clearing should be dusty');
});

test('rocks concentrate on geology rather than a uniform grid', () => {
  const w = new World({ seed: 42, nearDeposits: 0.2 });
  const rocks = w.rocks();
  assert.ok(rocks.length > 40, `expected a debris field, got ${rocks.length}`);
  const nearPad = rocks.filter((r) => Math.hypot(r.x, r.z) < 30).length;
  assert.equal(nearPad, 0, 'the landing pad must stay clear of boulders');
  // Density should vary: some 80×80 cells packed, some empty.
  const cells = new Map<string, number>();
  for (const r of rocks) {
    const k = `${Math.floor(r.x / 80)},${Math.floor(r.z / 80)}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  const counts = [...cells.values()];
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  assert.ok(max > min * 1.5 || max >= 8, 'rock density should vary with geology');
});

test('a seed picks a landable patch of real Mars, not Olympus', () => {
  const seen = new Set<string>();
  for (const seed of [1, 7, 21, 42, 99, 1234]) {
    const w = new World({ seed, nearDeposits: 0.2 });
    const site = w.landingSite();
    assert.ok(Math.abs(site.lat) <= 58, 'keep off the polar caps');
    assert.ok(site.elevKm < 9, 'do not land on Olympus Mons');
    assert.ok(Math.hypot(site.dEdx, site.dEdz) < 0.15, 'regional slope must stay buildable');
    seen.add(`${site.lat.toFixed(1)},${site.lon.toFixed(1)}`);
  }
  assert.ok(seen.size >= 4, 'different seeds should land in different places');
});

test('rugged mountains are uncommon on a landable site', () => {
  const w = new World({ seed: 21, nearDeposits: 0.2 });
  let rugged = 0;
  let n = 0;
  for (let x = -280; x <= 280; x += 35) {
    for (let z = -280; z <= 280; z += 35) {
      n++;
      if (w.sampleSurface(x, z).region === 'rugged') rugged++;
    }
  }
  assert.ok(rugged / n < 0.2, `mountains should be uncommon, got ${(rugged / n).toFixed(2)}`);
});

test('rovers can drive the pad and reach deposits without dropping off rims', () => {
  const w = new World({ seed: 42, nearDeposits: 0.2 });
  assert.ok(w.canDrive(0, 0), 'landing pad must be driveable');
  assert.ok(w.canBuild(0, 0), 'landing pad must be buildable');
  const stats = w.navStats();
  assert.ok(stats.reachable > 80, `pad flood should open the plains, got ${stats.reachable}`);
  assert.ok(stats.reachable <= stats.walkable);
  // The world must not be a billiard table: craters, dunes and the MOLA
  // mesoscale have to leave measurable relief. Sharp lips that do occur stay
  // off the drive map by construction (blocked cells never flood).
  let minH = Infinity;
  let maxH = -Infinity;
  let maxSlope = 0;
  for (let x = -280; x <= 280; x += 35) {
    for (let z = -280; z <= 280; z += 35) {
      const h = w.sampleSurface(x, z).height;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      const gx = w.sampleSurface(x + 17.5, z).height - w.sampleSurface(x - 17.5, z).height;
      const gz = w.sampleSurface(x, z + 17.5).height - w.sampleSurface(x, z - 17.5).height;
      maxSlope = Math.max(maxSlope, Math.hypot(gx, gz) / 35);
    }
  }
  assert.ok(maxH - minH > 2, `landing terrain should have relief, got ${(maxH - minH).toFixed(1)} m`);
  assert.ok(maxSlope > 0.03, `terrain should not be flat paste, max slope ${maxSlope.toFixed(3)}`);
  assert.ok(w.deposits.length >= 8, `expected a field of seams, got ${w.deposits.length}`);
  for (const d of w.deposits) {
    assert.ok(w.canDrive(d.x, d.z), `deposit ${d.id} ${d.resource} at ${d.x.toFixed(1)},${d.z.toFixed(1)} is not reachable`);
  }
  const far = w.deposits.reduce((a, b) => (Math.hypot(b.x, b.z) > Math.hypot(a.x, a.z) ? b : a));
  const path = w.findPath(0, 0, far.x, far.z);
  assert.ok(path && path.length >= 1, 'A* should reach a far deposit from the pad');
  const len = w.pathLength(0, 0, far.x, far.z);
  assert.ok(Number.isFinite(len) && len >= Math.hypot(far.x, far.z) * 0.9, 'path should not teleport');
});

await finish('sim/world');
