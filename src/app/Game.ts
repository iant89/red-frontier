/**
 * Application shell: owns the frame loop, input, and the wiring between the
 * simulation, the renderer and the HUD.
 *
 * The dependency arrows all point one way. The sim knows nothing about this
 * file; the renderer and HUD only read the sim. Everything the player does
 * arrives here as a gesture and leaves as a *command* on the simulation.
 */

import { Simulation } from '../sim/Simulation';
import type { Rover } from '../sim/Simulation';
import { GameRenderer } from '../render/Renderer';
import type { OverlayMode } from '../render/Renderer';
import { CameraRig } from './CameraRig';
import { HUD } from '../ui/HUD';
import type { BuildingKind, RoverKind } from '../sim/defs';
import { BUILDINGS, BUILDING_ORDER, ROVERS } from '../sim/defs';
import { SPEEDS, AUTOSAVE_INTERVAL_S, SAVE_VERSION } from '../sim/config';

const SAVE_KEY = 'red-frontier-save-v4';
const TAP_TRAVEL = 8; // px before a press becomes a camera drag
const DRAG_START = 5; // px before a press counts as a drag at all
const LONG_PRESS_MS = 480;

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

type Selection =
  | { type: 'rover'; id: number }
  | { type: 'building'; id: number }
  | { type: 'colonist'; id: number }
  | null;

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
  private longPressTimer: number | null = null;
  private endShown = false;

  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.hud = new HUD({
      onSpeed: () => {
        /* HUD owns the speed index; the loop reads it */
      },
      onPickBuild: (k) => this.setPendingBuild(k),
      onAction: (a, arg) => this.handleAction(a, arg),
      onStart: (seedText, near) => this.begin(seedText, near),
      onOverlay: (m) => this.renderer?.setOverlay(m),
    });
    this.attachInput();
    window.addEventListener('resize', () => this.resize());

    // Persist on tab hide — TDD §23 asks for saves on visibility transitions.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.started) this.save(true);
    });

    this.offerResume();
    this.loop(performance.now());
  }

  private offerResume(): void {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    let label = '▶ Resume last save';
    try {
      const data = JSON.parse(raw);
      if (data?.clock) label = `▶ Resume — Sol ${(data.clock.sol ?? 0) + 1}`;
    } catch {
      /* a corrupt save still gets a button; restore() will report the problem */
    }
    const holder = document.querySelector('#start-overlay .actions');
    if (!holder) return;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = label;
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.resume();
    });
    holder.appendChild(btn);
  }

  // ------------------------------------------------------ mission start ----
  private begin(seedText: string, near: number): void {
    this.seed = hashSeed(seedText || 'mars2066');
    this.launch(new Simulation({ seed: this.seed, nearDeposits: near }));
    this.hud.addLog(
      'ok',
      'Descent stage down and stable. Two rovers deployed. You have a few sols of air, water and rations.',
    );
    this.hud.addLog(
      'info',
      'Priority one: ice → Water Extractor → Oxygen Generator. Solar dies at night, so build batteries too.',
    );
  }

  private resume(): void {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const sim = new Simulation({ seed: data?.seed ?? 1 });
      sim.restore(data);
      this.launch(sim);
      this.hud.addLog('ok', `Save restored — ${sim.clock.format()}.`);
    } catch (e) {
      console.error(e);
      this.hud.addLog(
        'warn',
        `Could not restore that save (${(e as Error).message}). Starting fresh is safest.`,
      );
    }
  }

  private launch(sim: Simulation): void {
    this.sim = sim;
    this.selected = null;
    this.pendingBuild = null;
    this.endShown = false;
    this.hud.setBuild(null);
    this.lastAuto = performance.now();
    this.renderer = new GameRenderer(this.canvas, sim.world);
    this.renderer.setOverlay(this.hud.overlay as OverlayMode);
    this.rig = new CameraRig(this.renderer.camera);
    this.resize();
    this.hud.updateVitals(sim);
    this.syncUI(true);
    const ov = document.getElementById('start-overlay');
    if (ov) ov.style.display = 'none';
    this.started = true;
  }

  // -------------------------------------------------------------- input ----
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
    this.shiftHeld = e.shiftKey || e.button === 1;
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

    // Long press = context order on touch (TDD §18).
    if (this.longPressTimer !== null) window.clearTimeout(this.longPressTimer);
    if (this.pointerCount === 1 && e.pointerType !== 'mouse') {
      this.longPressTimer = window.setTimeout(() => {
        const still = this.pointers.get(e.pointerId);
        if (still && still.travel < TAP_TRAVEL) {
          still.dragging = true; // consume the gesture
          this.contextTap(still.x, still.y);
        }
      }, LONG_PRESS_MS);
    }
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
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
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
    if (e.button === 1) this.shiftHeld = false;
  }

  private pointerCancel(e: PointerEvent): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.pointers.delete(e.pointerId);
    this.pointerCount = this.pointers.size;
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key === 'Shift') this.shiftHeld = true;
    if (!this.started) return;
    const key = e.key.toLowerCase();

    if ((e.ctrlKey || e.metaKey) && key === 's') {
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
      this.hud.setSpeed(this.hud.speedIdx === 0 ? 1 : 0);
      return;
    }
    if (key === 'v') {
      this.renderer?.setOverlay(this.hud.cycleOverlay() as OverlayMode);
      return;
    }
    if (key === 'f') {
      this.centerOnSelected();
      return;
    }
    // Number keys select build blueprints in palette order.
    const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
    if (idx >= 0 && idx < BUILDING_ORDER.length) {
      const kind = BUILDING_ORDER[idx];
      this.setPendingBuild(this.pendingBuild === kind ? null : kind);
    }
  }

  // ---------------------------------------------------------- gestures ----
  private contextTap(x: number, y: number): void {
    if (!this.renderer || !this.sim) return;
    if (this.pendingBuild) {
      this.setPendingBuild(null);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.sim.issueMove(this.selected.id, pt.x, pt.z, this.shiftHeld);
    } else if (this.selected?.type === 'colonist') {
      this.sim.orderColonist({ type: 'moveTo', x: pt.x, z: pt.z });
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
        // With a rover selected, tapping a stranded one dispatches a rescue —
        // the same grammar as deposit → mine (P4's RECOVER task).
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const target = this.sim.roverById(pick.id);
        if (rv && target && target.id !== rv.id && target.phase === 'disabled') {
          this.sim.issueRecover(rv.id, target.id, this.shiftHeld);
        } else {
          this.selected = { type: 'rover', id: pick.id };
        }
      } else if (pick.type === 'building') {
        // With a rover selected, tapping a battered or buried structure sends
        // the rover to service it — the same grammar as deposit → mine.
        const rv =
          this.selected?.type === 'rover' ? this.sim.roverById(this.selected.id) : undefined;
        const job = this.sim.needsMaintenance(pick.id);
        if (rv && job) {
          if (job === 'repair') this.sim.issueRepair(rv.id, pick.id, this.shiftHeld);
          else this.sim.issueClean(rv.id, pick.id, this.shiftHeld);
        } else {
          this.selected = { type: 'building', id: pick.id };
        }
      } else if (pick.type === 'colonist') {
        this.selected = { type: 'colonist', id: pick.id };
      } else if (pick.type === 'deposit') {
        if (this.selected?.type === 'rover') {
          this.sim.issueMine(this.selected.id, pick.id, this.shiftHeld);
        } else {
          const d = this.sim.world.deposits.find((dp) => dp.id === pick.id);
          this.hud.addLog(
            'info',
            d
              ? `${d.resource} deposit — about ${Math.round(d.amount)} kg. Select a rover, then tap it to mine.`
              : 'Select a rover first, then tap a deposit to mine it.',
          );
        }
      }
      this.syncUI(true);
      return;
    }
    const pt = this.renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.sim.issueMove(this.selected.id, pt.x, pt.z, this.shiftHeld);
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
      // Shift-place keeps the blueprint armed for laying out solar farms.
      if (!this.shiftHeld) this.setPendingBuild(null);
    }
  }

  private handleAction(a: string, arg?: number | string): void {
    if (!this.sim) return;
    if (a === 'focus' && typeof arg === 'number') {
      const r = this.sim.roverById(arg);
      const b = this.sim.buildingById(arg);
      if (r) this.selected = { type: 'rover', id: arg };
      else if (b) this.selected = { type: 'building', id: arg };
      else if (this.sim.colonist.id === arg) this.selected = { type: 'colonist', id: arg };
      this.centerOnSelected();
      this.syncUI(true);
      return;
    }
    if (!this.selected) return;
    switch (a) {
      case 'stop':
        if (this.selected.type === 'rover') this.sim.stopRover(this.selected.id);
        break;
      case 'wait':
        if (this.selected.type === 'rover')
          this.sim.issueWait(this.selected.id, Number(arg) || 60, true);
        break;
      case 'recenter':
        this.centerOnSelected();
        break;
      case 'repeathaul':
        if (this.selected.type === 'rover') {
          const rv = this.sim.roverById(this.selected.id);
          this.sim.setRepeatRoute(this.selected.id, !(rv?.command.type === 'mine' && rv.command.repeat));
        }
        break;
      case 'rule-haul':
      case 'rule-svc':
      case 'rule-storm':
      case 'rule-rescue':
        if (this.selected.type === 'rover') {
          const rule =
            a === 'rule-haul'
              ? 'autoHaul'
              : a === 'rule-svc'
                ? 'autoService'
                : a === 'rule-storm'
                  ? 'stormShelter'
                  : 'autoRescue';
          this.sim.setRoverRule(this.selected.id, rule, arg === 1);
        }
        break;
      case 'rule-charge':
        if (this.selected.type === 'rover' && typeof arg === 'number') {
          this.sim.setChargeFloor(this.selected.id, arg);
        }
        break;
      case 'toggle':
        if (this.selected.type === 'building') {
          const b = this.sim.buildingById(this.selected.id);
          if (b) this.sim.setBuildingEnabled(b.id, !b.enabled);
        }
        break;
      case 'demolish':
        if (this.selected.type === 'building') {
          this.sim.demolish(this.selected.id);
          this.selected = null;
        }
        break;
      case 'shelter':
        this.sim.orderColonist({ type: 'shelter' });
        break;
      case 'service':
        if (this.selected.type === 'building') {
          this.sim.dispatchMaintenance(this.selected.id);
        }
        break;
      case 'assemble':
        if (this.selected.type === 'building' && typeof arg === 'string') {
          this.sim.assembleRover(this.selected.id, arg as RoverKind);
        }
        break;
    }
    this.syncUI(true);
  }

  private centerOnSelected(): void {
    if (!this.rig || !this.selected || !this.sim) return;
    const e =
      this.selected.type === 'rover'
        ? this.sim.roverById(this.selected.id)
        : this.selected.type === 'building'
          ? this.sim.buildingById(this.selected.id)
          : this.sim.colonist;
    if (e) this.rig.target.set(e.x, 4, e.z);
  }

  private save(quiet = false): void {
    if (!this.sim) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.sim.snapshot()));
      if (!quiet) this.hud.flashSave(`Saved · ${this.sim.clock.format()}`);
    } catch (e) {
      // Quota is the realistic failure here; say so rather than failing silently.
      this.hud.flashSave('Save failed — browser storage full?');
      console.error(e);
    }
  }

  // -------------------------------------------------------- per-frame ----
  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer?.resize(w, h);
  }

  private lastT = 0;

  private loop(nowMs: number): void {
    requestAnimationFrame((t) => this.loop(t));
    if (!this.started || !this.renderer || !this.sim || !this.rig) return;
    const t = nowMs / 1000;
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1; // clamp after a stall rather than fast-forwarding
    if (dt < 0) dt = 0;

    const speed = SPEEDS[this.hud.speedIdx];
    if (speed > 0 && !this.sim.gameOver) this.sim.step(dt * speed);

    for (const ev of this.sim.drainEvents()) {
      this.hud.addLog(ev.severity, ev.text, ev.stamp);
    }

    this.renderer.sync(this.sim);
    this.rig.update();

    if (nowMs - this.lastAuto > AUTOSAVE_INTERVAL_S * 1000) {
      this.lastAuto = nowMs;
      this.save(true);
    }

    this.updateGhost();
    this.updateSelectionVisual();
    this.syncUI(false);
    this.renderer.render();

    if (this.sim.gameOver && !this.endShown) {
      this.endShown = true;
      this.save(true);
      this.hud.showEnd(
        'MISSION LOST',
        `${this.sim.gameOver.reason} Sol ${this.sim.gameOver.sol}. Mars does not negotiate.`,
      );
    }
  }

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
    const err = this.sim.canPlace(this.pendingBuild, pt.x, pt.z);
    this.renderer.showGhost(this.pendingBuild, pt.x, pt.z, err === null);
    if (err) this.hud.hint(`<b>Cannot build here</b> — ${err}`);
    else {
      const def = BUILDINGS[this.pendingBuild];
      this.hud.hint(
        `Placing <b>${def.label}</b> — click to site it, Shift+click to place several, Esc to cancel.`,
      );
    }
  }

  private updateSelectionVisual(): void {
    if (!this.renderer || !this.sim) return;
    if (!this.selected) {
      this.renderer.setSelection(null);
      this.renderer.showRoute(null);
      return;
    }
    if (this.selected.type === 'rover') {
      const rv = this.sim.roverById(this.selected.id);
      if (!rv) {
        this.selected = null;
        this.renderer.setSelection(null);
        this.renderer.showRoute(null);
        return;
      }
      this.renderer.setSelection({ x: rv.x, z: rv.z, radius: ROVERS[rv.kind].radius });
      this.renderer.showRoute(this.routePoints(rv));
    } else if (this.selected.type === 'building') {
      const b = this.sim.buildingById(this.selected.id);
      if (!b) {
        this.selected = null;
        this.renderer.setSelection(null);
        this.renderer.showRoute(null);
        return;
      }
      this.renderer.setSelection({ x: b.x, z: b.z, radius: BUILDINGS[b.kind].radius });
      this.renderer.showRoute(null);
    } else {
      const c = this.sim.colonist;
      this.renderer.setSelection({ x: c.x, z: c.z, radius: 2 });
      this.renderer.showRoute(null);
    }
  }

  /**
   * The selected rover's route, as world points: where it is now, where the
   * active task is headed, then every queued task's destination. The renderer
   * just draws the polyline (it never interprets tasks).
   */
  private routePoints(rv: Rover): Array<{ x: number; z: number }> | null {
    if (!this.sim) return null;
    const pts: Array<{ x: number; z: number }> = [{ x: rv.x, z: rv.z }];
    for (const t of [rv.command, ...rv.pending]) {
      let p: { x: number; z: number } | null = null;
      if (t.type === 'moveTo') p = { x: t.x, z: t.z };
      else if (t.type === 'mine') {
        const d = this.sim.world.deposits.find((dp) => dp.id === t.depositId);
        if (d) p = { x: d.x, z: d.z };
      } else if (t.type === 'construct' || t.type === 'clean' || t.type === 'repair') {
        const b = this.sim.buildingById(t.buildingId);
        if (b) p = { x: b.x, z: b.z };
      } else if (t.type === 'recover') {
        const s = this.sim.roverById(t.roverId);
        if (s) p = { x: s.x, z: s.z };
      }
      if (p && Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z) > 1) {
        pts.push(p);
      }
    }
    return pts.length > 1 ? pts : null;
  }

  private syncUI(force: boolean): void {
    if (!this.sim) return;
    const now = performance.now();
    // The HUD patches cached nodes, but there is no value in doing it at 144 Hz.
    if (!force && now - this.lastInspector < 120) return;
    this.lastInspector = now;

    this.hud.updateVitals(this.sim);
    this.hud.updateAlerts(this.sim.alerts.list());
    this.hud.updateAffordability(this.sim);

    if (this.selected) {
      if (this.selected.type === 'rover') {
        const r = this.sim.roverById(this.selected.id);
        if (r) this.hud.showRover(r, this.sim);
        else this.selected = null;
      } else if (this.selected.type === 'building') {
        const b = this.sim.buildingById(this.selected.id);
        if (b) this.hud.showBuilding(b, this.sim);
        else this.selected = null;
      } else {
        this.hud.showColonist(this.sim.colonist, this.sim);
      }
    }
    if (!this.selected) this.hud.clearInspector();

    if (!this.pendingBuild && force) this.hud.hint(null);
  }
}
