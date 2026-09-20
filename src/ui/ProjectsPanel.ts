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

/** The panel's markup for one board state. Pure — no DOM, no clock. */
export function renderProjectsHtml(model: ProjectsPanelModel): string {
  const parts: string[] = [];

  parts.push(
    `<div class="proj-head"><span class="proj-title">Engineering Projects</span>` +
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

export class ProjectsPanel {
  private root: HTMLElement;
  private lastKey = '';

  constructor() {
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
  }

  /** Paint the board. Cheap enough to call every frame; it repaints on change. */
  update(sim: SimView): void {
    const objectives = sim.objectives as ProjectsPanelModel | undefined;
    if (!objectives) {
      this.root.style.display = 'none';
      return;
    }
    const key = signature(objectives);
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.root.innerHTML = renderProjectsHtml(objectives);
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
