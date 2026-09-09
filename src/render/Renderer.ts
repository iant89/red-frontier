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
import { RESOURCES, ROVERS, BUILDINGS, ALL_FLUIDS } from '../sim/defs';
import type { SunState } from '../sim/clock';
import { sunDirection } from '../sim/clock';
import type { Colonist } from '../sim/lifesupport';
import { makeMarsFallbackMaterial, makeMarsTerrainMaterial } from './marsTerrain';

export type OverlayMode = 'none' | 'power' | 'life' | 'weather';

/** Sky tint the dust drags everything toward during a storm. */
const DUST_HAZE = new THREE.Color(0x9a5f33);
/** Side length of the (camera-following) airborne-dust particle box. */
const DUST_FIELD = 240;

/** Sky/light keyframes across a sol. The renderer reads the sim's sun only. */
const SKY_NIGHT = new THREE.Color(0x07070f);
const SKY_TWILIGHT = new THREE.Color(0x38203a);
const SKY_DAY = new THREE.Color(0xc98a5e);
const FOG_NIGHT = new THREE.Color(0x0a0a14);
const FOG_DAY = new THREE.Color(0xc08050);
const SUN_LOW = new THREE.Color(0xff8340);
const SUN_HIGH = new THREE.Color(0xfff0d0);

export interface PickTarget {
  object: THREE.Object3D;
  type: 'rover' | 'building' | 'deposit' | 'colonist';
  id: number;
}

const TERRAIN_SEGS = 280;

/** Albedo tints matching the 2×3 atlas tiles, used as vertex colour. */
const MAT_TINT = [
  new THREE.Color(0xc4a07a), // dust
  new THREE.Color(0xb56a3c), // sand
  new THREE.Color(0x5c3228), // bedrock
  new THREE.Color(0x8a6a4e), // layered
  new THREE.Color(0x3a322c), // basalt
  new THREE.Color(0xcbb89a), // pale
];

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
  private colonistMesh: THREE.Group | null = null;
  private overlayRoot = new THREE.Group();
  private overlayMarks = new Map<number, THREE.Group>();
  private overlayMode: OverlayMode = 'none';
  private hemi!: THREE.HemisphereLight;
  private fillLight!: THREE.DirectionalLight;
  private skyMat!: THREE.MeshBasicMaterial;
  private padLight!: THREE.PointLight;
  private buildingMeshes = new Map<
    number,
    { group: THREE.Group; body: THREE.Object3D; pad: THREE.Mesh; construction: THREE.Object3D; damageRing: THREE.Mesh }
  >();
  private depositMeshes = new Map<number, THREE.Group>();

  selectionRing: THREE.Mesh;
  ghostGroup: THREE.Group;
  private ghostBody: THREE.Mesh;

  /** The selected rover's queued route: a polyline plus waypoint diamonds. */
  private routeLine: THREE.Line | null = null;
  private routeMarks = new Map<number, THREE.Mesh>();
  private routeGroup = new THREE.Group();

  private dustField: THREE.Points | null = null;
  private dustPositions: Float32Array | null = null;
  private lastSimT = 0;

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
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.5, 4200);
    this.camera.position.set(120, 110, 150);
    this.camera.lookAt(SPAWN_X, 0, SPAWN_Z);

    this.buildEnvironment();
    this.terrain = this.buildTerrain();
    this.scene.add(this.terrain);
    this.buildRocks();
    this.loadMarsPbr();
    this.scene.add(this.roverRoot);
    this.scene.add(this.buildingRoot);
    this.scene.add(this.depositRoot);
    this.scene.add(this.overlayRoot);

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
    this.scene.add(this.routeGroup);
    this.buildSpawnPad();
    this.buildDustField();
  }

  private buildEnvironment(): void {
    this.scene.background = SKY_DAY.clone();
    this.scene.fog = new THREE.Fog(FOG_DAY.clone(), 520, 2800);

    this.hemi = new THREE.HemisphereLight(0xffe0b0, 0x441f0e, 0.75);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffe2b8, 1.7);
    this.sun.position.set(240, 380, -160);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -720;
    cam.right = 720;
    cam.top = 720;
    cam.bottom = -720;
    cam.near = 50;
    cam.far = 2200;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sun.target.position.set(0, 0, 0);

    this.fillLight = new THREE.DirectionalLight(0x6fa8ff, 0.3);
    this.fillLight.position.set(-200, 120, 260);
    this.scene.add(this.fillLight);

    // The landing pad keeps a work light burning after dark — a small anchor
    // so the base never disappears entirely at night.
    this.padLight = new THREE.PointLight(0xffcf8a, 0, 120, 2);
    this.padLight.position.set(SPAWN_X, 14, SPAWN_Z);
    this.scene.add(this.padLight);

    const skyGeo = new THREE.SphereGeometry(3600, 32, 16);
    this.skyMat = new THREE.MeshBasicMaterial({
      color: SKY_DAY.clone(),
      side: THREE.BackSide,
      fog: false,
    });
    const sky = new THREE.Mesh(skyGeo, this.skyMat);
    sky.position.set(0, -600, 0);
    this.scene.add(sky);
  }

  /**
   * Drive every light in the scene from the simulation's authoritative sun
   * (TDD §12 — one source of truth for both solar output and rendering).
   */
  private applySun(sun: SunState, dust: number, visibility: number): void {
    const dir = sunDirection(sun);
    const dist = 700;
    this.sun.position.set(dir.x * dist, Math.max(24, dir.y * dist), dir.z * dist);
    this.sun.target.position.set(0, 0, 0);

    // Daylight strength, and a separate twilight factor for the colour ramp.
    const day = Math.max(0, Math.min(1, sun.altitude * 2.2));
    const twilight = Math.max(0, 1 - Math.abs(sun.altitude) * 3.4);

    // The sim's dust transmission is the same number the panels use — a storm
    // visibly darkens the world by exactly as much as it dims the grid.
    const transmission = 1 - 0.75 * Math.pow(dust, 1.1);
    this.sun.intensity = 2.2 * sun.irradiance * (0.35 + 0.65 * transmission);
    this.sun.color.copy(SUN_LOW).lerp(SUN_HIGH, Math.min(1, Math.max(0, sun.altitude * 2.6)));
    this.sun.castShadow = sun.irradiance > 0.03;

    let sky = SKY_NIGHT.clone().lerp(SKY_TWILIGHT, twilight).lerp(SKY_DAY, day);
    sky.lerp(DUST_HAZE, Math.min(0.72, dust * 0.85 * Math.max(0.25, day)));
    this.skyMat.color.copy(sky);
    (this.scene.background as THREE.Color).copy(sky);

    const fog = this.scene.fog as THREE.Fog;
    const hazed = FOG_NIGHT.clone().lerp(FOG_DAY, Math.max(day, twilight * 0.55));
    fog.color.copy(hazed.lerp(DUST_HAZE, Math.min(0.85, dust * 0.9)));
    // Visibility closes the fog in — a severe storm pulls the horizon to your feet.
    const stormy = 1 - visibility;
    fog.near = 520 - 430 * stormy;
    fog.far = 2800 - 2100 * stormy;

    this.hemi.intensity = (0.1 + 0.68 * day) * (0.55 + 0.45 * transmission);
    this.hemi.color.copy(SUN_LOW).lerp(SUN_HIGH, day);
    this.fillLight.intensity = 0.06 + 0.26 * (1 - day);
    this.padLight.intensity = 1.5 * (1 - day) + 0.6 * stormy * day;

    this.renderer.toneMappingExposure = 0.82 + 0.3 * day - 0.12 * stormy;
  }

  // ---------------- weather atmosphere ----------------
  /** Grit in the wind: a cheap wrapped particle field driven by the sim. */
  private buildDustField(): void {
    const N = 900;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * DUST_FIELD;
      pos[i * 3 + 1] = Math.random() * 46;
      pos[i * 3 + 2] = (Math.random() - 0.5) * DUST_FIELD;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustPositions = pos;
    this.dustField = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xc49a6c,
        size: 1.15,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.dustField.frustumCulled = false;
    this.scene.add(this.dustField);
  }

  private syncDustField(sim: Simulation): void {
    const wx = sim.weather;
    const pts = this.dustField;
    if (!pts || !this.dustPositions) return;
    const mat = pts.material as THREE.PointsMaterial;
    // Nearly invisible on a clear sol; a storm becomes a wall of flying grit.
    mat.opacity = Math.min(0.66, Math.max(0, wx.dust * 0.95 - 0.03));

    // Sim seconds advanced since last frame (frozen while paused — weather is
    // sim state, not a screen effect).
    const dt = Math.min(0.5, Math.max(0, sim.simTime - this.lastSimT));
    this.lastSimT = sim.simTime;

    // Wind vector from the sim's speed/bearing.
    const wv = wx.windSpeed * 0.45;
    const vx = Math.sin(wx.windDirRad) * wv;
    const vz = Math.cos(wx.windDirRad) * wv;

    // Keep the field centred near the camera and wrap particles through it.
    const c = this.camera;
    const cx = Math.round(c.position.x / DUST_FIELD) * DUST_FIELD;
    const cz = Math.round(c.position.z / DUST_FIELD) * DUST_FIELD;
    pts.position.set(cx, 0, cz);

    const pos = this.dustPositions;
    const drift = vx * dt;
    const driftZ = vz * dt;
    const half = DUST_FIELD / 2;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] += drift + Math.sin(sim.simTime * 0.9 + i) * 0.4 * dt;
      pos[i + 2] += driftZ + Math.cos(sim.simTime * 0.8 + i) * 0.4 * dt;
      if (pos[i] > half) pos[i] -= DUST_FIELD;
      else if (pos[i] < -half) pos[i] += DUST_FIELD;
      if (pos[i + 2] > half) pos[i + 2] -= DUST_FIELD;
      else if (pos[i + 2] < -half) pos[i + 2] += DUST_FIELD;
    }
    (pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private buildTerrain(): THREE.Mesh {
    const size = WORLD_HALF * 2;
    const geo = new THREE.PlaneGeometry(size, size, TERRAIN_SEGS, TERRAIN_SEGS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uv = geo.attributes.uv;
    const c = new THREE.Color();
    const tint = new THREE.Color();
    const uvScale = 0.0072;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const s = this.world.sampleSurface(x, z);
      pos.setY(i, s.height);
      uv.setXY(i, x * uvScale, z * uvScale);
      tint.setRGB(0, 0, 0);
      for (let k = 0; k < 6; k++) {
        tint.r += MAT_TINT[k].r * s.mat[k];
        tint.g += MAT_TINT[k].g * s.mat[k];
        tint.b += MAT_TINT[k].b * s.mat[k];
      }
      c.copy(tint);
      c.lerp(MAT_TINT[2], s.steep * 0.28);
      c.multiplyScalar(1 - s.crater * 0.08 * s.craterAge);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv2', uv.clone());
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, makeMarsFallbackMaterial());
    mesh.receiveShadow = true;
    mesh.userData.pickableTerrain = true;
    return mesh;
  }

  private loadMarsPbr(): void {
    const base = `${import.meta.env.BASE_URL}textures/pbr`;
    const loader = new THREE.TextureLoader();
    const names = ['albedo', 'normal', 'roughness', 'metallic', 'ao', 'height'] as const;
    const loaded: Partial<Record<(typeof names)[number], THREE.Texture>> = {};
    let pending = names.length;
    const finish = (): void => {
      if (--pending > 0) return;
      const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const mat = makeMarsTerrainMaterial(
        {
          albedo: loaded.albedo!,
          normal: loaded.normal!,
          roughness: loaded.roughness!,
          metallic: loaded.metallic!,
          ao: loaded.ao!,
          height: loaded.height!,
        },
        anisotropy,
      );
      const old = this.terrain.material as THREE.Material;
      this.terrain.material = mat;
      old.dispose();
    };
    for (const name of names) {
      loader.load(`${base}/${name}.jpg`, (tex) => {
        loaded[name] = tex;
        finish();
      });
    }
  }

  private buildRocks(): void {
    const list = this.world.rocks();
    if (list.length === 0) return;
    const geos: THREE.BufferGeometry[] = [
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.BoxGeometry(1.5, 0.42, 1.15),
      new THREE.IcosahedronGeometry(0.72, 0),
    ];
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.06 }),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.04 }),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, metalness: 0.03 }),
    ];
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let kind = 0; kind < 3; kind++) {
      const subset = list.filter((r) => r.kind === kind);
      if (subset.length === 0) continue;
      const mesh = new THREE.InstancedMesh(geos[kind], mats[kind], subset.length);
      mesh.castShadow = kind === 0;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      for (let i = 0; i < subset.length; i++) {
        const r = subset[i];
        dummy.position.set(r.x, r.y + r.sy * 0.35, r.z);
        dummy.rotation.set(r.rotX, r.rotY, 0);
        dummy.scale.set(r.sx, r.sy, r.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.copy(MAT_TINT[2]).lerp(MAT_TINT[4], kind === 0 ? 0.35 : 0.15);
        color.multiplyScalar(0.55 + r.shade * 0.55);
        mesh.setColorAt(i, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
    }
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
    this.clockT = sim.simTime;
    // Panels face the sun's azimuth and tilt with its elevation.
    const el = Math.max(0, sim.sun.elevationRad);
    this.sunTilt = {
      y: -sim.sun.azimuthRad,
      z: -(Math.PI / 2 - el) * 0.55,
    };
    this.applySun(sim.sun, sim.weather.dust, sim.weather.visibility);
    this.syncDustField(sim);
    this.syncRovers(sim.rovers);
    this.syncBuildings(sim.buildings);
    this.syncDeposits(sim.world.deposits);
    this.syncColonist(sim.colonist);
    this.syncOverlay(sim);
  }

  // ---------------- colonist ----------------
  private syncColonist(c: Colonist): void {
    if (!this.colonistMesh) {
      this.colonistMesh = this.makeColonistMesh(c.id);
      this.scene.add(this.colonistMesh);
    }
    const g = this.colonistMesh;
    const y = this.world.heightAt(c.x, c.z);
    g.position.set(c.x, y, c.z);
    // The figure faces +Z (lamp forward, pack aft), and sim headings are
    // atan2(x, z) compass angles — so the mesh yaw *is* the heading.
    g.rotation.y = c.heading;
    // Inside a pressurised volume the figure is hidden by the structure.
    g.visible = !c.inside && !c.dead;
  }

  private makeColonistMesh(id: number): THREE.Group {
    const g = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({
      color: 0xe9e5db,
      roughness: 0.55,
      metalness: 0.1,
    });
    const trim = new THREE.MeshStandardMaterial({
      color: 0xe07b3a,
      roughness: 0.5,
      metalness: 0.2,
    });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.72, 4, 10), suit);
    torso.position.y = 1.25;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 14, 12),
      new THREE.MeshStandardMaterial({
        color: 0x2a3a4a,
        roughness: 0.15,
        metalness: 0.5,
        emissive: 0x14202c,
      }),
    );
    head.position.y = 2.0;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.34), trim);
    pack.position.set(0, 1.36, -0.42);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 3, 7), suit);
      leg.position.set(side * 0.2, 0.5, 0);
      g.add(leg);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.46, 3, 7), suit);
      arm.position.set(side * 0.55, 1.32, 0);
      g.add(arm);
    }
    // A helmet lamp so the figure reads at night.
    const lamp = new THREE.PointLight(0xfff0cc, 1.1, 26, 2);
    lamp.position.set(0, 2.1, 0.4);
    g.add(torso, head, pack, lamp);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    g.userData.pickable = true;
    g.userData.pickType = 'colonist';
    g.userData.pickId = id;
    g.scale.setScalar(1.35); // readable at strategic zoom
    return g;
  }

  // ---------------- overlays ----------------
  setOverlay(mode: OverlayMode): void {
    this.overlayMode = mode;
    this.overlayRoot.visible = mode !== 'none';
    if (mode === 'none') {
      for (const [, m] of this.overlayMarks) m.visible = false;
    }
  }

  /**
   * Floating markers above each building showing what it contributes to the
   * selected network. Cheap, readable, and colour-independent (TDD §11 asks
   * for colour-independent icons, so each mark carries a distinct shape too).
   */
  private syncOverlay(sim: Simulation): void {
    if (this.overlayMode === 'none') return;
    const seen = new Set<number>();
    for (const b of sim.buildings) {
      const def = BUILDINGS[b.kind];
      const relevant =
        this.overlayMode === 'power'
          ? def.powerProduceKw > 0 || def.powerDrawKw > 0 || def.batteryKWh > 0
          : this.overlayMode === 'weather'
            ? def.generation === 'solar' || def.exposure >= 0.5
            : !!def.process || !!def.fluidCapacity;
      if (!relevant || b.state !== 'online') continue;
      seen.add(b.id);

      let mark = this.overlayMarks.get(b.id);
      if (!mark) {
        mark = new THREE.Group();
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1, 0.16, 6, 22),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 1, 6),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthTest: false }),
        );
        mark.add(ring, beam);
        mark.renderOrder = 999;
        this.overlayRoot.add(mark);
        this.overlayMarks.set(b.id, mark);
      }
      mark.visible = true;

      const y = this.world.heightAt(b.x, b.z);
      const height = def.radius * 1.6 + 6;
      mark.position.set(b.x, y + height, b.z);

      const ring = mark.children[0] as THREE.Mesh;
      const beam = mark.children[1] as THREE.Mesh;
      const ringMat = ring.material as THREE.MeshBasicMaterial;
      const beamMat = beam.material as THREE.MeshBasicMaterial;

      let color = 0x888888;
      let scale = 1;
      if (this.overlayMode === 'power') {
        if (b.genKw > 0.01) {
          color = 0xffd479;
          scale = 1 + (b.genKw / Math.max(1, def.powerProduceKw)) * 1.4;
        } else if (def.batteryKWh > 0) {
          color = 0x9f7fe0;
          scale = 1.2;
        } else if (b.loadKw > 0.01) {
          color = 0x6fd3ff;
          scale = 1 + (b.loadKw / Math.max(1, def.powerDrawKw)) * 1.1;
        } else {
          color = 0x555555;
          scale = 0.7;
        }
        if (b.powerSat < 0.995) color = 0xd9553f;
      } else if (this.overlayMode === 'weather') {
        // Red = storm-damaged, amber = dust-buried array, white = exposed and
        // weatherproof enough. Shape stays the ring, so it reads everywhere.
        if (b.damaged) {
          color = 0xd9553f;
          scale = 1.5;
        } else if (def.generation === 'solar') {
          color = b.cleanliness < 0.55 ? 0xd98c3f : b.cleanliness < 0.8 ? 0xe0c060 : 0xf0ead8;
          scale = 0.8 + b.cleanliness * 0.9;
        } else {
          color = 0xf0ead8;
          scale = 0.6 + def.exposure;
        }
      } else {
        const p = def.process;
        if (p?.fluidOut?.water || def.fluidCapacity?.water) color = 0x4aa3e0;
        if (p?.fluidOut?.oxygen || def.fluidCapacity?.oxygen) color = 0x7fd9c8;
        if (p?.fluidOut?.food || def.fluidCapacity?.food) color = 0x8fce5a;
        scale = p ? 0.7 + b.throughput * 1.6 : 1;
        if (p && b.throughput < 0.02) color = 0xd9553f;
      }
      ringMat.color.setHex(color);
      beamMat.color.setHex(color);
      ring.scale.setScalar(scale * 1.6);
      beam.scale.set(1, height, 1);
      beam.position.y = -height / 2;
    }
    for (const [id, m] of this.overlayMarks) {
      if (!seen.has(id)) m.visible = false;
    }
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
      // The truck faces +X (cab and headlight forward), while sim headings
      // are atan2(x, z) compass angles measured from +Z. Offsetting by -90°
      // swings the nose onto the direction of travel — without it rovers
      // drive visibly sideways.
      g.rotation.y = r.heading - Math.PI / 2;
      g.userData.battery = r.battery / ROVERS[r.kind].maxBatteryKWh;

      // A battery-flat rover goes dark and flashes its reserve-powered yellow
      // strobe — "come get me". Live rovers burn headlights and a white rear
      // strobe whenever the sim has the lights lit (night / blowing dust).
      const stranded = r.phase === 'disabled';
      this.syncRoverLights(g, r.id, r.lightsActive && !stranded, stranded);
      this.setGroupBrightness(g, stranded ? 0.55 : 1);
    }
    for (const [id, g] of this.roverMeshes) {
      if (!seen.has(id)) {
        this.roverRoot.remove(g);
        this.roverMeshes.delete(id);
      }
    }
  }

  /**
   * Double-flash beacon envelope: two quick hits, then a rest, on a 1.6 s
   * cycle. Driven by sim time, so it freezes with the world when the game is
   * paused — lights are sim state, not a screen effect.
   */
  private strobeFlash(t: number): number {
    const p = ((t % 1.6) + 1.6) % 1.6;
    return p < 0.14 || (p >= 0.3 && p < 0.44) ? 1 : 0;
  }

  /**
   * Drive one rover's light rig from the sim: headlamps + beam while the
   * lights are lit, and the rear strobe — a white double-flash on the move,
   * or the amber emergency flash of a disabled rover, whose point light
   * lights up the ground in a radius around the truck every time it fires.
   */
  private syncRoverLights(g: THREE.Group, id: number, lit: boolean, stranded: boolean): void {
    // A per-rover offset keeps a fleet from blinking in lockstep; it is a
    // pure function of the (deterministic) rover id.
    const flash = this.strobeFlash(this.clockT + (id % 5) * 0.37);

    const head = g.getObjectByName('headlight') as THREE.SpotLight | undefined;
    if (head) head.intensity = lit ? 2.6 : 0;

    for (const name of ['lampL', 'lampR']) {
      const lamp = g.getObjectByName(name) as THREE.Mesh | undefined;
      if (!lamp) continue;
      (lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = lit ? 1.8 : 0;
    }
    const marker = g.getObjectByName('marker') as THREE.Mesh | undefined;
    if (marker) {
      (marker.material as THREE.MeshStandardMaterial).emissiveIntensity = lit ? 1.2 : 0.3;
    }

    const strobe = g.getObjectByName('strobe') as THREE.Mesh | undefined;
    const strobeLight = g.getObjectByName('strobeLight') as THREE.PointLight | undefined;
    if (strobe) {
      const m = strobe.material as THREE.MeshStandardMaterial;
      if (stranded) {
        // The emergency strobe is yellow, and it flashes whether or not the
        // lights switch is on — it runs off a reserve cell, not the battery.
        m.emissive.setHex(0xffb824);
        m.emissiveIntensity = 0.4 + 2.2 * flash;
      } else if (lit) {
        m.emissive.setHex(0xfff3c0);
        m.emissiveIntensity = 0.15 + 2.0 * flash;
      } else {
        m.emissiveIntensity = 0;
      }
    }
    if (strobeLight) {
      if (stranded) {
        strobeLight.color.setHex(0xffb824);
        strobeLight.intensity = 3.0 * flash;
      } else if (lit) {
        strobeLight.color.setHex(0xfff3c0);
        strobeLight.intensity = 2.4 * flash;
      } else {
        strobeLight.intensity = 0;
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
        const damageRing = this.makeRing(0xd9553f, BUILDINGS[b.kind].radius * 1.05, 0.5);
        damageRing.position.y = 0.55;
        damageRing.visible = false;
        group.add(pad);
        group.add(body);
        group.add(construction);
        group.add(damageRing);
        this.buildingRoot.add(group);
        rec = { group, body, pad, construction, damageRing };
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

      /**
       * Runtime state is legible from the world itself, not only the HUD: a
       * switched-off or unpowered building visibly dims, a running process
       * pulses, and solar panels physically track the sun.
       */
      if (b.state === 'online') {
        const running = b.enabled && b.powerSat > 0.02;
        let dim = !b.enabled ? 0.34 : b.powerSat < 0.5 ? 0.6 : 1;
        // Dust on the glass reads as a duller array; storm damage as a red ring.
        if (BUILDINGS[b.kind].generation === 'solar') {
          dim *= 0.55 + 0.45 * b.cleanliness;
        }
        this.setGroupBrightness(rec.body, dim);
        rec.damageRing.visible = b.damaged;
        if (b.damaged) {
          const pulse = 0.6 + 0.4 * Math.sin(this.clockT * 5);
          (rec.damageRing.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * pulse;
        }

        if (b.kind === 'solar') {
          // Tilt the array toward the sun; park it flat after dark.
          const tilt = this.sunTilt;
          rec.body.rotation.z = tilt.z;
          rec.body.rotation.y = tilt.y;
        }
        if (def.process && running && b.throughput > 0.02) {
          const pulse = 1 + Math.sin(this.clockT * 3.2) * 0.02 * b.throughput;
          rec.body.scale.setScalar(pulse);
        } else {
          rec.body.scale.setScalar(1);
        }
      }
    }
    for (const [id, rec] of this.buildingMeshes) {
      if (!seen.has(id)) {
        this.buildingRoot.remove(rec.group);
        this.buildingMeshes.delete(id);
      }
    }
  }

  /** Cached per-frame values used while syncing buildings. */
  private sunTilt = { y: 0, z: 0 };
  private clockT = 0;

  /**
   * Scale a mesh tree's emissive/colour to convey "powered" vs "dark".
   * Materials are cloned on first touch so shared definitions aren't mutated.
   */
  private setGroupBrightness(root: THREE.Object3D, factor: number): void {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = o.material as THREE.MeshStandardMaterial;
      if (!mat || !mat.color) return;
      if (!o.userData.baseColor) {
        o.material = mat.clone();
        (o.material as THREE.MeshStandardMaterial).userData = {};
        o.userData.baseColor = (o.material as THREE.MeshStandardMaterial).color.clone();
      }
      const m = o.material as THREE.MeshStandardMaterial;
      const base = o.userData.baseColor as THREE.Color;
      if (o.userData.brightness !== factor) {
        m.color.copy(base).multiplyScalar(factor);
        o.userData.brightness = factor;
      }
    });
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
      case 'extractor': {
        // A squat kiln that bakes hauled ice, with a hopper and a vent stack.
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(3.4, 4.0, 4.2, 12),
          mat(0x6d7d86, { rough: 0.45, metal: 0.55 }),
        );
        body.position.y = 2.1;
        const hopper = new THREE.Mesh(
          new THREE.CylinderGeometry(2.4, 1.2, 2.2, 8),
          mat(0x4c5a62, { rough: 0.5, metal: 0.5 }),
        );
        hopper.position.set(0, 5.2, 0);
        const stack = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.5, 4.4, 8),
          mat(0x8b9299, { metal: 0.7 }),
        );
        stack.position.set(2.6, 4.2, 1.4);
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(3.5, 0.22, 6, 18),
          mat(0x2f7fb0, { metal: 0.5, rough: 0.3 }),
        );
        band.rotation.x = Math.PI / 2;
        band.position.y = 2.6;
        g.add(body, hopper, stack, band);
        break;
      }
      case 'oxygenator': {
        // Electrolysis stacks: paired cylinders and a gas manifold.
        const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.4, 5), mat(0x50565c, { metal: 0.5 }));
        base.position.y = 0.7;
        g.add(base);
        for (const dx of [-1.9, 0, 1.9]) {
          const cell = new THREE.Mesh(
            new THREE.CylinderGeometry(0.85, 0.85, 4.6, 12),
            mat(0xd6dde0, { rough: 0.3, metal: 0.45 }),
          );
          cell.position.set(dx, 3.7, 0);
          const cap = new THREE.Mesh(
            new THREE.SphereGeometry(0.86, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            mat(0x7fd9c8, { rough: 0.25, metal: 0.4 }),
          );
          cap.position.set(dx, 6.0, 0);
          g.add(cell, cap);
        }
        const manifold = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, 6.2, 8),
          mat(0x8b9299, { metal: 0.7 }),
        );
        manifold.rotation.z = Math.PI / 2;
        manifold.position.y = 6.6;
        g.add(manifold);
        break;
      }
      case 'greenhouse': {
        // A glazed barrel vault — the only green thing on the planet.
        const vault = new THREE.Mesh(
          new THREE.CylinderGeometry(4.6, 4.6, 11, 16, 1, false, 0, Math.PI),
          new THREE.MeshStandardMaterial({
            color: 0xbfe6f5,
            roughness: 0.12,
            metalness: 0.1,
            transparent: true,
            opacity: 0.42,
            side: THREE.DoubleSide,
          }),
        );
        vault.rotation.z = Math.PI / 2;
        vault.rotation.y = Math.PI / 2;
        vault.position.y = 0.4;
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(11.4, 1, 9.6), mat(0x7d7466));
        plinth.position.y = 0.5;
        g.add(plinth, vault);
        // Crop rows visible through the glass.
        for (const dz of [-2.6, 0, 2.6]) {
          const row = new THREE.Mesh(
            new THREE.BoxGeometry(9.4, 0.9, 1.5),
            mat(0x4f8f3a, { rough: 0.9, metal: 0 }),
          );
          row.position.set(0, 1.4, dz);
          g.add(row);
        }
        const ribMat = mat(0xa8b0b6, { metal: 0.6 });
        for (const dx of [-4.6, 0, 4.6]) {
          const rib = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.16, 5, 14, Math.PI), ribMat);
          rib.position.set(dx, 0.4, 0);
          rib.rotation.y = Math.PI / 2;
          g.add(rib);
        }
        break;
      }
      case 'garage': {
        // A Quonset-style vehicle bay: half-barrel roof, end walls, a charge
        // post with a glowing wand, and a hardstand apron out front.
        const arch = new THREE.Mesh(
          new THREE.CylinderGeometry(4.6, 4.6, 9.5, 18, 1, false, 0, Math.PI),
          mat(0x8d99a3, { rough: 0.45, metal: 0.55 }),
        );
        arch.rotation.z = Math.PI / 2;
        arch.rotation.y = Math.PI / 2;
        arch.position.y = 0.2;
        for (const dx of [-4.75, 4.75]) {
          const wall = new THREE.Mesh(
            new THREE.CircleGeometry(4.6, 18, 0, Math.PI),
            mat(0x6d7883, { rough: 0.6, metal: 0.4 }),
          );
          wall.position.set(dx, 0.2, 0);
          wall.rotation.y = dx > 0 ? -Math.PI / 2 : Math.PI / 2;
          g.add(wall);
        }
        const apron = new THREE.Mesh(
          new THREE.BoxGeometry(9.5, 0.3, 5),
          mat(0x4a4a52, { rough: 0.9 }),
        );
        apron.position.set(0, 0.15, 4.2);
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 3.4, 0.5),
          mat(0x3f4348, { metal: 0.6 }),
        );
        post.position.set(5.6, 1.7, 3.4);
        const wand = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 1.6, 8),
          new THREE.MeshStandardMaterial({
            color: 0x7fd9c8,
            emissive: 0x2fae9c,
            emissiveIntensity: 1.1,
            roughness: 0.4,
          }),
        );
        wand.rotation.z = Math.PI / 2.4;
        wand.position.set(5.2, 3.1, 3.4);
        const glow = new THREE.PointLight(0x7fd9c8, 0.8, 18, 2);
        glow.position.set(5.2, 3.2, 3.4);
        g.add(arch, apron, post, wand, glow);
        break;
      }
      case 'rtg': {
        // Radioisotope units on a finned heat-rejection rack.
        const rack = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.9, 4.4), mat(0x3f4348, { metal: 0.6 }));
        rack.position.y = 0.45;
        g.add(rack);
        for (const dx of [-1.7, 1.7]) {
          const unit = new THREE.Mesh(
            new THREE.CylinderGeometry(1.05, 1.05, 3.4, 10),
            mat(0x2b2f33, { rough: 0.35, metal: 0.75 }),
          );
          unit.position.set(dx, 2.6, 0);
          const glow = new THREE.Mesh(
            new THREE.CylinderGeometry(1.09, 1.09, 0.5, 10),
            new THREE.MeshStandardMaterial({
              color: 0xff7a3a,
              emissive: 0xff5a1a,
              emissiveIntensity: 1.4,
              roughness: 0.4,
            }),
          );
          glow.position.set(dx, 2.6, 0);
          g.add(unit, glow);
          for (let i = 0; i < 6; i++) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.2, 2.0), mat(0x565b60, { metal: 0.7 }));
            fin.position.set(dx, 2.6, 0);
            fin.rotation.y = (i / 6) * Math.PI;
            g.add(fin);
          }
        }
        const warmth = new THREE.PointLight(0xff7a3a, 0.9, 34, 2);
        warmth.position.set(0, 3, 0);
        g.add(warmth);
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
    // A cargo rover is simply a bigger truck: longer, wider, six wheels.
    const L = kind === 'cargo' ? 4.6 : 3.2;
    const W = kind === 'cargo' ? 2.6 : 2.0;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(L, 1.1, W),
      new THREE.MeshStandardMaterial({ color: def.bodyColor, roughness: 0.5, metalness: 0.35 }),
    );
    body.position.y = 1.15;
    body.castShadow = true;
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.9, W * 0.55),
      new THREE.MeshStandardMaterial({ color: 0xe8e6da, roughness: 0.35, metalness: 0.1 }),
    );
    cab.position.set(L / 2 - 0.7, 2.0, 0);
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(L + 0.4, 0.5, W + 0.4),
      new THREE.MeshStandardMaterial({ color: def.accentColor, roughness: 0.7 }),
    );
    chassis.position.y = 0.55;
    // wheels — the axle runs across the truck (Z), so the treads roll fore/aft
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    wheelGeo.rotateX(Math.PI / 2);
    const wheelXs = kind === 'cargo' ? [-L / 2 + 0.5, 0, L / 2 - 0.5] : [-1.3, 1.3];
    for (const wx of wheelXs) {
      for (const wz of [W / 2 + 0.05, -W / 2 - 0.05]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(wx, 0.55, wz);
        g.add(w);
      }
    }
    // front marker + antenna
    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6),
      new THREE.MeshStandardMaterial({ color: 0xdddddd }),
    );
    ant.position.set(-L / 2 + 0.4, 2.6, 0);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffc040,
        emissive: 0xffa020,
        emissiveIntensity: 0.3,
      }),
    );
    marker.name = 'marker';
    marker.position.set(L / 2 + 0.5, 1.6, 0);
    g.add(body);
    g.add(chassis);
    g.add(cab);
    g.add(ant);
    g.add(marker);

    // ---- position lights ---------------------------------------------------
    // Headlamps on the nose plus a beam that reaches down the road; the sim
    // powers them (and bills the battery) whenever it calls for lights.
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xf7f2dd,
      emissive: 0xffedb0,
      emissiveIntensity: 0,
      roughness: 0.35,
    });
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.22, 10), lampMat);
      lamp.name = side < 0 ? 'lampL' : 'lampR';
      lamp.rotation.z = Math.PI / 2;
      lamp.position.set(L / 2 + 0.12, 1.15, side * W * 0.32);
      g.add(lamp);
    }
    const headlight = new THREE.SpotLight(0xffedb0, 0, 46, 0.5, 0.55, 1.2);
    headlight.name = 'headlight';
    headlight.position.set(L / 2 + 0.3, 1.5, 0);
    headlight.target.position.set(L / 2 + 24, -2, 0);
    g.add(headlight);
    g.add(headlight.target);

    // Rear strobe on the antenna mast. White double-flash while the lights
    // are on; the reserve-powered amber flash of a disabled rover. Its point
    // light is what slaps the ground bright inside the flash.
    const strobe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.19, 0.34, 10),
      new THREE.MeshStandardMaterial({
        color: 0x3a3a40,
        emissive: 0xfff3c0,
        emissiveIntensity: 0,
        roughness: 0.4,
      }),
    );
    strobe.name = 'strobe';
    strobe.position.set(-L / 2 + 0.4, 3.3, 0);
    const strobeLight = new THREE.PointLight(0xfff3c0, 0, 30, 2);
    strobeLight.name = 'strobeLight';
    strobeLight.position.set(-L / 2 + 0.4, 3.7, 0);
    g.add(strobe);
    g.add(strobeLight);

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
    if (kind === 'cargo') {
      // Container flats on the bed — it reads as a hauler at a glance.
      for (const dz of [-W / 4, W / 4]) {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(L * 0.5, 1.3, W * 0.42),
          new THREE.MeshStandardMaterial({ color: 0x8f9aa4, roughness: 0.65, metalness: 0.3 }),
        );
        box.position.set(-L * 0.2, 2.3, dz);
        g.add(box);
      }
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

  /**
   * Draw the selected rover's route (P4): a ground-hugging polyline through
   * its task destinations, with a diamond at each waypoint. `null` hides it.
   * Pure presentation — the Game layer decides what the points are.
   */
  showRoute(points: Array<{ x: number; z: number }> | null): void {
    if (!points || points.length < 2) {
      if (this.routeLine) this.routeLine.visible = false;
      for (const [, m] of this.routeMarks) m.visible = false;
      return;
    }
    if (!this.routeLine) {
      const mat = new THREE.LineBasicMaterial({
        color: 0x6fd3ff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      this.routeLine = new THREE.Line(new THREE.BufferGeometry(), mat);
      this.routeLine.renderOrder = 998;
      this.routeGroup.add(this.routeLine);
    }
    const pts = points.map((p) => {
      const y = this.world.heightAt(p.x, p.z);
      return new THREE.Vector3(p.x, y + 1.2, p.z);
    });
    this.routeLine.geometry.setFromPoints(pts);
    this.routeLine.visible = true;

    // Waypoint diamonds (skip 0 — the rover itself is ringed by the selection).
    for (let i = 1; i < points.length; i++) {
      let mark = this.routeMarks.get(i);
      if (!mark) {
        mark = new THREE.Mesh(
          new THREE.OctahedronGeometry(1.1),
          new THREE.MeshBasicMaterial({
            color: 0x6fd3ff,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
          }),
        );
        mark.renderOrder = 999;
        this.routeGroup.add(mark);
        this.routeMarks.set(i, mark);
      }
      const p = points[i];
      mark.position.set(p.x, this.world.heightAt(p.x, p.z) + 1.2, p.z);
      mark.visible = true;
      mark.rotation.y = this.clockT * 1.5;
    }
    for (const [i, m] of this.routeMarks) {
      if (i >= points.length) m.visible = false;
    }
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

  /**
   * World → screen projection for the HUD's off-screen markers. Returns client
   * coords plus whether the point sits behind the camera (callers mirror
   * those to the far edge instead of trusting the flipped projection).
   */
  project(x: number, z: number): { x: number; y: number; behind: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(x, this.world.heightAt(x, z) + 2, z).project(this.camera);
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
      behind: v.z > 1,
    };
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
