/** Water-only overlay: cached terrain-following links, live flow beads and ports.
 * Drawn from the immutable host payload; no topology or simulation decisions. */
import * as THREE from 'three';
import type { SimView } from '../sim/host';

export class WaterNetworkOverlay {
  readonly root = new THREE.Group();
  private signature = '';
  private nodes = new Map<number, { ring: THREE.Mesh; warning: THREE.Mesh }>();
  private links = new Map<
    string,
    { line: THREE.Line; bead: THREE.Mesh; points: THREE.Vector3[] }
  >();
  constructor() {
    this.root.visible = false;
    this.root.name = 'water-network-overlay';
  }
  sync(sim: SimView): void {
    const network = sim.waterNetwork;
    const signature = JSON.stringify([
      sim.seed,
      network.nodes.map((n) => [n.id, n.x, n.z]),
      network.links.map((l) => [l.a, l.b]),
    ]);
    if (signature !== this.signature) {
      this.dispose();
      this.signature = signature;
      for (const n of network.nodes) {
        const material = new THREE.MeshBasicMaterial({
          color: 0x5fbce2,
          depthTest: false,
        });
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(2.5, 0.16, 6, 24),
          material,
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(n.x, sim.world.heightAt(n.x, n.z) + 1, n.z);
        const warning = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.8),
          new THREE.MeshBasicMaterial({ color: 0xffb34f, depthTest: false }),
        );
        warning.position.copy(ring.position).y += 3;
        this.root.add(ring, warning);
        this.nodes.set(n.id, { ring, warning });
      }
      for (const l of network.links) {
        const from = network.nodes.find((n) => n.id === l.a),
          to = network.nodes.find((n) => n.id === l.b);
        if (!from || !to) continue;
        const steps = Math.max(
          2,
          Math.ceil(Math.hypot(from.x - to.x, from.z - to.z) / 4),
        );
        const points = Array.from({ length: steps + 1 }, (_, i) => {
          const x = from.x + ((to.x - from.x) * i) / steps,
            z = from.z + ((to.z - from.z) * i) / steps;
          return new THREE.Vector3(x, sim.world.heightAt(x, z) + 0.65, z);
        });
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: 0x5b8795, depthTest: false }),
        );
        const bead = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xc1faff, depthTest: false }),
        );
        this.root.add(line, bead);
        this.links.set(`${l.a}:${l.b}`, { line, bead, points });
      }
    }
    for (const n of network.nodes) {
      const mark = this.nodes.get(n.id)!;
      const warning = network.active && n.status !== 'Supplied';
      mark.warning.visible = warning;
      (mark.ring.material as THREE.MeshBasicMaterial).color.setHex(
        warning ? 0xffb34f : 0x5fbce2,
      );
    }
    for (const l of network.links) {
      const mark = this.links.get(`${l.a}:${l.b}`);
      if (!mark) continue;
      const flowing = network.active && Math.abs(l.flowKgHour) > 1e-8;
      mark.bead.visible = flowing;
      (mark.line.material as THREE.LineBasicMaterial).color.setHex(
        flowing ? 0x6be3ff : 0x5b8795,
      );
      const fraction = (sim.simTime * 0.3) % 1;
      const position =
        (l.flowKgHour >= 0 ? fraction : 1 - fraction) *
        (mark.points.length - 1);
      const index = Math.min(Math.floor(position), mark.points.length - 2);
      mark.bead.position.lerpVectors(
        mark.points[index],
        mark.points[index + 1],
        position - index,
      );
    }
  }
  dispose(): void {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.root.clear();
    this.nodes.clear();
    this.links.clear();
    this.signature = '';
  }
}
