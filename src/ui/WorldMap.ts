/**
 * Minimap + World Map — the planet overview.
 *
 * Two canvases share one renderer:
 * - the minimap: small, always visible, fitted to the whole claim
 * - the world map: large overlay, zoomable/pannable, same markers
 *
 * Both read from SimView and never mutate it. All markers use world (x,z)
 * coordinates, so they stay correct at every map size (small/medium/large/
 * huge). The world map's transform is independent of CameraRig — closing it
 * never moves the game camera.
 */

import type { SimView } from '../sim/host';
import { BUILDINGS, RESOURCES, ALL_RESOURCES } from '../sim/defs';
import type { BuildingKind } from '../sim/defs';
import { POI_KINDS } from '../sim/pois';
import type { Rover } from '../sim/Simulation';

// ------------------------------------------------------------------ types --

export interface MapTransform {
  /** pixels per world metre */
  scale: number;
  /** canvas pixel where world (0,0) lands */
  offsetX: number;
  offsetY: number;
}

export interface WorldMapCallbacks {
  onSelect?: (type: 'rover' | 'building' | 'colonist' | 'poi', id: number) => void;
  onFocus?: (x: number, z: number) => void;
  onClose?: () => void;
}

// ---------------------------------------------------------------- colors --

const BG = '#1a1210';
const BG_GRID = 'rgba(255,255,255,0.04)';
const BG_GRID_STRONG = 'rgba(255,255,255,0.07)';
const BOUNDS = 'rgba(224,123,58,0.35)';
const CAMERA = 'rgba(111,211,255,0.9)';

const BUILDING_COLOR: Record<string, string> = {
  habitat: '#e8dcc6',
  solar: '#ffd479',
  battery: '#7fb46a',
  warehouse: '#a39278',
  workshop: '#d9a23a',
  extractor: '#4aa3e0',
  oxygenator: '#7fd9c8',
  greenhouse: '#7fb46a',
  garage: '#e07b3a',
  rtg: '#d9553f',
};

const ROVER_COLOR: Record<string, string> = {
  utility: '#6fd3ff',
  mining: '#d9a23a',
  cargo: '#e07b3a',
};

// ---------------------------------------------------------------- helpers --

export function worldToCanvas(
  x: number,
  z: number,
  tr: MapTransform,
  _canvasW: number,
  _canvasH: number,
): { x: number; y: number } {
  return {
    x: tr.offsetX + x * tr.scale,
    y: tr.offsetY - z * tr.scale, // world +Z is north, canvas +Y is down
  };
}

export function canvasToWorld(
  cx: number,
  cy: number,
  tr: MapTransform,
): { x: number; z: number } {
  return {
    x: (cx - tr.offsetX) / tr.scale,
    z: (tr.offsetY - cy) / tr.scale,
  };
}

export function fitTransform(
  canvasW: number,
  canvasH: number,
  worldHalf: number,
  padding = 0.12,
): MapTransform {
  const worldSize = worldHalf * 2;
  const availW = canvasW * (1 - padding * 2);
  const availH = canvasH * (1 - padding * 2);
  const scale = Math.min(availW / worldSize, availH / worldSize);
  return {
    scale,
    offsetX: canvasW / 2,
    offsetY: canvasH / 2,
  };
}

// ---------------------------------------------------------------- renderer --

export class MapRenderer {
  /** Draw the whole world into a 2D canvas context. */
  static render(
    ctx: CanvasRenderingContext2D,
    canvasW: number,
    canvasH: number,
    view: SimView,
    tr: MapTransform,
    opts: {
      showGrid?: boolean;
      showDeposits?: boolean;
      showCamera?: { x: number; z: number } | null;
      highlightId?: { type: string; id: number } | null;
      time?: number;
    } = {},
  ): void {
    const { showGrid = true, showDeposits = true, showCamera = null, highlightId = null } = opts;

    // clear
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // grid
    if (showGrid) {
      const worldHalf = view.world.half;
      const step = worldHalf > 800 ? 200 : worldHalf > 400 ? 100 : 50;
      ctx.strokeStyle = BG_GRID;
      ctx.lineWidth = 1;
      // vertical lines (x)
      for (let wx = -worldHalf; wx <= worldHalf; wx += step) {
        const a = worldToCanvas(wx, -worldHalf, tr, canvasW, canvasH);
        const b = worldToCanvas(wx, worldHalf, tr, canvasW, canvasH);
        const isStrong = wx % (step * 2) === 0;
        ctx.strokeStyle = isStrong ? BG_GRID_STRONG : BG_GRID;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // horizontal (z)
      for (let wz = -worldHalf; wz <= worldHalf; wz += step) {
        const a = worldToCanvas(-worldHalf, wz, tr, canvasW, canvasH);
        const b = worldToCanvas(worldHalf, wz, tr, canvasW, canvasH);
        const isStrong = wz % (step * 2) === 0;
        ctx.strokeStyle = isStrong ? BG_GRID_STRONG : BG_GRID;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // world bounds
    {
      const tl = worldToCanvas(-view.world.half, view.world.half, tr, canvasW, canvasH);
      const br = worldToCanvas(view.world.half, -view.world.half, tr, canvasW, canvasH);
      ctx.strokeStyle = BOUNDS;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);
    }

    // spawn / landing pad area
    {
      const c = worldToCanvas(0, 0, tr, canvasW, canvasH);
      const r = 26 * tr.scale; // SPAWN_RADIUS
      if (r > 2) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // deposits
    if (showDeposits) {
      for (const d of view.world.deposits) {
        if (d.amount <= 0.5) continue;
        const p = worldToCanvas(d.x, d.z, tr, canvasW, canvasH);
        if (p.x < -20 || p.x > canvasW + 20 || p.y < -20 || p.y > canvasH + 20) continue;
        const col = RESOURCES[d.resource]?.color ?? 0x888888;
        const hex = `#${col.toString(16).padStart(6, '0')}`;
        const rad = Math.max(1.5, Math.min(6, (d.radius * tr.scale) * 0.15 + 1.5));
        ctx.fillStyle = hex;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // POIs
    for (const poi of view.world.pois) {
      const p = worldToCanvas(poi.x, poi.z, tr, canvasW, canvasH);
      if (p.x < -30 || p.x > canvasW + 30 || p.y < -30 || p.y > canvasH + 30) continue;
      const isBuried = (poi as any).buried;
      const isClean = poi.salvage ? Object.values(poi.salvage as any).every((v: any) => (v ?? 0) <= 0.5) && (poi.energyKWh ?? 0) <= 0.5 : false;
      if (isBuried || isClean) {
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, 3 * tr.scale * 0.1), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const isDrop = poi.kind === 'supplyDrop';
      const pulse = opts.time ? 0.7 + 0.3 * Math.sin(opts.time * 0.002) : 1;
      const baseR = isDrop ? 5 : 4;
      const r = baseR * (tr.scale > 0.5 ? 1 : 0.7) * pulse;

      // ground pulse ring
      ctx.strokeStyle = isDrop ? 'rgba(111,211,255,0.5)' : 'rgba(224,123,58,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();

      // core
      ctx.fillStyle = isDrop ? '#6fd3ff' : '#e07b3a';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      // highlight if selected
      if (highlightId?.type === 'poi' && highlightId.id === poi.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // buildings
    for (const b of view.buildings) {
      const p = worldToCanvas(b.x, b.z, tr, canvasW, canvasH);
      if (p.x < -30 || p.x > canvasW + 30 || p.y < -30 || p.y > canvasH + 30) continue;
      const col = BUILDING_COLOR[b.kind] ?? '#e8dcc6';
      const size = Math.max(3, Math.min(12, (BUILDINGS[b.kind as BuildingKind]?.radius ?? 6) * tr.scale * 0.35));
      const isDamaged = (b as any).damaged;
      ctx.fillStyle = col;
      if (isDamaged) ctx.globalAlpha = 0.6;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.globalAlpha = 1;
      if (isDamaged) {
        ctx.strokeStyle = '#d9553f';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(p.x - size / 2 - 1, p.y - size / 2 - 1, size + 2, size + 2);
      }
      if (highlightId?.type === 'building' && highlightId.id === b.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - size / 2 - 2, p.y - size / 2 - 2, size + 4, size + 4);
      }
    }

    // rovers
    for (const r of view.rovers) {
      const p = worldToCanvas(r.x, r.z, tr, canvasW, canvasH);
      if (p.x < -20 || p.x > canvasW + 20 || p.y < -20 || p.y > canvasH + 20) continue;
      const col = ROVER_COLOR[r.kind] ?? '#e8dcc6';
      const rad = Math.max(3, Math.min(10, 3.5 * (tr.scale > 0.4 ? 1 : 0.6) + tr.scale * 0.3));
      const isDisabled = (r as any).phase === 'disabled';
      ctx.fillStyle = isDisabled ? '#d9553f' : col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fill();
      // heading line
      if (!isDisabled && tr.scale > 0.15) {
        const heading = (r as any).heading ?? 0;
        ctx.strokeStyle = isDisabled ? '#d9553f' : col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.sin(heading) * (rad + 4), p.y - Math.cos(heading) * (rad + 4));
        ctx.stroke();
      }
      if (highlightId?.type === 'rover' && highlightId.id === r.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // colonist
    {
      const c = view.colonist;
      const p = worldToCanvas(c.x, c.z, tr, canvasW, canvasH);
      if (!(p.x < -20 || p.x > canvasW + 20 || p.y < -20 || p.y > canvasH + 20)) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(3, 4 * (tr.scale > 0.4 ? 1 : 0.7)), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        if (highlightId?.type === 'colonist' && highlightId.id === c.id) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // camera target crosshair
    if (showCamera) {
      const p = worldToCanvas(showCamera.x, showCamera.z, tr, canvasW, canvasH);
      if (!(p.x < -30 || p.x > canvasW + 30 || p.y < -30 || p.y > canvasH + 30)) {
        ctx.strokeStyle = CAMERA;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x - 10, p.y);
        ctx.lineTo(p.x + 10, p.y);
        ctx.moveTo(p.x, p.y - 10);
        ctx.lineTo(p.x, p.y + 10);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(p.x - 12, p.y - 12, 24, 24);
      }
    }
  }

  /** Find nearest entity to a canvas point, within pixel threshold. */
  static pick(
    cx: number,
    cy: number,
    view: SimView,
    tr: MapTransform,
    canvasW: number,
    canvasH: number,
    thresholdPx = 12,
  ): { type: 'rover' | 'building' | 'colonist' | 'poi'; id: number; dist: number } | null {
    let best: { type: any; id: number; dist: number } | null = null;
    const consider = (x: number, z: number, type: any, id: number) => {
      const p = worldToCanvas(x, z, tr, canvasW, canvasH);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d <= thresholdPx && (!best || d < best.dist)) best = { type, id, dist: d };
    };
    for (const r of view.rovers) consider(r.x, r.z, 'rover', r.id);
    for (const b of view.buildings) consider(b.x, b.z, 'building', b.id);
    consider(view.colonist.x, view.colonist.z, 'colonist', view.colonist.id);
    for (const poi of view.world.pois) {
      const buried = (poi as any).buried;
      if (buried) continue;
      consider(poi.x, poi.z, 'poi', poi.id);
    }
    return best;
  }
}

// -------------------------------------------------------------- overlay --

export class WorldMapOverlay {
  private root: HTMLElement;
  private card: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private coordsEl: HTMLElement;
  private view: SimView | null = null;
  private camera: { x: number; z: number } | null = null;
  private selected: { type: string; id: number } | null = null;
  private tr: MapTransform = { scale: 0.2, offsetX: 0, offsetY: 0 };
  private isOpen = false;
  private callbacks: WorldMapCallbacks;
  private animId: number | null = null;

  // pan state
  private panning = false;
  private panStart = { x: 0, y: 0 };
  private panOrig = { offsetX: 0, offsetY: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;

  constructor(cb: WorldMapCallbacks = {}) {
    this.callbacks = cb;

    const overlay = document.createElement('div');
    overlay.className = 'worldmap-overlay';
    overlay.id = 'worldmap-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="worldmap-card" id="worldmap-card">
        <div class="worldmap-head hud-drag">
          <span class="wm-title">🗺 World Map</span>
          <span class="wm-coords" id="wm-coords">—</span>
          <span class="i-spacer"></span>
          <button class="mini-btn" id="wm-fit" title="Fit to world (0)">⛶</button>
          <button class="mini-btn" id="wm-reset" title="Reset view">↺</button>
          <button class="mini-btn" id="wm-close" title="Close (Esc)">×</button>
        </div>
        <div class="worldmap-body">
          <canvas class="worldmap-canvas" id="worldmap-canvas"></canvas>
          <div class="worldmap-controls">
            <button class="btn wm-zoom" id="wm-zoomin" title="Zoom in (+)">＋</button>
            <button class="btn wm-zoom" id="wm-zoomout" title="Zoom out (−)">−</button>
          </div>
          <div class="worldmap-legend" id="worldmap-legend">
            <span class="wm-leg"><i style="background:#6fd3ff"></i>Rover</span>
            <span class="wm-leg"><i style="background:#ffd479"></i>Building</span>
            <span class="wm-leg"><i style="background:#e07b3a"></i>POI</span>
            <span class="wm-leg"><i style="background:#4aa3e0"></i>Deposit</span>
            <span class="wm-leg"><i style="background:#fff"></i>Colonist</span>
            <span class="wm-leg"><i style="border:1px dashed #e07b3a"></i>Bounds</span>
          </div>
          <div class="worldmap-hint">Drag to pan · Wheel/pinch to zoom · Click entity to select · Esc to close</div>
        </div>
      </div>
    `;
    document.getElementById('app')!.appendChild(overlay);
    this.root = overlay;
    this.card = overlay.querySelector('#worldmap-card') as HTMLElement;
    this.canvas = overlay.querySelector('#worldmap-canvas') as HTMLCanvasElement;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('worldmap canvas 2d context missing');
    this.ctx = ctx;
    this.coordsEl = overlay.querySelector('#wm-coords') as HTMLElement;

    // buttons
    overlay.querySelector('#wm-close')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.close();
    });
    overlay.querySelector('#wm-fit')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.fit();
    });
    overlay.querySelector('#wm-reset')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.fit();
    });
    overlay.querySelector('#wm-zoomin')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 1.35);
    });
    overlay.querySelector('#wm-zoomout')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 1 / 1.35);
    });

    // canvas interaction — pan & zoom, no leak to game
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // overlay background click closes? No — only X / Esc, to avoid accidental close while panning

    // keyboard
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (e.key === '+' || e.key === '=' ) {
        this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 1.25);
      } else if (e.key === '-' || e.key === '_') {
        this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 0.8);
      } else if (e.key === '0') {
        this.fit();
      }
    });

    window.addEventListener('resize', () => {
      if (this.isOpen) this.resize();
    });
  }

  setView(view: SimView, camera: { x: number; z: number } | null, selected: { type: string; id: number } | null): void {
    this.view = view;
    this.camera = camera;
    this.selected = selected;
    if (this.isOpen) this.render();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.style.display = 'flex';
    this.resize();
    this.fit();
    this.render();
    this.startLoop();
    // focus trap: prevent game hotkeys leaking
    this.card.focus?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.style.display = 'none';
    this.stopLoop();
    this.callbacks.onClose?.();
  }

  isVisible(): boolean {
    return this.isOpen;
  }

  private resize(): void {
    const rect = this.card.getBoundingClientRect();
    // canvas fills card minus header
    const body = this.root.querySelector('.worldmap-body') as HTMLElement;
    const bw = body.clientWidth;
    const bh = body.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(200, bw) * dpr;
    this.canvas.height = Math.max(200, bh - 28) * dpr;
    this.canvas.style.width = `${Math.max(200, bw)}px`;
    this.canvas.style.height = `${Math.max(200, bh - 28)}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // keep transform centered if it was zero
    if (this.tr.scale < 0.001) this.fit();
    this.render();
  }

  fit(): void {
    if (!this.view) return;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.tr = fitTransform(w, h, this.view.world.half, 0.12);
    this.render();
  }

  private zoomAt(cx: number, cy: number, factor: number): void {
    const newScale = Math.max(0.02, Math.min(8, this.tr.scale * factor));
    if (newScale === this.tr.scale) return;
    // keep world point under cx,cy stable
    const wx = (cx - this.tr.offsetX) / this.tr.scale;
    const wz = (this.tr.offsetY - cy) / this.tr.scale;
    this.tr.scale = newScale;
    this.tr.offsetX = cx - wx * newScale;
    this.tr.offsetY = cy + wz * newScale;
    this.render();
  }

  // ---------------------------------------------------------- input --

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.panning = true;
      this.panStart = { x: e.clientX, y: e.clientY };
      this.panOrig = { offsetX: this.tr.offsetX, offsetY: this.tr.offsetY };
    } else if (this.pointers.size === 2) {
      // pinch start
      const pts = [...this.pointers.values()];
      this.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.panning = false;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    e.stopPropagation();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1 && this.panning) {
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      // if moved a bit, it's a pan not a click
      if (Math.hypot(dx, dy) > 3) {
        this.tr.offsetX = this.panOrig.offsetX + dx;
        this.tr.offsetY = this.panOrig.offsetY + dy;
        this.render();
      }
      // update coords display
      this.updateCoords(e);
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.lastPinchDist > 0) {
        const factor = dist / this.lastPinchDist;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        // convert client to canvas local
        const rect = this.canvas.getBoundingClientRect();
        const cx = midX - rect.left;
        const cy = midY - rect.top;
        this.zoomAt(cx, cy, factor);
      }
      this.lastPinchDist = dist;
    } else {
      this.updateCoords(e);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const wasPanning = this.panning;
    const startDist = Math.hypot(this.panStart.x - e.clientX, this.panStart.y - e.clientY);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.panning = false;
      this.lastPinchDist = 0;
      // if barely moved, treat as click/pick
      if (startDist < 6 && !wasPanning) {
        this.handlePick(e);
      } else if (startDist < 6) {
        // tiny pan that was actually a click
        this.handlePick(e);
      }
    } else if (this.pointers.size === 1) {
      // back to single pan
      const remaining = [...this.pointers.values()][0];
      this.panning = true;
      this.panStart = { x: remaining.x, y: remaining.y };
      this.panOrig = { offsetX: this.tr.offsetX, offsetY: this.tr.offsetY };
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.isOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.pow(1.12, e.deltaY > 0 ? -1 : 1);
    this.zoomAt(cx, cy, factor);
  }

  private updateCoords(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const w = canvasToWorld(cx, cy, this.tr);
    this.coordsEl.textContent = `${Math.round(w.x)}, ${Math.round(w.z)}`;
  }

  private handlePick(e: PointerEvent): void {
    if (!this.view) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const picked = MapRenderer.pick(cx, cy, this.view, this.tr, rect.width, rect.height, 14);
    if (picked) {
      this.callbacks.onSelect?.(picked.type, picked.id);
      this.selected = { type: picked.type, id: picked.id };
      this.render();
    } else {
      // click empty -> focus world? optional
      const w = canvasToWorld(cx, cy, this.tr);
      this.callbacks.onFocus?.(w.x, w.z);
    }
  }

  // ---------------------------------------------------------- render loop --

  private startLoop(): void {
    const loop = (t: number) => {
      if (!this.isOpen) return;
      this.render(t);
      this.animId = window.requestAnimationFrame(loop) as unknown as number;
    };
    this.animId = window.requestAnimationFrame(loop) as unknown as number;
  }

  private stopLoop(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  private render(time = 0): void {
    if (!this.view) return;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    MapRenderer.render(this.ctx, w, h, this.view, this.tr, {
      showGrid: true,
      showDeposits: true,
      showCamera: this.camera,
      highlightId: this.selected as any,
      time,
    });
  }
}
