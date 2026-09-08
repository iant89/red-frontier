import * as THREE from 'three';
import type { World } from '../sim/World';
import { WORLD_HALF, SPAWN_X, SPAWN_Z, SPAWN_RADIUS } from '../sim/config';
import type { Deposit } from '../sim/World';
import type {
  Building as SBuilding,
  Rover as SRover,
  Simulation,
} from '../sim/Simulation';
import type { RoverKind, BuildingKind, ResourceId } from '../sim/defs';
import { RESOURCES, ROVERS, BUILDINGS } from '../sim/defs';

export interface PickTarget {
  object: THREE.Object3D;
  type: 'rover' | 'building' | 'deposit';
  id: number;
}

const TERRAIN_SEGS = 200;

export class GameRenderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  private world: World;

  terrain: THREE.Mesh;
  private roverRoot = new THREE.Group();
  private buildingRoot = new THREE.Group();
  private depositRoot = new THREE.Group();

  private roverMeshes = new Map<number, THREE.Group>();
  private buildingMeshes = new Map<number, { group: THREE.Group; body: THREE.Object3D; pad: THREE.Mesh; construction: THREE.Object3D }>();
  private depositMeshes = new Map<number, THREE.Group>();

  selectionRing: THREE.Mesh;
  ghostGroup: THREE.Group;
  private ghostBody: THREE.Mesh;

  private sun!: THREE.DirectionalLight;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    const aspect = canvas.clientWidth / canvas.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.5, 2600);
    this.camera.position.set(120, 110, 150);
    this.camera.lookAt(SPAWN_X, 0, SPAWN_Z);

    this.buildEnvironment();
    this.terrain = this.buildTerrain();
    this.scene.add(this.terrain);
    this.scene.add(this.roverRoot);
    this.scene.add(this.buildingRoot);
    this.scene.add(this.depositRoot);

    this.selectionRing = this.makeRing(0xffffff, 1.4, 0.35);
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;
    this.scene.add(this.ghostGroup);
    this.ghostBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.2, 2, 6),
      new THREE.MeshBasicMaterial({
        color: 0x7fe07a,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    this.ghostGroup.add(this.ghostBody);
    this.buildSpawnPad();
  }

  private buildEnvironment(): void {
    this.scene.background = new THREE.Color(0x0c0a16);
    this.scene.fog = new THREE.Fog(0x0d0a18, 420, 1900);

    const hemi = new THREE.HemisphereLight(0xffe0b0, 0x441f0e, 0.75);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xffe2b8, 1.7);
    this.sun.position.set(240, 380, -160);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -360;
    cam.right = 360;
    cam.top = 360;
    cam.bottom = -360;
    cam.near = 50;
    cam.far = 1200;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sun.target.position.set(0, 0, 0);

    const fill = new THREE.DirectionalLight(0x6fa8ff, 0.35);
    fill.position.set(-200, 120, 260);
    this.scene.add(fill);

    // stars / martian twilight sphere (very dim)
    const skyGeo = new THREE.SphereGeometry(2200, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x14101f,
      side: THREE.BackSide,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.set(0, -600, 0);
    this.scene.add(sky);
  }

  private buildTerrain(): THREE.Mesh {
    const size = WORLD_HALF * 2;
    const geo = new THREE.PlaneGeometry(size, size, TERRAIN_SEGS, TERRAIN_SEGS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cBase = new THREE.Color(0xc07348);
    const cDark = new THREE.Color(0x7a3d26);
    const cHi = new THREE.Color(0xd9a066);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.world.heightAt(x, z);
      pos.setY(i, h);
      const slope = this.world.slopeAt(x, z);
      const r = Math.hypot(x - SPAWN_X, z - SPAWN_Z);
      // land colour, dustier near base, darker on slopes, lighter on crests
      c.copy(cBase).lerp(cDark, Math.min(1, slope * 2.4));
      c.lerp(cHi, Math.min(0.5, Math.max(0, h * 0.06)));
      const dust = 1 - Math.min(1, Math.max(0, (r - 20) / 400));
      c.lerp(new THREE.Color(0x8a5a36), dust * 0.5);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData.pickableTerrain = true;
    return mesh;
  }

  private buildSpawnPad(): void {
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(SPAWN_RADIUS - 1, SPAWN_RADIUS + 1, 48),
      new THREE.MeshStandardMaterial({ color: 0x3a4a52, roughness: 0.9, side: THREE.DoubleSide }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.05, 0);
    this.scene.add(pad);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(SPAWN_RADIUS - 1, 48),
      new THREE.MeshStandardMaterial({ color: 0x4c3a2b, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0.0, 0);
    this.scene.add(ground);
  }

  private makeRing(color: number, radius: number, thickness = 0.35): THREE.Mesh {
    const g = new THREE.Mesh(
      new THREE.RingGeometry(radius - thickness / 2, radius + thickness / 2, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    g.rotation.x = -Math.PI / 2;
    return g;
  }

  // ---------------- entity syncing ----------------
  sync(sim: Simulation): void {
    this.syncRovers(sim.rovers);
    this.syncBuildings(sim.buildings);
    this.syncDeposits(sim.world.deposits);
  }

  private syncRovers(rovers: SRover[]): void {
    const seen = new Set<number>();
    for (const r of rovers) {
      seen.add(r.id);
      let g = this.roverMeshes.get(r.id);
      if (!g) {
        g = this.makeRoverMesh(r.kind, r.id);
        this.roverRoot.add(g);
        this.roverMeshes.set(r.id, g);
      }
      const y = this.world.heightAt(r.x, r.z);
      g.position.set(r.x, y + 0.4, r.z);
      g.rotation.y = -r.heading;
      g.userData.battery = r.battery / ROVERS[r.kind].maxBatteryKWh;
    }
    for (const [id, g] of this.roverMeshes) {
      if (!seen.has(id)) {
        this.roverRoot.remove(g);
        this.roverMeshes.delete(id);
      }
    }
  }

  private syncBuildings(buildings: SBuilding[]): void {
    const seen = new Set<number>();
    for (const b of buildings) {
      seen.add(b.id);
      let rec = this.buildingMeshes.get(b.id);
      if (!rec) {
        const group = new THREE.Group();
        const body = this.makeBuildingBody(b.kind, b.id);
        const pad = this.makePadMesh(BUILDINGS[b.kind].radius);
        const construction = this.makeConstructionMesh(BUILDINGS[b.kind].radius);
        group.add(pad);
        group.add(body);
        group.add(construction);
        this.buildingRoot.add(group);
        rec = { group, body, pad, construction };
        this.buildingMeshes.set(b.id, rec);
      }
      const y = this.world.heightAt(b.x, b.z);
      rec.group.position.set(b.x, y, b.z);
      const def = BUILDINGS[b.kind];
      const prog =
        b.state === 'online' ? 1 : b.state === 'building' ? Math.max(0.05, b.progress) : 0.05;
      // buildings all rest on pad; scale body up from ground as it is built
      rec.body.visible = b.state === 'online';
      rec.construction.visible = b.state !== 'online';
      if (rec.construction) {
        rec.construction.scale.set(1, Math.max(0.08, prog), 1);
      }
      rec.group.userData.pickable = true;
      rec.group.userData.pickType = 'building';
      rec.group.userData.pickId = b.id;
      rec.pad.visible = true;
      void def;
    }
    for (const [id, rec] of this.buildingMeshes) {
      if (!seen.has(id)) {
        this.buildingRoot.remove(rec.group);
        this.buildingMeshes.delete(id);
      }
    }
  }

  private syncDeposits(deposits: Deposit[]): void {
    const seen = new Set<number>();
    for (const d of deposits) {
      if (d.amount <= 0) continue;
      seen.add(d.id);
      let g = this.depositMeshes.get(d.id);
      if (!g) {
        g = this.makeDepositMesh(d);
        this.depositRoot.add(g);
        this.depositMeshes.set(d.id, g);
      }
      const y = this.world.heightAt(d.x, d.z);
      const frac = Math.max(0.08, d.amount / d.maxAmount);
      g.position.set(d.x, y, d.z);
      g.scale.setScalar(Math.max(0.25, Math.min(1, frac * 1.4)));
      g.visible = d.amount > 1;
    }
    for (const [id, g] of this.depositMeshes) {
      if (!seen.has(id)) {
        this.depositRoot.remove(g);
        this.depositMeshes.delete(id);
      }
    }
  }

  private makeDepositMesh(d: Deposit): THREE.Group {
    const g = new THREE.Group();
    const color = RESOURCES[d.resource].color;
    const blob = new THREE.Mesh(
      new THREE.ConeGeometry(d.radius * 0.7, d.radius * 0.9, 7),
      new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.05 }),
    );
    blob.position.y = d.radius * 0.2;
    blob.castShadow = true;
    blob.receiveShadow = true;
    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(d.radius * 0.75, d.radius, d.radius * 0.7, 7),
      new THREE.MeshStandardMaterial({ color: darken(color, 0.7), roughness: 1 }),
    );
    mound.position.y = -d.radius * 0.1;
    mound.receiveShadow = true;
    g.add(mound);
    g.add(blob);
    g.userData.pickable = true;
    g.userData.pickType = 'deposit';
    g.userData.pickId = d.id;
    return g;
  }

  private makePadMesh(radius: number): THREE.Mesh {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.25, radius * 1.35, 0.35, 28),
      new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.9 }),
    );
    pad.position.y = -0.05;
    pad.receiveShadow = true;
    return pad;
  }

  private makeConstructionMesh(radius: number): THREE.Object3D {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, radius * 2, 6, 1),
      new THREE.MeshStandardMaterial({
        color: 0xffc04a,
        roughness: 0.6,
        metalness: 0.1,
        transparent: true,
        opacity: 0.55,
      }),
    );
    frame.position.y = radius;
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(frame.geometry as THREE.BufferGeometry),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    wire.position.copy(frame.position);
    g.add(frame);
    g.add(wire);
    g.userData.isConstruction = true;
    return g;
  }

  private makeBuildingBody(kind: BuildingKind, id: number): THREE.Object3D {
    const g = new THREE.Group();
    const mat = (c: number, opts: { rough?: number; metal?: number; emissive?: number } = {}) =>
      new THREE.MeshStandardMaterial({
        color: c,
        roughness: opts.rough ?? 0.7,
        metalness: opts.metal ?? 0.2,
      });
    switch (kind) {
      case 'habitat': {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 3.4, 20), mat(0xd8d2c2, { rough: 0.55 }));
        base.position.y = 1.7;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xbcc8cf, { rough: 0.3, metal: 0.3 }));
        dome.position.y = 3.4;
        const door = new THREE.Mesh(new THREE.BoxGeometry(2, 2.6, 0.4), mat(0x8a7a5a));
        door.position.set(0, 1.3, 6.9);
        g.add(base);
        g.add(dome);
        g.add(door);
        break;
      }
      case 'solar': {
        const posts = new THREE.Group();
        for (let i = -2; i <= 2; i++) {
          for (let j = -1; j <= 1; j++) {
            const p = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 2.1), mat(0x2a4fae, { rough: 0.25, metal: 0.4 }));
            p.position.set(i * 4, 1.5, j * 3);
            p.rotation.x = -0.5;
            p.position.y = 1.5 + (j * 0.2);
            p.castShadow = true;
            posts.add(p);
          }
        }
        g.add(posts);
        break;
      }
      case 'battery': {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 5), mat(0x39463f, { rough: 0.4, metal: 0.6 }));
        wall.position.y = 1.8;
        for (let i = -2; i <= 2; i++) {
          const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.4, 12), mat(0x232e2a, { rough: 0.3, metal: 0.7 }));
          cell.position.set(i * 1.3, 2.4, 2.0);
          g.add(cell);
        }
        g.add(wall);
        break;
      }
      case 'warehouse': {
        const box = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 8), mat(0x8f8a82, { rough: 0.65, metal: 0.2 }));
        box.position.y = 2.5;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(7.2, 2.6, 4), mat(0x6e5a3a));
        roof.rotation.y = Math.PI / 4;
        roof.position.y = 6.3;
        g.add(box);
        g.add(roof);
        break;
      }
      case 'workshop': {
        const box = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 6), mat(0x9a6b45, { rough: 0.6 }));
        box.position.y = 2;
        const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 6, 10), mat(0x5a554a, { metal: 0.5 }));
        duct.rotation.x = Math.PI / 2;
        duct.position.y = 4.4;
        g.add(box);
        g.add(duct);
        break;
      }
    }
    g.castShadow = true;
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    g.userData.pickType = 'building';
    g.userData.pickId = id;
    return g;
  }

  private makeRoverMesh(kind: RoverKind, id: number): THREE.Group {
    const def = ROVERS[kind];
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.1, 2.0),
      new THREE.MeshStandardMaterial({ color: def.bodyColor, roughness: 0.5, metalness: 0.35 }),
    );
    body.position.y = 1.15;
    body.castShadow = true;
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.9, 1.1),
      new THREE.MeshStandardMaterial({ color: 0xe8e6da, roughness: 0.35, metalness: 0.1 }),
    );
    cab.position.set(0.9, 2.0, 0);
    const basePl = new THREE.BoxGeometry(3.6, 0.5, 2.4);
    const chassis = new THREE.Mesh(
      basePl,
      new THREE.MeshStandardMaterial({ color: def.accentColor, roughness: 0.7 }),
    );
    chassis.position.y = 0.55;
    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [wx, wz] of [
      [-1.3, 1.05],
      [1.3, 1.05],
      [-1.3, -1.05],
      [1.3, -1.05],
    ]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(wx, 0.55, wz);
      g.add(w);
    }
    // front marker + antenna
    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6),
      new THREE.MeshStandardMaterial({ color: 0xdddddd }),
    );
    ant.position.set(-1.2, 2.6, 0);
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffc040,
        emissive: 0xffa020,
        emissiveIntensity: 0.7,
      }),
    );
    light.position.set(1.7, 1.6, 0);
    g.add(body);
    g.add(chassis);
    g.add(cab);
    g.add(ant);
    g.add(light);

    if (kind === 'mining') {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.3, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x5a4a3a, metalness: 0.6 }),
      );
      arm.position.set(-1.2, 1.3, -1.1);
      arm.rotation.z = -0.6;
      const bit = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 0.7, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.8, roughness: 0.3 }),
      );
      bit.rotation.z = Math.PI;
      bit.position.set(-1.9, 0.7, -1.1);
      g.add(arm);
      g.add(bit);
    }
    g.userData.pickable = true;
    g.userData.pickType = 'rover';
    g.userData.pickId = id;
    return g;
  }

  // ---------------- selection / ghost ----------------
  setSelection(entity: { x: number; z: number; radius: number } | null): void {
    if (!entity) {
      this.selectionRing.visible = false;
      return;
    }
    const y = this.world.heightAt(entity.x, entity.z);
    this.selectionRing.position.set(entity.x, y + 0.2, entity.z);
    this.selectionRing.scale.set(entity.radius, 1, entity.radius);
    this.selectionRing.visible = true;
  }

  showGhost(kind: BuildingKind | null, x: number, z: number, valid: boolean): void {
    if (!kind) {
      this.ghostGroup.visible = false;
      return;
    }
    const def = BUILDINGS[kind];
    const y = this.world.heightAt(x, z);
    this.ghostGroup.visible = true;
    this.ghostGroup.position.set(x, y + 0.05, z);
    const s = def.radius;
    this.ghostBody.scale.set(s / 1.2, 1, s);
    (this.ghostBody.material as THREE.MeshBasicMaterial).color.set(valid ? 0x62e06a : 0xe0624a);
  }

  // ---------------- picking ----------------
  /** Root object3d per pickable entity (their child meshes carry the actual geometry). */
  getPickObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const [, g] of this.roverMeshes) out.push(g);
    for (const [, rec] of this.buildingMeshes) out.push(rec.group);
    for (const [, g] of this.depositMeshes) out.push(g);
    return out;
  }

  raycastTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    if (hits.length === 0) return null;
    return hits[0].point;
  }

  /** Pick an entity at a screen point, or null (climbs parents for grouped meshes). */
  pickTargetAt(clientX: number, clientY: number): PickTarget | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.getPickObjects(), true);
    for (const h of hits) {
      let node: THREE.Object3D | null = h.object;
      while (node) {
        const pickType = node.userData.pickType as PickTarget['type'] | undefined;
        const pickId = node.userData.pickId as number | undefined;
        if (pickType !== undefined && pickId !== undefined) {
          return { object: node, type: pickType, id: pickId };
        }
        node = node.parent;
      }
    }
    return null;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

function darken(hex: number, mul: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(mul);
  return c.getHex();
}
