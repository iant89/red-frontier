/**
 * TutorialPanel — Phase 1 First 30 Minutes UI
 *
 * Situation-driven hints, not modal click-chain.
 * Reads SimView.tutorial, shows next hint and active warnings with
 * copy from strings.ts and "Why this matters" explanations.
 *
 * Deterministic UI: no RNG, no sim writes except dismissHint via callback.
 */

import type { SimView } from '../sim/host';
import { STRINGS } from './strings';
import { formatSolsToEmpty, warningForFluid } from '../sim/forecast';

export interface TutorialPanelCallbacks {
  onDismissHint: (hintId: string) => void;
  onAction: (action: string, arg?: number | string) => void;
}

const HINT_COPY: Record<string, { title: string; body: string; why?: string }> = {
  welcome: {
    title: 'Welcome to Mars',
    body: STRINGS['tutorial.welcome'] as string,
    why: 'Your lander has 4 sols of air, water and rations. Everything after that you build. The chain is ice → water → oxygen → food.',
  },
  'move-rover': {
    title: 'Move a rover',
    body: STRINGS['tutorial.firstMove'] as string,
    why: STRINGS['why.rover'] as string,
  },
  'find-resources': {
    title: 'Find resources',
    body: STRINGS['tutorial.findResources'] as string,
    why: STRINGS['why.exploration'] as string,
  },
  extract: {
    title: 'Extract',
    body: STRINGS['tutorial.extract'] as string,
    why: 'Mining rovers haul to storage automatically if a route is set. Shift+click queues orders.',
  },
  'bring-home': {
    title: 'Bring it home',
    body: STRINGS['tutorial.bringHome'] as string,
    why: 'Storage is per-resource silos — one rover-load of regolith cannot deadlock the colony.',
  },
  build: {
    title: 'Build',
    body: STRINGS['tutorial.build'] as string,
    why: 'A workshop within 70 m lends tools — 1.35× build speed. Place near sites.',
  },
  power: {
    title: 'Generate power',
    body: STRINGS['tutorial.power'] as string,
    why: STRINGS['why.power'] as string,
  },
  'life-support': {
    title: 'Manage life support',
    body: STRINGS['tutorial.lifeSupport'] as string,
    why: STRINGS['why.water'] as string,
  },
  automate: {
    title: 'Automate',
    body: STRINGS['tutorial.automate'] as string,
    why: STRINGS['why.automation'] as string,
  },
  storm: {
    title: 'Survive a storm',
    body: STRINGS['tutorial.storm'] as string,
    why: 'Weather is a place, not a mood — a circular system with a footprint that travels. Forecast lead is 60s, 2.25× with radar.',
  },
  objective: {
    title: 'Colony objective',
    body: STRINGS['tutorial.objective'] as string,
    why: 'Establish Survival: functional oxygen, water, food, stable power. Colony enters Stable Operations.',
  },
  'why-water': {
    title: 'Why water matters',
    body: STRINGS['why.water'] as string,
  },
  'why-oxygen': {
    title: 'Why oxygen matters',
    body: STRINGS['why.oxygen'] as string,
  },
  'why-power': {
    title: 'Why power matters',
    body: STRINGS['why.power'] as string,
  },
  'why-rover': {
    title: 'Why rovers matter',
    body: STRINGS['why.rover'] as string,
  },
  'why-automation': {
    title: 'Why automation matters',
    body: STRINGS['why.automation'] as string,
  },
};

const WARNING_COPY: Record<string, { title: string; body: (sim: SimView) => string }> = {
  'water-low': {
    title: 'Water low',
    body: (sim) => {
      const reserve = sim.reserveSols('water');
      const net = sim.netRatePerSol('water');
      // Format via forecast helper
      const sols = formatSolsToEmpty(reserve);
      return `Your water reserve will run dry in ${sols}. Net ${net.toFixed(2)} kg/sol. Build an extractor, or reduce consumption.`;
    },
  },
  'water-critical': {
    title: 'Water critical',
    body: (sim) => {
      const reserve = sim.reserveSols('water');
      const sols = formatSolsToEmpty(reserve);
      return `Your water reserve will run dry in ${sols}. Immediate action required — ice → water chain.`;
    },
  },
  'oxygen-low': {
    title: 'Oxygen low',
    body: (sim) => {
      const reserve = sim.reserveSols('oxygen');
      const sols = formatSolsToEmpty(reserve);
      return `Your oxygen reserve will run dry in ${sols}. Oxygenator needs water + power.`;
    },
  },
  'oxygen-critical': {
    title: 'Oxygen critical',
    body: (sim) => {
      const reserve = sim.reserveSols('oxygen');
      const sols = formatSolsToEmpty(reserve);
      return `Your oxygen reserve will run dry in ${sols}. Colonist will die in hours.`;
    },
  },
  'food-low': {
    title: 'Food low',
    body: (sim) => {
      const reserve = sim.reserveSols('food');
      const sols = formatSolsToEmpty(reserve);
      return `Food low — ${sols} remaining. Greenhouse needs water + power + daylight.`;
    },
  },
  'power-low': {
    title: 'Power low',
    body: () => STRINGS['warning.powerLow'] as string,
  },
  'battery-low': {
    title: 'Battery low',
    body: (sim) => {
      const pct = sim.power.capacityKWh > 0 ? Math.round((sim.power.storedKWh / sim.power.capacityKWh) * 100) : 0;
      return `Battery reserve ${pct}% — ${pct < 10 ? 'critical, shedding industry' : 'low, charge or shed load'}.`;
    },
  },
  'panels-dirty': {
    title: 'Panels dirty',
    body: () => STRINGS['warning.solarDirty'] as string,
  },
  'rover-stranded': {
    title: 'Rover stranded',
    body: (sim) => {
      const r = sim.rovers.find(ro => ro.phase === 'disabled');
      const label = r ? r.label : 'A rover';
      return `${label} stranded — battery flat. Order recovery.`;
    },
  },
  'storm-inbound': {
    title: 'Storm inbound',
    body: (sim) => {
      const fc = sim.weather.forecast();
      if (!fc) return 'Storm inbound — shelter rovers, charge batteries.';
      const mins = Math.max(1, Math.round(fc.arrivesIn / 60));
      return `${fc.label} storm inbound — ${mins} min lead. Shelter rovers, charge batteries.`;
    },
  },
  'building-damaged': {
    title: 'Building damaged',
    body: (sim) => {
      const b = sim.buildings.find(bu => bu.damaged);
      const label = b ? b.kind : 'A structure';
      return `${label} damaged — tripped offline. Order repair.`;
    },
  },
};

export class TutorialPanel {
  private root: HTMLElement;
  private cb: TutorialPanelCallbacks;
  private lastKey = '';

  constructor(cb: TutorialPanelCallbacks) {
    this.cb = cb;
    const existing = document.getElementById('tutorial-panel');
    if (existing) {
      this.root = existing as HTMLElement;
    } else {
      this.root = document.createElement('div');
      this.root.id = 'tutorial-panel';
      this.root.className = 'panel tutorial-panel';
      this.root.style.display = 'none';
      const app = document.getElementById('app');
      if (app) app.appendChild(this.root);
    }
  }

  update(sim: SimView): void {
    const tut = sim.tutorial;
    if (!tut) {
      this.root.style.display = 'none';
      return;
    }

    const nextHint = tut.nextHint;
    const warnings = tut.activeWarnings ?? [];

    // Build key for change detection
    const key = `${nextHint ?? ''}|${warnings.join(',')}|${tut.milestones['first-move']?.completed ? '1' : '0'}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // If no hint and no warnings, hide
    if (!nextHint && warnings.length === 0) {
      this.root.style.display = 'none';
      return;
    }

    let html = '';

    // Warnings first (situation → warning)
    if (warnings.length > 0) {
      html += `<div class="tut-warnings">`;
      for (const wId of warnings.slice(0, 3)) {
        const cfg = WARNING_COPY[wId];
        if (!cfg) continue;
        const body = cfg.body(sim);
        html += `<div class="tut-warning ${wId.includes('critical') || wId.includes('battery') ? 'crit' : 'warn'}">
          <div class="tut-w-title">⚠ ${cfg.title}</div>
          <div class="tut-w-body">${body}</div>
        </div>`;
      }
      html += `</div>`;
    }

    // Next hint
    if (nextHint) {
      const cfg = HINT_COPY[nextHint] ?? { title: nextHint, body: `Hint: ${nextHint}` };
      html += `<div class="tut-hint">
        <div class="tut-h-head"><b>${cfg.title}</b><span class="i-spacer"></span><button class="mini-btn tut-dismiss" data-hint="${nextHint}" title="Dismiss">×</button></div>
        <div class="tut-h-body">${cfg.body}</div>
        ${cfg.why ? `<div class="tut-h-why"><span class="k">Why this matters:</span> ${cfg.why}</div>` : ''}
      </div>`;
    }

    // Progress dots
    const total = Object.keys(tut.milestones).length;
    const done = Object.values(tut.milestones).filter((m: any) => m.completed).length;
    html += `<div class="tut-progress"><span class="k">Progress</span><span class="v">${done}/${total} milestones</span><div class="bar-wrap"><div class="bar-fill green" style="width:${total ? (done / total) * 100 : 0}%"></div></div></div>`;

    this.root.innerHTML = html;
    this.root.style.display = 'block';

    // Wire dismiss buttons
    this.root.querySelectorAll('.tut-dismiss').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const hid = (btn as HTMLElement).dataset.hint;
        if (hid) this.cb.onDismissHint(hid);
      });
    });
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  isVisible(): boolean {
    return this.root.style.display !== 'none';
  }
}
