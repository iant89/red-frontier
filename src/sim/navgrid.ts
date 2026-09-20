/**
 * Drive / place map for the playable window.
 *
 * Built once after terrain gen. A cell is a cliff when the drop to a neighbour
 * is a rim wall; gentler slopes (notches, valley floors, degraded rims) stay
 * open so a rover can drive down. Reachability is flooded from the pad so a
 * bowl with no path in is not a legal destination.
 */

import { WORLD_HALF, SPAWN_RADIUS } from './config';
import { getProfiler } from './debug/Profiler';

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

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Reusable pathfinding workspace with generation stamping and indexed binary min-heap.
 * Eliminates per-search typed array allocations and replaces O(N) open scans with O(log N) heap operations.
 */
export class NavWorkspace {
  readonly capacity: number;
  readonly gScore: Float32Array;
  readonly came: Int32Array;
  readonly heapNodes: Int32Array;
  readonly heapF: Float32Array;
  readonly heapPos: Int32Array;
  readonly gStamp: Uint32Array;
  readonly inOpenStamp: Uint32Array;
  heapSize = 0;
  stamp = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.gScore = new Float32Array(capacity);
    this.came = new Int32Array(capacity);
    this.heapNodes = new Int32Array(capacity);
    this.heapF = new Float32Array(capacity);
    this.heapPos = new Int32Array(capacity);
    this.gStamp = new Uint32Array(capacity);
    this.inOpenStamp = new Uint32Array(capacity);
  }

  nextSearch(): number {
    this.stamp++;
    if (this.stamp === 0xffffffff) {
      this.gStamp.fill(0);
      this.inOpenStamp.fill(0);
      this.stamp = 1;
    }
    this.heapSize = 0;
    return this.stamp;
  }

  push(node: number, f: number, stamp: number): void {
    let i = this.heapSize++;
    this.heapNodes[i] = node;
    this.heapF[i] = f;
    this.heapPos[node] = i;
    this.inOpenStamp[node] = stamp;
    this.bubbleUp(i);
  }

  decreaseKey(node: number, newF: number): void {
    const i = this.heapPos[node];
    this.heapF[i] = newF;
    this.bubbleUp(i);
  }

  pop(): number {
    if (this.heapSize === 0) return -1;
    const top = this.heapNodes[0];
    this.inOpenStamp[top] = 0;
    this.heapSize--;
    if (this.heapSize > 0) {
      const last = this.heapNodes[this.heapSize];
      this.heapNodes[0] = last;
      this.heapF[0] = this.heapF[this.heapSize];
      this.heapPos[last] = 0;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    const node = this.heapNodes[i];
    const f = this.heapF[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (f >= this.heapF[parent]) break;
      const pNode = this.heapNodes[parent];
      this.heapNodes[i] = pNode;
      this.heapF[i] = this.heapF[parent];
      this.heapPos[pNode] = i;
      i = parent;
    }
    this.heapNodes[i] = node;
    this.heapF[i] = f;
    this.heapPos[node] = i;
  }

  private bubbleDown(i: number): void {
    const node = this.heapNodes[i];
    const f = this.heapF[i];
    const half = this.heapSize >> 1;
    while (i < half) {
      let left = (i << 1) + 1;
      const right = left + 1;
      let bestChild = left;
      let bestF = this.heapF[left];
      if (right < this.heapSize && this.heapF[right] < bestF) {
        bestChild = right;
        bestF = this.heapF[right];
      }
      if (f <= bestF) break;
      const bestNode = this.heapNodes[bestChild];
      this.heapNodes[i] = bestNode;
      this.heapF[i] = bestF;
      this.heapPos[bestNode] = i;
      i = bestChild;
    }
    this.heapNodes[i] = node;
    this.heapF[i] = f;
    this.heapPos[node] = i;
  }
}

export class NavGrid {
  readonly cell = NAV_CELL;
  readonly n: number;
  private readonly origin: number;
  private readonly walk: Uint8Array;
  private readonly reach: Uint8Array;
  private readonly slope: Float32Array;
  readonly workspace: NavWorkspace;

  constructor(heightAt: (x: number, z: number) => number, worldHalf: number = WORLD_HALF) {
    this.n = Math.round((worldHalf * 2) / this.cell);
    this.origin = -worldHalf;
    const n = this.n;
    const h = new Float32Array(n * n);
    this.walk = new Uint8Array(n * n);
    this.reach = new Uint8Array(n * n);
    this.slope = new Float32Array(n * n);
    this.workspace = new NavWorkspace(n * n);

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
    const t0 = now();
    const n = this.n;
    let si = this.clampI(this.toI(ax));
    let sj = this.clampI(this.toI(az));
    let gi = this.clampI(this.toI(bx));
    let gj = this.clampI(this.toI(bz));
    const goal = this.nearestDriveable(gi, gj);
    if (!goal) {
      getProfiler().recordPathfind(now() - t0, 0, 0, 0);
      return null;
    }
    gi = goal.i;
    gj = goal.j;
    if (si === gi && sj === gj) {
      getProfiler().recordPathfind(now() - t0, 0, 0, 0);
      return [{ x: bx, z: bz }];
    }

    const stamp = this.workspace.nextSearch();
    const start = sj * n + si;
    const end = gj * n + gi;
    this.workspace.gScore[start] = 0;
    this.workspace.gStamp[start] = stamp;
    this.workspace.came[start] = -1;

    const heur = (k: number): number => {
      const i = k % n;
      const j = (k / n) | 0;
      return Math.hypot(i - gi, j - gj);
    };

    const passable = (k: number): boolean => {
      if (k === start) return true;
      return this.walk[k] === 1 && this.reach[k] === 1;
    };

    this.workspace.push(start, heur(start), stamp);

    let nodesExpanded = 0;
    while (this.workspace.heapSize > 0) {
      const cur = this.workspace.pop();
      nodesExpanded++;
      if (cur === end) break;
      const ci = cur % n;
      const cj = (cur / n) | 0;
      const curG = this.workspace.gScore[cur];
      for (const [di, dj, dist] of N8) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (!passable(nk)) continue;
        const step = dist * (1 + this.slope[nk] * 1.4);
        const tentative = curG + step;
        const isVisited = this.workspace.gStamp[nk] === stamp;
        if (!isVisited || tentative < this.workspace.gScore[nk]) {
          this.workspace.came[nk] = cur;
          this.workspace.gScore[nk] = tentative;
          this.workspace.gStamp[nk] = stamp;
          const f = tentative + heur(nk);
          if (this.workspace.inOpenStamp[nk] === stamp) {
            this.workspace.decreaseKey(nk, f);
          } else {
            this.workspace.push(nk, f, stamp);
          }
        }
      }
    }

    if (this.workspace.gStamp[end] !== stamp) {
      getProfiler().recordPathfind(now() - t0, nodesExpanded, 0, 0);
      return null;
    }
    const cells: Array<{ i: number; j: number }> = [];
    let k = end;
    while (k >= 0) {
      cells.push({ i: k % n, j: (k / n) | 0 });
      if (k === start) break;
      k = this.workspace.came[k];
    }
    cells.reverse();
    const pulled = this.stringPull(cells);
    const path = pulled.map((c) => this.center(c.i, c.j));
    // Keep the exact click if it is driveable; otherwise stay on the snapped cell.
    if (this.canDrive(bx, bz)) path[path.length - 1] = { x: bx, z: bz };

    let totalLen = 0;
    for (let i = 1; i < path.length; i++) {
      totalLen += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    }
    getProfiler().recordPathfind(now() - t0, nodesExpanded, totalLen, 0);
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
