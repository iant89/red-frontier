/**
 * The saved-expeditions browser: most recent first, each row launching on
 * click, with a "…" menu for rename / delete. Mutations go through the
 * SaveStore and re-render in place.
 */

import type { SaveStore, SaveMeta } from './SaveStore';
import { timeAgo } from './SaveStore';
import { DIFFICULTIES, WORLD_SIZES } from '../sim/difficulty';

export interface LoadGameOptions {
  store: SaveStore;
  onLaunch: (id: string) => void;
  onNewGame: () => void;
  onBack: () => void;
}

function bgUrl(file: string): string {
  return `${import.meta.env.BASE_URL}ui/${file}`;
}

export class LoadGameScreen {
  readonly root: HTMLElement;
  private opts: LoadGameOptions;
  private listEl: HTMLElement;
  private openPop: HTMLElement | null = null;

  constructor(opts: LoadGameOptions) {
    this.opts = opts;
    const root = document.createElement('div');
    root.className = 'rf-overlay rf-loads';
    root.innerHTML = `
      <div class="rf-bg blur"><img src="${bgUrl('loading-bg.jpg')}" alt="" draggable="false" /></div>
      <div class="rf-card rf-scroll">
        <div class="rf-top-actions">
          <button class="rf-btn rf-btn-ghost" data-act="back">← Back</button>
          <button class="rf-btn" data-act="new">✦ New Expedition</button>
        </div>
        <div class="rf-kicker">Colony Records</div>
        <h2 class="rf-h2">SAVED EXPEDITIONS</h2>
        <p class="rf-hint">Most recently played first. Select a colony to resume it where you left off.</p>
        <div class="rf-save-list"></div>
      </div>`;
    this.root = root;
    this.listEl = root.querySelector('.rf-save-list') as HTMLElement;
    (root.querySelector('[data-act="back"]') as HTMLButtonElement).addEventListener('click', () => {
      this.closePop();
      opts.onBack();
    });
    (root.querySelector('[data-act="new"]') as HTMLButtonElement).addEventListener('click', () => {
      this.closePop();
      opts.onNewGame();
    });
    // Clicking anywhere outside an open "…" menu closes it.
    root.addEventListener('pointerdown', (e) => {
      if (this.openPop && !(e.target as HTMLElement).closest('.rf-menu-pop, .rf-dots')) {
        this.closePop();
      }
    });
    this.refresh();
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  refresh(): void {
    this.closePop();
    const saves = this.opts.store.list();
    this.listEl.innerHTML = '';
    if (saves.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rf-empty';
      empty.innerHTML =
        'No colonies on file yet.<br/>The red planet is waiting — found your first expedition.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const meta of saves) {
      this.listEl.appendChild(this.rowFor(meta));
    }
  }

  private rowFor(meta: SaveMeta): HTMLElement {
    const row = document.createElement('div');
    row.className = 'rf-save-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    const diff = DIFFICULTIES[meta.difficulty]?.label ?? meta.difficulty;
    const size = WORLD_SIZES[meta.worldSize]?.label ?? '';
    const where = meta.region ?? 'Random site';
    row.innerHTML = `
      <div class="rf-save-main">
        <div class="rf-save-name"></div>
        <div class="rf-save-meta"></div>
      </div>
      <button class="rf-save-launch">Resume ▸</button>
      <button class="rf-dots" title="Colony options" aria-label="Colony options">•••</button>`;
    (row.querySelector('.rf-save-name') as HTMLElement).textContent = meta.name;
    (row.querySelector('.rf-save-meta') as HTMLElement).textContent =
      `Sol ${meta.sol} · ${diff} · ${size} · ${where} · ${timeAgo(meta.updatedAt)}`;

    row.addEventListener('click', () => this.opts.onLaunch(meta.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.opts.onLaunch(meta.id);
      }
    });
    const dots = row.querySelector('.rf-dots') as HTMLButtonElement;
    dots.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePop(row, meta);
    });
    return row;
  }

  private togglePop(row: HTMLElement, meta: SaveMeta): void {
    if (this.openPop?.dataset.for === meta.id) {
      this.closePop();
      return;
    }
    this.closePop();
    const pop = document.createElement('div');
    pop.className = 'rf-menu-pop';
    pop.dataset.for = meta.id;
    pop.innerHTML = `
      <button data-act="rename"><span>✎</span><span>Rename colony</span></button>
      <button data-act="delete" class="danger"><span>🗑</span><span>Delete save</span></button>`;
    (pop.querySelector('[data-act="rename"]') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePop();
      this.startRename(row, meta);
    });
    const delBtn = pop.querySelector('[data-act="delete"]') as HTMLButtonElement;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!delBtn.classList.contains('confirm')) {
        delBtn.classList.add('confirm');
        delBtn.innerHTML = '<span>⚠</span><span>Click again to confirm</span>';
        return;
      }
      this.opts.store.remove(meta.id);
      this.refresh();
    });
    row.appendChild(pop);
    this.openPop = pop;
  }

  private closePop(): void {
    this.openPop?.remove();
    this.openPop = null;
  }

  private startRename(row: HTMLElement, meta: SaveMeta): void {
    const main = row.querySelector('.rf-save-main') as HTMLElement;
    const prev = main.innerHTML;
    main.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'rf-rename-row';
    wrap.innerHTML = `
      <input class="rf-input" maxlength="60" />
      <button class="rf-btn rf-btn-primary">Save</button>
      <button class="rf-btn rf-btn-ghost">Cancel</button>`;
    const input = wrap.querySelector('input') as HTMLInputElement;
    input.value = meta.name;
    main.appendChild(wrap);
    input.focus();
    input.select();

    // The row launches on click — renaming must not.
    const stop = (e: Event) => e.stopPropagation();
    wrap.addEventListener('click', stop);
    wrap.addEventListener('keydown', stop);

    const done = (save: boolean) => {
      if (save) this.opts.store.rename(meta.id, input.value);
      main.innerHTML = prev;
      const m = this.opts.store.get(meta.id) ?? meta;
      const diff = DIFFICULTIES[m.difficulty]?.label ?? m.difficulty;
      const size = WORLD_SIZES[m.worldSize]?.label ?? '';
      (main.querySelector('.rf-save-name') as HTMLElement).textContent = m.name;
      (main.querySelector('.rf-save-meta') as HTMLElement).textContent =
        `Sol ${m.sol} · ${diff} · ${size} · ${m.region ?? 'Random site'} · ${timeAgo(m.updatedAt)}`;
    };
    (wrap.querySelector('.rf-btn-primary') as HTMLButtonElement).addEventListener('click', () => done(true));
    (wrap.querySelector('.rf-btn-ghost') as HTMLButtonElement).addEventListener('click', () => done(false));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
  }
}
