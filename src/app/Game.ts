import * as THREE from 'three';
import { Simulation } from '../sim/Simulation';
import { GameRenderer } from '../render/Renderer';
import { CameraRig } from './CameraRig';
import { HUD } from '../ui/HUD';
import type { BuildingKind } from '../sim/defs';
import { BUILDINGS, ROVERS } from '../sim/defs';
import { SPEEDS, AUTOSAVE_INTERVAL_S } from '../sim/config';

const SAVE_KEY = 'red-frontier-autosave';
const TAP_TRAVEL = 8; // px before a press becomes a camera drag
const DRAG_START = 5; // px before a press counts as a drag at all

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface ActivePointer {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  travel: number;
  t0: number;
  button: number;
  dragging: boolean;
}

type Selection = { type: 'rover'; id: number } | { type: 'building'; id: number } | null;

export class Game {
  sim: Simulation | null = null;
  renderer: GameRenderer | null = null;
  rig: CameraRig | null = null;
  hud: HUD;

  private seed = 0;
  private selected: Selection = null;
  private pendingBuild: BuildingKind | null = null;
  private mouse = { x: -1, y: -1, in: false };
  private pointers = new Map<number, ActivePointer>();
  private pointerCount = 0;
  private pinchLast = 0;
  private midLastX = 0;
  private midLastY = 0;
  private lastAuto = 0;
  private lastInspector = 0;
  private started = false;
  private shiftHeld = false;

  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.hud = new HUD({
      onSpeed: (i) => {
        /* handled by HUD itself */
      },
      onPickBuild: (k) => this.setPendingBuild(k),
      onAction: (a) => this.handleAction(a),
      onStart: (seedText, near) => this.begin(seedText, near),
    });
    this.attachInput();
    window.addEventListener('resize', () => this.resize());

    const resume = localStorage.getItem(SAVE_KEY);
    if (resume) {
      const holder = document.querySelector('#start-overlay .actions');
      if (holder) {
        const btn = document.createElement('button');
        btn.className = 'btn primary';
        btn.textContent = '▶ Resume last auto-save';
        btn.addEventListener('pointerdown', () => this.resume());
        holder.appendChild(btn);
      }
    }

    this.loop(performance.now());
  }

  // ---------- mission start ----------
  private begin(seedText: string, near: number): void {
    this.seed = hashSeed(seedText || 'mars2066');
    const sim = new Simulation({ seed: this.seed, nearDeposits: near });
    this.launch(sim);
    this.hideStart();
    this.hud.addLog('ok', 'Mission start. Two rovers, a landing pad, and a world that doesn’t want you here.');
    this.hud.addLog('info', 'Select a rover, then tap a nearby deposit to mine. Build storage to stockpile more.');
  }

  private resume(): void {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const sim = new Simulation({ seed: data?.seed ?? 1 });
      sim.restore(data);
      this.launch(sim);
      this.hideStart();
      this.hud.addLog('ok', 'Auto-save restored.');
    } catch (e) {
      console.error(e);
      this.hud.addLog('warn', 'Could not restore the auto-save.');
    }
  }

  private hideStart(): void {
    const ov = document.getElementById('start-overlay');
    if (ov) ov.style.display = 'none';
  }

  private launch(sim: Simulation): void {
    this.sim = sim;
    this.selected = null;
    this.pendingBuild = null;
    this.hud.setBuild(null);
    this.lastAuto = performance.now();
    this.renderer = new GameRenderer(this.canvas, sim.world);
    this.rig = new CameraRig(this.renderer.camera);
    this.resize();
    this.hud.updateResources(sim);
    this.syncUI(true);
    this.started = true;
  }

  // ---------- input ----------
  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => this.pointerCancel(e));
    window.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.in = true;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.rig) return;
        e.preventDefault();
        this.rig.dolly(Math.pow(1.13, e.deltaY > 0 ? 1 : -1));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shiftHeld = false;
    });
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.started) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.shiftHeld = e.shiftKey || e.button === 2;
    const p: ActivePointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      travel: 0,
      t0: performance.now(),
      button: e.button,
      dragging: false,
    };
    this.pointers.set(e.pointerId, p);
    this.pointerCount = this.pointers.size;
    if (this.pointerCount === 2) this.resetPinch();
  }

  private resetPinch(): void {
    const arr = [...this.pointers.values()];
    if (arr.length < 2) return;
    this.pinchLast = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    this.midLastX = (arr[0].x + arr[1].x) / 2;
    this.midLastY = (arr[0].y + arr[1].y) / 2;
  }

  private pointerMove(e: PointerEvent): void {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.in = true;
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.started) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.travel += Math.hypot(dx, dy);
    p.x = e.clientX;
    p.y = e.clientY;

    if (!this.rig) return;

    if (this.pointerCount === 1) {
      if (p.travel < DRAG_START) return; // still possibly a tap
      p.dragging = true;
      if (this.shiftHeld) this.rig.panByPixels(dx, dy, window.innerHeight);
      else this.rig.rotateByPixels(dx, dy, window.innerWidth, window.innerHeight);
    } else if (this.pointerCount === 2) {
      const arr = [...this.pointers.values()];
      const a = arr[0];
      const b = arr[1];
      a.dragging = true;
      b.dragging = true;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (this.pinchLast > 0) this.rig.dolly(this.pinchLast / Math.max(1, dist));
      this.rig.panByPixels(midX - this.midLastX, midY - this.midLastY, window.innerHeight);
      this.pinchLast = dist;
      this.midLastX = midX;
      this.midLastY = midY;
    }
  }

  private pointerUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.pointerCount = this.pointers.size;
    const dur = performance.now() - p.t0;
    const isTap = !p.dragging && p.travel < TAP_TRAVEL && dur < 500;
    if (isTap && this.started) {
      if (e.button === 2) this.contextTap(e.clientX, e.clientY);
      else this.primaryTap(e.clientX, e.clientY);
    }
    if (this.pointerCount === 2) this.resetPinch();
    if (e.button === 2) this.shiftHeld = false;
  }

  private pointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pointerCount = this.pointers.size;
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key === 'Shift') this.shiftHeld = true;
    if (!this.started) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.save();
      return;
    }
    if (e.key === 'Escape') {
      if (this.pendingBuild) this.setPendingBuild(null);
      else this.selected = null;
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const next = this.hud.speedIdx === 0 ? 1 : 0;
      this.hud.setSpeed(next);
      return;
    }
    const kinds: BuildingKind[] = ['warehouse', 'solar', 'battery', 'workshop', 'habitat'];
    const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (idx >= 0) {
      this.setPendingBuild(this.pendingBuild === kinds[idx] ? null : kinds[idx]);
    }
  }

  private contextTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.pendingBuild) {
      this.setPendingBuild(null);
      return;
    }
    if (this.selected?.type === 'rover') {
      const pt = this.renderer.raycastTerrain(x, y);
      if (pt) this.sim.issueMove(this.selected.id, pt.x, pt.z);
    }
  }

  private primaryTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.pendingBuild) {
      this.placeBuild(x, y);
      return;
    }
    const pick = this.renderer.pickTargetAt(x, y);
    if (pick) {
      if (pick.type === 'rover') {
        this.selected = { type: 'rover', id: pick.id };
      } else if (pick.type === 'building') {
        this.selected = { type: 'building', id: pick.id };
      } else if (pick.type === 'deposit') {
        if (this.selected?.type === 'rover') {
          this.sim.issueMine(this.selected.id, pick.id);
        } else {
          this.hud.addLog('info', 'Select a rover first, then tap a deposit to mine it.');
        }
      }
      this.syncUI(true);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.sim.issueMove(this.selected.id, pt.x, pt.z);
    }
  }

  private setPendingBuild(kind: BuildingKind | null): void {
    this.pendingBuild = kind;
    this.hud.setBuild(kind);
    if (!kind) this.renderer?.showGhost(null, 0, 0, false);
    this.syncUI(true);
  }

  private placeBuild(x: number, y: number): void {
    if (!this.renderer || !this.sim || !this.pendingBuild) return;
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    const b = this.sim.placeBuilding(this.pendingBuild, pt.x, pt.z);
    if (b) {
      this.selected = { type: 'building', id: b.id };
    } else {
      this.hud.addLog('warn', 'Cannot build here.');
    }
  }

  private handleAction(a: string): void {
    if (!this.selected) return;
    if (a === 'stop' && this.selected.type === 'rover' && this.sim) {
      this.sim.stopRover(this.selected.id);
    } else if (a === 'recenter') {
      this.centerOnSelected();
    }
  }

  private centerOnSelected(): void {
    if (!this.rig || !this.selected || !this.sim) return;
    const e =
      this.selected.type === 'rover'
        ? this.sim.roverById(this.selected.id)
        : this.sim.buildingById(this.selected.id);
    if (e) this.rig.target.set(e.x, 4, e.z);
  }

  private save(): void {
    if (!this.sim) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.sim.snapshot()));
      this.hud.flashSave('Saved to browser (Ctrl+S anytime)');
    } catch {
      this.hud.flashSave('Save failed');
    }
  }

  // ---------- per-frame ----------
  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer?.resize(w, h);
  }

  private loop(nowMs: number): void {
    requestAnimationFrame((t) => this.loop(t));
    if (!this.started || !this.renderer || !this.sim || !this.rig) return;
    const t = nowMs / 1000;
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    const speed = SPEEDS[this.hud.speedIdx];
    if (speed > 0) this.sim.step(dt * speed);

    const events = this.sim.drainEvents();
    for (const ev of events) this.hud.addLog(ev.severity, ev.text);

    this.renderer.sync(this.sim);
    this.rig.update();

    if (nowMs - this.lastAuto > AUTOSAVE_INTERVAL_S * 1000) {
      this.lastAuto = nowMs;
      this.save();
    }

    this.updateGhost();
    this.updateSelectionVisual();
    this.syncUI(false);
    this.renderer.render();
  }

  private lastT = 0;

  private updateGhost(): void {
    if (!this.renderer || !this.sim) return;
    if (!this.pendingBuild || !this.mouse.in) {
      this.renderer.showGhost(null, 0, 0, false);
      return;
    }
    const pt = this.renderer.raycastTerrain(this.mouse.x, this.mouse.y);
    if (!pt) {
      this.renderer.showGhost(null, 0, 0, false);
      return;
    }
    const valid = this.sim.canPlace(this.pendingBuild, pt.x, pt.z) === null;
    this.renderer.showGhost(this.pendingBuild, pt.x, pt.z, valid);
  }

  private updateSelectionVisual(): void {
    if (!this.renderer || !this.sim) return;
    if (!this.selected) {
      this.renderer.setSelection(null);
      return;
    }
    if (this.selected.type === 'rover') {
      const rv = this.sim.roverById(this.selected.id);
      if (!rv) {
        this.selected = null;
        this.renderer.setSelection(null);
        return;
      }
      this.renderer.setSelection({ x: rv.x, z: rv.z, radius: ROVERS[rv.kind].radius });
    } else {
      const b = this.sim.buildingById(this.selected.id);
      if (!b) {
        this.selected = null;
        this.renderer.setSelection(null);
        return;
      }
      this.renderer.setSelection({ x: b.x, z: b.z, radius: BUILDINGS[b.kind].radius });
    }
  }

  private syncUI(force: boolean): void {
    if (!this.sim) return;
    const now = performance.now();
    if (!force && now - this.lastInspector < 180) return;
    this.lastInspector = now;
    this.hud.updateResources(this.sim);

    if (this.selected) {
      if (this.selected.type === 'rover') {
        const r = this.sim.roverById(this.selected.id);
        if (r) this.hud.showRover(r, this.sim);
      } else {
        const b = this.sim.buildingById(this.selected.id);
        if (b) this.hud.showBuilding(b, this.sim);
      }
    } else if (!force || this.selected === null) {
      this.hud.clearInspector();
    }
    if (this.pendingBuild) {
      const def = BUILDINGS[this.pendingBuild];
      this.hud.hint(`Placing ${def.label} — click terrain to build, right-click or Esc to cancel.`);
    } else if (force) {
      this.hud.hint(null);
    }
  }
}
