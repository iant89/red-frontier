/**
 * The New Expedition wizard: mission name + difficulty → world size →
 * landing-zone globe → advanced options & launch review.
 *
 * Each step renders into one content host; the globe is created lazily when
 * its step opens and disposed when the wizard closes, so the menu never pays
 * for a WebGL context it isn't showing.
 */

import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  WORLD_SIZES,
  WORLD_SIZE_ORDER,
  DEPOSIT_SPREADS,
  DEFAULT_WORLD_OPTIONS,
  randomSeedText,
  type DifficultyId,
  type WorldSizeId,
  type NewGameConfig,
  type WorldOptions,
  type StormLevel,
  type SupplyLevel,
  type RichnessLevel,
  type DepositSpread,
} from '../sim/difficulty';
import { LANDABLE_REGIONS } from '../sim/marsGlobe';
import { BIOME_COLORS, BIOME_LABELS, briefFor } from './landingRegions';
import { GlobePicker } from './GlobePicker';

export interface WizardOptions {
  onCancel: () => void;
  onBegin: (config: NewGameConfig) => void;
}

const STEPS = ['Mission', 'World', 'Landing', 'Launch'];

function bgUrl(file: string): string {
  return `${import.meta.env.BASE_URL}ui/${file}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class NewGameWizard {
  readonly root: HTMLElement;
  private opts: WizardOptions;
  private step = 0;
  private content: HTMLElement;
  private dots: HTMLElement;
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;

  // ---- draft configuration ----
  private saveName = '';
  private difficulty: DifficultyId = 'pioneer';
  private worldSize: WorldSizeId = 'medium';
  private region: string | null = null;
  private seedText = randomSeedText();
  private advancedOpen = false;
  private options: WorldOptions = { ...DEFAULT_WORLD_OPTIONS };
  private spread: DepositSpread = 'standard';

  private globe: GlobePicker | null = null;
  private sitePanel: HTMLElement | null = null;

  constructor(opts: WizardOptions) {
    this.opts = opts;
    const root = document.createElement('div');
    root.className = 'rf-overlay rf-wizard';
    root.innerHTML = `
      <div class="rf-bg blur"><img src="${bgUrl('loading-bg.jpg')}" alt="" draggable="false" /></div>
      <div class="rf-card rf-scroll">
        <div class="rf-wizard-head">
          <div class="grow">
            <div class="rf-kicker">Mission Planning</div>
            <h2 class="rf-h2">NEW EXPEDITION</h2>
          </div>
          <button class="rf-btn rf-btn-ghost rf-icon-btn" data-act="cancel" title="Back to menu">×</button>
        </div>
        <div class="rf-steps"></div>
        <div class="rf-wizard-body"></div>
        <div class="rf-wizard-nav">
          <button class="rf-btn" data-act="back">← Back</button>
          <span class="spacer"></span>
          <button class="rf-btn rf-btn-primary" data-act="next">Next →</button>
        </div>
      </div>`;
    this.root = root;
    this.content = root.querySelector('.rf-wizard-body') as HTMLElement;
    this.dots = root.querySelector('.rf-steps') as HTMLElement;
    this.backBtn = root.querySelector('[data-act="back"]') as HTMLButtonElement;
    this.nextBtn = root.querySelector('[data-act="next"]') as HTMLButtonElement;
    (root.querySelector('[data-act="cancel"]') as HTMLButtonElement).addEventListener('click', () =>
      this.close(),
    );
    this.backBtn.addEventListener('click', () => this.goto(this.step - 1));
    this.nextBtn.addEventListener('click', () => {
      if (this.step < STEPS.length - 1) this.goto(this.step + 1);
      else this.begin();
    });
    this.render();
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.disposeGlobe();
    this.root.remove();
  }

  private close(): void {
    this.unmount();
    this.opts.onCancel();
  }

  private begin(): void {
    const config: NewGameConfig = {
      saveName: this.saveName.trim() || 'Ares Expedition',
      seedText: this.seedText.trim() || randomSeedText(),
      difficulty: this.difficulty,
      worldSize: this.worldSize,
      region: this.region,
      options: { ...this.options, nearDeposits: DEPOSIT_SPREADS[this.spread].value },
    };
    this.unmount();
    this.opts.onBegin(config);
  }

  // ---------------------------------------------------------------- steps ----

  private goto(step: number): void {
    this.step = Math.max(0, Math.min(STEPS.length - 1, step));
    this.render();
  }

  private render(): void {
    this.disposeGlobe();
    this.dots.innerHTML = STEPS.map(
      (label, i) =>
        `<div class="rf-step ${i < this.step ? 'done' : i === this.step ? 'active' : ''}"><span class="bar"></span><span class="lbl">${i + 1} · ${label}</span></div>`,
    ).join('');
    this.backBtn.disabled = this.step === 0;
    if (this.step < STEPS.length - 1) {
      this.nextBtn.innerHTML = 'Next →';
      this.nextBtn.disabled = this.step === 2 && !this.region;
    } else {
      this.nextBtn.innerHTML = '▶ Begin Mission';
      this.nextBtn.disabled = false;
    }
    this.content.innerHTML = '';
    if (this.step === 0) this.renderMission();
    else if (this.step === 1) this.renderWorld();
    else if (this.step === 2) this.renderLanding();
    else this.renderLaunch();
  }

  private pickCard(
    host: HTMLElement,
    opts: { label: string; tag: string; desc: string; selected: boolean; onPick: () => void },
  ): void {
    const b = document.createElement('button');
    b.className = 'rf-pick' + (opts.selected ? ' selected' : '');
    b.innerHTML = `<span class="pk-check">✓</span><span class="pk-label"></span><span class="pk-tag"></span><span class="pk-desc"></span>`;
    (b.querySelector('.pk-label') as HTMLElement).textContent = opts.label;
    (b.querySelector('.pk-tag') as HTMLElement).textContent = opts.tag;
    (b.querySelector('.pk-desc') as HTMLElement).textContent = opts.desc;
    b.addEventListener('click', () => {
      opts.onPick();
      host.querySelectorAll('.rf-pick').forEach((n) => n.classList.remove('selected'));
      b.classList.add('selected');
    });
    host.appendChild(b);
  }

  // ------------------------------------------------------------- mission ----

  private renderMission(): void {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p class="rf-hint">Name this expedition for the colony records, then choose how hard Mars gets to fight back.</p>
      <div class="rf-field">
        <label for="rf-save-name">Expedition name</label>
        <input class="rf-input" id="rf-save-name" maxlength="60" placeholder="Ares Expedition" />
      </div>
      <div class="rf-field"><label>Difficulty</label></div>
      <div class="rf-grid cols-3" data-grid="diff"></div>`;
    const input = wrap.querySelector('#rf-save-name') as HTMLInputElement;
    input.value = this.saveName;
    input.addEventListener('input', () => {
      this.saveName = input.value;
    });
    const grid = wrap.querySelector('[data-grid="diff"]') as HTMLElement;
    for (const id of DIFFICULTY_ORDER) {
      const d = DIFFICULTIES[id];
      this.pickCard(grid, {
        label: d.label,
        tag: d.tagline,
        desc: d.description,
        selected: this.difficulty === id,
        onPick: () => {
          this.difficulty = id;
        },
      });
    }
    this.content.appendChild(wrap);
    window.setTimeout(() => input.focus(), 60);
  }

  // --------------------------------------------------------------- world ----

  private renderWorld(): void {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p class="rf-hint">How much of Mars does the descent stage survey? Larger claims hold more deposits — and longer hauls.</p>
      <div class="rf-grid cols-4" data-grid="size"></div>`;
    const grid = wrap.querySelector('[data-grid="size"]') as HTMLElement;
    for (const id of WORLD_SIZE_ORDER) {
      const s = WORLD_SIZES[id];
      this.pickCard(grid, {
        label: `${s.label} · ${s.sizeLabel}`,
        tag: s.tagline,
        desc: s.description,
        selected: this.worldSize === id,
        onPick: () => {
          this.worldSize = id;
        },
      });
    }
    this.content.appendChild(wrap);
  }

  // ------------------------------------------------------------- landing ----

  private renderLanding(): void {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p class="rf-hint">Spin the globe and select a landing zone. Each region lands you on different geology — read the brief before you commit.</p>
      <div class="rf-globe-layout">
        <div class="rf-globe-wrap"><div class="rf-globe-hint">Drag to spin · click a zone to select</div></div>
        <div class="rf-site-panel empty"></div>
      </div>
      <div class="rf-legend"></div>`;
    const globeHost = wrap.querySelector('.rf-globe-wrap') as HTMLElement;
    this.sitePanel = wrap.querySelector('.rf-site-panel') as HTMLElement;
    const legend = wrap.querySelector('.rf-legend') as HTMLElement;
    const seen = new Set<string>();
    for (const r of LANDABLE_REGIONS) {
      if (seen.has(r.biome)) continue;
      seen.add(r.biome);
      const s = document.createElement('span');
      s.innerHTML = `<i></i><span></span>`;
      (s.querySelector('i') as HTMLElement).style.background = BIOME_COLORS[r.biome];
      (s.querySelector('span:last-child') as HTMLElement).textContent = BIOME_LABELS[r.biome];
      legend.appendChild(s);
    }
    this.content.appendChild(wrap);
    this.renderSitePanel();
    this.globe = new GlobePicker(globeHost, {
      selected: this.region,
      onSelect: (name) => {
        this.region = name;
        this.renderSitePanel();
        this.nextBtn.disabled = false;
      },
    });
  }

  private renderSitePanel(): void {
    const panel = this.sitePanel;
    if (!panel) return;
    const brief = this.region ? briefFor(this.region) : null;
    const geo = this.region ? LANDABLE_REGIONS.find((r) => r.name === this.region) : null;
    if (!brief || !geo) {
      panel.className = 'rf-site-panel empty';
      panel.innerHTML = `<div style="font-size:26px">◉</div><div>No landing zone selected.<br/>Click one of the glowing zones on the globe to read its brief.</div>`;
      return;
    }
    panel.className = 'rf-site-panel';
    const color = BIOME_COLORS[brief.biome];
    panel.innerHTML = `
      <span class="rf-site-biome"></span>
      <h3 class="rf-site-name"></h3>
      <div class="rf-site-coords"></div>
      <p class="rf-site-desc"></p>
      <ul class="rf-site-traits"></ul>`;
    const badge = panel.querySelector('.rf-site-biome') as HTMLElement;
    badge.textContent = BIOME_LABELS[brief.biome];
    badge.style.color = color;
    badge.style.borderColor = color;
    badge.style.background = `${color}1f`;
    (panel.querySelector('.rf-site-name') as HTMLElement).textContent = brief.name;
    (panel.querySelector('.rf-site-coords') as HTMLElement).textContent =
      `${Math.abs(geo.lat).toFixed(1)}° ${geo.lat >= 0 ? 'N' : 'S'} · ${geo.lon.toFixed(1)}° E`;
    (panel.querySelector('.rf-site-desc') as HTMLElement).textContent = brief.description;
    const traits = panel.querySelector('.rf-site-traits') as HTMLElement;
    for (const t of brief.traits) {
      const li = document.createElement('li');
      li.innerHTML = `<span>▸</span><span></span>`;
      (li.lastChild as HTMLElement).textContent = t;
      traits.appendChild(li);
    }
  }

  private disposeGlobe(): void {
    this.globe?.dispose();
    this.globe = null;
    this.sitePanel = null;
  }

  // -------------------------------------------------------------- launch ----

  private renderLaunch(): void {
    const wrap = document.createElement('div');
    const diff = DIFFICULTIES[this.difficulty];
    const size = WORLD_SIZES[this.worldSize];
    wrap.innerHTML = `
      <p class="rf-hint">Review the flight plan${this.region ? '' : ' — <b>no landing zone selected</b> (a random site will be used)'}.</p>
      <div class="rf-summary">
        <div class="rf-summary-row"><span class="k">Expedition</span><span class="v">${esc(this.saveName.trim() || 'Ares Expedition')}</span></div>
        <div class="rf-summary-row"><span class="k">Difficulty</span><span class="v">${esc(diff.label)} · ${esc(diff.tagline)}</span></div>
        <div class="rf-summary-row"><span class="k">World</span><span class="v">${esc(size.label)} · ${esc(size.sizeLabel)}</span></div>
        <div class="rf-summary-row"><span class="k">Landing zone</span><span class="v">${esc(this.region ?? 'Random site')}</span></div>
      </div>
      <div class="rf-advanced${this.advancedOpen ? ' open' : ''}">
        <button class="rf-advanced-toggle"><span>⚙</span><span>Advanced options</span><span class="chev">▾</span></button>
        <div class="rf-advanced-body">
          <div class="rf-field">
            <label for="rf-seed">World seed</label>
            <div class="rf-seed-row">
              <input class="rf-input" id="rf-seed" maxlength="32" spellcheck="false" />
              <button class="rf-btn rf-icon-btn" data-act="reseed" title="Generate a random seed">⟳</button>
            </div>
          </div>
          <div class="rf-adv-grid">
            <div class="rf-field"><label for="rf-opt-near">Starter deposits nearby</label><select class="rf-select" id="rf-opt-near"></select></div>
            <div class="rf-field"><label for="rf-opt-storm">Storm activity</label><select class="rf-select" id="rf-opt-storm"></select></div>
            <div class="rf-field"><label for="rf-opt-supply">Starting supplies</label><select class="rf-select" id="rf-opt-supply"></select></div>
            <div class="rf-field"><label for="rf-opt-rich">Deposit richness</label><select class="rf-select" id="rf-opt-rich"></select></div>
          </div>
        </div>
      </div>`;
    this.content.appendChild(wrap);

    const adv = wrap.querySelector('.rf-advanced') as HTMLElement;
    (wrap.querySelector('.rf-advanced-toggle') as HTMLButtonElement).addEventListener('click', () => {
      this.advancedOpen = !this.advancedOpen;
      adv.classList.toggle('open', this.advancedOpen);
    });

    const seedInput = wrap.querySelector('#rf-seed') as HTMLInputElement;
    seedInput.value = this.seedText;
    seedInput.addEventListener('input', () => {
      this.seedText = seedInput.value;
    });
    (wrap.querySelector('[data-act="reseed"]') as HTMLButtonElement).addEventListener('click', () => {
      this.seedText = randomSeedText();
      seedInput.value = this.seedText;
    });

    const fillSelect = <T extends string>(
      id: string,
      opts: Array<{ value: T; label: string }>,
      current: T,
      onChange: (v: T) => void,
    ): void => {
      const sel = wrap.querySelector(id) as HTMLSelectElement;
      for (const o of opts) {
        const el = document.createElement('option');
        el.value = o.value;
        el.textContent = o.label;
        sel.appendChild(el);
      }
      sel.value = current;
      sel.addEventListener('change', () => onChange(sel.value as T));
    };
    fillSelect<DepositSpread>(
      '#rf-opt-near',
      (Object.keys(DEPOSIT_SPREADS) as DepositSpread[]).map((k) => ({
        value: k,
        label: `${DEPOSIT_SPREADS[k].label} — ${DEPOSIT_SPREADS[k].blurb}`,
      })),
      this.spread,
      (v) => {
        this.spread = v;
      },
    );
    fillSelect<StormLevel>(
      '#rf-opt-storm',
      [
        { value: 'calm', label: 'Calm — quiet skies, rare storms' },
        { value: 'normal', label: 'Normal — the usual Martian temper' },
        { value: 'brutal', label: 'Brutal — frequent, violent weather' },
      ],
      this.options.stormLevel,
      (v) => {
        this.options.stormLevel = v;
      },
    );
    fillSelect<SupplyLevel>(
      '#rf-opt-supply',
      [
        { value: 'lean', label: 'Lean — 70% starting stores' },
        { value: 'standard', label: 'Standard — the manifest as filed' },
        { value: 'abundant', label: 'Abundant — 140% starting stores' },
      ],
      this.options.supplies,
      (v) => {
        this.options.supplies = v;
      },
    );
    fillSelect<RichnessLevel>(
      '#rf-opt-rich',
      [
        { value: 'poor', label: 'Poor — thin seams everywhere' },
        { value: 'standard', label: 'Standard — honest Martian geology' },
        { value: 'rich', label: 'Rich — a prospector\'s dream' },
      ],
      this.options.richness,
      (v) => {
        this.options.richness = v;
      },
    );
  }
}
