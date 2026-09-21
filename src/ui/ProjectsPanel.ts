/**
 * ProjectsPanel — Phase 2 Engineering Projects UI.
 *
 * The answer to the roadmap's complaint that the colony has no objective: a
 * standing card naming what the colony is being asked to do, how far along it
 * is, and what it earns. Read-only — it renders `SimView.objectives` and sends
 * nothing back, because a project closes itself when the colony meets it.
 *
 * Deterministic: no RNG, no timers, no writes. The HTML is produced by
 * {@link renderProjectsHtml} so the copy and the numbers can be pinned in a
 * test without a DOM.
 *
 * The roadmap's tutorial philosophy is kept here too: the panel states the
 * situation ("water 3/80 kg") and leaves the fix to the player.
 */

import type { SimView } from '../sim/host';

export interface ObjectiveRequirementRow {
  key: string;
  label: string;
  current: number;
  target: number;
  unit: string;
  met: boolean;
}

export interface ObjectiveProjectRow {
  id: string;
  title: string;
  blurb: string;
  why: string;
  requirements: ObjectiveRequirementRow[];
  met: number;
  total: number;
  rewards: Array<{ id: string; title: string; granted: boolean }>;
}

/** The slice of `SimView.objectives` this panel renders. */
export interface ProjectsPanelModel {
  active: ObjectiveProjectRow[];
  completed: Array<{ id: string; title: string; sol: number }>;
  unlocks: Array<{ id: string; title: string; sol: number }>;
  solsWithoutOrder: number;
}

/** Escape player-visible text — all of it is data, and none of it is markup. */
function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A requirement's numbers, read the way the sim measured them. */
export function formatRequirement(row: ObjectiveRequirementRow): string {
  const current = row.current;
  const target = row.target;
  switch (row.unit) {
    case 'kg':
      return `${Math.round(current)} / ${Math.round(target)} kg`;
    case 'kWh':
      return `${Math.round(current)} / ${Math.round(target)} kWh`;
    case 'sols':
      return `${current.toFixed(1)} / ${target} sols`;
    case 'percent':
      return `${Math.round(current)}% / ${Math.round(target)}%`;
    default:
      return `${Math.round(current)} / ${Math.round(target)}`;
  }
}

/**
 * The HUD pip — the compact, situation-driven summary the review asked for
 * beside the vitals ("a projects panel + situation-driven pips on the HUD").
 * The panel carries the detail; the pip answers "what is my project and how
 * close am I?" in a glance and never more than a few words.
 *
 * Tone follows the situation, not a timer: `idle` when nothing is done yet,
 * `progress` while it moves, `near` when one requirement remains, `done` when
 * the board is clear. Pure, so the copy can be pinned in a test.
 */
export type ProjectPipTone = 'idle' | 'progress' | 'near' | 'done';

export interface ProjectPip {
  text: string;
  tone: ProjectPipTone;
  /** The full sentence for the tooltip — the next unmet requirement. */
  title: string;
}

export function projectPip(model: ProjectsPanelModel): ProjectPip | null {
  if (model.active.length === 0) {
    if (model.completed.length === 0) return null;
    return { text: 'Projects · all complete', tone: 'done', title: 'Every engineering project has landed.' };
  }
  // The front of the board is the project the player is furthest into — the
  // one they can most plausibly state unprompted (playtest M2).
  const lead = [...model.active].sort((a, b) => b.met / b.total - a.met / a.total)[0];
  const remaining = lead.total - lead.met;
  const next = lead.requirements.find((r) => !r.met);
  const tone: ProjectPipTone = lead.met === 0 ? 'idle' : remaining <= 1 ? 'near' : 'progress';
  const more = model.active.length > 1 ? ` +${model.active.length - 1}` : '';
  const title = next
    ? `${lead.title} — next: ${next.label} (${formatRequirement(next)})`
    : `${lead.title} — every requirement holds`;
  return { text: `${lead.title} ${lead.met}/${lead.total}${more}`, tone, title };
}

/**
 * Phase 3 — the autonomy headline (AUTONOMY.md §12): `AUTONOMY 6.8 sols ·
 * ENGINEER`, with the last break as the tooltip so the number teaches. Pure.
 */
export interface AutonomyChipModel {
  current: number;
  best: number;
  rung: string;
  identity: string;
  coverage: number;
  singlePoints: ReadonlyArray<string>;
  lastBreak: { reason: string; streak: number; detail: string } | null;
}

export function autonomyChip(a: AutonomyChipModel): { text: string; identity: string; rung: string; title: string } {
  const identity = a.identity.toUpperCase();
  const rung = a.rung.toUpperCase();
  const lines = [
    `${rung} · coverage ${Math.round(a.coverage * 100)}% · best ${a.best.toFixed(1)} sols`,
    a.singlePoints.length
      ? `Single points of failure: ${a.singlePoints.join(', ')}`
      : 'No single machine can end this colony.',
  ];
  if (a.lastBreak) {
    lines.push(
      a.lastBreak.reason === 'intervention'
        ? `Last break: ${a.lastBreak.detail} at ${a.lastBreak.streak.toFixed(1)} sols.`
        : `Last break: ${a.lastBreak.detail} after ${a.lastBreak.streak.toFixed(1)} sols.`,
    );
  }
  return {
    text: `Autonomy ${a.current.toFixed(1)} sols · ${identity}`,
    identity: a.identity,
    rung: a.rung,
    title: lines.join('\n'),
  };
}

/**
 * Phase 3 — the Standing Orders card. Four fixed-shape policies, each a
 * toggle and at most one number; the card states what each policy is
 * holding right now (`252 / 400 kg`, `2 shed`, `worst wear 51 %`) so the
 * player can see a policy working without opening a log. Pure markup; the
 * panel wires the inputs to `policy/*` commands.
 */
export interface PolicyCardModel {
  unlocked: boolean;
  stockpile: { on: boolean; resource: string; minKg: number; currentKg: number };
  nightPower: { on: boolean; minBatteryPct: number; shedding: number };
  stormShelter: { on: boolean };
  autoMaintain: { on: boolean; maxWearPct: number; worstWearPct: number };
  actions: number;
}

export const POLICY_RESOURCE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ice', label: 'Ice' },
  { id: 'regolith', label: 'Regolith' },
  { id: 'iron', label: 'Iron ore' },
  { id: 'silicon', label: 'Silicon' },
  { id: 'aluminum', label: 'Aluminum' },
  { id: 'steel', label: 'Steel' },
];

export function renderPolicyHtml(m: PolicyCardModel): string {
  const dis = m.unlocked ? '' : ' disabled';
  const row = (id: string, on: boolean, label: string, status: string, control: string) =>
    `<div class="pol-row${on ? ' on' : ''}" data-policy="${id}">` +
    `<label class="pol-toggle"><input type="checkbox" data-pol-on="${id}"${on ? ' checked' : ''}${dis}><b>${esc(label)}</b></label>` +
    `<span class="pol-status">${esc(status)}</span>` +
    (control ? `<div class="pol-ctl">${control}</div>` : '') +
    `</div>`;

  const opts = POLICY_RESOURCE_OPTIONS.map(
    (o) => `<option value="${o.id}"${o.id === m.stockpile.resource ? ' selected' : ''}>${o.label}</option>`,
  ).join('');
  const sp = row(
    'stockpile',
    m.stockpile.on,
    'Stockpile',
    `${Math.round(m.stockpile.currentKg)} / ${Math.round(m.stockpile.minKg)} kg`,
    `<select data-pol-resource${dis}>${opts}</select>` +
      `<input type="number" data-pol-num="minKg" min="0" max="5000" step="50" value="${Math.round(m.stockpile.minKg)}"${dis}><span class="pol-unit">kg floor</span>`,
  );
  const np = row(
    'nightPower',
    m.nightPower.on,
    'Night power',
    m.nightPower.shedding > 0 ? `${m.nightPower.shedding} shed until morning` : 'industry running',
    `<input type="number" data-pol-num="minBatteryPct" min="0" max="100" step="5" value="${Math.round(m.nightPower.minBatteryPct)}"${dis}><span class="pol-unit">% battery floor after dark</span>`,
  );
  const ss = row('stormShelter', m.stormShelter.on, 'Storm shelter', 'recall the fleet on a storm forecast', '');
  const am = row(
    'autoMaintain',
    m.autoMaintain.on,
    'Auto-maintain',
    `worst wear ${m.autoMaintain.worstWearPct} %`,
    `<input type="number" data-pol-num="maxWearPct" min="0" max="100" step="5" value="${Math.round(m.autoMaintain.maxWearPct)}"${dis}><span class="pol-unit">% wear dispatches a rover</span>`,
  );
  const head =
    `<div class="pol-head"><b>Standing Orders</b><span class="proj-count">${m.unlocked ? `${m.actions} actions` : 'locked'}</span></div>` +
    (m.unlocked
      ? `<div class="proj-blurb">A policy doing the work is the fantasy working — none of these end your autonomy streak.</div>`
      : `<div class="proj-blurb pol-locked">Colony-level standing orders unlock with <b>Industrialize</b> (advanced automation).</div>`);
  return `<div class="pol-card${m.unlocked ? '' : ' locked'}">${head}${sp}${np}${ss}${am}</div>`;
}

/** The panel's markup for one board state. Pure — no DOM, no clock. */
export function renderProjectsHtml(model: ProjectsPanelModel): string {
  const parts: string[] = [];

  parts.push(
    `<div class="proj-head" title="Collapse or expand the projects card"><span class="proj-title">Engineering Projects</span>` +
      `<span class="proj-count">${model.active.length} active</span></div>`,
  );

  for (const p of model.active) {
    const pct = p.total > 0 ? Math.round((p.met / p.total) * 100) : 0;
    let html = `<div class="proj-card" data-project="${esc(p.id)}">`;
    html += `<div class="proj-card-head"><b>${esc(p.title)}</b><span class="proj-pct">${pct}%</span></div>`;
    html += `<div class="proj-blurb">${esc(p.blurb)}</div>`;
    html += `<div class="proj-bar"><div class="proj-bar-fill" style="width:${pct}%"></div></div>`;
    html += `<div class="proj-reqs">`;
    for (const r of p.requirements) {
      html +=
        `<div class="proj-req${r.met ? ' met' : ''}">` +
        `<span class="proj-req-mark">${r.met ? '✓' : '·'}</span>` +
        `<span class="proj-req-label">${esc(r.label)}</span>` +
        `<span class="proj-req-num">${esc(formatRequirement(r))}</span>` +
        `</div>`;
    }
    html += `</div>`;
    html += `<div class="proj-why"><span class="k">Why</span> ${esc(p.why)}</div>`;
    if (p.rewards.length > 0) {
      html += `<div class="proj-reward"><span class="k">Reward</span> ${p.rewards
        .map((r) => esc(r.title))
        .join(', ')}</div>`;
    }
    html += `</div>`;
    parts.push(html);
  }

  if (model.active.length === 0) {
    parts.push(
      `<div class="proj-empty">No open project. The colony is running on its own objectives.</div>`,
    );
  }

  if (model.unlocks.length > 0) {
    let html = `<div class="proj-earned"><span class="k">Earned</span>`;
    for (const u of model.unlocks) {
      html += `<span class="proj-unlock" title="Sol ${Math.round(u.sol)}">${esc(u.title)}</span>`;
    }
    html += `</div>`;
    parts.push(html);
  }

  if (model.completed.length > 0) {
    let html = `<div class="proj-done"><span class="k">Completed</span>`;
    for (const c of model.completed) {
      html += `<span class="proj-done-row">${esc(c.title)} <span class="proj-sol">sol ${Math.round(c.sol)}</span></span>`;
    }
    html += `</div>`;
    parts.push(html);
  }

  return parts.join('');
}

export interface ProjectsPanelCallbacks {
  /** A `policy/*` command, ready to send. */
  onPolicy?: (cmd: { type: string } & Record<string, unknown>) => void;
}

export class ProjectsPanel {
  private root: HTMLElement;
  private lastKey = '';
  private policyKey = '';
  private collapsed = false;
  private policyEl: HTMLElement | null = null;
  private lastPolicy: PolicyCardModel | null = null;

  constructor(private readonly cb: ProjectsPanelCallbacks = {}) {
    const existing = document.getElementById('projects-panel');
    if (existing) {
      this.root = existing as HTMLElement;
    } else {
      this.root = document.createElement('div');
      this.root.id = 'projects-panel';
      this.root.className = 'panel projects-panel';
      this.root.style.display = 'none';
      const app = document.getElementById('app');
      if (app) app.appendChild(this.root);
    }
    let stored: string | null = null;
    try {
      stored = window.localStorage?.getItem('rf-collapse-projects');
    } catch {
      /* private mode */
    }
    this.setCollapsed(stored === '1');
    // The header is the toggle; the pip on the HUD is the other one.
    this.root.addEventListener('pointerdown', (e) => {
      const head = (e.target as HTMLElement | null)?.closest('.proj-head');
      if (!head) return;
      e.stopPropagation();
      this.setCollapsed(!this.collapsed);
    });
    // Standing orders: every input change is one `policy/*` command carrying
    // the row's whole shape, so the sim never sees a half-set policy.
    this.root.addEventListener('change', (e) => {
      const t = e.target as HTMLElement | null;
      const rowEl = t?.closest('.pol-row') as HTMLElement | null;
      if (!rowEl || !this.lastPolicy) return;
      const id = rowEl.dataset.policy as keyof PolicyCardModel & string;
      const cmd = this.policyCommand(id, rowEl);
      if (cmd) this.cb.onPolicy?.(cmd);
    });
  }

  /** Read one row back into the command that sets it. Exposed for tests. */
  policyCommand(id: string, rowEl: HTMLElement): ({ type: string } & Record<string, unknown>) | null {
    const on = (rowEl.querySelector('[data-pol-on]') as HTMLInputElement | null)?.checked ?? false;
    const num = (name: string, fallback: number) => {
      const el = rowEl.querySelector(`[data-pol-num="${name}"]`) as HTMLInputElement | null;
      const v = el ? Number(el.value) : NaN;
      return Number.isFinite(v) ? v : fallback;
    };
    const m = this.lastPolicy;
    if (!m) return null;
    switch (id) {
      case 'stockpile': {
        const sel = rowEl.querySelector('[data-pol-resource]') as HTMLSelectElement | null;
        return { type: 'policy/stockpile', on, resource: sel?.value ?? m.stockpile.resource, minKg: num('minKg', m.stockpile.minKg) };
      }
      case 'nightPower':
        return { type: 'policy/nightPower', on, minBatteryPct: num('minBatteryPct', m.nightPower.minBatteryPct) };
      case 'stormShelter':
        return { type: 'policy/stormShelter', on };
      case 'autoMaintain':
        return { type: 'policy/autoMaintain', on, maxWearPct: num('maxWearPct', m.autoMaintain.maxWearPct) };
      default:
        return null;
    }
  }

  /** Collapse to the headline (the HUD pip still carries the situation). */
  setCollapsed(on: boolean): void {
    this.collapsed = on;
    this.root.classList.toggle('collapsed', on);
    try {
      window.localStorage?.setItem('rf-collapse-projects', on ? '1' : '0');
    } catch {
      /* private mode */
    }
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  /** Paint the board. Cheap enough to call every frame; it repaints on change. */
  update(sim: SimView): void {
    const objectives = sim.objectives as ProjectsPanelModel | undefined;
    if (!objectives) {
      this.root.style.display = 'none';
      return;
    }
    const key = signature(objectives);
    const policies = (sim as { policies?: PolicyCardModel }).policies ?? null;
    const pkey = policies ? policySignature(policies) : '';
    if (key === this.lastKey && pkey === this.policyKey) return;

    if (key !== this.lastKey) {
      this.lastKey = key;
      this.root.innerHTML = renderProjectsHtml(objectives);
      this.policyEl = null;
      this.policyKey = '';
    }
    if (policies && pkey !== this.policyKey) {
      // Rebuilding a card the player is typing into would eat the keystroke;
      // the signature rounds the live numbers so it only changes when the
      // words on the card do.
      const focused = this.policyEl?.contains(document.activeElement ?? null) ?? false;
      if (!focused) {
        this.policyKey = pkey;
        this.lastPolicy = policies;
        if (!this.policyEl) {
          this.policyEl = document.createElement('div');
          this.policyEl.className = 'pol-wrap';
          this.root.appendChild(this.policyEl);
        }
        this.policyEl.innerHTML = renderPolicyHtml(policies);
      }
    }
    this.root.style.display = 'block';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  isVisible(): boolean {
    return this.root.style.display !== 'none';
  }
}

/**
 * Change detection key. Deliberately fine-grained: requirement numbers move
 * every tick, but the *rounded* values the player reads move rarely, and a
 * panel that rebuilt its DOM twenty times a second would fight the renderer
 * for frame time.
 */
function policySignature(m: PolicyCardModel): string {
  return [
    m.unlocked ? 'u' : 'l',
    m.actions,
    m.stockpile.on, m.stockpile.resource, Math.round(m.stockpile.minKg), Math.round(m.stockpile.currentKg),
    m.nightPower.on, Math.round(m.nightPower.minBatteryPct), m.nightPower.shedding,
    m.stormShelter.on,
    m.autoMaintain.on, Math.round(m.autoMaintain.maxWearPct), m.autoMaintain.worstWearPct,
  ].join('|');
}

function signature(model: ProjectsPanelModel): string {
  const active = model.active
    .map(
      (p) =>
        `${p.id}:${p.met}/${p.total}:${p.requirements
          .map((r) => `${r.key}=${Math.round(r.current)}/${r.target}${r.met ? '!' : ''}`)
          .join(',')}`,
    )
    .join('|');
  const done = model.completed.map((c) => `${c.id}@${c.sol}`).join(',');
  const unlocked = model.unlocks.map((u) => u.id).join(',');
  return `${active}#${done}#${unlocked}`;
}
