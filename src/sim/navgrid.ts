/**
 * Drive / place map for the playable window.
 *
 * Built once after terrain gen. A cell is a cliff when the drop to a neighbour
 * is a rim wall; gentler slopes (notches, valley floors, degraded rims) stay
 * open so a rover can drive down. Reachability is flooded from the pad so a
 * bowl with no path in is not a legal destination.
 */

import { WORLD_HALF, SPAWN_RADIUS } from './config';

export const NAV_CELL = 8;
/** Rise/run above this over one cell is a drop-off, not a ramp. */
const CLIFF_DROP = 0.52;
/** Rovers refuse slopes steeper than this even without a sharp lip. */
const DRIVE_MAX_SLOPE = 0.42;
const BUILD_MAX_SLOPE = 0.24;

export type NavPoint = { x: number; z: number };

const N8: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export class NavGrid {
  readonly cell = NAV_CELL;
  readonly n: number;
  private readonly origin: number;
  private readonly walk: Uint8Array;
  private readonly reach: Uint8Array;
  private readonly slope: Float32Array;

  constructor(heightAt: (x: number, z: number) => number) {
    this.n = Math.round((WORLD_HALF * 2) / this.cell);
    this.origin = -WORLD_HALF;
    const n = this.n;
    const h = new Float32Array(n * n);
    this.walk = new Uint8Array(n * n);
    this.reach = new Uint8Array(n * n);
    this.slope = new Float32Array(n * n);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const { x, z } = this.center(i, j);
        h[j * n + i] = heightAt(x, z);
      }
    }

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const { x, z } = this.center(i, j);
        if (Math.hypot(x, z) < SPAWN_RADIUS + 6) {
          this.walk[k] = 1;
          this.slope[k] = 0;
          continue;
        }
        const hx = this.atH(h, i + 1, j) - this.atH(h, i - 1, j);
        const hz = this.atH(h, i, j + 1) - this.atH(h, i, j - 1);
        const sl = Math.hypot(hx, hz) / (2 * this.cell);
        this.slope[k] = sl;
        let cliff = sl > DRIVE_MAX_SLOPE;
        if (!cliff) {
          const here = h[k];
          for (const [di, dj, dist] of N8) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
            const drop = (here - h[nj * n + ni]) / (dist * this.cell);
            if (drop > CLIFF_DROP) {
              cliff = true;
              break;
            }
          }
        }
        this.walk[k] = cliff ? 0 : 1;
      }
    }

    this.floodPad();
  }

  canDrive(x: number, z: number): boolean {
    const i = this.clampI(this.toI(x));
    const j = this.clampI(this.toI(z));
    const k = j * this.n + i;
    return this.walk[k] === 1 && this.reach[k] === 1;
  }

  canBuild(x: number, z: number): boolean {
    if (!this.canDrive(x, z)) return false;
    const i = this.clampI(this.toI(x));
    const j = this.clampI(this.toI(z));
    return this.slope[j * this.n + i] <= BUILD_MAX_SLOPE;
  }

  slopeAtCell(x: number, z: number): number {
    const i = this.clampI(this.toI(x));
    const j = this.clampI(this.toI(z));
    return this.slope[j * this.n + i];
  }

  /** A* on walkable, reachable cells. Snaps the goal to the nearest driveable cell. */
  findPath(ax: number, az: number, bx: number, bz: number): NavPoint[] | null {
    const n = this.n;
    let si = this.clampI(this.toI(ax));
    let sj = this.clampI(this.toI(az));
    let gi = this.clampI(this.toI(bx));
    let gj = this.clampI(this.toI(bz));
    const goal = this.nearestDriveable(gi, gj);
    if (!goal) return null;
    gi = goal.i;
    gj = goal.j;
    if (si === gi && sj === gj) return [{ x: bx, z: bz }];

    const inf = 1e12;
    const gScore = new Float32Array(n * n);
    gScore.fill(inf);
    const came = new Int32Array(n * n);
    came.fill(-1);
    const inOpen = new Uint8Array(n * n);
    const open: number[] = [];
    const start = sj * n + si;
    const end = gj * n + gi;
    gScore[start] = 0;
    open.push(start);
    inOpen[start] = 1;

    const heur = (k: number): number => {
      const i = k % n;
      const j = (k / n) | 0;
      return Math.hypot(i - gi, j - gj);
    };

    const passable = (k: number): boolean => {
      if (k === start) return true;
      return this.walk[k] === 1 && this.reach[k] === 1;
    };

    while (open.length) {
      let best = 0;
      let bestF = gScore[open[0]] + heur(open[0]);
      for (let o = 1; o < open.length; o++) {
        const f = gScore[open[o]] + heur(open[o]);
        if (f < bestF) {
          bestF = f;
          best = o;
        }
      }
      const cur = open[best];
      inOpen[cur] = 0;
      open[best] = open[open.length - 1];
      open.pop();
      if (cur === end) break;
      const ci = cur % n;
      const cj = (cur / n) | 0;
      for (const [di, dj, dist] of N8) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (!passable(nk)) continue;
        const step = dist * (1 + this.slope[nk] * 1.4);
        const tentative = gScore[cur] + step;
        if (tentative < gScore[nk]) {
          came[nk] = cur;
          gScore[nk] = tentative;
          if (!inOpen[nk]) {
            open.push(nk);
            inOpen[nk] = 1;
          }
        }
      }
    }

    if (gScore[end] >= inf) return null;
    const cells: Array<{ i: number; j: number }> = [];
    let k = end;
    while (k >= 0) {
      cells.push({ i: k % n, j: (k / n) | 0 });
      k = came[k];
    }
    cells.reverse();
    const pulled = this.stringPull(cells);
    const path = pulled.map((c) => this.center(c.i, c.j));
    // Keep the exact click if it is driveable; otherwise stay on the snapped cell.
    if (this.canDrive(bx, bz)) path[path.length - 1] = { x: bx, z: bz };
    return path;
  }

  pathLength(ax: number, az: number, bx: number, bz: number): number {
    const path = this.findPath(ax, az, bx, bz);
    if (!path || path.length === 0) return Infinity;
    let d = Math.hypot(path[0].x - ax, path[0].z - az);
    for (let i = 1; i < path.length; i++) {
      d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    }
    return d;
  }

  stats(): { walkable: number; blocked: number; reachable: number } {
    let walkable = 0;
    let blocked = 0;
    let reachable = 0;
    for (let k = 0; k < this.walk.length; k++) {
      if (this.walk[k]) walkable++;
      else blocked++;
      if (this.reach[k]) reachable++;
    }
    return { walkable, blocked, reachable };
  }

  private floodPad(): void {
    const n = this.n;
    const si = this.clampI(this.toI(0));
    const sj = this.clampI(this.toI(0));
    const q = [sj * n + si];
    this.reach[sj * n + si] = 1;
    for (let head = 0; head < q.length; head++) {
      const cur = q[head];
      const ci = cur % n;
      const cj = (cur / n) | 0;
      for (const [di, dj] of N8) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (this.reach[nk] || this.walk[nk] === 0) continue;
        this.reach[nk] = 1;
        q.push(nk);
      }
    }
  }

  private nearestDriveable(i: number, j: number): { i: number; j: number } | null {
    const n = this.n;
    if (this.ok(i, j)) return { i, j };
    for (let r = 1; r <= 12; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ni = i + di;
          const nj = j + dj;
          if (this.ok(ni, nj)) return { i: ni, j: nj };
        }
      }
    }
    return null;
  }

  private ok(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return false;
    const k = j * this.n + i;
    return this.walk[k] === 1 && this.reach[k] === 1;
  }

  private stringPull(cells: Array<{ i: number; j: number }>): Array<{ i: number; j: number }> {
    if (cells.length <= 2) return cells;
    const out = [cells[0]];
    let a = 0;
    while (a < cells.length - 1) {
      let best = a + 1;
      for (let b = cells.length - 1; b > a + 1; b--) {
        if (this.lineClear(cells[a], cells[b])) {
          best = b;
          break;
        }
      }
      out.push(cells[best]);
      a = best;
    }
    return out;
  }

  private lineClear(a: { i: number; j: number }, b: { i: number; j: number }): boolean {
    let i = a.i;
    let j = a.j;
    const di = Math.sign(b.i - a.i);
    const dj = Math.sign(b.j - a.j);
    const ni = Math.abs(b.i - a.i);
    const nj = Math.abs(b.j - a.j);
    let err = ni - nj;
    while (i !== b.i || j !== b.j) {
      if (!this.ok(i, j)) return false;
      const e2 = 2 * err;
      if (e2 > -nj) {
        err -= nj;
        i += di;
      }
      if (e2 < ni) {
        err += ni;
        j += dj;
      }
    }
    return this.ok(b.i, b.j);
  }

  private atH(h: Float32Array, i: number, j: number): number {
    i = this.clampI(i);
    j = this.clampI(j);
    return h[j * this.n + i];
  }

  private toI(v: number): number {
    return Math.floor((v - this.origin) / this.cell);
  }

  private clampI(i: number): number {
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  private center(i: number, j: number): NavPoint {
    return {
      x: this.origin + (i + 0.5) * this.cell,
      z: this.origin + (j + 0.5) * this.cell,
    };
  }
}
