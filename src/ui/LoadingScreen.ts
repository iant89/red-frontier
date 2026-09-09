/**
 * Full-screen loading surface: the Mars vista (blurred, HUD-free) behind a
 * mission-control card with a progress bar, a live status line and a total
 * percentage. Used by the boot splash, world generation and save loading —
 * one component so every wait looks and reads the same.
 */

export interface LoadStep {
  label: string;
}

function bgUrl(file: string): string {
  return `${import.meta.env.BASE_URL}ui/${file}`;
}

export class LoadingScreen {
  readonly root: HTMLElement;
  private fill: HTMLElement;
  private labelEl: HTMLElement;
  private pctEl: HTMLElement;
  private stepsEl: HTMLElement | null = null;
  private stepItems: HTMLElement[] = [];
  private titleEl: HTMLElement;
  private kickerEl: HTMLElement;

  constructor(opts: {
    kicker?: string;
    title?: string;
    steps?: string[];
    background?: string;
    blur?: boolean;
  }) {
    const root = document.createElement('div');
    root.className = 'rf-overlay rf-loading';
    const bg = opts.background ?? 'loading-bg.jpg';
    root.innerHTML = `
      <div class="rf-bg ${opts.blur === false ? 'dim' : 'blur'}">
        <img src="${bgUrl(bg)}" alt="" draggable="false" />
      </div>
      <div class="rf-card rf-splash-card rf-scroll">
        <div class="rf-kicker"></div>
        <h1 class="rf-title"></h1>
        <div class="rf-progress">
          <div class="rf-progress-track"><div class="rf-progress-fill"></div></div>
          <div class="rf-progress-meta">
            <span class="rf-progress-label">Preparing…</span>
            <span class="rf-progress-pct">0%</span>
          </div>
        </div>
        <ul class="rf-load-steps"></ul>
      </div>`;
    this.root = root;
    this.titleEl = root.querySelector('.rf-title') as HTMLElement;
    this.kickerEl = root.querySelector('.rf-kicker') as HTMLElement;
    this.fill = root.querySelector('.rf-progress-fill') as HTMLElement;
    this.labelEl = root.querySelector('.rf-progress-label') as HTMLElement;
    this.pctEl = root.querySelector('.rf-progress-pct') as HTMLElement;
    this.stepsEl = root.querySelector('.rf-load-steps') as HTMLElement;
    this.titleEl.textContent = opts.title ?? 'RED FRONTIER';
    this.kickerEl.textContent = opts.kicker ?? 'MISSION CONTROL';
    if (opts.steps) this.setSteps(opts.steps);
    else if (this.stepsEl) this.stepsEl.style.display = 'none';
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  setSteps(labels: string[]): void {
    if (!this.stepsEl) return;
    this.stepsEl.style.display = '';
    this.stepsEl.innerHTML = '';
    this.stepItems = labels.map((label) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="st-ic">○</span><span></span>`;
      (li.lastChild as HTMLElement).textContent = label;
      this.stepsEl!.appendChild(li);
      return li;
    });
  }

  /** Mark step `index` active; every step before it reads as done. */
  setActiveStep(index: number): void {
    this.stepItems.forEach((li, i) => {
      li.classList.toggle('done', i < index);
      li.classList.toggle('active', i === index);
      const ic = li.querySelector('.st-ic') as HTMLElement;
      ic.textContent = i < index ? '●' : i === index ? '◐' : '○';
    });
  }

  markAllDone(): void {
    this.stepItems.forEach((li) => {
      li.classList.add('done');
      li.classList.remove('active');
      (li.querySelector('.st-ic') as HTMLElement).textContent = '●';
    });
  }

  /** `frac` in 0..1, plus the human-readable status line. */
  setProgress(frac: number, label?: string): void {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    this.fill.style.width = `${pct}%`;
    this.pctEl.textContent = `${pct}%`;
    if (label !== undefined) this.labelEl.textContent = label;
  }
}

/** Let the browser paint the loading frame before heavy synchronous work. */
export function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return delay(16);
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
