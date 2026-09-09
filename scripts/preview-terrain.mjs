/**
 * Sample MartianTerrain and paint an overhead hillshade + oblique view.
 * Output: terrain-preview.jpg
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = path.join(root, 'node_modules', '.test-dist', 'terrain-preview-lib.mjs');

await build({
  entryPoints: [path.join(root, 'src/sim/terrain.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundled,
  logLevel: 'warning',
});

const { MartianTerrain } = await import(bundled);

const SEED = 42;
const HALF = 640;
const N = 280;
const t0 = Date.now();
const terrain = new MartianTerrain(SEED);
const site = terrain.site;
console.log(
  `generated seed ${SEED} in ${Date.now() - t0}ms — ${site.name} (${site.lat.toFixed(1)}°, ${site.lon.toFixed(1)}°E) ${site.biome} · ${terrain.craters.length} craters, ${terrain.rocks.length} rocks`,
);

const TINT = [
  [196, 160, 122], // dust
  [181, 106, 60], // sand
  [92, 50, 40], // bedrock
  [138, 106, 78], // layered
  [58, 50, 44], // basalt
  [203, 184, 154], // pale
];

const H = new Float32Array(N * N);
const R = new Uint8Array(N * N);
const G = new Uint8Array(N * N);
const B = new Uint8Array(N * N);
const crater = new Float32Array(N * N);
const steep = new Float32Array(N * N);

const t1 = Date.now();
for (let j = 0; j < N; j++) {
  const z = -HALF + ((j + 0.5) / N) * HALF * 2;
  for (let i = 0; i < N; i++) {
    const x = -HALF + ((i + 0.5) / N) * HALF * 2;
    const s = terrain.sample(x, z);
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
    crater[k] = s.crater;
    steep[k] = s.steep;
  }
  if (j % 40 === 0) console.log(`sampled row ${j}/${N}`);
}
console.log(`sampled ${N}×${N} in ${Date.now() - t1}ms`);

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
    const o = k * 3;
    over[o] = Math.min(255, R[k] * s);
    over[o + 1] = Math.min(255, G[k] * s);
    over[o + 2] = Math.min(255, B[k] * s);
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

// ---------- oblique ----------
const OW = 1600;
const OH = 980;
const out = Buffer.alloc(OW * OH * 3);
const depth = new Float32Array(OW * OH);
depth.fill(-1e9);
// dusty sky
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
  // dusty air — far cells wash toward haze
  const haze = Math.min(1, Math.max(0, (p00.dep + 220) / 700));
  r = r * (1 - haze * 0.45) + 160 * haze * 0.45;
  g = g * (1 - haze * 0.45) + 96 * haze * 0.45;
  b = b * (1 - haze * 0.45) + 64 * haze * 0.45;
  const rr = Math.max(0, Math.min(255, r | 0));
  const gg = Math.max(0, Math.min(255, g | 0));
  const bb = Math.max(0, Math.min(255, b | 0));
  const dep = (p00.dep + p10.dep + p01.dep + p11.dep) * 0.25;
  fillTri(p00.sx, p00.sy, p10.sx, p10.sy, p01.sx, p01.sy, dep, rr, gg, bb);
  fillTri(p10.sx, p10.sy, p11.sx, p11.sy, p01.sx, p01.sy, dep + 0.01, rr, gg, bb);
}

const tmpOver = '/tmp/terrain-over.ppm';
const tmpObl = '/tmp/terrain-oblique.ppm';
writePpm(N, N, over, tmpOver);
writePpm(OW, OH, out, tmpObl);

const dest = path.join(root, 'terrain-preview.jpg');
const destOver = path.join(root, 'terrain-overhead.jpg');
spawnSync(
  'convert',
  [
    tmpObl,
    '-resize',
    '1600x980!',
    '-quality',
    '90',
    dest,
  ],
  { stdio: 'inherit' },
);
spawnSync(
  'convert',
  [
    tmpOver,
    '-filter',
    'Lanczos',
    '-resize',
    '1200x1200',
    '-quality',
    '90',
    destOver,
  ],
  { stdio: 'inherit' },
);

// ---------- MOLA-style hypsometric map ----------
// NASA MOLA legend (km) approximated in RGB, remapped onto this seed's metres.
const MOLA = [
  [-8, 12, 0, 28],
  [-6, 72, 0, 110],
  [-4, 30, 70, 210],
  [-2, 40, 190, 230],
  [0, 50, 190, 70],
  [2, 230, 220, 40],
  [4, 235, 140, 35],
  [6, 210, 40, 45],
  [8, 210, 170, 140],
  [12, 232, 232, 228],
];
function molaRgb(t) {
  // t in [-8, 12]
  if (t <= MOLA[0][0]) return [MOLA[0][1], MOLA[0][2], MOLA[0][3]];
  if (t >= MOLA[MOLA.length - 1][0]) {
    const c = MOLA[MOLA.length - 1];
    return [c[1], c[2], c[3]];
  }
  for (let i = 1; i < MOLA.length; i++) {
    if (t <= MOLA[i][0]) {
      const a = MOLA[i - 1];
      const b = MOLA[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      return [
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
        a[3] + (b[3] - a[3]) * u,
      ];
    }
  }
  return [128, 128, 128];
}

const sorted = Float32Array.from(H).sort();
const hLo = sorted[(sorted.length * 0.02) | 0];
const hHi = sorted[(sorted.length * 0.98) | 0];
const span = Math.max(8, hHi - hLo);

const mola = Buffer.alloc(N * N * 3);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const t = ((H[k] - hLo) / span) * 14 - 6; // map into roughly -6..+8 km legend
    const [cr, cg, cb] = molaRgb(t);
    const s = 0.38 + 0.62 * shade[k];
    const o = k * 3;
    mola[o] = Math.max(0, Math.min(255, cr * s));
    mola[o + 1] = Math.max(0, Math.min(255, cg * s));
    mola[o + 2] = Math.max(0, Math.min(255, cb * s));
  }
}
const tmpMola = '/tmp/terrain-mola.ppm';
writePpm(N, N, mola, tmpMola);

const destMola = path.join(root, 'terrain-mola.jpg');
const barW = 420;
const barH = 18;
const bar = Buffer.alloc(barW * barH * 3);
for (let x = 0; x < barW; x++) {
  const t = -8 + (x / (barW - 1)) * 20;
  const [cr, cg, cb] = molaRgb(t);
  for (let y = 0; y < barH; y++) {
    const o = (y * barW + x) * 3;
    bar[o] = cr;
    bar[o + 1] = cg;
    bar[o + 2] = cb;
  }
}
writePpm(barW, barH, bar, '/tmp/mola-bar.ppm');

const loLab = `${hLo.toFixed(1)} m`;
const hiLab = `${hHi.toFixed(1)} m`;
spawnSync(
  'convert',
  [
    '-size',
    '1600x980',
    'xc:white',
    '(',
    tmpMola,
    '-filter',
    'Lanczos',
    '-resize',
    '1480x820',
    ')',
    '-gravity',
    'north',
    '-geometry',
    '+0+72',
    '-composite',
    '-gravity',
    'northwest',
    '-fill',
    '#222',
    '-font',
    'DejaVu-Sans',
    '-pointsize',
    '22',
    '-annotate',
    '+40+28',
    `RED FRONTIER   ·   ${site.name}  (seed ${SEED})`,
    '-pointsize',
    '13',
    '-fill',
    '#555',
    '-annotate',
    '+40+54',
    'Playable map 640 × 640   ·   hypsometric colour after MOLA   ·   hillshade from generated elevation',
    '(',
    '/tmp/mola-bar.ppm',
    '-resize',
    '420x18!',
    ')',
    '-gravity',
    'northeast',
    '-geometry',
    '+40+30',
    '-composite',
    '-gravity',
    'northeast',
    '-pointsize',
    '11',
    '-fill',
    '#333',
    '-annotate',
    '+40+58',
    `${loLab}                         ${hiLab}`,
    '-quality',
    '92',
    destMola,
  ],
  { stdio: 'inherit' },
);
console.log('wrote', dest, destOver, destMola);
console.log(`elevation ${loLab} … ${hiLab}`);
