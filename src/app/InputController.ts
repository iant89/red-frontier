/**
 * Phase 19 — keyboard, pointer, touch, camera input, and command-gesture wiring.
 * Move-not-redesign from Game.ts (attachInput / pointer* / keyDown / uiCoversPoint).
 */

import type { BuildingKind } from '../sim/defs';
import { BUILDING_ORDER } from '../sim/defs';
import type { OverlayMode } from '../render/Renderer';
import type { CameraRig } from './CameraRig';
import { singlePointerGesture, twoPointerGesture } from './gestures';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import type { GameRenderer } from '../render/Renderer';
import type { Selection } from './SelectionController';

const TAP_TRAVEL = 8; // px before a press becomes a camera drag
const DRAG_START = 5; // px before a press counts as a drag at all
const LONG_PRESS_MS = 480;

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
  /** Touch (or pen) rather than a mouse — decides pan-first vs orbit-first. */
  touch: boolean;
  /** This frame's movement, consumed and cleared by the gesture map. */
  dx: number;
  dy: number;
  /** Travel accumulated since the current two-finger gesture began. */
  gestureTravel: number;
}

export interface InputControllerDeps {
  canvas: HTMLCanvasElement;
  getStarted: () => boolean;
  getRig: () => CameraRig | null;
  getRenderer: () => GameRenderer | null;
  hud: HUD;
  audio: AudioSystem;
  /** Pause menu open? Esc resumes; other keys ignored. */
  isPauseMenuOpen: () => boolean;
  closePauseMenu: () => boolean;
  isSaveInFlight: () => boolean;
  updateNoticeLater: () => void;
  manualSave: () => void;
  toggleDevPanel: () => void;
  hasArmedSpawn: () => boolean;
  clearArmedSpawn: () => void;
  getPendingBuild: () => BuildingKind | null;
  setPendingBuild: (kind: BuildingKind | null) => void;
  setSelected: (sel: Selection) => void;
  primaryTap: (x: number, y: number) => void;
  contextTap: (x: number, y: number) => void;
  centerOnSelected: () => void;
  cycleIdle: () => void;
  syncUI: (force: boolean) => void;
}

export class InputController {
  mouse = { x: -1, y: -1, in: false };
  private pointers = new Map<number, ActivePointer>();
  private pointerCount = 0;
  private pinchLast = 0;
  /** Finger span when the current two-finger gesture began (pinch drift baseline). */
  private pinchStart = 0;
  shiftHeld = false;
  private longPressTimer: number | null = null;

  constructor(private readonly d: InputControllerDeps) {}

  attachInput(): void {
    const c = this.d.canvas;
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
        const rig = this.d.getRig();
        if (!rig) return;
        e.preventDefault();
        rig.dolly(Math.pow(1.13, e.deltaY > 0 ? 1 : -1));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shiftHeld = false;
    });
  }

  /**
   * True when HUD chrome is visually at this screen point. Belt and braces on
   * top of the panels' `pointer-events`: a tap that lands on any UI surface —
   * a speed button, a panel, a chip — must never leak through to the canvas
   * and become a move order for the selected rover.
   */
  uiCoversPoint(x: number, y: number): boolean {
    try {
      const el = document.elementFromPoint(x, y);
      return !!el && el !== this.d.canvas;
    } catch {
      return false; // headless/odd environments: the CSS layer already guards
    }
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.d.getStarted()) return;
    if (this.d.hud.isWorldMapOpen()) return;
    e.preventDefault();
    try {
      this.d.canvas.setPointerCapture(e.pointerId);
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
      touch: e.pointerType !== 'mouse',
      dx: 0,
      dy: 0,
      gestureTravel: 0,
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
          this.d.contextTap(still.x, still.y);
        }
      }, LONG_PRESS_MS);
    }
  }

  private resetPinch(): void {
    const arr = [...this.pointers.values()];
    if (arr.length < 2) return;
    const dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    this.pinchLast = dist;
    this.pinchStart = dist;
    // Travel is measured from the start of the two-finger gesture, so whichever
    // finger went down first doesn't get counted as "the mover" for free.
    for (const q of arr) {
      q.gestureTravel = 0;
      q.dx = 0;
      q.dy = 0;
    }
  }

  private pointerMove(e: PointerEvent): void {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.in = true;
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.d.getStarted()) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.travel += Math.hypot(dx, dy);
    p.x = e.clientX;
    p.y = e.clientY;

    const rig = this.d.getRig();
    if (!rig) return;

    p.dx = dx;
    p.dy = dy;
    p.gestureTravel += Math.hypot(dx, dy);

    if (this.pointerCount === 1) {
      if (p.travel < DRAG_START) return; // still possibly a tap
      const g = singlePointerGesture({
        touch: p.touch,
        panModifier: this.shiftHeld,
        dx,
        dy,
      });
      if (g.kind === 'none') return; // a resting finger must not nudge the camera
      p.dragging = true;
      if (g.kind === 'pan') rig.panByPixels(g.dx, g.dy, window.innerHeight);
      else rig.rotateByPixels(g.dx, g.dy, window.innerWidth, window.innerHeight);
      p.dx = 0;
      p.dy = 0;
    } else if (this.pointerCount === 2) {
      const arr = [...this.pointers.values()];
      const a = arr[0];
      const b = arr[1];
      a.dragging = true;
      b.dragging = true;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // The map classifies on per-gesture travel, so project it explicitly:
      // passing the pointers themselves would hand it `travel` (accumulated
      // since touch-down, including any one-finger pan from before the second
      // finger landed) and the look would credit the wrong finger.
      const g = twoPointerGesture(
        { dx: a.dx, dy: a.dy, travel: a.gestureTravel },
        { dx: b.dx, dy: b.dy, travel: b.gestureTravel },
        this.pinchLast,
        dist,
        this.pinchStart,
      );
      if (g.dolly !== 1) rig.dolly(g.dolly);
      // Two fingers look around; pan is the one-finger gesture now. Driving
      // both off the same gesture is what made panning feel broken (#1).
      if (g.orbit) {
        rig.rotateByPixels(g.orbit.dx, g.orbit.dy, window.innerWidth, window.innerHeight);
      }
      this.pinchLast = dist;
      a.dx = 0;
      a.dy = 0;
      b.dx = 0;
      b.dy = 0;
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
    if (isTap && this.d.getStarted()) {
      if (e.button === 2) this.d.contextTap(e.clientX, e.clientY);
      else this.d.primaryTap(e.clientX, e.clientY);
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
    if (!this.d.getStarted()) return;
    const key = e.key.toLowerCase();

    // Typing into a field (the dev panel's number boxes, a wizard input)
    // must never trigger game hotkeys.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    this.d.audio.activateFromUserGesture();

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      this.d.manualSave();
      return;
    }
    // The update card owns the keyboard while it is open: Esc means "later"
    // (keep playing this build); a stray key must not leak into a frozen
    // colony. While the card's own save is in flight Esc is ignored —
    // dismissing the card mid-save would make the save land on a card the
    // player can no longer see.
    if (this.d.hud.isUpdateNoticeOpen()) {
      if (e.key === 'Escape' && !this.d.isSaveInFlight()) {
        this.d.updateNoticeLater();
        this.d.audio.command('rover/stop');
      }
      return;
    }
    // The pause menu owns the keyboard while it is open: Esc resumes, and
    // everything else is ignored so a stray key never leaks into a frozen
    // colony (or the world map underneath the frost).
    if (this.d.isPauseMenuOpen()) {
      if (e.key === 'Escape') {
        this.d.closePauseMenu();
        this.d.audio.command('rover/stop');
      }
      return;
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      this.d.toggleDevPanel();
      return;
    }
    if (e.key === 'Escape') {
      if (
        this.d.hud.closeWorldMap() ||
        this.d.hud.closeAlertHistory() ||
        this.d.hud.closeBuildInfo()
      ) {
        this.d.audio.command('rover/stop');
        return;
      }
      if (this.d.hasArmedSpawn()) {
        this.d.clearArmedSpawn();
        this.d.audio.command('rover/stop');
        return;
      }
      if (this.d.getPendingBuild()) this.d.setPendingBuild(null);
      else this.d.setSelected(null);
      this.d.audio.command('rover/stop');
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const next = this.d.hud.speedIdx === 0 ? 1 : 0;
      this.d.hud.setSpeed(next);
      this.d.audio.setPaused(next === 0);
      return;
    }
    if (key === 'v') {
      this.d.getRenderer()?.setOverlay(this.d.hud.cycleOverlay() as OverlayMode);
      this.d.audio.select();
      return;
    }
    if (key === 'f') {
      this.d.centerOnSelected();
      this.d.audio.select();
      return;
    }
    if (key === 'h') {
      this.d.hud.openAlertHistory();
      this.d.audio.select();
      return;
    }
    if (key === 'm') {
      if (this.d.hud.isWorldMapOpen()) this.d.hud.closeWorldMap();
      else this.d.hud.openWorldMap();
      this.d.audio.select();
      return;
    }
    if (key === '.') {
      this.d.cycleIdle();
      this.d.syncUI(true);
      this.d.audio.select();
      return;
    }
    // Number keys select build blueprints in palette order.
    const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
    if (idx >= 0 && idx < BUILDING_ORDER.length) {
      const kind = BUILDING_ORDER[idx];
      this.d.setPendingBuild(this.d.getPendingBuild() === kind ? null : kind);
      this.d.audio.select();
    }
  }
}
