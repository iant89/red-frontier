/**
 * DashboardPanel — Phase 4 Colony Operations Dashboard.
 *
 * The roadmap's answer to "why is my colony failing?": one overlay that
 * states what the colony is doing — power, the three life-support fluids,
 * the fleet, autonomy, and the historical graphs — without spreadsheet
 * archaeology. Per the review (§5 P4) it is a **pure view**: everything it
 * shows comes from the mirror (`SimView`), nothing writes back, and the
 * advisory "NEXT BOTTLENECK" is deliberately absent — that is P5's panel,
 * keeping description and advice separate (the roadmap's don't-auto-solve
 * principle).
 *
 * Phase 13 teeth (review §5 P13): the single-points-of-failure row — any
 * critical chain with exactly one producer gets a marker. The sim measures
 * it (AutonomySystem resilience); one row here teaches redundancy without a
 * tutorial line.
 *
 * Deterministic: no RNG, no writes. The status card and graph checklists are
 * pure functions ({@link dashboardModelFromView} / {@link renderDashboardHtml})
 * so the copy and the numbers can be pinned in a test without a DOM.
 */

import type { SimView } from '../sim/host';
import type { HistorySample, SolHistoryRow } from '../sim/Simulation';
import type { FluidId } from '../sim/defs';
import { STRINGS } from './strings';

const S = STRINGS as Record<string, string | ((...a: never[]) => string)>;

function str(key: string): string {
  const v = S[key];
  return typeof v === 'string' ? v : key;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ------------------------------------------------------------------ model ----

export type OpsTone = 'ok' | 'warn' | 'crit';
export type OpsStatus = 'stable' | 'warning' | 'critical' | 'operational';

export interface OpsRow {
  id: 'power' | 'water' | 'oxygen' | 'food' | 'rovers' | 'autonomy';
  label: string;
  /** The headline number — `84%`, `4/5`, `6.8 sols`. */
  value: string;
  /** The secondary line — `12.4 kW gen · 9.1 kW load`, `best 8.2 sols`. */
  sub: string;
  status: string;
  tone: OpsTone;
  /** Tooltip carrying the reason for the tone. */
  title: string;
}

export interface OpsCardModel {
  rows: OpsRow[];
  singlePoints: string[];
}

/**
 * The structural slice of `SimView` the dashboard reads. Declared so the
 * model builder is testable without the whole mirror.
 */
export interface OpsViewSource {
  pools: { amounts: Readonly<Record<FluidId, number>>; capacity: Readonly<Record<FluidId, number>> };
  power: {
    generationKw: number;
    demandKw: number;
    servedKw: number;
    storedKWh: number;
    capacityKWh: number;
    brownout: boolean;
    firstShedTier: number | null;
  };
  storedKWh: number;
  rovers: ReadonlyArray<{ phase: string }>;
  autonomy: {
    current: number;
    best: number;
    identity: string;
    singlePoints: ReadonlyArray<string>;
  };
  reserveSols(f: FluidId): number;
  netRatePerSol(f: FluidId): number;
}

/** Fluid status tiers — the same floors the tutorial warnings and AUTONOMY.md B4 use. */
const FLUID_CRIT_SOLS = 1.0;
const FLUID_WARN_SOLS = 2.5;
/** Battery tiers for the power row. */
const BATT_CRIT_FRAC = 0.05;
const BATT_WARN_FRAC = 0.25;

function fluidStatus(reserveSols: number): { status: string; tone: OpsTone; title: string } {
  const reserve = Number.isFinite(reserveSols) ? `${reserveSols.toFixed(1)} sols of reserve` : 'reserve stable or growing';
  if (reserveSols < FLUID_CRIT_SOLS) {
    return { status: str('dashboard.critical'), tone: 'crit', title: `Runs dry inside one sol — ${reserve}.` };
  }
  if (reserveSols < FLUID_WARN_SOLS) {
    return { status: str('dashboard.warning'), tone: 'warn', title: `Depleting — ${reserve}.` };
  }
  return { status: str('dashboard.stable'), tone: 'ok', title: `Stable — ${reserve}.` };
}

function powerStatus(p: OpsViewSource['power'], storedFrac: number): { status: string; tone: OpsTone; title: string } {
  const pct = `${Math.round(storedFrac * 100)}%`;
  if (p.firstShedTier === 0 || storedFrac <= BATT_CRIT_FRAC) {
    return {
      status: str('dashboard.critical'),
      tone: 'crit',
      title: p.firstShedTier === 0 ? 'Life support is shedding power.' : `Battery reserve at ${pct}.`,
    };
  }
  if (p.brownout || storedFrac <= BATT_WARN_FRAC) {
    return {
      status: str('dashboard.warning'),
      tone: 'warn',
      title: p.brownout ? 'Grid is brownout — some tier is not fully served.' : `Battery reserve at ${pct}.`,
    };
  }
  return { status: str('dashboard.stable'), tone: 'ok', title: `Grid healthy — battery ${pct}.` };
}

/** Build the six-row operations card from the view. Pure. */
export function dashboardModelFromView(sim: OpsViewSource): OpsCardModel {
  const rows: OpsRow[] = [];

  const capacityKWh = sim.power.capacityKWh;
  const storedFrac = capacityKWh > 0 ? sim.storedKWh / capacityKWh : 0;
  const pw = powerStatus(sim.power, storedFrac);
  rows.push({
    id: 'power',
    label: str('dashboard.power'),
    value: `${Math.round(storedFrac * 100)}%`,
    sub: STRINGS['dashboard.sub.power'](sim.power.generationKw, sim.power.demandKw),
    status: pw.status,
    tone: pw.tone,
    title: pw.title,
  });

  for (const f of ['water', 'oxygen', 'food'] as const) {
    const amount = sim.pools.amounts[f];
    const capacity = sim.pools.capacity[f];
    const pct = capacity > 0 ? Math.round((amount / capacity) * 100) : 0;
    const st = fluidStatus(sim.reserveSols(f));
    rows.push({
      id: f,
      label: str(`dashboard.${f}`),
      value: `${pct}%`,
      sub: STRINGS['dashboard.sub.fluid'](sim.netRatePerSol(f)),
      status: st.status,
      tone: st.tone,
      title: st.title,
    });
  }

  const total = sim.rovers.length;
  const operational = sim.rovers.filter((r) => r.phase !== 'disabled').length;
  const roverTone: OpsTone = total === 0 ? 'warn' : operational === 0 ? 'crit' : operational < total ? 'warn' : 'ok';
  rows.push({
    id: 'rovers',
    label: str('dashboard.rovers'),
    value: STRINGS['dashboard.sub.rovers'](operational, total),
    sub: str('dashboard.operational').toLowerCase(),
    status: str('dashboard.operational'),
    tone: roverTone,
    title:
      operational === total
        ? `Every rover in the fleet is operational.`
        : `${total - operational} of ${total} rovers are disabled.`,
  });

  const a = sim.autonomy;
  rows.push({
    id: 'autonomy',
    label: str('dashboard.autonomy'),
    value: `${a.current.toFixed(1)} sols`,
    sub: `${a.identity.toUpperCase()} · ${STRINGS['dashboard.bestAutonomy'](a.best)}`,
    status: a.identity.toUpperCase(),
    tone: 'ok',
    title: 'Sols the colony has run without intervention or a life-support breaker.',
  });

  return { rows, singlePoints: [...a.singlePoints] };
}

/** The status card markup. Pure — the test pins this. */
export function renderDashboardHtml(model: OpsCardModel): string {
  let html = `<div class="dash-grid">`;
  for (const r of model.rows) {
    html +=
      `<div class="dash-row tone-${r.tone}" data-ops="${r.id}" title="${esc(r.title)}">` +
      `<span class="dash-label">${esc(r.label)}</span>` +
      `<span class="dash-value-block"><b class="dash-value">${esc(r.value)}</b><span class="dash-sub">${esc(r.sub)}</span></span>` +
      `<span class="dash-status">${esc(r.status)}</span>` +
      `</div>`;
  }
  html += `</div>`;
  const spof = model.singlePoints.length
    ? `<div class="dash-spof warn" title="${esc(model.singlePoints.join(', '))}">` +
      `<b>${esc(str('dashboard.singlePoints'))}</b><span>${esc(model.singlePoints.join(' · '))}</span></div>`
    : `<div class="dash-spof ok"><b>${esc(str('dashboard.singlePoints'))}</b><span>${esc(str('dashboard.noSinglePoints'))}</span></div>`;
  return html + spof;
}

// ----------------------------------------------------------------- graphs ----

export type OpsScope = 'live' | 'sols';

export interface GraphSeriesDef {
  /** Legend label. */
  label: string;
  color: string;
  pick: (s: HistorySample) => number;
  pickSol: (r: SolHistoryRow) => number;
}

export interface GraphDef {
  id: string;
  title: string;
  series: GraphSeriesDef[];
  /** Fixed [0,1] domain for ratio charts; otherwise autoscale to the data. */
  ratio?: boolean;
}

const FLUID_COLORS: Record<FluidId, string> = { water: '#5db8ff', oxygen: '#9fd8ae', food: '#e8c07d' };

/** The roadmap's nine checkboxes, in its order. */
export const GRAPH_DEFS: ReadonlyArray<GraphDef> = [
  {
    id: 'power',
    title: str('dashboard.graph.power'),
    series: [
      { label: str('dashboard.legend.gen'), color: '#ffd479', pick: (s) => s.genKw, pickSol: (r) => r.genKwAvg },
      { label: str('dashboard.legend.load'), color: '#6fd3ff', pick: (s) => s.loadKw, pickSol: (r) => r.loadKwAvg },
    ],
  },
  {
    id: 'water',
    title: str('dashboard.graph.water'),
    series: [{ label: 'kg', color: FLUID_COLORS.water, pick: (s) => s.water, pickSol: (r) => r.water }],
  },
  {
    id: 'oxygen',
    title: str('dashboard.graph.oxygen'),
    series: [{ label: 'kg', color: FLUID_COLORS.oxygen, pick: (s) => s.oxygen, pickSol: (r) => r.oxygen }],
  },
  {
    id: 'food',
    title: str('dashboard.graph.food'),
    series: [{ label: 'kg', color: FLUID_COLORS.food, pick: (s) => s.food, pickSol: (r) => r.food }],
  },
  {
    id: 'ore',
    title: str('dashboard.graph.ore'),
    series: [{ label: 'kg', color: '#c97b4a', pick: (s) => s.ore, pickSol: (r) => r.ore }],
  },
  {
    id: 'utilization',
    title: str('dashboard.graph.utilization'),
    ratio: true,
    series: [{ label: '%', color: '#d3b6ff', pick: (s) => s.roverUtil, pickSol: (r) => r.roverUtilAvg }],
  },
  {
    id: 'battery',
    title: str('dashboard.graph.battery'),
    ratio: true,
    series: [{ label: '%', color: '#ffc85a', pick: (s) => s.storedFrac, pickSol: (r) => r.storedFracMin }],
  },
  {
    id: 'production',
    title: str('dashboard.graph.production'),
    series: (['water', 'oxygen', 'food'] as const).map((f) => ({
      label: f,
      color: FLUID_COLORS[f],
      pick: (s: HistorySample) => s.prod[f],
      pickSol: (r: SolHistoryRow) => r.prod[f],
    })),
  },
  {
    id: 'consumption',
    title: str('dashboard.graph.consumption'),
    series: (['water', 'oxygen', 'food'] as const).map((f) => ({
      label: f,
      color: FLUID_COLORS[f],
      pick: (s: HistorySample) => s.cons[f],
      pickSol: (r: SolHistoryRow) => r.cons[f],
    })),
  },
];

/** Default checked boxes: the vitals, as the roadmap's mock leads with. */
const DEFAULT_GRAPHS = ['power', 'water', 'oxygen', 'food'];

/** The checklist + scope toggle markup. Pure. */
export function renderGraphControlsHtml(active: ReadonlyArray<string>, scope: OpsScope): string {
  const boxes = GRAPH_DEFS.map(
    (g) =>
      `<label class="dash-check${active.includes(g.id) ? ' on' : ''}">` +
      `<input type="checkbox" data-graph="${g.id}"${active.includes(g.id) ? ' checked' : ''}>` +
      `<span>${esc(g.title)}</span></label>`,
  ).join('');
  const scopes = (['live', 'sols'] as const)
    .map(
      (sc) =>
        `<button class="dash-scope${scope === sc ? ' on' : ''}" data-scope="${sc}">${esc(str(`dashboard.scope.${sc}`))}</button>`,
    )
    .join('');
  return `<div class="dash-controls"><div class="dash-checks">${boxes}</div>` +
    `<div class="dash-scopes">${scopes}</div></div>`;
}

// ------------------------------------------------------------------ panel ----

const LS_GRAPHS = 'rf-dash-graphs';
const LS_SCOPE = 'rf-dash-scope';

export class DashboardPanel {
  private root: HTMLElement;
  private cardEl: HTMLElement | null = null;
  private controlsEl: HTMLElement | null = null;
  private graphsEl: HTMLElement | null = null;
  private openState = false;
  private graphs: string[];
  private scope: OpsScope;
  private lastKey = '';

  constructor() {
    const existing = document.getElementById('dashboard-overlay');
    if (existing) {
      this.root = existing as HTMLElement;
    } else {
      this.root = document.createElement('div');
      this.root.id = 'dashboard-overlay';
      this.root.className = 'hist-overlay dash-overlay';
      this.root.style.display = 'none';
      const app = document.getElementById('app');
      if (app) app.appendChild(this.root);
    }
    this.graphs = this.readGraphs();
    this.scope = this.readScope();

    this.root.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('.dash-close')) {
        e.stopPropagation();
        this.close();
        return;
      }
      if (t === this.root) {
        // Backdrop click dismisses, like the alert-history overlay.
        this.close();
        return;
      }
      const scopeBtn = t.closest('[data-scope]') as HTMLElement | null;
      if (scopeBtn) {
        e.stopPropagation();
        this.setScope(scopeBtn.dataset.scope as OpsScope);
      }
    });
    this.root.addEventListener('change', (e) => {
      const box = (e.target as HTMLElement | null)?.closest('[data-graph]') as HTMLInputElement | null;
      if (!box) return;
      const id = box.dataset.graph!;
      this.graphs = box.checked ? [...new Set([...this.graphs, id])] : this.graphs.filter((g) => g !== id);
      this.writeGraphs();
      this.lastKey = ''; // force repaint
    });
  }

  // ----------------------------------------------------------- visibility ----

  isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    this.openState = true;
    this.root.style.display = 'flex';
    this.lastKey = ''; // repaint on open
  }

  /** Esc chain contract: true when this call actually closed something. */
  close(): boolean {
    if (!this.openState) return false;
    this.openState = false;
    this.root.style.display = 'none';
    return true;
  }

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  // ------------------------------------------------------------- settings ----

  private readGraphs(): string[] {
    try {
      const raw = window.localStorage?.getItem(LS_GRAPHS);
      if (!raw) return [...DEFAULT_GRAPHS];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_GRAPHS];
      const valid = parsed.filter((g) => typeof g === 'string' && GRAPH_DEFS.some((d) => d.id === g));
      return valid.length > 0 || parsed.length === 0 ? valid : [...DEFAULT_GRAPHS];
    } catch {
      return [...DEFAULT_GRAPHS];
    }
  }

  private writeGraphs(): void {
    try {
      window.localStorage?.setItem(LS_GRAPHS, JSON.stringify(this.graphs));
    } catch {
      /* private mode */
    }
  }

  private readScope(): OpsScope {
    try {
      return window.localStorage?.getItem(LS_SCOPE) === 'sols' ? 'sols' : 'live';
    } catch {
      return 'live';
    }
  }

  private setScope(scope: OpsScope): void {
    if (scope !== 'live' && scope !== 'sols') return;
    this.scope = scope;
    try {
      window.localStorage?.setItem(LS_SCOPE, scope);
    } catch {
      /* private mode */
    }
    this.lastKey = '';
  }

  // --------------------------------------------------------------- update ----

  /** Paint from the mirror. Reads only; writes nothing back. */
  update(sim: SimView): void {
    if (!this.openState) return;
    const model = dashboardModelFromView(sim);
    const key = [
      model.rows.map((r) => `${r.id}:${r.value}:${r.tone}:${r.sub}`).join('|'),
      model.singlePoints.join(','),
      this.graphs.join(','),
      this.scope,
      sim.history.length,
      sim.solHistory.length,
      // Sample values move continuously; the repaint only follows what the
      // eye can see — the rounded tail sample.
      tailKey(sim),
    ].join('#');
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.ensureChrome();
    this.cardEl!.innerHTML = renderDashboardHtml(model);
    this.controlsEl!.innerHTML = renderGraphControlsHtml(this.graphs, this.scope);
    this.drawGraphs(sim);
  }

  private ensureChrome(): void {
    if (this.cardEl) return;
    this.root.innerHTML =
      `<div class="hist-card dash-card">` +
      `<div class="hist-head"><b>${esc(str('dashboard.title'))}</b><span class="i-spacer"></span>` +
      `<button class="mini-btn dash-close" title="${esc(str('dashboard.close'))}">×</button></div>` +
      `<div class="dash-status"></div>` +
      `<div class="dash-graph-controls"></div>` +
      `<div class="dash-graphs"></div>` +
      `</div>`;
    this.cardEl = this.root.querySelector('.dash-status');
    this.controlsEl = this.root.querySelector('.dash-graph-controls');
    this.graphsEl = this.root.querySelector('.dash-graphs');
  }

  private drawGraphs(sim: SimView): void {
    if (!this.graphsEl) return;
    const chosen = GRAPH_DEFS.filter((g) => this.graphs.includes(g.id));
    // Rebuild the graph nodes only when the set changed; canvases themselves
    // are redrawn in place so a long session does not churn the DOM.
    const sig = chosen.map((g) => g.id).join(',') + `@${this.scope}`;
    if (this.graphsEl.dataset.sig !== sig) {
      this.graphsEl.dataset.sig = sig;
      this.graphsEl.innerHTML = chosen
        .map(
          (g) =>
            `<div class="dash-graph" data-g="${g.id}"><div class="dash-graph-head"><b>${esc(g.title)}</b>` +
            `<span class="dash-legend">${g.series
              .map((s) => `<i style="background:${s.color}"></i>${esc(s.label)}`)
              .join(' ')}</span></div>` +
            `<canvas width="560" height="120"></canvas></div>`,
        )
        .join('');
    }
    if (this.scope === 'sols' && sim.solHistory.length === 0) {
      this.graphsEl.innerHTML = `<div class="dash-empty">${esc(str('dashboard.noSols'))}</div>`;
      return;
    }
    for (const node of Array.from(this.graphsEl.querySelectorAll('.dash-graph'))) {
      const def = GRAPH_DEFS.find((g) => g.id === (node as HTMLElement).dataset.g);
      const canvas = node.querySelector('canvas') as HTMLCanvasElement | null;
      if (!def || !canvas) continue;
      drawGraph(canvas, def, sim, this.scope);
    }
  }
}

/**
 * Cheaper-than-painting change key: the newest point, rounded. Graphs redraw
 * when the last sample moves — which is all a scrolling sparkline can show.
 */
function tailKey(sim: SimView): string {
  const h = sim.history;
  const last = h[h.length - 1];
  if (!last) return 'empty';
  return [
    Math.round(last.genKw),
    Math.round(last.loadKw),
    Math.round(last.water),
    Math.round(last.oxygen),
    Math.round(last.food),
    Math.round(last.ore),
    Math.round(last.roverUtil * 20),
    last.t,
  ].join(',');
}

/** One chart on its canvas. Autoscaled across all series unless ratio. */
export function drawGraph(
  canvas: HTMLCanvasElement,
  def: GraphDef,
  sim: Pick<SimView, 'history' | 'solHistory'>,
  scope: OpsScope,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const points: number[][] = def.series.map((ser) => {
    if (scope === 'sols') return sim.solHistory.map((r) => ser.pickSol(r));
    return sim.history.map((s) => ser.pick(s));
  });
  const n = Math.max(0, ...points.map((p) => p.length));
  if (n < 2) return;

  let max = 1;
  let min = 0;
  if (def.ratio) {
    max = 1;
  } else {
    for (const p of points) for (const v of p) max = Math.max(max, v);
    max *= 1.15;
  }

  const xAt = (i: number) => (i / (n - 1)) * w;
  const yAt = (v: number) => h - ((v - min) / (max - min)) * (h - 6) - 3;

  // Zero line when the chart is not already bottom-anchored by data.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yAt(0));
  ctx.lineTo(w, yAt(0));
  ctx.stroke();

  def.series.forEach((ser, si) => {
    const p = points[si];
    if (p.length < 2) return;
    ctx.beginPath();
    p.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = ser.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}
