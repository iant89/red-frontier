/**
 * The main menu: Continue / New Expedition / Saved Expeditions over the
 * orbital Mars backdrop. Pure DOM — it mounts above the (still idle) game
 * canvas and unmounts the moment a colony boots.
 */

import type { SaveMeta } from './SaveStore';
import { timeAgo } from './SaveStore';
import { DIFFICULTIES } from '../sim/difficulty';
import { assessBuild, BUILD_COMMIT, latestMainCommit, shortSha } from './BuildStatus';
import { ChangelogDialog } from './Changelog';

export interface MainMenuOptions {
  saves: SaveMeta[];
  onNewGame: () => void;
  onLoadGame: () => void;
  onContinue: (id: string) => void;
}

function bgUrl(file: string): string {
  return `${(import.meta as any).env?.BASE_URL ?? ''}ui/${file}`;
}

export class MainMenu {
  readonly root: HTMLElement;
  private changelog: ChangelogDialog | null = null;
  private currentSha: string | null = BUILD_COMMIT;
  private latestSha: string | null = null;

  constructor(opts: MainMenuOptions) {
    const recent = opts.saves[0] ?? null;
    const totalSols = opts.saves.reduce((s, m) => s + m.sol, 0);
    const root = document.createElement('div');
    root.className = 'rf-overlay rf-menu';
    root.innerHTML = `
      <div class="rf-bg dim"><img src="${bgUrl('menu-bg.jpg')}" alt="" draggable="false" /></div>
      <div class="rf-menu-layout">
        <div class="rf-menu-hero">
          <div class="rf-kicker">Ares Expeditionary Command · 2066</div>
          <h1 class="rf-title">RED<br/>FRONTIER</h1>
          <p class="rf-menu-tag">
            One human. A handful of machines. An entire planet that doesn't want you there.
            Found a colony, keep the air on, and automate yourself out of the daily grind —
            before <b>Mars</b> automates <b>you</b> out of existence.
          </p>
          <div class="rf-menu-stats">
            <div class="rf-stat"><b>${opts.saves.length}</b><span>Expeditions</span></div>
            <div class="rf-stat"><b>${totalSols}</b><span>Sols survived</span></div>
            <div class="rf-stat"><b>18</b><span>Landing zones</span></div>
          </div>
        </div>
        <div class="rf-menu-panel">
          ${recent ? `
            <button class="rf-btn rf-btn-primary" data-act="continue">
              <span class="mi" aria-hidden="true">▶</span>
              <span class="rf-btn-label">Continue<small></small></span>
            </button>` : ''}
          <button class="rf-btn" data-act="new">
            <span class="mi" aria-hidden="true">✦</span>
            <span class="rf-btn-label">New Expedition<small>Found a colony on untouched ground</small></span>
          </button>
          <button class="rf-btn" data-act="load">
            <span class="mi" aria-hidden="true">▤</span>
            <span class="rf-btn-label">Saved Expeditions<small>${opts.saves.length === 0 ? 'No colonies on file yet' : `${opts.saves.length} ${opts.saves.length === 1 ? 'colony' : 'colonies'} on file`}</small></span>
          </button>
          <div class="rf-menu-foot">Prototype 5 · deterministic sim · autosaves locally</div>
        </div>
      </div>
      <button class="rf-build-status" data-state="checking" type="button" aria-label="View changelog — build history">
        <span class="rf-build-dot" aria-hidden="true"></span>
        <span data-build-label>Checking build…</span>
      </button>`;
    this.root = root;

    if (recent) {
      const btn = root.querySelector('[data-act="continue"]') as HTMLButtonElement;
      const small = btn.querySelector('small') as HTMLElement;
      const diff = DIFFICULTIES[recent.difficulty]?.label ?? '';
      small.textContent = `${recent.name} · Sol ${recent.sol}${diff ? ` · ${diff}` : ''} · ${timeAgo(recent.updatedAt)}`;
      btn.addEventListener('click', () => opts.onContinue(recent.id));
    }
    (root.querySelector('[data-act="new"]') as HTMLButtonElement).addEventListener('click', opts.onNewGame);
    (root.querySelector('[data-act="load"]') as HTMLButtonElement).addEventListener('click', opts.onLoadGame);

    // Build badge → changelog timeline.
    const badge = root.querySelector('.rf-build-status') as HTMLButtonElement;
    badge.addEventListener('click', () => this.openChangelog());
    badge.title = 'View build history and changelog';
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
    void this.updateBuildStatus();
  }

  private async updateBuildStatus(): Promise<void> {
    const badge = this.root.querySelector('.rf-build-status') as HTMLElement;
    const label = badge.querySelector('[data-build-label]') as HTMLElement;

    if (!BUILD_COMMIT) {
      badge.dataset.state = 'unknown';
      label.textContent = 'Build status unavailable';
      badge.title = 'View changelog — this build has no commit identifier.';
      return;
    }

    try {
      const latest = await latestMainCommit();
      this.latestSha = latest;
      const result = assessBuild(BUILD_COMMIT, latest);
      badge.dataset.state = result.state;
      if (result.state === 'latest') {
        label.textContent = `Latest build · ${shortSha(result.current)}`;
        badge.title = `Running the latest commit on main (${result.current}) — click to view changelog.`;
      } else {
        label.textContent = `Old build · ${shortSha(result.current)}`;
        badge.title = `Running ${result.current}; latest on main is ${result.latest} — click to view changelog.`;
      }
    } catch (error) {
      badge.dataset.state = 'unknown';
      label.textContent = `Could not verify build · ${shortSha(BUILD_COMMIT)}`;
      badge.title = `${error instanceof Error ? error.message : 'The GitHub build check failed.'} — click to view changelog.`;
    }
  }

  private openChangelog(): void {
    if (this.changelog) return;
    this.changelog = new ChangelogDialog({
      currentSha: this.currentSha,
      latestSha: this.latestSha,
      onClose: () => this.closeChangelog(),
    });
    this.changelog.mount(this.root);
  }

  private closeChangelog(): void {
    if (!this.changelog) return;
    this.changelog.unmount();
    this.changelog = null;
    // Return focus to the badge for keyboard users.
    (this.root.querySelector('.rf-build-status') as HTMLElement | null)?.focus();
  }

  unmount(): void {
    this.changelog?.unmount();
    this.changelog = null;
    this.root.remove();
  }
}
