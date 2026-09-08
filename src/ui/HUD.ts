import type {
  BuildingKind,
  ResourceAmounts,
  ResourceId,
} from '../sim/defs';
import { BUILDINGS, RESOURCES, ALL_RESOURCES } from '../sim/defs';
import type { Building, Rover, Simulation } from '../sim/Simulation';
import { roverStatusText } from '../sim/Simulation';
import { ROVERS } from '../sim/defs';

export interface HUDCallbacks {
  onSpeed: (idx: number) => void;
  onPickBuild: (kind: BuildingKind | null) => void;
  onAction: (action: string) => void;
  onStart: (seedText: string, near: number) => void;
}

const fmtKg = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}t` : `${Math.round(n)} kg`);

export class HUD {
  private root: HTMLElement;
  cb: HUDCallbacks;
  speedIdx = 1;
  private buildKinds: BuildingKind[] = ['warehouse', 'solar', 'battery', 'workshop', 'habitat'];
  activeBuild: BuildingKind | null = null;

  // element refs
  private chips!: HTMLElement;
  private speedBtns: HTMLElement[] = [];
  private buildBtns = new Map<BuildingKind, HTMLElement>();
  private inspector!: HTMLElement;
  private log!: HTMLElement;
  private hintEl!: HTMLElement;
  private saveFlash!: HTMLElement;

  constructor(cb: HUDCallbacks) {
    this.cb = cb;
    this.root = document.getElementById('app')!;
    this.buildChrome();
    this.buildPalette();
    this.setSpeed(1);
  }

  private el(id: string): HTMLElement {
    return document.getElementById(id)!;
  }

  private buildChrome(): void {
    const d = document.createElement('div');
    d.className = 'hud';
    d.innerHTML = `
      <div class="panel" id="topbar">
        <div class="brand"><b>RED FRONTIER</b><span>Prototype 1 · Sol 1 · Mars, 2066</span></div>
        <div class="resources" id="resources"></div>
        <div class="toolbar" id="speeds"></div>
      </div>
      <div class="panel" id="inspector"><div class="empty">Click a rover to inspect it.<br/>Select a rover, then tap a deposit to mine, or the ground to move.</div></div>
      <div class="panel" id="buildbar"></div>
      <div class="panel" id="hintbar" style="display:none"></div>
      <div class="panel" id="log"><span class="lg-title">Colony log</span></div>
      <div class="overlay" id="start-overlay">
        <h1>RED FRONTIER</h1>
        <div class="tag">One human. A handful of machines. An entire planet that doesn’t want you there.<br/>Mine Mars. Build your outpost. Survive. — Prototype 1</div>
        <div class="actions" style="display:flex;flex-direction:column;gap:8px;min-width:260px">
          <label style="display:flex;justify-content:space-between;gap:12px;align-items:center">World seed
            <input id="seed-input" type="text" value="mars2066" style="flex:1;max-width:160px;padding:6px" /></label>
          <label style="display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:12px">Starter deposits nearby
            <select id="near-select" style="padding:6px">
              <option value="0.18">Standard</option><option value="0.3">Plentiful</option><option value="0.05">Scarce</option>
            </select></label>
          <button class="btn primary" id="start-btn">Begin Mission</button>
        </div>
        <div style="font-size:11px;color:var(--ui-text-dim);max-width:460px">
          Drag to rotate camera · mouse wheel to zoom · hold Shift+drag to pan ·
          tap a rover then tap a deposit to mine · build from the palette below.
        </div>
      </div>
      <div id="save-flash" style="position:fixed;right:16px;bottom:16px;color:#7fb46a;font-size:12px;display:none"></div>
    `;
    this.root.appendChild(d);
    this.chips = this.el('resources');
    this.inspector = this.el('inspector');
    this.log = this.el('log');
    this.hintEl = this.el('hintbar');
    this.saveFlash = this.el('save-flash');

    // resource chips
    this.chips.innerHTML = ALL_RESOURCES.map(
      (r) =>
        `<div class="res-chip" title="${RESOURCES[r].description}"><span class="swatch" style="background:#${RESOURCES[r].color.toString(16).padStart(6, '0')}"></span><span class="n" id="chip-${r}">0</span></div>`,
    ).join('');

    // speed buttons
    const speeds = document.createElement('div');
    speeds.className = 'toolbar';
    const labels = ['❚❚', '1×', '2×', '4×'];
    const tooltips = ['Pause', '1× speed', '2× speed', '4× speed'];
    labels.forEach((l, i) => {
      const b = document.createElement('button');
      b.className = 'btn speed-btn';
      b.textContent = l;
      b.title = tooltips[i];
      b.dataset.speed = String(i);
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setSpeed(i);
        this.cb.onSpeed(i);
      });
      speeds.appendChild(b);
      this.speedBtns.push(b);
    });
    this.el('speeds').replaceChildren(speeds);

    this.buildBar = this.el('buildbar');

    // wire the "Begin Mission" flow
    const startBtn = this.el('start-btn');
    if (startBtn) {
      startBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const seed = (this.el('seed-input') as HTMLInputElement).value;
        const near = parseFloat((this.el('near-select') as HTMLSelectElement).value) || 0.18;
        this.cb.onStart(seed, near);
      });
    }
  }

  private buildBar!: HTMLElement;

  private buildPalette(): void {
    const wrap = document.createElement('div');
    wrap.style.display = 'contents';
    this.buildKinds.forEach((k) => {
      const def = BUILDINGS[k];
      const btn = document.createElement('button');
      btn.className = 'build-btn';
      btn.title = def.description;
      const costTxt = (['regolith', 'iron', 'silicon', 'aluminum'] as ResourceId[])
        .filter((r) => def.cost[r] > 0)
        .map((r) => `${Math.round(def.cost[r])}`)
        .join(' · ');
      btn.innerHTML = `<span class="ic">${iconFor(k)}</span><span>${def.label}</span><span class="cost">${costTxt} kg</span>`;
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const active = this.activeBuild === k;
        this.setBuild(null);
        if (!active) this.setBuild(k);
      });
      this.buildBar.appendChild(btn);
      this.buildBtns.set(k, btn);
    });
  }

  setBuild(kind: BuildingKind | null): void {
    this.activeBuild = kind;
    for (const [k, btn] of this.buildBtns) {
      btn.classList.toggle('active', kind === k);
    }
  }

  setSpeed(idx: number): void {
    this.speedIdx = idx;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  updateResources(sim: Simulation): void {
    for (const r of ALL_RESOURCES) {
      this.el(`chip-${r}`).textContent = Math.round(sim.storage[r]).toLocaleString();
    }
  }

  clearInspector(): void {
    this.inspector.innerHTML = `<div class="empty" style="color:var(--ui-text-dim);font-size:12.5px">Click a rover to inspect it.<br/>Select a rover, then tap a deposit to mine, or the ground to move.</div>`;
  }

  showRover(r: Rover, sim: Simulation): void {
    const def = ROVERS[r.kind];
    const mass = cargoSum(r.cargo);
    const status = roverStatusText(r);
    const chips = ALL_RESOURCES.filter((res) => r.cargo[res] > 0)
      .map((res) => `<span style="color:var(--ui-text-dim)">${RESOURCES[res].label} ${Math.round(r.cargo[res])}</span>`)
      .join('  ');
    this.inspector.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
        <h3>${r.label}</h3>
        <span style="font-size:11px;color:var(--ui-text-dim)">#${r.id}</span>
      </div>
      <div class="sub">${def.role}</div>
      <div class="stat"><span class="k">Status</span><span class="v">${status}</span></div>
      <div class="stat"><span class="k">Battery</span><span class="v">${Math.round(r.battery)} / ${def.maxBatteryKWh} kWh</span></div>
      <div class="bar-wrap"><div class="bar-fill blue" style="width:${Math.max(0, Math.min(100, (r.battery / def.maxBatteryKWh) * 100))}%"></div></div>
      <div class="stat"><span class="k">Cargo</span><span class="v">${Math.round(mass)} / ${def.capacityKg} kg</span></div>
      <div class="bar-wrap"><div class="bar-fill green" style="width:${Math.min(100, (mass / def.capacityKg) * 100)}%"></div></div>
      <div style="font-size:11px;color:var(--ui-text-dim);white-space:normal">${chips || 'empty'}</div>
      <div style="margin-top:6px;font-size:11.5px;color:var(--ui-text-dim)">
        Commands: tap a <b style="color:var(--ui-text)">deposit</b> to mine, a <b style="color:var(--ui-text)">warehouse/base</b> to haul when full, or the <b style="color:var(--ui-text)">ground</b> to move.
      </div>
      <div class="action-grid" style="margin-top:8px">
        <button class="btn" data-act="stop">Stop</button>
        <button class="btn" data-act="recenter">Recenter</button>
      </div>
    `;
    const actBtns = this.inspector.querySelectorAll('[data-act]');
    actBtns.forEach((b) =>
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.cb.onAction((b as HTMLElement).dataset.act!);
      }),
    );
  }

  showBuilding(b: Building, sim: Simulation): void {
    const def = BUILDINGS[b.kind];
    const state =
      b.state === 'online'
        ? 'Online'
        : b.state === 'building'
          ? `Building ${Math.round(b.progress * 100)}%`
          : 'Site — awaiting builder';
    const costLeft = remainingStr(b);
    this.inspector.innerHTML = `
      <h3>${def.label}</h3>
      <div class="sub">${def.description}</div>
      <div class="stat"><span class="k">Status</span><span class="v">${state}</span></div>
      <div class="stat"><span class="k">Materials needed</span><span class="v">${costLeft}</span></div>
      <div class="stat"><span class="k">Power</span><span class="v">${def.powerProduceKw ? `+${def.powerProduceKw}` : `−${def.powerDrawKw}`} kW</span></div>
      ${def.storageCapacityKg ? `<div class="stat"><span class="k">Adds storage</span><span class="v">+${def.storageCapacityKg} kg</span></div>` : ''}
      ${b.needsMaterials ? `<div style="color:var(--warn);font-size:12px;margin-top:4px">⚠ Waiting for materials in storage.</div>` : ''}
    `;
  }

  addLog(severity: string, text: string, max = 40): void {
    const item = document.createElement('div');
    item.className = `log-item ${severity}`;
    item.textContent = text;
    this.log.appendChild(item);
    while (this.log.children.length > max + 1) {
      if (this.log.children[1]) this.log.children[1].remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  hint(text: string | null): void {
    this.hintEl.style.display = text ? 'flex' : 'none';
    this.hintEl.textContent = text ?? '';
  }

  flashSave(txt = 'Saved'): void {
    this.saveFlash.textContent = txt;
    this.saveFlash.style.display = 'block';
    window.setTimeout(() => {
      this.saveFlash.style.display = 'none';
    }, 1800);
  }
}

function iconFor(k: BuildingKind): string {
  switch (k) {
    case 'habitat':
      return '🛰';
    case 'solar':
      return '☀';
    case 'battery':
      return '🔋';
    case 'warehouse':
      return '🏭';
    case 'workshop':
      return '🔧';
  }
}

function cargoSum(cargo: ResourceAmounts): number {
  let t = 0;
  for (const k of ALL_RESOURCES) t += cargo[k];
  return t;
}

function remainingStr(b: Building): string {
  const parts: string[] = [];
  for (const r of ALL_RESOURCES) {
    if (b.remainingCost[r] > 0) {
      parts.push(`${Math.round(b.remainingCost[r])} ${RESOURCES[r].label}`);
    }
  }
  return parts.join(', ') || '—';
}

export { fmtKg };
