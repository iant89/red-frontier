/**
 * Overhead playable map + oblique 3D of seed 42, with nav overlays:
 *   yellow 50%  — cannot drive
 *   red    50%  — cannot place buildings
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = path.join(root, 'node_modules', '.test-dist', 'nav-preview-lib.mjs');

await build({
  entryPoints: [path.join(root, 'src/sim/World.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundled,
  logLevel: 'warning',
});

const { World } = await import(bundled);

const SEED = 42;
const HALF = 640;
const N = 280;
const t0 = Date.now();
const world = new World({ seed: SEED, nearDeposits: 0.2 });
const site = world.landingSite();
const stats = world.navStats();
console.log(
  `seed ${SEED} in ${Date.now() - t0}ms — ${site.name} (${site.lat.toFixed(1)}°, ${site.lon.toFixed(1)}°E) ${site.biome}`,
);
console.log(
  `nav walkable ${stats.walkable}  blocked ${stats.blocked}  reachable ${stats.reachable}  deposits ${world.deposits.length}`,
);

const TINT = [
  [196, 160, 122],
  [181, 106, 60],
  [92, 50, 40],
  [138, 106, 78],
  [58, 50, 44],
  [203, 184, 154],
];

const H = new Float32Array(N * N);
const R = new Uint8Array(N * N);
const G = new Uint8Array(N * N);
const B = new Uint8Array(N * N);
const noDrive = new Uint8Array(N * N);
const noBuild = new Uint8Array(N * N);

const t1 = Date.now();
for (let j = 0; j < N; j++) {
  const z = -HALF + ((j + 0.5) / N) * HALF * 2;
  for (let i = 0; i < N; i++) {
    const x = -HALF + ((i + 0.5) / N) * HALF * 2;
    const s = world.sampleSurface(x, z);
    const k = j * N + i;
    H[k] = s.height;
    let r = 0,
      g = 0,
      b = 0;
    for (let m = 0; m < 6; m++) {
      r += TINT[m][0] * s.mat[m];
      g += TINT[m][1] * s.mat[m];
      b += TINT[m][2] * s.mat[m];
    }
    R[k] = r;
    G[k] = g;
    B[k] = b;
    // Authoritative nav (8 m cells) plus the same slope/cliff rules at
    // image resolution so rims read on the picture, not as 1-pixel specks.
    noDrive[k] = world.canDrive(x, z) ? 0 : 1;
    noBuild[k] = world.canBuild(x, z) ? 0 : 1;
  }
  if (j % 40 === 0) console.log(`sampled row ${j}/${N}`);
}
console.log(`sampled ${N}×${N} in ${Date.now() - t1}ms`);

const CELL = (HALF * 2) / N;
const CLIFF_DROP = 0.52;
const DRIVE_MAX_SLOPE = 0.42;
const BUILD_MAX_SLOPE = 0.24;
const N8 = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];
function atH(i, j) {
  i = Math.max(0, Math.min(N - 1, i));
  j = Math.max(0, Math.min(N - 1, j));
  return H[j * N + i];
}
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const x = -HALF + ((i + 0.5) / N) * HALF * 2;
    const z = -HALF + ((j + 0.5) / N) * HALF * 2;
    if (Math.hypot(x, z) < 32) continue;
    const hx = atH(i + 1, j) - atH(i - 1, j);
    const hz = atH(i, j + 1) - atH(i, j - 1);
    const sl = Math.hypot(hx, hz) / (2 * CELL);
    let cliff = sl > DRIVE_MAX_SLOPE;
    if (!cliff) {
      const here = H[k];
      for (const [di, dj, dist] of N8) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const drop = (here - H[nj * N + ni]) / (dist * CELL);
        if (drop > CLIFF_DROP) {
          cliff = true;
          break;
        }
      }
    }
    if (cliff) noDrive[k] = 1;
    if (cliff || sl > BUILD_MAX_SLOPE) noBuild[k] = 1;
  }
}

let nd = 0,
  nb = 0;
for (let k = 0; k < N * N; k++) {
  if (noDrive[k]) nd++;
  if (noBuild[k]) nb++;
}
console.log(
  `pixels no-drive ${(100 * nd) / (N * N)}%  no-build ${(100 * nb) / (N * N)}%`,
);

function heightAt(i, j) {
  i = Math.max(0, Math.min(N - 1, i));
  j = Math.max(0, Math.min(N - 1, j));
  return H[j * N + i];
}

const lx = 0.55,
  ly = 0.75,
  lz = 0.35;
const llen = Math.hypot(lx, ly, lz);
const Lx = lx / llen,
  Ly = ly / llen,
  Lz = lz / llen;
const shade = new Float32Array(N * N);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const dx = heightAt(i + 1, j) - heightAt(i - 1, j);
    const dz = heightAt(i, j + 1) - heightAt(i, j - 1);
    const nx = -dx;
    const ny = 2.2;
    const nz = -dz;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    let s = (nx / nlen) * Lx + (ny / nlen) * Ly + (nz / nlen) * Lz;
    s = 0.28 + 0.72 * Math.max(0, s);
    shade[j * N + i] = s;
  }
}

const YELLOW = [255, 210, 0];
const RED = [220, 28, 36];
const ALPHA = 0.5;

function overlay(r, g, b, k) {
  if (noBuild[k]) {
    r = r * (1 - ALPHA) + RED[0] * ALPHA;
    g = g * (1 - ALPHA) + RED[1] * ALPHA;
    b = b * (1 - ALPHA) + RED[2] * ALPHA;
  }
  if (noDrive[k]) {
    r = r * (1 - ALPHA) + YELLOW[0] * ALPHA;
    g = g * (1 - ALPHA) + YELLOW[1] * ALPHA;
    b = b * (1 - ALPHA) + YELLOW[2] * ALPHA;
  }
  return [r, g, b];
}

function writePpm(w, h, rgb, file) {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
  fs.writeFileSync(file, Buffer.concat([header, rgb]));
}

// ---------- overhead ----------
const over = Buffer.alloc(N * N * 3);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const s = shade[k];
    let r = R[k] * s;
    let g = G[k] * s;
    let b = B[k] * s;
    [r, g, b] = overlay(r, g, b, k);
    const o = k * 3;
    over[o] = Math.min(255, r);
    over[o + 1] = Math.min(255, g);
    over[o + 2] = Math.min(255, b);
    const x = -HALF + ((i + 0.5) / N) * HALF * 2;
    const z = -HALF + ((j + 0.5) / N) * HALF * 2;
    const pad = Math.hypot(x, z);
    if (pad < 26 && pad > 24.2) {
      over[o] = 70;
      over[o + 1] = 90;
      over[o + 2] = 100;
    }
  }
}

// ---------- oblique 3D ----------
const OW = 1600;
const OH = 980;
const out = Buffer.alloc(OW * OH * 3);
const depth = new Float32Array(OW * OH);
depth.fill(-1e9);
for (let y = 0; y < OH; y++) {
  const t = y / (OH - 1);
  const r = 18 + t * 92;
  const g = 14 + t * 62;
  const b = 18 + t * 48;
  for (let x = 0; x < OW; x++) {
    const o = (y * OW + x) * 3;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
}

const ang = -0.72;
const cosA = Math.cos(ang);
const sinA = Math.sin(ang);
const scale = 1.72;
const hScale = 5.8;
const cx = OW * 0.5;
const cy = OH * 0.62;

function project(i, j, h) {
  const x = -HALF + ((i + 0.5) / N) * HALF * 2;
  const z = -HALF + ((j + 0.5) / N) * HALF * 2;
  const xr = x * cosA - z * sinA;
  const zr = x * sinA + z * cosA;
  return {
    sx: cx + xr * scale,
    sy: cy + zr * scale * 0.46 - h * hScale,
    dep: zr,
  };
}

function plot(px, py, dep, r, g, b) {
  const x = px | 0;
  const y = py | 0;
  if (x < 0 || x >= OW || y < 0 || y >= OH) return;
  const idx = y * OW + x;
  if (dep < depth[idx]) return;
  depth[idx] = dep;
  const o = idx * 3;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

function fillTri(ax, ay, bx, by, cx, cy, dep, r, g, b) {
  const minx = Math.max(0, Math.min(ax, bx, cx) | 0);
  const maxx = Math.min(OW - 1, Math.max(ax, bx, cx) | 0);
  const miny = Math.max(0, Math.min(ay, by, cy) | 0);
  const maxy = Math.min(OH - 1, Math.max(ay, by, cy) | 0);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 0.5) return;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
      const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        plot(x, y, dep, r, g, b);
      }
    }
  }
}

const order = [];
for (let j = 0; j < N - 1; j++) {
  for (let i = 0; i < N - 1; i++) {
    const x = -HALF + ((i + 0.5) / N) * HALF * 2;
    const z = -HALF + ((j + 0.5) / N) * HALF * 2;
    order.push({ i, j, zr: x * sinA + z * cosA });
  }
}
order.sort((a, b) => a.zr - b.zr);

for (const cell of order) {
  const i = cell.i;
  const j = cell.j;
  if (i < 2 || j < 2 || i > N - 4 || j > N - 4) continue;
  const k00 = j * N + i;
  const k10 = j * N + i + 1;
  const k01 = (j + 1) * N + i;
  const k11 = (j + 1) * N + i + 1;
  const p00 = project(i, j, H[k00]);
  const p10 = project(i + 1, j, H[k10]);
  const p01 = project(i, j + 1, H[k01]);
  const p11 = project(i + 1, j + 1, H[k11]);
  const s = (shade[k00] + shade[k10] + shade[k01] + shade[k11]) * 0.25;
  let r = (R[k00] + R[k10] + R[k01] + R[k11]) * 0.25 * s;
  let g = (G[k00] + G[k10] + G[k01] + G[k11]) * 0.25 * s;
  let b = (B[k00] + B[k10] + B[k01] + B[k11]) * 0.25 * s;
  const haze = Math.min(1, Math.max(0, (p00.dep + 220) / 700));
  r = r * (1 - haze * 0.45) + 160 * haze * 0.45;
  g = g * (1 - haze * 0.45) + 96 * haze * 0.45;
  b = b * (1 - haze * 0.45) + 64 * haze * 0.45;
  // Overlay from the cell centre so the nav grid reads as patches, not noise.
  [r, g, b] = overlay(r, g, b, k00);
  const rr = Math.max(0, Math.min(255, r | 0));
  const gg = Math.max(0, Math.min(255, g | 0));
  const bb = Math.max(0, Math.min(255, b | 0));
  const dep = (p00.dep + p10.dep + p01.dep + p11.dep) * 0.25;
  fillTri(p00.sx, p00.sy, p10.sx, p10.sy, p01.sx, p01.sy, dep, rr, gg, bb);
  fillTri(p10.sx, p10.sy, p11.sx, p11.sy, p01.sx, p01.sy, dep + 0.01, rr, gg, bb);
}

const tmpOver = '/tmp/nav-over.ppm';
const tmpObl = '/tmp/nav-oblique.ppm';
writePpm(N, N, over, tmpOver);
writePpm(OW, OH, out, tmpObl);

const destOver = path.join(root, 'nav-map.jpg');
const dest3d = path.join(root, 'nav-3d.jpg');

const title = `RED FRONTIER  ·  ${site.name}  (seed ${SEED})`;
const sub = `Playable 1280 × 1280 m  ·  yellow 50% = cannot drive  ·  red 50% = cannot place buildings`;

function annotate(src, dest, size, extraGeom) {
  const args = [
    '-size',
    size,
    'xc:#0c0a08',
    '(',
    src,
    '-filter',
    'Lanczos',
    '-resize',
    extraGeom,
    ')',
    '-gravity',
    'north',
    '-geometry',
    '+0+64',
    '-composite',
    '-gravity',
    'northwest',
    '-fill',
    '#f2e6d4',
    '-font',
    'DejaVu-Sans',
    '-pointsize',
    '20',
    '-annotate',
    '+28+28',
    title,
    '-pointsize',
    '13',
    '-fill',
    '#c8b89a',
    '-annotate',
    '+28+52',
    sub,
    '-fill',
    '#ffd200',
    '-draw',
    'rectangle 28,1010 48,1030',
    '-fill',
    '#dc1c24',
    '-draw',
    'rectangle 280,1010 300,1030',
    '-fill',
    '#ddd0bc',
    '-pointsize',
    '12',
    '-annotate',
    '+56+1026',
    'cannot drive (50%)',
    '-annotate',
    '+308+1026',
    'cannot place buildings (50%)',
    '-quality',
    '90',
    dest,
  ];
  const r = spawnSync('convert', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error('convert failed for ' + dest);
  }
}

// Overhead is square — compose onto a 1200×1260 canvas with room for legend.
spawnSync(
  'convert',
  [
    '-size',
    '1200x1260',
    'xc:#0c0a08',
    '(',
    tmpOver,
    '-filter',
    'Lanczos',
    '-resize',
    '1140x1140',
    ')',
    '-gravity',
    'north',
    '-geometry',
    '+0+64',
    '-composite',
    '-gravity',
    'northwest',
    '-fill',
    '#f2e6d4',
    '-font',
    'DejaVu-Sans',
    '-pointsize',
    '20',
    '-annotate',
    '+28+28',
    title,
    '-pointsize',
    '13',
    '-fill',
    '#c8b89a',
    '-annotate',
    '+28+52',
    sub,
    '-fill',
    '#ffd200',
    '-draw',
    'rectangle 28,1222 48,1242',
    '-fill',
    '#dc1c24',
    '-draw',
    'rectangle 280,1222 300,1242',
    '-fill',
    '#ddd0bc',
    '-pointsize',
    '12',
    '-annotate',
    '+56+1238',
    'cannot drive (50%)',
    '-annotate',
    '+308+1238',
    'cannot place buildings (50%)',
    '-quality',
    '90',
    destOver,
  ],
  { stdio: 'inherit' },
);

spawnSync(
  'convert',
  [
    '-size',
    '1600x1048',
    'xc:#0c0a08',
    '(',
    tmpObl,
    '-resize',
    '1600x980!',
    ')',
    '-gravity',
    'north',
    '-geometry',
    '+0+0',
    '-composite',
    '-gravity',
    'northwest',
    '-fill',
    '#f2e6d4',
    '-font',
    'DejaVu-Sans',
    '-pointsize',
    '20',
    '-annotate',
    '+28+28',
    title,
    '-pointsize',
    '13',
    '-fill',
    '#c8b89a',
    '-annotate',
    '+28+52',
    sub,
    '-fill',
    '#ffd200',
    '-draw',
    'rectangle 28,1010 48,1030',
    '-fill',
    '#dc1c24',
    '-draw',
    'rectangle 320,1010 340,1030',
    '-fill',
    '#ddd0bc',
    '-pointsize',
    '13',
    '-annotate',
    '+56+1026',
    'cannot drive (50%)',
    '-annotate',
    '+348+1026',
    'cannot place buildings (50%)',
    '-quality',
    '90',
    dest3d,
  ],
  { stdio: 'inherit' },
);

console.log('wrote', destOver, dest3d);
