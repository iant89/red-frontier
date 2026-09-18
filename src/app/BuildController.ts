/**
 * Phase 19 — build mode, placement cursor, ghost positioning, placement request.
 *
 * Must not determine final placement validity: `canPlace` / host ack remain the
 * authority; this controller only arms a blueprint and requests placement.
 *
 * Move-not-redesign from Game.ts (setPendingBuild / placeBuild / updateGhost).
 */

import type { BuildingKind } from '../sim/defs';
import { BUILDINGS } from '../sim/defs';
import type { SimHost, SimView } from '../sim/host';
import type { GameRenderer } from '../render/Renderer';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import type { Selection } from './SelectionController';

export interface BuildControllerDeps {
  getHost: () => SimHost | null;
  getSim: () => SimView | null;
  getRenderer: () => GameRenderer | null;
  hud: HUD;
  audio: AudioSystem;
  /** Shared with InputController — Shift+place keeps the blueprint armed. */
  isShiftHeld: () => boolean;
  /** Hit-test so the ghost does not draw over HUD chrome. */
  uiCoversPoint: (x: number, y: number) => boolean;
  getMouse: () => { x: number; y: number; in: boolean };
  setSelected: (sel: Selection) => void;
  syncUI: (force: boolean) => void;
}

export class BuildController {
  pendingBuild: BuildingKind | null = null;

  constructor(private readonly d: BuildControllerDeps) {}

  setPendingBuild(kind: BuildingKind | null): void {
    this.pendingBuild = kind;
    this.d.hud.setBuild(kind);
    if (!kind) this.d.getRenderer()?.showGhost(null, 0, 0, false);
    this.d.syncUI(true);
  }

  async placeBuild(x: number, y: number): Promise<void> {
    const host = this.d.getHost();
    const renderer = this.d.getRenderer();
    if (!renderer || !host || !this.pendingBuild) return;
    const pt = renderer.raycastTerrain(x, y);
    if (!pt) return;
    const kind = this.pendingBuild;
    // Placing is the one gesture whose result the UI needs immediately: the new
    // structure must be selected, and only the sim knows the id it allocated.
    // `request` is the ack path the protocol reserves for exactly that.
    try {
      const ack = await host.requestPlacement({ type: 'building/place', kind, x: pt.x, z: pt.z });
      if (ack.ok && ack.entityId !== undefined) {
        this.d.audio.command('building/place');
        this.d.setSelected({ type: 'building', id: ack.entityId });
        // Shift-place keeps the blueprint armed for laying out solar farms.
        if (!this.d.isShiftHeld()) this.setPendingBuild(null);
      } else {
        this.d.audio.reject();
      }
    } catch {
      // A host can disappear while a placement request is in flight (for
      // example, when returning to the menu). Its rejection is feedback, not a
      // reason to leave an unhandled promise behind.
      this.d.audio.reject();
    }
  }

  updateGhost(): void {
    const renderer = this.d.getRenderer();
    const sim = this.d.getSim();
    if (!renderer || !sim) return;
    const mouse = this.d.getMouse();
    // Over HUD chrome the blueprint ghost hides — the panel owns that pixel.
    if (!this.pendingBuild || !mouse.in || this.d.uiCoversPoint(mouse.x, mouse.y)) {
      renderer.showGhost(null, 0, 0, false);
      return;
    }
    const pt = renderer.raycastTerrain(mouse.x, mouse.y);
    if (!pt) {
      renderer.showGhost(null, 0, 0, false);
      return;
    }
    // Validity stays on the sim view — we only request / preview.
    const err = sim.canPlace(this.pendingBuild, pt.x, pt.z);
    renderer.showGhost(this.pendingBuild, pt.x, pt.z, err === null);
    if (err) this.d.hud.hint(`<b>Cannot build here</b> — ${err}`);
    else {
      const def = BUILDINGS[this.pendingBuild];
      this.d.hud.hint(
        `Placing <b>${def.label}</b> — click to site it, Shift+click to place several, Esc to cancel.`,
      );
    }
  }

  /** Clear pending build state on a fresh colony launch. */
  reset(): void {
    this.pendingBuild = null;
  }
}
