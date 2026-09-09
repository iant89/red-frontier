/**
 * The main menu: Continue / New Expedition / Saved Expeditions over the
 * orbital Mars backdrop. Pure DOM — it mounts above the (still idle) game
 * canvas and unmounts the moment a colony boots.
 */

import type { SaveMeta } from './SaveStore';
import { timeAgo } from './SaveStore';
import { DIFFICULTIES } from '../sim/difficulty';

export interface MainMenuOptions {
  saves: SaveMeta[];
  onNewGame: () => void;
  onLoadGame: () => void;
  onContinue: (id: string) => void;
}

function bgUrl(file: string): string {
  return `${import.meta.env.BASE_URL}ui/${file}`;
}

export class MainMenu {
  readonly root: HTMLElement;

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
              <span class="mi">▶</span>
              <span>Continue<span class="btn-sub"></span><small></small></span>
            </button>` : ''}
          <button class="rf-btn" data-act="new">
            <span class="mi">✦</span>
            <span>New Expedition<small>Found a colony on untouched ground</small></span>
          </button>
          <button class="rf-btn" data-act="load">
            <span class="mi">▤</span>
            <span>Saved Expeditions<small>${opts.saves.length === 0 ? 'No colonies on file yet' : `${opts.saves.length} ${opts.saves.length === 1 ? 'colony' : 'colonies'} on file`}</small></span>
          </button>
          <div class="rf-menu-foot">Prototype 5 · deterministic sim · autosaves locally</div>
        </div>
      </div>`;
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
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }
}
