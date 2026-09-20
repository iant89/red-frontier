/** Owns modal lifecycle and its pause lease. No authoritative state mutation. */
import type { SimHost, SimView } from '../sim/host';
import type { HUD } from '../ui/HUD';
import type { EntityTarget } from '../sim/engineering/upgrades';
import { BUILDINGS } from '../sim/defs';
import { EngineeringPanel } from '../ui/EngineeringPanel';
import { EntityPreview } from '../render/EntityPreview';
import type { GameRenderer } from '../render/Renderer';
export interface EngineeringDeps {
  getHost(): SimHost | null;
  getSim(): SimView | null;
  getRenderer(): GameRenderer | null;
  hud: HUD;
  blocked(): boolean;
  action(a: string, arg?: string): void;
}
export class EngineeringController {
  private panel: EngineeringPanel | null = null;
  private preview: EntityPreview | null = null;
  private previousSpeed = 0;
  private host: SimHost | null = null;
  constructor(private d: EngineeringDeps) {}
  get isOpen(): boolean {
    return this.panel !== null;
  }
  open(target: EntityTarget): void {
    if (this.d.blocked()) return;
    const sim = this.d.getSim(),
      host = this.d.getHost(),
      renderer = this.d.getRenderer();
    if (!sim || !host || !renderer) return;
    const e =
      target.entity === 'rover'
        ? sim.roverById(target.id)
        : sim.buildingById(target.id);
    if (!e) return;
    if (this.panel) this.close();
    this.previousSpeed = this.d.hud.speedIdx;
    this.host = host;
    this.d.hud.setSpeed(0);
    const panel = new EngineeringPanel(target, {
      close: () => this.close(),
      command: (c) => {
        if (this.host === this.d.getHost()) {
          host.send(c);
          this.update();
        }
      },
      action: (a, arg) => this.d.action(a, arg),
      previewPaint: (c) => this.preview?.paint(c),
      garage: () => {
        const r = this.d.getSim()?.roverById(target.id);
        if (!r) return;
        const garage = this.d
          .getSim()!
          .buildings.filter(
            (b) =>
              b.kind === 'garage' &&
              b.state === 'online' &&
              b.enabled &&
              !b.damaged,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - r.x, a.z - r.z) -
              Math.hypot(b.x - r.x, b.z - r.z),
          )[0];
        if (!garage) {
          this.d.hud.flashSave('Build an enabled Garage first');
          return;
        }
        const angle = Math.atan2(r.z - garage.z, r.x - garage.x),
          reach = BUILDINGS.garage.radius + 3;
        host.send({
          type: 'rover/move',
          roverId: r.id,
          x: garage.x + Math.cos(angle) * reach,
          z: garage.z + Math.sin(angle) * reach,
          queue: false,
        });
        this.close();
      },
    });
    this.panel = panel;
    panel.mount();
    panel.update(sim);
    try {
      const model = renderer.previewEntity(target);
      if (model) {
        this.preview = new EntityPreview(panel.preview, model);
        this.preview.paint(e.paint ?? null);
      }
    } catch {
      panel.preview.textContent =
        '3D preview unavailable on this device. Engineering controls remain available.';
    }
  }
  update(): void {
    if (!this.panel) return;
    if (this.host !== this.d.getHost() || this.d.getSim()?.gameOver) {
      this.close(false);
      return;
    }
    const sim = this.d.getSim();
    if (sim) this.panel.update(sim);
  }
  close(restore = true): boolean {
    if (!this.panel) return false;
    this.preview?.dispose();
    this.preview = null;
    this.panel.dispose();
    this.panel = null;
    if (restore && this.host === this.d.getHost())
      this.d.hud.setSpeed(this.previousSpeed);
    this.host = null;
    return true;
  }
}
