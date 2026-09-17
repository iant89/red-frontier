/**
 * Weather Radar Station — presentation mesh.
 *
 * A RAXpol-style polarimetric dish on a rotating pedestal, housed in a green
 * spherical radome, with a Robinson cup anemometer + wind vane on a met mast.
 * The equipment hut and pedestal wear NASA-style white quilted MLI (the same
 * beta-cloth / kapton blankets that wrap rovers and satellites).
 *
 * It is **presentation only**. The sim owns radar range, forecasting and wind
 * readings; this module only draws what those already decided. Animation is
 * keyed to sim time so a paused colony holds still.
 *
 * Radome shading is load-bearing: `THREE.FrontSide` so the outer surface is
 * opaque green, while the inner half is culled — you can see through it from
 * the inside, but not from the outside.
 */
import * as THREE from 'three';

/** Green of the rotating radome — matches the world-map / HUD radar accent. */
export const RADOME_COLOR = 0x6fd3b4;

/**
 * The radome is front-faces only. Outer hemisphere: opaque. Inner hemisphere:
 * culled, so a camera (or the dish) looking out from inside sees through it.
 * `THREE.FrontSide === 0`; exported as a number so the render suite can pin
 * the contract without standing up a GPU context.
 */
export const RADOME_SIDE: typeof THREE.FrontSide = THREE.FrontSide;

/** Quilted white MLI outer layer (beta cloth), with gold kapton at the seams. */
export const MLI_WHITE = 0xf3efe4;
export const MLI_GOLD = 0xc4a35a;

// ------------------------------------------------------------------ motion ----

/**
 * Cup-anemometer spin, radians. Linear in wind speed and sim time, so a
 * paused colony freezes the cups and a gale visibly outruns a breeze.
 */
export function cupSpinRad(t: number, windSpeed: number): number {
  const time = Number.isFinite(t) ? t : 0;
  const v = Number.isFinite(windSpeed) && windSpeed > 0 ? windSpeed : 0;
  return time * v * 1.65;
}

/** Wind-vane yaw: the fin points the way the wind blows (sim compass). */
export function vaneYaw(windDirRad: number): number {
  return Number.isFinite(windDirRad) ? windDirRad : 0;
}

/**
 * RAXpol azimuth, radians. Rapid-scan when powered; the angle is a pure
 * function of sim time so two stations never need to store a motor position.
 */
export function raxpolAzimuth(t: number, powered: boolean): number {
  if (!powered) return 0;
  return (Number.isFinite(t) ? t : 0) * 0.55;
}

/** Elevation nod of the dish, radians off horizontal. A slow volume-scan. */
export function raxpolElevation(t: number, powered: boolean): number {
  const rest = 0.34;
  if (!powered) return rest;
  return rest + 0.14 * Math.sin((Number.isFinite(t) ? t : 0) * 0.32);
}

/**
 * Status-LED envelope, 0..1. Two quick hits then a rest, on a 1.4 s cycle,
 * offset per lamp so a bank never blinks in lockstep.
 */
export function stationLedPulse(t: number, lane = 0): number {
  if (!Number.isFinite(t)) return 0;
  const p = (((t + lane * 0.37) % 1.4) + 1.4) % 1.4;
  return p < 0.12 || (p >= 0.26 && p < 0.38) ? 1 : 0;
}

export interface WeatherStationSync {
  time: number;
  powered: boolean;
  windSpeed: number;
  windDirRad: number;
  damaged?: boolean;
}

// -------------------------------------------------------------------- build ----

/**
 * Build the station as a single group. Named descendants (`radarDish`,
 * `radome`, `raxpolElev`, `anemometerCups`, `windVane`, the `led*` lamps)
 * are what `syncWeatherStation` drives each frame.
 */
export function buildWeatherStation(_id: number): THREE.Group {
  const root = new THREE.Group();
  root.name = 'weatherStation';

  const steel = (color: number, rough = 0.45, metal = 0.55) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const mliTex = mliAlbedoTexture();
  const mliMat = new THREE.MeshStandardMaterial({
    color: MLI_WHITE,
    map: mliTex,
    roughness: 0.92,
    metalness: 0.04,
  });
  const goldMat = steel(MLI_GOLD, 0.38, 0.55);

  root.add(buildHut(mliMat, goldMat, steel));
  root.add(buildRadar(steel, mliMat, goldMat));
  root.add(buildAnemometer(steel, mliMat));
  root.add(buildLeds());

  return root;
}

/** Drive every moving part from sim time. No-ops on a mesh tree that isn't ours. */
export function syncWeatherStation(root: THREE.Object3D, s: WeatherStationSync): void {
  const t = s.time;
  const dish = root.getObjectByName('radarDish');
  if (dish) dish.rotation.y = raxpolAzimuth(t, s.powered);

  const elev = root.getObjectByName('raxpolElev');
  if (elev) elev.rotation.x = raxpolElevation(t, s.powered);

  const cups = root.getObjectByName('anemometerCups');
  if (cups) cups.rotation.y = cupSpinRad(t, s.windSpeed);

  const vane = root.getObjectByName('windVane');
  if (vane) vane.rotation.y = vaneYaw(s.windDirRad);

  const pulse = stationLedPulse(t, 0);
  const scan = stationLedPulse(t, 1);
  const beacon = stationLedPulse(t, 2);
  setLed(root, 'ledPower', s.powered ? 0.35 + 1.4 * pulse : 0.04, s.powered ? 0x7fe07a : 0x3a4a3a);
  setLed(root, 'ledScan', s.powered ? 0.2 + 1.8 * scan : 0, 0x6fd3b4);
  setLed(root, 'ledFault', s.damaged ? 0.5 + 1.6 * pulse : 0, 0xff5a3a);
  setLed(root, 'ledBeacon', s.powered ? 0.15 + 2.2 * beacon : 0.05, 0xfff3c0);
}

function setLed(root: THREE.Object3D, name: string, intensity: number, color: number): void {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
  if (!mesh) return;
  const m = mesh.material as THREE.MeshStandardMaterial;
  if (!m || !m.emissive) return;
  m.emissive.setHex(color);
  m.emissiveIntensity = intensity;
}

// ------------------------------------------------------------- subassemblies ----

function buildHut(
  mli: THREE.MeshStandardMaterial,
  gold: THREE.MeshStandardMaterial,
  steel: (c: number, r?: number, m?: number) => THREE.MeshStandardMaterial,
): THREE.Group {
  const hut = new THREE.Group();
  hut.name = 'wxHut';

  // Quilted MLI blanket over a boxy equipment shelter.
  const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.55, 5.2), mli);
  body.position.set(0, 1.35, -1.55);
  hut.add(body);

  // Gold kapton tape at every seam — the NASA tell.
  const tape = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gold);
    t.position.set(x, y, z);
    hut.add(t);
  };
  tape(6.55, 0.07, 0.07, 0, 2.62, -1.55);
  tape(6.55, 0.07, 0.07, 0, 0.12, -1.55);
  tape(0.07, 2.55, 0.07, 3.2, 1.35, -1.55);
  tape(0.07, 2.55, 0.07, -3.2, 1.35, -1.55);
  tape(0.07, 0.07, 5.35, 3.2, 2.62, -1.55);
  tape(0.07, 0.07, 5.35, -3.2, 2.62, -1.55);

  // Access hatch and porthole so it reads as a room, not a crate.
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.7, 0.12), steel(0x3f4348, 0.5, 0.4));
  hatch.position.set(0, 1.05, 1.08);
  hut.add(hatch);
  const port = new THREE.Mesh(
    new THREE.CircleGeometry(0.28, 16),
    new THREE.MeshStandardMaterial({
      color: 0x1a2830,
      roughness: 0.12,
      metalness: 0.4,
      emissive: 0x0a1820,
      emissiveIntensity: 0.4,
    }),
  );
  port.position.set(1.7, 1.7, 1.07);
  hut.add(port);

  // Roof ridge + small thermal radiator.
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.16, 0.55), gold);
  ridge.position.set(0, 2.72, -1.55);
  hut.add(ridge);
  const rad = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 1.1), steel(0x6a7078, 0.35, 0.7));
  rad.position.set(-1.4, 2.78, -1.55);
  hut.add(rad);
  for (const dx of [-0.7, 0, 0.7]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 1.0), steel(0x8b9198, 0.4, 0.65));
    fin.position.set(-1.4 + dx, 2.94, -1.55);
    hut.add(fin);
  }

  // Cable tray from the hut to the radar pedestal.
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 3.4), steel(0x4a4f55, 0.6, 0.4));
  tray.position.set(1.6, 0.55, 0.4);
  hut.add(tray);

  return hut;
}

function buildRadar(
  steel: (c: number, r?: number, m?: number) => THREE.MeshStandardMaterial,
  mli: THREE.MeshStandardMaterial,
  gold: THREE.MeshStandardMaterial,
): THREE.Group {
  const radar = new THREE.Group();
  radar.position.set(0, 0, 1.85);

  // Pedestal, MLI-wrapped, with a gold ring at the slew bearing.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 0.45, 20), mli);
  base.position.y = 0.22;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 3.1, 16), mli);
  column.position.y = 1.95;
  const bearing = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.09, 8, 24), gold);
  bearing.rotation.x = Math.PI / 2;
  bearing.position.y = 3.52;
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.38, 0.7), steel(0x3f4348, 0.4, 0.6));
  yoke.position.y = 3.85;
  radar.add(base, column, bearing, yoke);

  // ---- rotating turret: green radome + RAXpol dish --------------------------
  const turret = new THREE.Group();
  turret.name = 'radarDish';
  turret.position.y = 5.15;

  // Opaque from the outside, see-through from the inside (FrontSide only).
  const radomeMat = new THREE.MeshStandardMaterial({
    color: RADOME_COLOR,
    roughness: 0.22,
    metalness: 0.38,
    side: RADOME_SIDE,
  });
  const radome = new THREE.Mesh(new THREE.SphereGeometry(2.35, 48, 32), radomeMat);
  radome.name = 'radome';
  turret.add(radome);

  // A faint inner tint so the shell still reads as a surface when you are
  // inside it, without blocking the view the FrontSide cull is there for.
  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(2.32, 32, 20),
    new THREE.MeshStandardMaterial({
      color: RADOME_COLOR,
      roughness: 0.15,
      metalness: 0.2,
      transparent: true,
      opacity: 0.07,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  inner.name = 'radomeInner';
  inner.userData.noCastShadow = true;
  turret.add(inner);

  const elev = new THREE.Group();
  elev.name = 'raxpolElev';
  elev.add(buildRaxpol(steel));
  turret.add(elev);

  radar.add(turret);
  return radar;
}

/**
 * RAXpol: a parabolic dual-pol dish on an elevation yoke, feed at the focus,
 * four struts. Mounted in front of the radome so the antenna is the silhouette
 * you read at strategic zoom, while the green sphere remains the rotating hub.
 */
function buildRaxpol(
  steel: (c: number, r?: number, m?: number) => THREE.MeshStandardMaterial,
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'raxpol';
  // Sit the dish on the +Z face of the radome so it is visible from outside.
  g.position.z = 1.15;

  const dishMat = steel(0xd8dde2, 0.28, 0.62);
  const dish = new THREE.Mesh(parabolicDishGeometry(2.15, 1.55, 48), dishMat);
  dish.name = 'raxpolDish';
  dish.rotation.x = Math.PI / 2;
  g.add(dish);

  // Backing ribs — the RAXpol's welded rear truss.
  const ribMat = steel(0x9aa3ab, 0.4, 0.55);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.06, 0.16), ribMat);
    rib.rotation.z = a;
    rib.position.z = -0.18;
    g.add(rib);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.28, 16), steel(0x4a4f55, 0.4, 0.6));
  hub.rotation.x = Math.PI / 2;
  hub.position.z = -0.22;
  g.add(hub);

  // Feed horn at the focal point, dual-pol probes crossed on the aperture.
  const focal = 1.55;
  const feed = new THREE.Group();
  feed.position.z = focal;
  const horn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.22, 0.42, 12),
    steel(0xc9cdd2, 0.3, 0.7),
  );
  horn.rotation.x = Math.PI / 2;
  const throat = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.22), steel(0x2a2e32, 0.35, 0.5));
  throat.position.z = -0.28;
  // Dual-pol: H and V probes.
  const probeMat = steel(0xe8c65a, 0.3, 0.8);
  const hProbe = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.03), probeMat);
  hProbe.position.z = 0.24;
  const vProbe = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.28, 0.03), probeMat);
  vProbe.position.z = 0.24;
  feed.add(horn, throat, hProbe, vProbe);
  g.add(feed);

  // Four feed struts, rim → focus.
  const strutMat = steel(0xb7bec4, 0.35, 0.65);
  for (const a of [0.4, 1.2, Math.PI + 0.4, Math.PI + 1.2]) {
    const rim = new THREE.Vector3(Math.cos(a) * 1.85, Math.sin(a) * 1.85, 0.35);
    const focus = new THREE.Vector3(0, 0, focal);
    const dir = focus.clone().sub(rim);
    const len = dir.length();
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8), strutMat);
    strut.position.copy(rim).addScaledVector(dir, 0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    strut.scale.y = len;
    g.add(strut);
  }

  // Elevation trunnions — the forks the dish nods in.
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.1, 0.28), steel(0x3f4348, 0.4, 0.6));
    arm.position.set(s * 1.05, 0, -0.55);
    g.add(arm);
  }

  return g;
}

function parabolicDishGeometry(radius: number, focal: number, segs: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 2; i <= 28; i++) {
    const r = (i / 28) * radius;
    const z = (r * r) / (4 * focal);
    pts.push(new THREE.Vector2(r, z));
  }
  return new THREE.LatheGeometry(pts, segs);
}

function buildAnemometer(
  steel: (c: number, r?: number, m?: number) => THREE.MeshStandardMaterial,
  mli: THREE.MeshStandardMaterial,
): THREE.Group {
  const mast = new THREE.Group();
  mast.position.set(2.85, 0, -1.15);

  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 0.28, 10), mli);
  foot.position.y = 0.14;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 6.4, 10), steel(0x8b9198, 0.4, 0.65));
  pole.position.y = 3.4;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 8), steel(0x8b9198, 0.4, 0.65));
  boom.rotation.z = Math.PI / 2;
  boom.position.set(-0.45, 6.55, 0);
  mast.add(foot, pole, boom);

  // Robinson cup anemometer — three hemispherical cups on a hub.
  const cups = new THREE.Group();
  cups.name = 'anemometerCups';
  cups.position.y = 6.85;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10), steel(0x3f4348, 0.4, 0.5));
  cups.add(hub);
  const cupMat = steel(0xb57a3c, 0.45, 0.35);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.05), steel(0x9aa0a8, 0.4, 0.6));
    arm.position.set(Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36);
    arm.rotation.y = -a;
    cups.add(arm);
    const cup = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      cupMat,
    );
    cup.rotation.z = Math.PI / 2;
    cup.rotation.y = a + Math.PI / 2;
    cup.position.set(Math.cos(a) * 0.72, 0, Math.sin(a) * 0.72);
    cups.add(cup);
  }
  mast.add(cups);

  // Wind vane on the opposite boom: a fin that yaws with the wind.
  const vane = new THREE.Group();
  vane.name = 'windVane';
  vane.position.set(-0.95, 6.55, 0);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), steel(0x8b9198, 0.4, 0.6));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.28, 8), steel(0xd8d2c2, 0.4, 0.5));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.42;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 0.42), steel(0xe8e6da, 0.5, 0.15));
  fin.position.z = -0.28;
  vane.add(shaft, nose, fin);
  mast.add(vane);

  return mast;
}

function buildLeds(): THREE.Group {
  const leds = new THREE.Group();
  const lamp = (name: string, color: number, x: number, y: number, z: number, r = 0.07) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 10, 8),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.2,
        roughness: 0.35,
      }),
    );
    m.name = name;
    m.position.set(x, y, z);
    leds.add(m);
  };
  lamp('ledPower', 0x7fe07a, 3.15, 2.35, 0.95);
  lamp('ledScan', 0x6fd3b4, -3.15, 2.35, 0.95);
  lamp('ledFault', 0xff5a3a, 3.15, 2.35, -3.95);
  lamp('ledBeacon', 0xfff3c0, 0, 7.55, 1.85, 0.11);
  return leds;
}

/**
 * Quilted MLI albedo: a grid of slightly different white squares with stitch
 * lines, the way beta-cloth blankets read at a glance. Built in a canvas so
 * we do not ship a texture; degrades to an empty texture off-DOM (tests).
 */
function mliAlbedoTexture(): THREE.Texture {
  const size = 256;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) return new THREE.Texture();
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.fillStyle = '#f4f0e6';
  ctx.fillRect(0, 0, size, size);
  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const puff = 0.92 + ((x * 13 + y * 7) % 9) * 0.012;
      const c = Math.round(232 * puff);
      ctx.fillStyle = `rgb(${c}, ${Math.round(c * 0.98)}, ${Math.round(c * 0.9)})`;
      ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  ctx.strokeStyle = 'rgba(90, 70, 40, 0.28)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell);
    ctx.lineTo(size, i * cell);
    ctx.stroke();
  }
  // Gold kapton strips every other seam.
  ctx.strokeStyle = 'rgba(196, 163, 90, 0.55)';
  ctx.lineWidth = 2.4;
  for (let i = 0; i <= cells; i += 2) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.needsUpdate = true;
  return tex;
}
