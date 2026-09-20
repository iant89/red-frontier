/** Stable inspector controls. Reads owned host data and emits intents only. */
import type { SimView } from '../sim/host';
import { WATER_PIPE_LENGTH, WATER_PIPE_MAX_RUN } from '../sim/config';

type Action = (action: string, arg?: string) => void;
const panels = new WeakMap<HTMLElement, WaterPanel>();
export function updateWaterPanel(
  root: HTMLElement,
  id: number,
  sim: SimView,
  action: Action,
): void {
  let panel = panels.get(root);
  if (!panel) {
    panel = new WaterPanel(root, action);
    panels.set(root, panel);
  }
  panel.update(id, sim);
}
class WaterPanel {
  private id = 0;
  private sim!: SimView;
  private signature = '';
  private select: HTMLSelectElement;
  constructor(
    private root: HTMLElement,
    action: Action,
  ) {
    root.innerHTML = `<div class="sub sm">Water network</div>
      <div class="note" data-water="status"></div>
      <div class="note dim" data-water="buffer"></div>
      <label class="note">Connect to <select aria-label="Water pipe destination" data-water="target" style="width:100%;margin:6px 0"></select></label>
      <div class="note dim" data-water="cost"></div>
      <div class="action-grid"><button class="btn" data-water="connect">Lay pipe</button><button class="btn danger" data-water="disconnect">Disconnect</button></div>
      <div class="note dim" data-water="flow"></div>
      <button class="btn" data-water="commission" style="width:100%">Commission network</button>
      <div class="note dim" data-water="mode"></div>`;
    this.select = this.el('target') as HTMLSelectElement;
    this.select.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.select.addEventListener('change', () => this.refresh());
    for (const command of ['connect', 'disconnect', 'commission']) {
      this.el(command).addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if ((this.el(command) as HTMLButtonElement).disabled) return;
        action(
          `water-${command}`,
          command === 'commission' ? undefined : this.select.value,
        );
      });
    }
  }
  private el(name: string): HTMLElement {
    return this.root.querySelector(`[data-water="${name}"]`)!;
  }
  update(id: number, sim: SimView): void {
    this.id = id;
    this.sim = sim;
    const node = sim.waterNetwork.nodes.find((n) => n.id === id);
    this.root.style.display = node ? '' : 'none';
    if (!node) return;
    const targets = sim.waterNetwork.nodes.filter((n) => n.id !== id);
    const signature = targets.map((n) => `${n.id}:${n.label}`).join('|');
    if (signature !== this.signature) {
      const selected = this.select.value;
      this.select.replaceChildren(
        ...targets.map((n) => {
          const option = document.createElement('option');
          option.value = String(n.id);
          option.textContent = n.label;
          return option;
        }),
      );
      if (targets.some((n) => String(n.id) === selected))
        this.select.value = selected;
      this.signature = signature;
    }
    this.refresh();
  }
  private refresh(): void {
    const sim = this.sim,
      network = sim.waterNetwork;
    const node = network.nodes.find((n) => n.id === this.id);
    if (!node) return;
    const target = network.nodes.find(
      (n) => String(n.id) === this.select.value,
    );
    const link = network.links.find(
      (l) =>
        (l.a === this.id && l.b === target?.id) ||
        (l.b === this.id && l.a === target?.id),
    );
    const distance = target
      ? Math.hypot(node.x - target.x, node.z - target.z)
      : 0;
    const cost = Math.max(1, Math.ceil(distance / WATER_PIPE_LENGTH));
    this.el('status').textContent = node.status;
    this.el('status').className =
      `note ${network.active && node.status !== 'Supplied' ? 'warn' : ''}`;
    this.el('buffer').textContent = network.active
      ? `Local buffer: ${node.water.toFixed(2)} / ${node.capacity.toFixed(0)} kg. Stored water remains usable without a pump.`
      : `Shared reserve: ${sim.pools.amounts.water.toFixed(1)} kg. Local capacity: ${node.capacity.toFixed(0)} kg.`;
    this.el('cost').textContent = target
      ? `${distance.toFixed(0)} m · ${cost} pipes · ${sim.components.pipe} in stock${distance > WATER_PIPE_MAX_RUN ? ' · too far (200 m max)' : ''}`
      : 'No other online water ports.';
    (this.el('connect') as HTMLButtonElement).disabled =
      !target ||
      !!link ||
      cost > sim.components.pipe ||
      distance > WATER_PIPE_MAX_RUN;
    (this.el('disconnect') as HTMLButtonElement).disabled = !link;
    this.el('disconnect').title =
      'Recover half the pipe sections (rounded down); excess salvage is lost if the rack is full.';
    this.el('flow').textContent = link
      ? `Connected · ${Math.abs(link.flowKgHour).toFixed(2)} kg/h${link.flowKgHour ? (link.flowKgHour > 0 === (link.a === this.id) ? ' outgoing' : ' incoming') : ' · no transfer'}`
      : 'No pipe to this destination. Pipes can branch through any water port.';
    this.el('commission').style.display = network.active ? 'none' : '';
    (this.el('commission') as HTMLButtonElement).disabled =
      !!network.commissionReason;
    this.el('mode').textContent = network.active
      ? 'Network commissioned. Every new water building needs a pipe. Cyan links carry flow; amber ports need attention. Tank damage or demolition loses its stored water. EVA water is provisioned from the pod.'
      : `Temporary shared plumbing keeps life support running while you manufacture and lay pipes. Commissioning is permanent and preserves the reserve across local tanks. ${network.commissionReason || 'Ready — connect and power checks passed.'}`;
  }
}
