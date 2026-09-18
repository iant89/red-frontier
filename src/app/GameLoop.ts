/**
 * Phase 19 — requestAnimationFrame / frame timing / host.step() / render scheduling.
 * Move-not-redesign from Game.ts (loop / resize).
 */

import type { SimHost } from '../sim/host';
import { SPEEDS } from '../sim/config';
import type { GameRenderer } from '../render/Renderer';
import type { CameraRig } from './CameraRig';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import type { UpdateCheck } from './UpdateCheck';

export interface GameLoopDeps {
  canvas: HTMLCanvasElement;
  getStarted: () => boolean;
  getHost: () => SimHost | null;
  getRenderer: () => GameRenderer | null;
  getRig: () => CameraRig | null;
  hud: HUD;
  audio: AudioSystem;
  getAutosaveSec: () => number;
  getLastAuto: () => number;
  setLastAuto: (ms: number) => void;
  saveQuiet: () => void;
  updateGhost: () => void;
  updateSelectionVisual: () => void;
  syncUI: (force: boolean) => void;
  getUpdateCheck: () => UpdateCheck | null;
  /** Mission-lost end card shown once. */
  isEndShown: () => boolean;
  setEndShown: (v: boolean) => void;
}

export class GameLoop {
  private lastT = 0;

  constructor(private readonly d: GameLoopDeps) {}

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.d.canvas.width = w;
    this.d.canvas.height = h;
    this.d.getRenderer()?.resize(w, h);
  }

  loop(nowMs: number): void {
    requestAnimationFrame((t) => this.loop(t));
    const host = this.d.getHost();
    const renderer = this.d.getRenderer();
    const rig = this.d.getRig();
    if (!this.d.getStarted() || !renderer || !host || !rig) return;
    const view = host.view;
    const t = nowMs / 1000;
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1; // clamp after a stall rather than fast-forwarding
    if (dt < 0) dt = 0;

    const speed = SPEEDS[this.d.hud.speedIdx];
    // The host owns the tick now. Stepping is the one call in this loop that a
    // worker host answers differently — and "differently" is all: an in-process
    // host runs the fixed substeps, a worker's own timer does, and this frame
    // simply reads whatever the newest view holds.
    //
    // A paused world still hands the frame over at zero, because the host also
    // runs its runtime overlays there: a developer-mode battery pin has to keep
    // its grip while the player inspects a frozen colony.
    host.step(speed > 0 && !view.gameOver ? dt * speed : 0);

    // Developer-mode modifiers ride on top of the sim, never inside it — which
    // is why they're saved nowhere. They are a host overlay now, so the pin
    // keeps its grip without this loop knowing developer mode exists.
    for (const ev of host.drainEvents()) {
      this.d.hud.addLog(ev.severity, ev.text, ev.stamp);
      this.d.audio.event(ev);
    }
    // Domain events have no HUD consumer yet (Phase 21). Drain and discard each
    // frame so LocalSimHost pending / WorkerSimHost unreadDomain cannot grow
    // without bound across play.
    void host.drainDomainEvents();
    // This lives outside the simulation tick. `loop()` still runs at speed 0,
    // so a paused player hears the frozen wind/storm ambience rather than a
    // dead soundscape.
    this.d.audio.update(view, speed === 0 || !!view.gameOver);

    renderer.sync(view);
    rig.update();

    // Autosave cadence is a player setting (pause menu → game); 0 disables it.
    const autosaveSec = this.d.getAutosaveSec();
    if (autosaveSec > 0 && nowMs - this.d.getLastAuto() > autosaveSec * 1000) {
      this.d.setLastAuto(nowMs);
      this.d.saveQuiet();
    }

    this.d.updateGhost();
    this.d.updateSelectionVisual();
    this.d.hud.updateMarkers(view, (x, z) => renderer.project(x, z));
    this.d.syncUI(false);
    renderer.render();

    const over = view.gameOver;
    if (over && !this.d.isEndShown()) {
      this.d.setEndShown(true);
      // A dead colony has no business reloading mid-death — the player
      // returns to the menu, and its badge covers the rest.
      this.d.getUpdateCheck()?.stop();
      this.d.saveQuiet();
      this.d.hud.showEnd(
        'MISSION LOST',
        `${over.reason} Sol ${over.sol}. Mars does not negotiate.`,
      );
    }
  }
}
