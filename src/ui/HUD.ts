/**
 * The DOM HUD.
 *
 * TDD §18: DOM/CSS for menus and info-heavy panels. This layer only ever
 * *reads* the simulation — every mutation goes back through a callback so the
 * sim stays the single source of truth.
 *
 * Performance note: rebuilding innerHTML every frame at 60 fps is what makes
 * browser HUDs feel sluggish. Panels here are built once and then patched
 * field-by-field through cached element references.
 */

import type { BuildingKind, ResourceId, FluidId } from '../sim/defs';
import {
  BUILDINGS,
  BUILDING_ORDER,
  RESOURCES,
  ALL_RESOURCES,
  ALL_FLUIDS,
  FLUIDS,
  ROVERS,
} from '../sim/defs';
import type { Building, Rover, Simulation, Colonist } from '../sim/Simulation';
import { roverStatusText, colonistStatusText } from '../sim/Simulation';
import { stormLabel } from '../sim/weather';
import {
  POWER_TIER_LABELS,
  SUIT_O2_CAPACITY,
  SOL_SECONDS,
  BUILDING_MAX_HEALTH,
} from '../sim/config';
import type { PowerTier } from '../sim/config';
import type { Alert, Severity } from '../sim/alerts';

export type OverlayMode = 'none' | 'power' | 'life' | 'weather';

export interface HUDCallbacks {
  onSpeed: (idx: number) => void;
  onPickBuild: (kind: BuildingKind | null) => void;
  onAction: (action: string, arg?: number | string) => void;
  onStart: (seedText: string, near: number) => void;
  onOverlay: (mode: OverlayMode) => void;
}

const fmtKg = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(1)} t` : `${Math.round(n)} kg`;

/** "1.4 sols", "12 h", "42 min" — whichever reads best at this magnitude. */
function fmtDuration(sols: number): string {
  if (!Number.isFinite(sols)) return 'stable';
  if (sols >= 2) return `${sols.toFixed(1)} sols`;
  const hours = sols * 24.66;
  if (hours >= 2) return `${hours.toFixed(1)} h`;
  return `${Math.max(0, Math.round(hours * 60))} min`;
}

function fmtRate(n: number): string {
  const sign = n > 0.001 ? '+' : '';
  if (Math.abs(n) < 0.005) return '±0';
  return `${sign}${n.toFixed(2)}`;
}

function severityIcon(s: Severity): string {
  switch (s) {
    case 'crit':
      return '⛔';
    case 'warn':
      return '⚠';
    case 'opportunity':
      return '✦';
    case 'ok':
      return '✓';
    default:
      return 'ⓘ';
  }
}

export class HUD {
  private root: HTMLElement;
  cb: HUDCallbacks;
  speedIdx = 1;
  activeBuild: BuildingKind | null = null;
  overlay: OverlayMode = 'none';

  // cached element references — built once, patched thereafter
  private els: Record<string, HTMLElement> = {};
  private speedBtns: HTMLElement[] = [];
  private buildBtns = new Map<BuildingKind, HTMLElement>();
  private overlayBtns = new Map<OverlayMode, HTMLElement>();
  private resChips = new Map<ResourceId, { val: HTMLElement; bar: HTMLElement; wrap: HTMLElement }>();
  private fluidRows = new Map<
    FluidId,
    { val: HTMLElement; bar: HTMLElement; rate: HTMLElement; eta: HTMLElement; row: HTMLElement }
  >();
  private tierRows = new Map<PowerTier, { bar: HTMLElement; val: HTMLElement; row: HTMLElement }>();

  /** Signature of the last inspector render, so we only rebuild on real change. */
  private inspectorKey = '';
  private alertKey = '';

  constructor(cb: HUDCallbacks) {
    this.cb = cb;
    this.root = document.getElementById('app')!;
    this.buildChrome();
    this.buildPalette();
    this.setSpeed(1);
  }

  private el(id: string): HTMLElement {
    let e = this.els[id];
    if (!e) {
      e = document.getElementById(id)!;
      this.els[id] = e;
    }
    return e;
  }

  // ------------------------------------------------------------ chrome ----
  private buildChrome(): void {
    const d = document.createElement('div');
    d.className = 'hud';
    d.innerHTML = `
      <div class="panel" id="topbar">
        <div class="brand">
          <b>RED FRONTIER</b>
          <span id="clock-line">Sol 1 · 08:00</span>
        </div>
        <div class="sunwrap" id="sunwrap" title="Solar irradiance across the sol">
          <div class="sundial"><div class="sun-dot" id="sun-dot"></div></div>
          <div class="sun-meta"><span id="phase-label">Morning</span><span id="irr-label">0%</span></div>
        </div>
        <div class="resources" id="resources"></div>
        <div class="toolbar" id="speeds"></div>
      </div>

      <div class="panel" id="vitals">
        <div class="vitals-head">
          <span class="vh-title">Colony vitals</span>
          <span class="vh-sub" id="vitals-sub"></span>
        </div>
        <div id="power-block">
          <div class="pw-top">
            <div class="pw-num"><span class="pw-k">Generation</span><span class="pw-v" id="pw-gen">0 kW</span></div>
            <div class="pw-num"><span class="pw-k">Load</span><span class="pw-v" id="pw-load">0 kW</span></div>
            <div class="pw-num"><span class="pw-k">Battery</span><span class="pw-v" id="pw-bat">0%</span></div>
          </div>
          <div class="bar-wrap tall"><div class="bar-fill amber" id="pw-batbar" style="width:0%"></div></div>
          <div class="pw-flow" id="pw-flow">—</div>
          <canvas id="pw-graph" class="graph" width="260" height="42"></canvas>
          <div class="tiers" id="tiers"></div>
        </div>
        <div class="vdivide"></div>
        <div id="wx-block">
          <div class="wx-head">
            <span class="vh-title">Weather</span>
            <span class="wx-badge" id="wx-badge">Clear</span>
          </div>
          <div class="wx-grid">
            <div class="wx-cell" title="Wind speed and bearing. Storm winds damage exposed structures.">
              <span class="k">Wind</span>
              <span class="wx-wind"><i class="wx-arrow" id="wx-arrow"></i><span class="v" id="wx-wind">—</span></span>
            </div>
            <div class="wx-cell" title="Airborne dust. Dims the sun for panels and crops alike.">
              <span class="k">Dust</span>
              <span class="wx-bar"><i id="wx-dust-bar" style="width:0%"></i></span>
            </div>
            <div class="wx-cell" title="Visibility. Storm haze closes the world in.">
              <span class="k">Visibility</span>
              <span class="wx-bar"><i id="wx-vis-bar" style="width:100%"></i></span>
            </div>
          </div>
          <div class="wx-status" id="wx-status">Clear skies.</div>
        </div>
        <div class="vdivide"></div>
        <div id="life-block"></div>
        <div class="vdivide"></div>
        <div id="crew-block">
          <div class="crew-head"><span id="crew-name">Cmdr. Vega</span><span id="crew-status">Sheltered</span></div>
          <div class="stat"><span class="k">Health</span><span class="v" id="crew-health">100%</span></div>
          <div class="bar-wrap"><div class="bar-fill green" id="crew-hp-bar" style="width:100%"></div></div>
          <div class="stat"><span class="k">Suit O₂</span><span class="v" id="crew-suit">100%</span></div>
          <div class="bar-wrap"><div class="bar-fill cyan" id="crew-suit-bar" style="width:100%"></div></div>
        </div>
      </div>

      <div class="panel" id="alerts"></div>
      <div class="panel" id="inspector"><div class="empty">Select a rover, a building, or your colonist.</div></div>
      <div class="panel" id="buildbar"></div>
      <div class="panel" id="hintbar" style="display:none"></div>
      <div class="panel" id="log"><span class="lg-title">Colony log</span></div>

      <div class="overlay" id="start-overlay">
        <h1>RED FRONTIER</h1>
        <div class="tag">
          One human. A handful of machines. An entire planet that doesn’t want you there.<br/>
          <b>Prototype 3</b> — power grids, the Mars sol, the water → oxygen → food chain that keeps a person alive,
          and the wind, dust and storms that test all of it.
        </div>
        <div class="actions">
          <label>World seed
            <input id="seed-input" type="text" value="mars2066" /></label>
          <label>Starter deposits nearby
            <select id="near-select">
              <option value="0.2">Standard</option>
              <option value="0.34">Plentiful</option>
              <option value="0.08">Scarce</option>
            </select></label>
          <button class="btn primary" id="start-btn">Begin Mission</button>
        </div>
        <div class="briefing">
          <b>Sol 1 briefing.</b> Your descent stage carries an RTG, a few sols of air, water and rations, and
          two rovers. Everything after that you build. The chain is
          <span class="chain">ice → <span class="c-w">water</span> → <span class="c-o">oxygen</span></span>, and
          a greenhouse to close the food loop. Solar dies every night — batteries are what get you to morning.
        </div>
      </div>

      <div class="overlay" id="end-overlay" style="display:none">
        <h1 id="end-title">MISSION LOST</h1>
        <div class="tag" id="end-text"></div>
        <div class="actions"><button class="btn primary" id="end-restart">Return to start</button></div>
      </div>

      <div id="save-flash"></div>
    `;
    this.root.appendChild(d);

    this.buildResourceChips();
    this.buildLifeBlock();
    this.buildTierRows();
    this.buildSpeeds();
    this.buildOverlayToggles();

    this.el('start-btn').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const seed = (this.el('seed-input') as HTMLInputElement).value;
      const near = parseFloat((this.el('near-select') as HTMLSelectElement).value) || 0.2;
      this.cb.onStart(seed, near);
    });
    this.el('end-restart').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      window.location.reload();
    });
  }

  private buildResourceChips(): void {
    const wrap = this.el('resources');
    wrap.innerHTML = '';
    for (const r of ALL_RESOURCES) {
      const info = RESOURCES[r];
      const chip = document.createElement('div');
      chip.className = 'res-chip';
      chip.title = `${info.label} — ${info.description}`;
      chip.innerHTML = `
        <span class="swatch" style="background:#${info.color.toString(16).padStart(6, '0')}"></span>
        <span class="rc-body">
          <span class="n">0</span>
          <span class="mini-bar"><i style="width:0%"></i></span>
        </span>`;
      wrap.appendChild(chip);
      this.resChips.set(r, {
        val: chip.querySelector('.n') as HTMLElement,
        bar: chip.querySelector('.mini-bar i') as HTMLElement,
        wrap: chip,
      });
    }
  }

  private buildLifeBlock(): void {
    const block = this.el('life-block');
    block.innerHTML = '';
    for (const f of ALL_FLUIDS) {
      const info = FLUIDS[f];
      const row = document.createElement('div');
      row.className = 'life-row';
      row.title = info.description;
      row.innerHTML = `
        <div class="lr-head">
          <span class="lr-name"><i class="dot" style="background:${info.cssColor}"></i>${info.label}</span>
          <span class="lr-val">0</span>
        </div>
        <div class="bar-wrap"><div class="bar-fill" style="background:${info.cssColor};width:0%"></div></div>
        <div class="lr-foot"><span class="lr-rate">±0 kg/sol</span><span class="lr-eta"></span></div>`;
      block.appendChild(row);
      this.fluidRows.set(f, {
        val: row.querySelector('.lr-val') as HTMLElement,
        bar: row.querySelector('.bar-fill') as HTMLElement,
        rate: row.querySelector('.lr-rate') as HTMLElement,
        eta: row.querySelector('.lr-eta') as HTMLElement,
        row,
      });
    }
  }

  private buildTierRows(): void {
    const wrap = this.el('tiers');
    wrap.innerHTML = '';
    for (const tier of [0, 1, 2, 3] as PowerTier[]) {
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.title = `Priority ${tier} — ${POWER_TIER_LABELS[tier]}. Higher tiers are shed first.`;
      row.innerHTML = `
        <span class="t-name">${POWER_TIER_LABELS[tier]}</span>
        <span class="t-bar"><i style="width:100%"></i></span>
        <span class="t-val">—</span>`;
      wrap.appendChild(row);
      this.tierRows.set(tier, {
        bar: row.querySelector('.t-bar i') as HTMLElement,
        val: row.querySelector('.t-val') as HTMLElement,
        row,
      });
    }
  }

  private buildSpeeds(): void {
    const speeds = document.createElement('div');
    speeds.className = 'toolbar';
    const labels = ['❚❚', '1×', '2×', '4×'];
    const tips = ['Pause (Space)', '1× speed', '2× speed', '4× speed'];
    labels.forEach((l, i) => {
      const b = document.createElement('button');
      b.className = 'btn speed-btn';
      b.textContent = l;
      b.title = tips[i];
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setSpeed(i);
        this.cb.onSpeed(i);
      });
      speeds.appendChild(b);
      this.speedBtns.push(b);
    });
    this.el('speeds').replaceChildren(speeds);
  }

  private buildOverlayToggles(): void {
    const wrap = document.createElement('div');
    wrap.className = 'overlay-toggles';
    const modes: Array<[OverlayMode, string, string]> = [
      ['none', '◻', 'No overlay (V)'],
      ['power', '⚡', 'Power overlay — generation, load and reach (V)'],
      ['life', '💧', 'Life-support overlay — fluid producers and consumers (V)'],
      ['weather', '🌪', 'Weather overlay — array cleanliness and storm damage (V)'],
    ];
    for (const [mode, icon, tip] of modes) {
      const b = document.createElement('button');
      b.className = 'btn ov-btn';
      b.textContent = icon;
      b.title = tip;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.setOverlay(mode);
        this.cb.onOverlay(mode);
      });
      wrap.appendChild(b);
      this.overlayBtns.set(mode, b);
    }
    this.el('vitals').appendChild(wrap);
    this.setOverlay('none');
  }

  setOverlay(mode: OverlayMode): void {
    this.overlay = mode;
    for (const [m, btn] of this.overlayBtns) btn.classList.toggle('active', m === mode);
  }

  cycleOverlay(): OverlayMode {
    const order: OverlayMode[] = ['none', 'power', 'life', 'weather'];
    const next = order[(order.indexOf(this.overlay) + 1) % order.length];
    this.setOverlay(next);
    return next;
  }

  // ----------------------------------------------------------- palette ----
  private buildPalette(): void {
    const bar = this.el('buildbar');
    BUILDING_ORDER.forEach((k, i) => {
      const def = BUILDINGS[k];
      const btn = document.createElement('button');
      btn.className = 'build-btn';
      const costTxt = ALL_RESOURCES.filter((r) => def.cost[r] > 0)
        .map((r) => `${Math.round(def.cost[r])} ${RESOURCES[r].short}`)
        .join(' · ');
      const power =
        def.powerProduceKw > 0
          ? `+${def.powerProduceKw} kW`
          : def.powerDrawKw > 0
            ? `−${def.powerDrawKw} kW`
            : def.batteryKWh
              ? `${def.batteryKWh} kWh`
              : '';
      btn.title = `${def.label} — ${def.description}\n\nCost: ${costTxt}${power ? `\nPower: ${power}` : ''}${def.process ? `\nProcess: ${def.process.summary}` : ''}`;
      btn.innerHTML = `
        <span class="ic">${iconFor(k)}</span>
        <span class="bl">${def.label}</span>
        <span class="cost">${costTxt}</span>
        ${power ? `<span class="pw">${power}</span>` : ''}
        ${i < 9 ? `<span class="key">${i + 1}</span>` : ''}`;
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const active = this.activeBuild === k;
        this.cb.onPickBuild(active ? null : k);
      });
      bar.appendChild(btn);
      this.buildBtns.set(k, btn);
    });
  }

  setBuild(kind: BuildingKind | null): void {
    this.activeBuild = kind;
    for (const [k, btn] of this.buildBtns) btn.classList.toggle('active', kind === k);
  }

  /** Grey out anything the colony cannot currently afford. */
  updateAffordability(sim: Simulation): void {
    for (const [k, btn] of this.buildBtns) {
      const def = BUILDINGS[k];
      let affordable = true;
      for (const r of ALL_RESOURCES) {
        if (def.cost[r] > 0 && sim.storage[r] < def.cost[r]) {
          affordable = false;
          break;
        }
      }
      btn.classList.toggle('unaffordable', !affordable);
    }
  }

  setSpeed(idx: number): void {
    this.speedIdx = idx;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  // ------------------------------------------------------------ vitals ----
  updateVitals(sim: Simulation): void {
    // ---- clock & sun ----
    this.el('clock-line').textContent = sim.clock.format();
    this.el('phase-label').textContent = sim.clock.phase();
    const irr = sim.sun.irradiance;
    this.el('irr-label').textContent = `${Math.round(irr * 100)}% sun`;
    const dot = this.el('sun-dot');
    // Trace the sun along a half-dome: left at dawn, top at noon, right at dusk.
    const ang = Math.PI * (1 - sim.clock.frac * 2 + 0.5);
    dot.style.left = `${50 + Math.cos(ang) * 42}%`;
    dot.style.bottom = `${Math.max(2, Math.sin(ang) * 78)}%`;
    dot.classList.toggle('night', !sim.sun.isDay);

    // ---- resources ----
    const cap = sim.storageCapacity();
    for (const r of ALL_RESOURCES) {
      const ref = this.resChips.get(r)!;
      const v = sim.storage[r];
      ref.val.textContent = Math.round(v).toLocaleString();
      const pct = cap > 0 ? Math.min(100, (v / cap) * 100) : 0;
      ref.bar.style.width = `${pct}%`;
      ref.wrap.classList.toggle('full', pct >= 99.5);
    }

    // ---- power ----
    const p = sim.power;
    this.el('pw-gen').textContent = `${p.generationKw.toFixed(1)} kW`;
    this.el('pw-load').textContent = `${p.servedKw.toFixed(1)} kW`;
    const batPct = p.capacityKWh > 0 ? (p.storedKWh / p.capacityKWh) * 100 : 0;
    this.el('pw-bat').textContent = `${Math.round(batPct)}%`;
    const bar = this.el('pw-batbar');
    bar.style.width = `${Math.max(0, Math.min(100, batPct))}%`;
    bar.className = `bar-fill ${batPct < 15 ? 'red' : batPct < 40 ? 'amber' : 'green'}`;

    const flow = this.el('pw-flow');
    if (p.batteryFlowKw > 0.05) {
      const full = p.capacityKWh - p.storedKWh;
      const hrs = full / p.batteryFlowKw;
      flow.textContent = `Charging ${p.batteryFlowKw.toFixed(1)} kW · full in ${fmtDuration(hrs / 24.66)}`;
      flow.className = 'pw-flow good';
    } else if (p.batteryFlowKw < -0.05) {
      const hrs = p.storedKWh / -p.batteryFlowKw;
      flow.textContent = `Draining ${(-p.batteryFlowKw).toFixed(1)} kW · empty in ${fmtDuration(hrs / 24.66)}`;
      flow.className = `pw-flow ${hrs < 3 ? 'bad' : 'warn'}`;
    } else if (p.curtailedKw > 0.05) {
      flow.textContent = `Batteries full · ${p.curtailedKw.toFixed(1)} kW curtailed`;
      flow.className = 'pw-flow dim';
    } else {
      flow.textContent = 'Grid balanced';
      flow.className = 'pw-flow dim';
    }

    for (const tier of [0, 1, 2, 3] as PowerTier[]) {
      const ref = this.tierRows.get(tier)!;
      const demand = p.tierDemand[tier];
      const sat = p.tierSatisfaction[tier];
      if (demand <= 0.001) {
        ref.bar.style.width = '0%';
        ref.val.textContent = '—';
        ref.row.className = 'tier-row idle';
      } else {
        ref.bar.style.width = `${sat * 100}%`;
        ref.val.textContent = `${(demand * sat).toFixed(1)}/${demand.toFixed(1)} kW`;
        ref.row.className = `tier-row ${sat < 0.995 ? (tier <= 1 ? 'crit' : 'shed') : 'ok'}`;
      }
    }

    this.drawPowerGraph(sim);

    // ---- weather ----
    const wx = sim.weather;
    const badge = this.el('wx-badge');
    badge.textContent = stormLabel(wx.storm);
    badge.className = `wx-badge ${
      wx.storm === 'calm' ? '' : wx.storm === 'severe' || wx.storm === 'planetary' ? 'crit' : 'warn'
    }`;
    this.el('wx-wind').textContent = `${Math.round(wx.windSpeed)} m/s`;
    // The arrow points the way the wind blows (world +Z reads as "up").
    this.el('wx-arrow').style.transform = `rotate(${(wx.windDirRad * 180) / Math.PI}deg)`;
    this.el('wx-dust-bar').style.width = `${Math.round(wx.dust * 100)}%`;
    this.el('wx-vis-bar').style.width = `${Math.round(wx.visibility * 100)}%`;

    const wxStatus = this.el('wx-status');
    const fc = wx.forecast();
    const active = wx.current();
    if (active) {
      wxStatus.textContent = `${stormLabel(active.kind)} — passing in ${fmtDuration(
        wx.passesIn() / SOL_SECONDS,
      )}. Rovers are sheltering.`;
      wxStatus.className = 'wx-status bad';
    } else if (fc) {
      wxStatus.textContent = `${fc.label} forecast — arriving in ~${fmtDuration(
        fc.arrivesIn / SOL_SECONDS,
      )}. Charge batteries, shelter the crews.`;
      wxStatus.className = 'wx-status warn';
    } else {
      wxStatus.textContent = `Clear skies · ${Math.round(wx.solarTransmission * 100)}% sunlight through the dust`;
      wxStatus.className = 'wx-status';
    }

    // ---- life support ----
    for (const f of ALL_FLUIDS) {
      const ref = this.fluidRows.get(f)!;
      const amount = sim.pools.amounts[f];
      const capacity = sim.pools.capacity[f];
      ref.val.textContent = `${amount.toFixed(1)} / ${Math.round(capacity)} kg`;
      const pct = capacity > 0 ? (amount / capacity) * 100 : 0;
      ref.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

      const rate = sim.netRatePerSol(f);
      ref.rate.textContent = `${fmtRate(rate)} kg/sol`;
      ref.rate.className = `lr-rate ${rate > 0.005 ? 'good' : rate < -0.005 ? 'bad' : 'dim'}`;

      const reserve = sim.reserveSols(f);
      if (!Number.isFinite(reserve)) {
        ref.eta.textContent = rate > 0.005 ? 'gaining' : 'stable';
        ref.eta.className = 'lr-eta dim';
      } else {
        ref.eta.textContent = `empty in ${fmtDuration(reserve)}`;
        ref.eta.className = `lr-eta ${reserve < 1 ? 'bad' : reserve < 3 ? 'warn' : 'dim'}`;
      }
      ref.row.classList.toggle('depleted', amount <= 0.01);
    }

    // ---- crew ----
    const c = sim.colonist;
    this.el('crew-name').textContent = c.name;
    this.el('crew-status').textContent = colonistStatusText(c);
    this.el('crew-health').textContent = `${Math.round(c.health)}%`;
    const hp = this.el('crew-hp-bar');
    hp.style.width = `${c.health}%`;
    hp.className = `bar-fill ${c.health < 35 ? 'red' : c.health < 70 ? 'amber' : 'green'}`;
    const suitPct = (c.suitO2 / SUIT_O2_CAPACITY) * 100;
    this.el('crew-suit').textContent = c.inside ? 'Docked · 100%' : `${Math.round(suitPct)}%`;
    const sb = this.el('crew-suit-bar');
    sb.style.width = `${Math.max(0, Math.min(100, suitPct))}%`;
    sb.className = `bar-fill ${suitPct < 30 ? 'red' : suitPct < 60 ? 'amber' : 'cyan'}`;

    const online = sim.buildings.filter((b) => b.state === 'online').length;
    const sites = sim.buildings.length - online;
    this.el('vitals-sub').textContent = `${online} online${sites ? ` · ${sites} building` : ''}`;
  }

  /** Small generation/load sparkline. Canvas beats 120 DOM nodes here. */
  private drawPowerGraph(sim: Simulation): void {
    const canvas = this.el('pw-graph') as unknown as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hist = sim.history;
    if (hist.length < 2) return;

    let max = 1;
    for (const s of hist) max = Math.max(max, s.genKw, s.loadKw);
    max *= 1.15;

    const xAt = (i: number) => (i / (hist.length - 1)) * w;
    const yAt = (v: number) => h - (v / max) * (h - 4) - 2;

    // battery level as a filled band behind the lines
    ctx.beginPath();
    ctx.moveTo(0, h);
    hist.forEach((s, i) => ctx.lineTo(xAt(i), h - s.storedFrac * (h - 4) - 2));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 190, 90, 0.13)';
    ctx.fill();

    const line = (pick: (s: (typeof hist)[number]) => number, color: string) => {
      ctx.beginPath();
      hist.forEach((s, i) => {
        const x = xAt(i);
        const y = yAt(pick(s));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    line((s) => s.genKw, '#ffd479');
    line((s) => s.loadKw, '#6fd3ff');
  }

  // ------------------------------------------------------------ alerts ----
  updateAlerts(alerts: Alert[]): void {
    const key = alerts.map((a) => `${a.key}:${a.severity}:${a.detail}`).join('|');
    if (key === this.alertKey) return;
    this.alertKey = key;

    const wrap = this.el('alerts');
    if (alerts.length === 0) {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    wrap.style.display = 'flex';
    wrap.innerHTML = alerts
      .slice(0, 6)
      .map(
        (a) => `
        <div class="alert ${a.severity}" ${a.entityId ? `data-focus="${a.entityId}"` : ''}>
          <span class="a-ic">${severityIcon(a.severity)}</span>
          <span class="a-body"><b>${a.title}</b><span>${a.detail}</span></span>
        </div>`,
      )
      .join('');
    wrap.querySelectorAll('[data-focus]').forEach((n) =>
      n.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.cb.onAction('focus', Number((n as HTMLElement).dataset.focus));
      }),
    );
  }

  // --------------------------------------------------------- inspector ----
  clearInspector(): void {
    if (this.inspectorKey === 'empty') return;
    this.inspectorKey = 'empty';
    this.el('inspector').innerHTML = `
      <div class="empty">
        Select a <b>rover</b>, a <b>building</b>, or your <b>colonist</b>.<br/><br/>
        With a rover selected, tap a deposit to mine it or the ground to move.
        Idle rovers automatically fetch whatever your build queue is short of.
      </div>`;
  }

  showRover(r: Rover, sim: Simulation): void {
    const def = ROVERS[r.kind];
    const mass = ALL_RESOURCES.reduce((s, k) => s + r.cargo[k], 0);
    const key = `rover:${r.id}`;
    const insp = this.el('inspector');

    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-head"><h3>${r.label}</h3><span class="i-id">#${r.id}</span></div>
        <div class="sub">${def.role}</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="i-status">—</span></div>
        <div class="stat"><span class="k">Battery</span><span class="v" id="i-bat">—</span></div>
        <div class="bar-wrap"><div class="bar-fill cyan" id="i-batbar"></div></div>
        <div class="stat"><span class="k">Cargo</span><span class="v" id="i-cargo">—</span></div>
        <div class="bar-wrap"><div class="bar-fill green" id="i-cargobar"></div></div>
        <div class="chips" id="i-chips"></div>
        <label class="toggle" id="i-auto-wrap">
          <input type="checkbox" id="i-auto" /> <span>Auto-haul when idle</span>
        </label>
        <div class="action-grid">
          <button class="btn" data-act="stop">Stop</button>
          <button class="btn" data-act="recenter">Focus</button>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((b) =>
        b.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.cb.onAction((b as HTMLElement).dataset.act!);
        }),
      );
      const auto = insp.querySelector('#i-auto') as HTMLInputElement;
      auto.addEventListener('change', () => this.cb.onAction('autohaul', auto.checked ? 1 : 0));
    }

    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    q('i-status').textContent = roverStatusText(r) + (r.autoTask ? ' (auto)' : '');
    q('i-bat').textContent = `${r.battery.toFixed(1)} / ${def.maxBatteryKWh} kWh`;
    const bpct = (r.battery / def.maxBatteryKWh) * 100;
    const bb = q('i-batbar');
    bb.style.width = `${Math.max(0, Math.min(100, bpct))}%`;
    bb.className = `bar-fill ${bpct < 20 ? 'red' : bpct < 45 ? 'amber' : 'cyan'}`;
    q('i-cargo').textContent = `${Math.round(mass)} / ${def.capacityKg} kg`;
    q('i-cargobar').style.width = `${Math.min(100, (mass / def.capacityKg) * 100)}%`;
    q('i-chips').innerHTML =
      ALL_RESOURCES.filter((res) => r.cargo[res] > 0.5)
        .map(
          (res) =>
            `<span class="chip"><i style="background:#${RESOURCES[res].color.toString(16).padStart(6, '0')}"></i>${RESOURCES[res].short} ${Math.round(r.cargo[res])}</span>`,
        )
        .join('') || '<span class="dim">Cargo bay empty</span>';
    const auto = insp.querySelector('#i-auto') as HTMLInputElement;
    if (auto && auto.checked !== r.autoHaul) auto.checked = r.autoHaul;
  }

  showBuilding(b: Building, sim: Simulation): void {
    const def = BUILDINGS[b.kind];
    const key = `bld:${b.id}`;
    const insp = this.el('inspector');

    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-head"><h3>${def.label}</h3><span class="i-id">#${b.id}</span></div>
        <div class="sub">${def.description}</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="b-state">—</span></div>
        <div id="b-progress-wrap" style="display:none">
          <div class="bar-wrap"><div class="bar-fill amber" id="b-progress"></div></div>
        </div>
        <div id="b-body"></div>
        <div class="action-grid" id="b-actions">
          <button class="btn" data-act="service" id="b-service">Clean panels</button>
          <button class="btn" data-act="toggle" id="b-toggle">Switch off</button>
          <button class="btn danger" data-act="demolish">Dismantle</button>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((n) =>
        n.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.cb.onAction((n as HTMLElement).dataset.act!);
        }),
      );
    }

    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    const state =
      b.state === 'online'
        ? b.enabled
          ? 'Online'
          : 'Offline (switched off)'
        : b.state === 'building'
          ? `Assembling — ${Math.round(b.progress * 100)}%`
          : b.needsMaterials
            ? 'Awaiting materials'
            : 'Ready to assemble';
    q('b-state').textContent = state;
    q('b-state').className = `v ${b.state === 'online' && b.enabled ? 'good' : b.needsMaterials ? 'warn' : ''}`;

    const pw = q('b-progress-wrap');
    if (b.state !== 'online') {
      pw.style.display = 'block';
      q('b-progress').style.width = `${b.progress * 100}%`;
    } else {
      pw.style.display = 'none';
    }

    const rows: string[] = [];
    if (b.state !== 'online') {
      const need = ALL_RESOURCES.filter((r) => b.remainingCost[r] > 0.5);
      rows.push(
        `<div class="stat"><span class="k">Still needs</span><span class="v">${
          need.length
            ? need.map((r) => `${Math.ceil(b.remainingCost[r])} ${RESOURCES[r].short}`).join(', ')
            : '— fully stocked'
        }</span></div>`,
      );
    } else {
      if (def.powerProduceKw > 0) {
        const clean = def.generation === 'solar' ? b.cleanliness : 1;
        rows.push(
          `<div class="stat"><span class="k">Generating</span><span class="v ${b.genKw > 0.01 ? 'good' : 'warn'}">${b.genKw.toFixed(1)} / ${def.powerProduceKw} kW</span></div>`,
        );
        if (def.generation === 'solar') {
          const pct = Math.round(clean * 100);
          rows.push(
            `<div class="stat"><span class="k">Panel dust</span><span class="v ${pct < 55 ? 'bad' : pct < 80 ? 'warn' : ''}">${pct}% clean</span></div>`,
            `<div class="bar-wrap"><div class="bar-fill ${pct < 55 ? 'red' : pct < 80 ? 'amber' : 'cyan'}" style="width:${pct}%"></div></div>`,
          );
        }
      }
      if (b.health < BUILDING_MAX_HEALTH - 0.5) {
        const hp = Math.round(b.health);
        rows.push(
          `<div class="stat"><span class="k">Structure</span><span class="v ${b.damaged ? 'bad' : hp < 60 ? 'warn' : ''}">${b.damaged ? 'Damaged — offline' : `${hp}%`}</span></div>`,
          `<div class="bar-wrap"><div class="bar-fill ${b.damaged || hp < 40 ? 'red' : 'amber'}" style="width:${hp}%"></div></div>`,
        );
      }
      if (def.powerDrawKw > 0 || def.idlePowerKw > 0) {
        rows.push(
          `<div class="stat"><span class="k">Drawing</span><span class="v">${b.loadKw.toFixed(1)} kW <span class="dim">· tier ${def.tier}</span></span></div>`,
        );
      }
      if (def.process) {
        const pct = Math.round(b.throughput * 100);
        rows.push(
          `<div class="stat"><span class="k">Throughput</span><span class="v ${pct > 0 ? 'good' : 'warn'}">${pct}%</span></div>`,
          `<div class="bar-wrap"><div class="bar-fill ${pct > 0 ? 'green' : 'amber'}" style="width:${pct}%"></div></div>`,
          `<div class="note">${def.process.summary}</div>`,
        );
        if (b.idleReason) rows.push(`<div class="note warn">⚠ ${b.idleReason}</div>`);
      }
      if (b.powerSat < 0.995) {
        rows.push(
          `<div class="note warn">⚠ Only receiving ${Math.round(b.powerSat * 100)}% of requested power.</div>`,
        );
      }
      if (def.batteryKWh) {
        rows.push(
          `<div class="stat"><span class="k">Grid storage</span><span class="v">+${def.batteryKWh} kWh</span></div>`,
        );
      }
      if (def.storagePerResourceKg) {
        rows.push(
          `<div class="stat"><span class="k">Silo capacity</span><span class="v">+${def.storagePerResourceKg} kg each</span></div>`,
        );
      }
      if (def.fluidCapacity) {
        const t = ALL_FLUIDS.filter((f) => def.fluidCapacity![f])
          .map((f) => `${def.fluidCapacity![f]} kg ${FLUIDS[f].label}`)
          .join(', ');
        if (t) rows.push(`<div class="stat"><span class="k">Tankage</span><span class="v">${t}</span></div>`);
      }
      if (def.pressurized) {
        rows.push(`<div class="note">Pressurised — your colonist can shelter here.</div>`);
      }
    }
    q('b-body').innerHTML = rows.join('');

    const toggle = q('b-toggle') as HTMLButtonElement;
    toggle.style.display = b.state === 'online' ? '' : 'none';
    toggle.textContent = b.enabled ? 'Switch off' : 'Switch on';

    const svc = q('b-service') as HTMLButtonElement;
    const needsRepair = b.state === 'online' && b.health < BUILDING_MAX_HEALTH - 0.5;
    const needsClean =
      b.state === 'online' &&
      BUILDINGS[b.kind].generation === 'solar' &&
      b.cleanliness < 0.995;
    svc.style.display = needsRepair || needsClean ? '' : 'none';
    svc.textContent = needsRepair ? 'Dispatch repair' : 'Clean panels';
  }

  showColonist(c: Colonist, sim: Simulation): void {
    const key = `col:${c.id}`;
    const insp = this.el('inspector');
    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      insp.innerHTML = `
        <div class="i-head"><h3>${c.name}</h3><span class="i-id">Crew</span></div>
        <div class="sub">The only human on the planet.</div>
        <div class="stat"><span class="k">Status</span><span class="v" id="c-status">—</span></div>
        <div class="stat"><span class="k">Health</span><span class="v" id="c-hp">—</span></div>
        <div class="bar-wrap"><div class="bar-fill green" id="c-hpbar"></div></div>
        <div class="stat"><span class="k">Suit O₂</span><span class="v" id="c-suit">—</span></div>
        <div class="bar-wrap"><div class="bar-fill cyan" id="c-suitbar"></div></div>
        <div id="c-needs"></div>
        <div class="note">Right-click the ground to send them on an EVA — the suit carries a fixed
        reserve, so range is limited. They return to shelter automatically when it runs low.</div>
        <div class="action-grid">
          <button class="btn" data-act="shelter">Return to shelter</button>
          <button class="btn" data-act="recenter">Focus</button>
        </div>`;
      insp.querySelectorAll('[data-act]').forEach((n) =>
        n.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.cb.onAction((n as HTMLElement).dataset.act!);
        }),
      );
    }
    const q = (id: string) => insp.querySelector(`#${id}`) as HTMLElement;
    q('c-status').textContent = colonistStatusText(c);
    q('c-hp').textContent = `${Math.round(c.health)}%`;
    const hb = q('c-hpbar');
    hb.style.width = `${c.health}%`;
    hb.className = `bar-fill ${c.health < 35 ? 'red' : c.health < 70 ? 'amber' : 'green'}`;
    const sp = (c.suitO2 / SUIT_O2_CAPACITY) * 100;
    q('c-suit').textContent = c.inside ? 'Docked (refilling)' : `${Math.round(sp)}%`;
    const sb = q('c-suitbar');
    sb.style.width = `${Math.max(0, Math.min(100, sp))}%`;
    sb.className = `bar-fill ${sp < 30 ? 'red' : sp < 60 ? 'amber' : 'cyan'}`;

    const unmet = ALL_FLUIDS.filter((f) => c.starved[f as keyof typeof c.starved]);
    q('c-needs').innerHTML = unmet.length
      ? `<div class="note bad">⛔ Unmet: ${unmet.map((f) => FLUIDS[f].label).join(', ')}</div>`
      : `<div class="note good">✓ All needs met.</div>`;
  }

  // -------------------------------------------------------------- misc ----
  addLog(severity: string, text: string, stamp = '', max = 60): void {
    const log = this.el('log');
    const item = document.createElement('div');
    item.className = `log-item ${severity}`;
    item.innerHTML = `${stamp ? `<span class="ts">${stamp}</span>` : ''}<span>${text}</span>`;
    log.appendChild(item);
    while (log.children.length > max + 1) log.children[1]?.remove();
    log.scrollTop = log.scrollHeight;
  }

  hint(text: string | null): void {
    const h = this.el('hintbar');
    h.style.display = text ? 'flex' : 'none';
    if (text) h.innerHTML = text;
  }

  flashSave(txt = 'Saved'): void {
    const f = this.el('save-flash');
    f.textContent = txt;
    f.style.display = 'block';
    window.setTimeout(() => {
      f.style.display = 'none';
    }, 1800);
  }

  showEnd(title: string, text: string): void {
    this.el('end-title').textContent = title;
    this.el('end-text').textContent = text;
    this.el('end-overlay').style.display = 'flex';
  }
}

function iconFor(k: BuildingKind): string {
  switch (k) {
    case 'habitat':
      return '🏠';
    case 'solar':
      return '☀';
    case 'battery':
      return '🔋';
    case 'warehouse':
      return '📦';
    case 'workshop':
      return '🔧';
    case 'extractor':
      return '💧';
    case 'oxygenator':
      return '🫁';
    case 'greenhouse':
      return '🌱';
    case 'rtg':
      return '☢';
  }
}

export { fmtKg, fmtDuration };
