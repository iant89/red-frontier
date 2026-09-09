/**
 * 2D simplex noise (deterministic) + fractal brownian motion.
 * Classic public-domain implementation, adapted to take an integer seed hash.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// Permutation table via mulberry32(seed) so different seeds -> different noise.
function makePerm(seed: number): Uint8Array {
  const rand = mulberry(seed);
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // Fisher–Yates shuffle
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Noise2D {
  private perm: Uint8Array;

  constructor(seed = 1) {
    this.perm = makePerm(seed);
  }

  /** Returns noise in ~[-1,1]. */
  sample(x: number, y: number): number {
    const { perm } = this;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = perm[ii + perm[jj]] % 12;
      t0 *= t0;
      n0 = t0 * t0 * (grad2(gi0, x0, y0));
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = perm[ii + i1 + perm[jj + j1]] % 12;
      t1 *= t1;
      n1 = t1 * t1 * grad2(gi1, x1, y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = perm[ii + 1 + perm[jj + 1]] % 12;
      t2 *= t2;
      n2 = t2 * t2 * grad2(gi2, x2, y2);
    }

    return 70 * (n0 + n1 + n2);
  }

  /** Fractal brownian motion over several octaves. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let normSum = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.sample(x * freq, y * freq) * amp;
      normSum += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / normSum;
  }

  /**
   * Ridged multifractal — sharp crests, useful for eroded highlands and
   * gully networks rather than smooth hills.
   * Returns roughly [0, 1].
   */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let normSum = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.sample(x * freq, y * freq));
      sum += n * n * amp;
      normSum += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / Math.max(1e-6, normSum);
  }
}

const GRAD3 = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
];

function grad2(hash: number, x: number, y: number): number {
  const g = GRAD3[hash & 11];
  return g[0] * x + g[1] * y;
}
