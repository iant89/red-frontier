/**
 * Phase 19 — selecting rover/building/colonist/poi, selection state, and
 * selection visualization. Move-not-redesign from Game.ts.
 */

import type { Rover } from '../sim/Simulation';
import type { SimCommand, SimHost, SimView } from '../sim/host';
import type { BuildingKind, RoverKind } from '../sim/defs';
import { BUILDINGS, ROVERS } from '../sim/defs';
import type { GameRenderer } from '../render/Renderer';
import type { CameraRig } from './CameraRig';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';

export type Selection =
  | { type: 'rover'; id: number }
  | { type: 'building'; id: number }
  | { type: 'colonist'; id: number }
  | { type: 'poi'; id: number }
  | null;

export interface SelectionControllerDeps {
  getHost: () => SimHost | null;
  getSim: () => SimView | null;
  getRenderer: () => GameRenderer | null;
  getRig: () => CameraRig | null;
  hud: HUD;
  audio: AudioSystem;
  isShiftHeld: () => boolean;
  uiCoversPoint: (x: number, y: number) => boolean;
  getPendingBuild: () => BuildingKind | null;
  setPendingBuild: (kind: BuildingKind | null) => void;
  placeBuild: (x: number, y: number) => Promise<void>;
  /** Developer click-to-place: when armed, primary tap places instead of selecting. */
  hasArmedSpawn: () => boolean;
  placeDevSpawn: (x: number, z: number) => void;
  syncUI: (force: boolean) => void;
}

export class SelectionController {
  selected: Selection = null;
  private idleCycleIdx = 0;

  constructor(private readonly d: SelectionControllerDeps) {}

  /** The one way gesture handlers write to the colony: an intent to the host. */
  order(command: SimCommand): void {
    const host = this.d.getHost();
    if (!host) return;
    this.d.audio.command(command.type);
    host.send(command);
  }

  contextTap(x: number, y: number): void {
    const renderer = this.d.getRenderer();
    const sim = this.d.getSim();
    if (!renderer || !sim) return;
    if (this.d.uiCoversPoint(x, y)) return;
    if (this.d.getPendingBuild()) {
      this.d.setPendingBuild(null);
      return;
    }
    const pt = renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.order({
        type: 'rover/move',
        roverId: this.selected.id,
        x: pt.x,
        z: pt.z,
        queue: this.d.isShiftHeld(),
      });
    } else if (this.selected?.type === 'colonist') {
      this.order({ type: 'colonist/order', order: { type: 'moveTo', x: pt.x, z: pt.z } });
    } else if (this.selected?.type === 'building') {
      // Right-clicking empty ground with a structure selected clears it.
      this.selected = null;
      this.d.syncUI(true);
    }
  }

  primaryTap(x: number, y: number): void {
    const renderer = this.d.getRenderer();
    const sim = this.d.getSim();
    if (!renderer || !sim) return;
    if (this.d.uiCoversPoint(x, y)) return;
    if (this.d.getPendingBuild()) {
      void this.d.placeBuild(x, y);
      return;
    }
    // A click-to-place spawn the developer panel armed consumes the tap.
    if (this.d.hasArmedSpawn()) {
      const pt = renderer.raycastTerrain(x, y);
      if (pt) this.d.placeDevSpawn(pt.x, pt.z);
      return;
    }
    const pick = renderer.pickTargetAt(x, y);
    if (pick) {
      // World selections are not DOM controls, so they get their own quiet
      // confirmation rather than relying on the menu/HUD click listener.
      this.d.audio.select();
      if (pick.type === 'rover') {
        // With a rover selected, tapping a stranded one dispatches a rescue —
        // the same grammar as deposit → mine (P4's RECOVER task).
        const rv =
          this.selected?.type === 'rover' ? sim.roverById(this.selected.id) : undefined;
        const target = sim.roverById(pick.id);
        if (rv && target && target.id !== rv.id && target.phase === 'disabled') {
          this.order({
            type: 'rover/recover',
            roverId: rv.id,
            strandedId: target.id,
            queue: this.d.isShiftHeld(),
          });
        } else if (this.selected?.type === 'rover' && this.selected.id === pick.id) {
          // Tapping the selected rover again deselects it.
          this.selected = null;
        } else {
          this.selected = { type: 'rover', id: pick.id };
        }
      } else if (pick.type === 'building') {
        // With a rover selected, tapping a construction site sends the rover to
        // build it, while tapping a battered or dusty structure sends it to
        // service — the same grammar as deposit → mine. Buildable check keeps
        // the wrong chassis from being dispatched to a site it cannot work.
        const rv =
          this.selected?.type === 'rover' ? sim.roverById(this.selected.id) : undefined;
        const b = sim.buildingById(pick.id);
        const isSite = b !== undefined && b.state !== 'online';
        const canBuild =
          isSite && rv !== undefined && BUILDINGS[b!.kind].buildableBy.includes(rv.kind);
        const job = sim.needsMaintenance(pick.id);
        if (rv && canBuild) {
          this.order({
            type: 'rover/construct',
            roverId: rv.id,
            buildingId: pick.id,
            queue: this.d.isShiftHeld(),
          });
        } else if (rv && job) {
          this.order(
            job === 'repair'
              ? {
                  type: 'rover/repair',
                  roverId: rv.id,
                  buildingId: pick.id,
                  queue: this.d.isShiftHeld(),
                }
              : {
                  type: 'rover/clean',
                  roverId: rv.id,
                  buildingId: pick.id,
                  queue: this.d.isShiftHeld(),
                },
          );
        } else if (this.selected?.type === 'building' && this.selected.id === pick.id) {
          // Tapping the selected structure again deselects it.
          this.selected = null;
        } else {
          this.selected = { type: 'building', id: pick.id };
        }
      } else if (pick.type === 'colonist') {
        if (this.selected?.type === 'colonist' && this.selected.id === pick.id) {
          this.selected = null;
        } else {
          this.selected = { type: 'colonist', id: pick.id };
        }
      } else if (pick.type === 'poi') {
        // The same grammar as a deposit: with a rover selected, tapping a site
        // sends it to salvage. Without one, the panel explains what it is.
        const site = sim.poiById(pick.id);
        if (this.selected?.type === 'rover' && site) {
          this.order({
            type: 'rover/salvage',
            roverId: this.selected.id,
            poiId: pick.id,
            queue: this.d.isShiftHeld(),
          });
        } else if (this.selected?.type === 'poi' && this.selected.id === pick.id) {
          this.selected = null;
        } else {
          this.selected = { type: 'poi', id: pick.id };
        }
      } else if (pick.type === 'deposit') {
        if (this.selected?.type === 'rover') {
          this.order({
            type: 'rover/mine',
            roverId: this.selected.id,
            depositId: pick.id,
            queue: this.d.isShiftHeld(),
          });
        } else {
          const d = sim.world.deposits.find((dp) => dp.id === pick.id);
          this.d.hud.addLog(
            'info',
            d
              ? `${d.resource} deposit — about ${Math.round(d.amount)} kg. Select a rover, then tap it to mine.`
              : 'Select a rover first, then tap a deposit to mine it.',
          );
        }
      }
      this.d.syncUI(true);
      return;
    }
    const pt = renderer.raycastTerrain(x, y);
    if (!pt) return;
    if (this.selected?.type === 'rover') {
      this.order({
        type: 'rover/move',
        roverId: this.selected.id,
        x: pt.x,
        z: pt.z,
        queue: this.d.isShiftHeld(),
      });
    } else if (this.selected) {
      // Tapping empty ground with a structure or the colonist selected
      // clears the selection (a rover instead takes it as a move order).
      this.selected = null;
      this.d.syncUI(true);
    }
  }

  handleAction(a: string, arg?: number | string): void {
    const sim = this.d.getSim();
    if (!sim) return;
    if (a === 'focus' && typeof arg === 'number') {
      const r = sim.roverById(arg);
      const b = sim.buildingById(arg);
      if (r) this.selected = { type: 'rover', id: arg };
      else if (b) this.selected = { type: 'building', id: arg };
      else if (sim.colonist.id === arg) this.selected = { type: 'colonist', id: arg };
      this.centerOnSelected();
      this.d.syncUI(true);
      return;
    }
    if (a === 'cycle-idle') {
      this.cycleIdle();
      this.d.syncUI(true);
      return;
    }
    if (!this.selected) return;
    switch (a) {
      case 'deselect':
        this.selected = null;
        break;
      case 'stop':
        if (this.selected.type === 'rover')
          this.order({ type: 'rover/stop', roverId: this.selected.id });
        break;
      case 'unload':
        if (this.selected.type === 'rover')
          this.order({
            type: 'rover/unload',
            roverId: this.selected.id,
            queue: this.d.isShiftHeld(),
          });
        break;
      case 'wait':
        if (this.selected.type === 'rover')
          this.order({
            type: 'rover/wait',
            roverId: this.selected.id,
            seconds: Number(arg) || 60,
            queue: true,
          });
        break;
      case 'recenter':
        this.centerOnSelected();
        break;
      case 'repeathaul':
        if (this.selected.type === 'rover') {
          const rv = sim.roverById(this.selected.id);
          this.order({
            type: 'rover/repeatRoute',
            roverId: this.selected.id,
            on: !(rv?.command.type === 'mine' && rv.command.repeat),
          });
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
          this.order({ type: 'rover/rule', roverId: this.selected.id, rule, on: arg === 1 });
        }
        break;
      case 'rule-charge':
        if (this.selected.type === 'rover' && typeof arg === 'number') {
          this.order({ type: 'rover/chargeFloor', roverId: this.selected.id, pct: arg });
        }
        break;
      case 'rule-lights':
        if (this.selected.type === 'rover') {
          this.order({ type: 'rover/lights', roverId: this.selected.id, on: arg === 1 });
        }
        break;
      case 'toggle':
        if (this.selected.type === 'building') {
          const b = sim.buildingById(this.selected.id);
          if (b) {
            const next = !b.enabled;
            this.order({ type: 'building/toggle', buildingId: b.id, enabled: next });
            // Worker host: the view is a mirror that stays stale until the
            // next `view` message arrives. Flip it optimistically so the
            // `syncUI(true)` that follows this switch reads the intended
            // state and the power button feels instant. The local host has
            // already mutated the live sim, so the guard keeps us from
            // flipping it back.
            const viewB = sim.buildingById(b.id);
            if (viewB && viewB.enabled !== next) {
              (viewB as { enabled: boolean }).enabled = next;
            }
          }
        }
        break;
      case 'demolish':
        if (this.selected.type === 'building') {
          this.order({ type: 'building/demolish', buildingId: this.selected.id });
          this.selected = null;
        }
        break;
      case 'shelter':
        this.order({ type: 'colonist/order', order: { type: 'shelter' } });
        break;
      case 'service':
        if (this.selected.type === 'building') {
          this.order({ type: 'building/maintain', buildingId: this.selected.id });
        }
        break;
      case 'assemble':
        if (this.selected.type === 'building' && typeof arg === 'string') {
          this.order({
            type: 'building/assemble',
            buildingId: this.selected.id,
            kind: arg as RoverKind,
          });
        }
        break;
    }
    this.d.syncUI(true);
  }

  /** Jump to the next rover with nothing to do (`.` hotkey + HUD button). */
  cycleIdle(): void {
    const idle = this.d.getSim()?.idleRovers();
    if (!idle) return;
    if (idle.length === 0) {
      this.d.hud.flashSave('No idle rovers');
      return;
    }
    const r = idle[this.idleCycleIdx % idle.length];
    this.idleCycleIdx = (this.idleCycleIdx + 1) % idle.length;
    this.selected = { type: 'rover', id: r.id };
    this.centerOnSelected();
  }

  centerOnSelected(): void {
    const rig = this.d.getRig();
    const sim = this.d.getSim();
    if (!rig || !this.selected || !sim) return;
    const e =
      this.selected.type === 'rover'
        ? sim.roverById(this.selected.id)
        : this.selected.type === 'building'
          ? sim.buildingById(this.selected.id)
          : sim.colonist;
    if (e) rig.target.set(e.x, 4, e.z);
  }

  updateSelectionVisual(): void {
    const renderer = this.d.getRenderer();
    const sim = this.d.getSim();
    if (!renderer || !sim) return;
    if (!this.selected) {
      renderer.setSelection(null);
      renderer.showRoute(null);
      return;
    }
    if (this.selected.type === 'rover') {
      const rv = sim.roverById(this.selected.id);
      if (!rv) {
        this.selected = null;
        renderer.setSelection(null);
        renderer.showRoute(null);
        return;
      }
      renderer.setSelection({ x: rv.x, z: rv.z, radius: ROVERS[rv.kind].radius });
      renderer.showRoute(this.routePoints(rv));
    } else if (this.selected.type === 'building') {
      const b = sim.buildingById(this.selected.id);
      if (!b) {
        this.selected = null;
        renderer.setSelection(null);
        renderer.showRoute(null);
        return;
      }
      renderer.setSelection({ x: b.x, z: b.z, radius: BUILDINGS[b.kind].radius });
      renderer.showRoute(null);
    } else {
      const c = sim.colonist;
      renderer.setSelection({ x: c.x, z: c.z, radius: 2 });
      renderer.showRoute(null);
    }
  }

  /**
   * The selected rover's route, as world points: where it is now, where the
   * active task is headed, then every queued task's destination. The renderer
   * just draws the polyline (it never interprets tasks).
   */
  routePoints(rv: Rover): Array<{ x: number; z: number }> | null {
    const sim = this.d.getSim();
    if (!sim) return null;
    const pts: Array<{ x: number; z: number }> = [{ x: rv.x, z: rv.z }];
    for (const t of [rv.command, ...rv.pending]) {
      let p: { x: number; z: number } | null = null;
      if (t.type === 'moveTo') p = { x: t.x, z: t.z };
      else if (t.type === 'mine') {
        const d = sim.world.deposits.find((dp) => dp.id === t.depositId);
        if (d) p = { x: d.x, z: d.z };
      } else if (t.type === 'construct' || t.type === 'clean' || t.type === 'repair') {
        const b = sim.buildingById(t.buildingId);
        if (b) p = { x: b.x, z: b.z };
      } else if (t.type === 'recover') {
        const s = sim.roverById(t.roverId);
        if (s) p = { x: s.x, z: s.z };
      }
      if (p && Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z) > 1) {
        pts.push(p);
      }
    }
    return pts.length > 1 ? pts : null;
  }

  /** Clear selection on a fresh colony launch. */
  reset(): void {
    this.selected = null;
  }
}
