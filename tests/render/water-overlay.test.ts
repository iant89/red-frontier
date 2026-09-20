/**
 * @suite render/water-overlay
 * @group unit
 * @covers src/render/WaterNetworkOverlay.ts
 * @desc Cached terrain-following pipe geometry, actual flow visibility,
 * attention markers, and geometry disposal without a WebGL context.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaterNetworkOverlay } from '../../src/render/WaterNetworkOverlay';
import { Simulation } from '../../src/sim/Simulation';
import { buildOnline } from '../fixtures/sim';
import { WaterSystem } from '../../src/sim/systems/WaterSystem';
import { test, finish } from '../harness';

test('water overlay follows terrain and reuses meshes until topology changes', () => {
  const sim = new Simulation({ seed: 515 });
  buildOnline(sim, 'workshop');
  const b = buildOnline(sim, 'extractor');
  const pump = buildOnline(sim, 'pumpStation');
  sim.components.pipe = 30;
  sim.connectWater(0, b.id);
  sim.connectWater(0, pump.id);
  const overlay = new WaterNetworkOverlay();
  overlay.sync(sim);
  const line = overlay.root.children.find(
    (c) => c instanceof THREE.Line,
  ) as THREE.Line;
  const positions = line.geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++)
    assert.ok(
      Math.abs(
        positions.getY(i) -
          sim.world.heightAt(positions.getX(i), positions.getZ(i)) -
          0.65,
      ) < 1e-4,
    );
  overlay.sync(sim);
  assert.ok(overlay.root.children.includes(line));
  pump.loadKw = 6;
  pump.powerSat = 1;
  sim.commissionWater();
  WaterSystem.take(sim.state, 0, 20);
  WaterSystem.tick(sim.state);
  overlay.sync(sim);
  const beads = overlay.root.children.filter(
    (c) =>
      c instanceof THREE.Mesh && c.geometry instanceof THREE.SphereGeometry,
  );
  assert.ok(beads.some((c) => c.visible));
  sim.disconnectWater(0, b.id);
  overlay.sync(sim);
  assert.ok(!overlay.root.children.includes(line), 'old topology was replaced');
  assert.ok(
    overlay.root.children.some(
      (c) =>
        c instanceof THREE.Mesh &&
        c.geometry instanceof THREE.OctahedronGeometry &&
        c.visible,
    ),
  );
  overlay.dispose();
  assert.equal(overlay.root.children.length, 0);
});
await finish('render/water-overlay');
