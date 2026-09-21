/**
 * AdvisorPanel — Phase 5 Bottleneck System UI.
 *
 * The roadmap's mock, rendered from the mirror:
 *
 *   +--------------------------------------+
 *   |          ! WATER BOTTLENECK          |
 *   +--------------------------------------+
 *   |   Production:        8.4 kg/sol      |
 *   |   Consumption:       9.7 kg/sol      |
 *   |                                      |
 *   |   Projected shortage: 3.2 sols       |
 *   |                                      |
 *   |   Contributing factors:              |
 *   |     - Ice deposit 2.4 km away        |
 *   |     - Water Extractor #1004 damaged  |
 *   |                                      |
 *   |   Possible solutions:                |
 *   |     > Haul more ice                  |
 *   |     > Repair Water Extractor #1004   |
 *   |                                      |
 *   +--------------------------------------+
 *
 * The two constraints the review (§5 P5) put on this phase are architectural
 * and kept here:
 *
 *   - **It advises; it never solves.** Every solution is past-tense
 *     measurement or could-tense suggestion. The only click target a
 *     factor/solution carries is *focus the machine it names* — the same
 *     gesture an alert card offers. No command is sent, none exists to send.
 *   - **Description stays on the P4 dashboard; advice lives here.** Two
 *     panels on purpose, so the operations view stays a pure read.
 *
 * Deterministic: no RNG, no timers, no writes. The card list is a pure
 * model ({@link advisorModelFromView}) and the markup a pure function
 * ({@link renderAdvisorHtml}), so the copy and the tone rules pin in a test
 * without a DOM; the class is a shell, the kin of DashboardPanel.
 */

import type { SimView } from '../sim/host';
import type { BottleneckFactorView, BottleneckSolutionView, BottleneckView, BottlenecksView } from '../sim/host/viewModels';
import { STRINGS } from './strings';

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ------------------------------------------------------------------ model ----

export type AdvisorTone = 'watch' | 'warning' | 'critical';

/** One entity-linked row, ready for markup. */
export interface AdvisorRowModel {
  label: string;
  /** Entity to focus when the row is tapped, or null when it names no machine. */
  focus: number | null;
}

export interface AdvisorCardModel {
  kind: 'water' | 'oxygen' | 'power';
  title: string;
  severity: AdvisorTone;
  severityLabel: string;
  /** Formatted production / consumption — "8.4 kg/sol", "297 kWh/sol". */
  production: string;
  consumption: string;
  /** Formatted projection — "3.2 sols" — or the "not draining" line. */
  shortage: string;
  shortageBreach: boolean;
  factors: AdvisorRowModel[];
  solutions: AdvisorRowModel[];
}

export interface AdvisorModel {
  cards: AdvisorCardModel[];
  /** Worst severity across the board, or null when nothing is short. */
  worst: AdvisorTone | null;
  count: number;
}

/** The structural slice of `SimView` the panel reads. */
export interface AdvisorViewSource {
  bottlenecks: BottlenecksView;
}

const SEVERITY_KEY: Record<AdvisorTone, string> = {
  watch: 'bottleneck.severity.watch',
  warning: 'bottleneck.severity.warning',
  critical: 'bottleneck.severity.critical',
};

function severityLabel(tone: AdvisorTone): string {
  const v = (STRINGS as Record<string, unknown>)[SEVERITY_KEY[tone]];
  return typeof v === 'string' ? v : tone.toUpperCase();
}

/** kg/sol keeps one decimal like the mock; kWh/sol rounds — it billows more. */
export function formatRate(perSol: number, unit: 'kg' | 'kWh'): string {
  if (unit === 'kWh') return `${perSol >= 100 ? Math.round(perSol) : perSol.toFixed(1)} kWh/sol`;
  return `${perSol.toFixed(1)} kg/sol`;
}

/** The mock's "Projected shortage: 3.2 sols" — or the honest "not draining". */
export function formatShortage(sols: number | null): { text: string; breach: boolean } {
  if (sols === null) return { text: STRINGS['bottleneck.shortageNone'], breach: false };
  return { text: `${sols.toFixed(1)} sols`, breach: sols < 1 };
}

function row(r: BottleneckFactorView | BottleneckSolutionView): AdvisorRowModel {
  return { label: r.label, focus: r.entityId };
}

/** Build the card list from the mirror. Pure; the test pins it. */
export function advisorModelFromView(sim: AdvisorViewSource): AdvisorModel {
  const cards = sim.bottlenecks.bottlenecks.map((b: BottleneckView): AdvisorCardModel => {
    const shortage = formatShortage(b.projectedShortageSols);
    return {
      kind: b.kind,
      title: b.title,
      severity: b.severity,
      severityLabel: severityLabel(b.severity),
      production: formatRate(b.productionPerSol, b.unit),
      consumption: formatRate(b.consumptionPerSol, b.unit),
      shortage: shortage.text,
      shortageBreach: shortage.breach,
      factors: b.factors.map(row),
      solutions: b.solutions.map(row),
    };
  });
  return { cards, worst: cards[0]?.severity ?? null, count: cards.length };
}

/**
 * The topbar badge: silent and empty when nothing is short, otherwise the
 * count of active bottlenecks in the worst severity's tone. The button is
 * the one panel surface that *does* shout a little — a shortage the player
 * never opens the advisor to see is advice never given.
 */
export function advisorBadge(model: AdvisorModel): { text: string; tone: AdvisorTone; title: string } | null {
  if (model.count === 0 || !model.worst) return null;
  const title = model.cards
    .map((c) => `${c.title} — tap the ⚠ button for the advisory (B)`)
    .join('\n');
  return { text: String(model.count), tone: model.worst, title };
}

// ------------------------------------------------------------------ render ----

function rowHtml(r: AdvisorRowModel, marker: '-' | '>'): string {
  const focusAttrs = r.focus != null ? ` data-focus="${r.focus}" tabindex="0" role="button" title="${esc(STRINGS['bottleneck.focus'])}"` : '';
  const cls = `adv-row${r.focus != null ? ' focusable' : ''}`;
  return `<li class="${cls}"${focusAttrs}><span class="adv-marker">${marker}</span><span>${esc(r.label)}</span></li>`;
}

/** The board markup — every active card, ranked worst-first. Pure. */
export function renderAdvisorHtml(model: AdvisorModel): string {
  if (model.count === 0) {
    return (
      `<div class="adv-empty"><b>${esc(STRINGS['bottleneck.empty'])}</b>` +
      `<span>${esc(STRINGS['bottleneck.emptySub'])}</span></div>`
    );
  }
  return model.cards
    .map(
      (c) =>
        `<section class="adv-card tone-${c.severity}" data-kind="${c.kind}">` +
        `<header class="adv-card-head"><b>! ${esc(c.title)}</b>` +
        `<span class="adv-severity">${esc(c.severityLabel)}</span></header>` +
        `<dl class="adv-rates">` +
        `<div><dt>${esc(STRINGS['bottleneck.production'])}</dt><dd>${esc(c.production)}</dd></div>` +
        `<div><dt>${esc(STRINGS['bottleneck.consumption'])}</dt><dd>${esc(c.consumption)}</dd></div>` +
        `<div class="adv-shortage${c.shortageBreach ? ' breach' : ''}"><dt>${esc(STRINGS['bottleneck.projectedShortage'])}</dt><dd>${esc(c.shortage)}</dd></div>` +
        `</dl>` +
        `<div class="adv-block"><b>${esc(STRINGS['bottleneck.contributing'])}</b>` +
        `<ul>${c.factors.map((r) => rowHtml(r, '-')).join('')}</ul></div>` +
        `<div class="adv-block solutions"><b>${esc(STRINGS['bottleneck.solutions'])}</b>` +
        `<ul>${c.solutions.map((r) => rowHtml(r, '>')).join('')}</ul></div>` +
        `<div class="adv-oath">${esc(STRINGS['bottleneck.oath'])}</div>` +
        `</section>`,
    )
    .join('');
}

// ------------------------------------------------------------------ panel ----

export interface AdvisorPanelCallbacks {
  /** HUD intent line — the panel only ever asks for 'focus'. */
  onAction: (action: string, arg?: number | string) => void;
}

export class AdvisorPanel {
  private root: HTMLElement;
  private bodyEl: HTMLElement | null = null;
  private openState = false;
  private lastKey = '';

  constructor(private readonly cb: AdvisorPanelCallbacks) {
    const existing = document.getElementById('advisor-overlay');
    if (existing) {
      this.root = existing as HTMLElement;
    } else {
      this.root = document.createElement('div');
      this.root.id = 'advisor-overlay';
      this.root.className = 'hist-overlay adv-overlay';
      this.root.style.display = 'none';
      const app = document.getElementById('app');
      if (app) app.appendChild(this.root);
    }

    this.root.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('.adv-close')) {
        e.stopPropagation();
        this.close();
        return;
      }
      const focusRow = t.closest('[data-focus]') as HTMLElement | null;
      if (focusRow) {
        e.stopPropagation();
        const id = Number(focusRow.dataset.focus);
        if (Number.isFinite(id)) this.cb.onAction('focus', id);
        return;
      }
      if (t === this.root) this.close(); // backdrop dismiss, like the alert history
    });
  }

  isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    this.openState = true;
    this.root.style.display = 'flex';
    // Sentinel, not '': an all-clear board's change key is the empty string,
    // and the empty state is exactly what must repaint on open.
    this.lastKey = '\u0000repaint';
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

  /** Paint from the mirror. Reads only; the sim is never asked twice the same sol. */
  update(sim: SimView): void {
    // The badge needs the model even with the panel closed: keep the cheap
    // count live either way, but skip markup churn while hidden.
    const model = advisorModelFromView(sim);
    if (!this.openState) return;
    const key = model.cards
      .map(
        (c) =>
          `${c.kind}:${c.severity}:${c.production}:${c.consumption}:${c.shortage}:` +
          `${c.factors.map((f) => f.label).join('|')}/${c.solutions.map((s) => s.label).join('|')}`,
      )
      .join('#');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ensureChrome();
    this.bodyEl!.innerHTML = renderAdvisorHtml(model);
  }

  private ensureChrome(): void {
    if (this.bodyEl) return;
    this.root.innerHTML =
      `<div class="hist-card adv-card-shell">` +
      `<div class="hist-head"><b>${esc(STRINGS['bottleneck.title'])}</b><span class="i-spacer"></span>` +
      `<button class="mini-btn adv-close" title="${esc(STRINGS['bottleneck.close'])}">×</button></div>` +
      `<div class="adv-body"></div>` +
      `</div>`;
    this.bodyEl = this.root.querySelector('.adv-body');
  }
}
