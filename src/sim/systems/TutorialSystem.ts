/**
 * TutorialSystem — Phase 1 First 30 Minutes
 *
 * Pure, deterministic, no DOM. Tracks first-time milestones and emits
 * situation-driven warnings using forecast utility.
 *
 * Philosophy (from roadmap, keep verbatim):
 *   Do NOT make the tutorial:
 *       Click here.
 *       Click here.
 *       Click here.
 *
 *   Instead:
 *       "Your water reserve will run dry in 1.8 sols."
 *
 *   Then let the player discover how to solve it.
 *
 * Tick order: after Failure→Alert, before History (same as AlertSystem).
 * Reads ColonyState, writes ColonyState.tutorial, emits DomainEvents.
 *
 * Milestones are saved, so reload doesn't repeat tutorial.
 */

import type { ColonyState } from '../state/ColonyState';
import type { MilestoneId, WarningId, HintId, FunnelEvent } from '../state/TutorialState';
import { ALL_MILESTONES } from '../state/TutorialState';
import { forecastFluidWithRates } from '../forecast';
import { SOL_SECONDS } from '../config';
import { BUILDINGS } from '../defs';

const TICKS_PER_SOL = 20 * SOL_SECONDS; // 4800
const WARNING_COOLDOWN_TICKS = TICKS_PER_SOL * 0.5; // 0.5 sol cooldown for same warning

export interface TutorialSystemContext {
  reserveSols: (fluid: 'water' | 'oxygen' | 'food') => number;
  netRatePerSol: (fluid: 'water' | 'oxygen' | 'food') => number;
  instantRatePerSol: (fluid: 'water' | 'oxygen' | 'food') => number;
}

function pushFunnel(state: ColonyState, ev: FunnelEvent): void {
  state.tutorial.funnel.push(ev);
  // Bounded: keep last 200 events
  if (state.tutorial.funnel.length > 200) {
    state.tutorial.funnel.shift();
  }
}

function completeMilestone(state: ColonyState, id: MilestoneId): boolean {
  const rec = state.tutorial.milestones[id];
  if (!rec || rec.completed) return false;
  rec.completed = true;
  rec.sol = state.clock.sol;
  rec.tick = state.ticksRun;
  pushFunnel(state, {
    id,
    type: 'milestone',
    sol: state.clock.sol,
    tick: state.ticksRun,
    at: state.simTime,
  });
  state.domainEvents.push({
    type: 'tutorial/milestone',
    milestone: id,
    sol: state.clock.sol,
  } as any);
  state.alerts.event('ok', `Milestone: ${id}`, state.simTime, state.clock.format());
  return true;
}

function triggerWarning(state: ColonyState, id: WarningId): boolean {
  const rec = state.tutorial.warnings[id];
  if (!rec) return false;
  // Cooldown
  if (state.ticksRun - rec.lastSeenTick < WARNING_COOLDOWN_TICKS && rec.count > 0) {
    // Still active, but don't spam
    rec.active = true;
    return false;
  }
  rec.lastSeenTick = state.ticksRun;
  rec.lastSeenSol = state.clock.sol;
  rec.count++;
  rec.active = true;
  pushFunnel(state, {
    id,
    type: 'warning',
    sol: state.clock.sol,
    tick: state.ticksRun,
    at: state.simTime,
  });
  state.domainEvents.push({
    type: 'tutorial/warning',
    warning: id,
    sol: state.clock.sol,
  } as any);
  return true;
}

function clearWarning(state: ColonyState, id: WarningId): void {
  const rec = state.tutorial.warnings[id];
  if (rec) rec.active = false;
}

export class TutorialSystem {
  /**
   * Tick tutorial — checks milestones and warnings.
   * Must be called after power/life-support/construction/rover systems,
   * before history.
   */
  static tick(state: ColonyState, ctx: TutorialSystemContext): void {
    const t = state.tutorial;

    // --- Milestone checks ---

    // first-move: any rover moved >5m from spawn or issued move command history
    // We check rovers that have moved from origin, or have non-idle command
    if (!t.milestones['first-move'].completed) {
      for (const r of state.rovers) {
        const moved = Math.hypot(r.x, r.z) > 12; // >12m from center = moved
        const hasMoveTask = r.command.type === 'moveTo' || r.pending.some(p => p.type === 'moveTo');
        if (moved || hasMoveTask || t.stats.moves > 0) {
          completeMilestone(state, 'first-move');
          break;
        }
      }
    }

    // first-resource-found: POI discovered or deposit visited
    if (!t.milestones['first-resource-found'].completed) {
      const anyDiscovered = state.world.pois.some(p => p.discovered);
      const anyReserved = state.world.deposits.some(d => d.reservedBy !== null);
      const anyMined = state.rovers.some(r => r.command.type === 'mine' || t.stats.mines > 0);
      if (anyDiscovered || anyReserved || anyMined) {
        completeMilestone(state, 'first-resource-found');
      }
    }

    // first-mine: mining task issued or cargo has ore
    if (!t.milestones['first-mine'].completed) {
      const mining = state.rovers.some(r => r.command.type === 'mine' || r.pending.some(p => p.type === 'mine'));
      const hasOre = state.rovers.some(r => {
        for (const k of Object.keys(r.cargo) as any[]) {
          if ((r.cargo as any)[k] > 0) return true;
        }
        return false;
      });
      if (mining || hasOre || t.stats.mines > 0) {
        completeMilestone(state, 'first-mine');
      }
    }

    // first-haul: cargo unloaded (storage increased or haul stat)
    if (!t.milestones['first-haul'].completed) {
      if (t.stats.hauls > 0) {
        completeMilestone(state, 'first-haul');
      } else {
        // Check if any storage has >0 (beyond initial) or rover unloaded recently
        // For simplicity, if any resource > base, count as haul
        // Actually storage starts 0, so any >0 is haul
        let hasStored = false;
        for (const k of Object.keys(state.storage) as any[]) {
          if ((state.storage as any)[k] > 1) { hasStored = true; break; }
        }
        if (hasStored) completeMilestone(state, 'first-haul');
      }
    }

    // first-build: building placed (site or online)
    if (!t.milestones['first-build'].completed) {
      if (state.buildings.length > 0 || t.stats.builds > 0) {
        completeMilestone(state, 'first-build');
      }
    }

    // first-power: solar or battery online and generating/storing
    if (!t.milestones['first-power'].completed) {
      const hasPowerBuilding = state.buildings.some(b => {
        if (b.state !== 'online' || b.damaged || !b.enabled) return false;
        const def = BUILDINGS[b.kind];
        return def.powerProduceKw > 0 || def.batteryKWh > 0;
      });
      const powerStable = state.power.generationKw > 5;
      if (hasPowerBuilding || powerStable) {
        completeMilestone(state, 'first-power');
      }
    }

    // first-water: extractor online or water production >0
    if (!t.milestones['first-water'].completed) {
      const hasExtractor = state.buildings.some(b => b.kind === 'extractor' && b.state === 'online' && !b.damaged);
      const waterProducing = ctx.netRatePerSol('water') > -1; // not depleting fast, or producing
      const waterAmount = state.pools.amounts.water > 10;
      if (hasExtractor && waterAmount) {
        completeMilestone(state, 'first-water');
      } else if (hasExtractor && waterProducing) {
        completeMilestone(state, 'first-water');
      }
    }

    // first-oxygen: oxygenator online
    if (!t.milestones['first-oxygen'].completed) {
      const hasOxy = state.buildings.some(b => b.kind === 'oxygenator' && b.state === 'online' && !b.damaged);
      if (hasOxy) completeMilestone(state, 'first-oxygen');
    }

    // first-food: greenhouse online
    if (!t.milestones['first-food'].completed) {
      const hasGreenhouse = state.buildings.some(b => b.kind === 'greenhouse' && b.state === 'online' && !b.damaged);
      if (hasGreenhouse) completeMilestone(state, 'first-food');
    }

    // first-automation: rover rule set or repeat route
    if (!t.milestones['first-automation'].completed) {
      const hasAutomation = state.rovers.some(r =>
        r.rules.autoHaul || r.rules.autoService || r.rules.stormShelter || r.rules.autoRescue || r.command.type === 'mine' && (r.command as any).repeat
      );
      if (hasAutomation || t.stats.automations > 0) {
        completeMilestone(state, 'first-automation');
      }
    }

    // first-storm-survived: storm ended and we survived
    if (!t.milestones['first-storm-survived'].completed) {
      if (t.stats.stormsSurvived > 0) {
        completeMilestone(state, 'first-storm-survived');
      } else {
        // Also check if weather had a storm and now calm
        // We track via funnel? For now, rely on stats increment from weather system
        // Alternative: if last storm ended and we are past sol 3
        if (state.weather.time > 0 && state.weather.storm === 'calm' && state.clock.sol >= 3) {
          // Check if we ever had a storm (via alerts history or domain events)
          // Domain events include storm/ended
          // If we have survived at least one storm, the stats should have been incremented
          // For now, don't auto-complete here — require explicit stat
        }
      }
    }

    // first-objective: placeholder — when player has stable water+oxygen
    if (!t.milestones['first-objective'].completed) {
      const waterOk = t.milestones['first-water'].completed;
      const oxyOk = t.milestones['first-oxygen'].completed;
      const powerOk = t.milestones['first-power'].completed;
      if (waterOk && oxyOk && powerOk && state.clock.sol >= 2) {
        completeMilestone(state, 'first-objective');
      }
    }

    // --- Warning checks (situation → warning, not click-here) ---

    // Use forecast utility for fluid warnings
    // We have ctx.reserveSols and netRate — but also need produced/consumed for copy
    // For now, use reserveSols to determine tier
    const fluids: Array<{ id: 'water' | 'oxygen' | 'food', warningLow: WarningId, warningCrit: WarningId }> = [
      { id: 'water', warningLow: 'water-low', warningCrit: 'water-critical' },
      { id: 'oxygen', warningLow: 'oxygen-low', warningCrit: 'oxygen-critical' },
      { id: 'food', warningLow: 'food-low', warningCrit: 'food-low' },
    ];

    for (const { id, warningLow, warningCrit } of fluids) {
      const reserve = ctx.reserveSols(id);
      const amount = state.pools.amounts[id];
      if (!Number.isFinite(reserve)) {
        clearWarning(state, warningLow);
        clearWarning(state, warningCrit);
        continue;
      }
      if (reserve < 1.0) {
        triggerWarning(state, warningCrit);
      } else if (reserve < 2.5) {
        triggerWarning(state, warningLow);
        clearWarning(state, warningCrit);
      } else {
        clearWarning(state, warningLow);
        clearWarning(state, warningCrit);
      }
      // Also warn if amount very low even if not depleting (edge case)
      if (amount < 5 && id !== 'food') {
        triggerWarning(state, warningCrit);
      }
    }

    // Power low: battery <20% or brownout
    const batPct = state.power.capacityKWh > 0 ? state.power.storedKWh / state.power.capacityKWh : 1;
    const hasBrownout = state.power.tierSatisfaction[2] < 0.995 || state.power.tierSatisfaction[1] < 0.995;
    if (batPct < 0.2 || hasBrownout) {
      if (batPct < 0.15) triggerWarning(state, 'battery-low');
      else triggerWarning(state, 'power-low');
    } else {
      clearWarning(state, 'power-low');
      clearWarning(state, 'battery-low');
    }

    // Panels dirty: any solar <70% cleanliness
    const dirtyPanels = state.buildings.some(b => b.kind === 'solar' && b.cleanliness < 0.7 && b.state === 'online');
    if (dirtyPanels) triggerWarning(state, 'panels-dirty');
    else clearWarning(state, 'panels-dirty');

    // Rover stranded: any disabled
    const stranded = state.rovers.some(r => r.phase === 'disabled');
    if (stranded) triggerWarning(state, 'rover-stranded');
    else clearWarning(state, 'rover-stranded');

    // Building damaged
    const damaged = state.buildings.some(b => b.damaged);
    if (damaged) triggerWarning(state, 'building-damaged');
    else clearWarning(state, 'building-damaged');

    // Storm inbound: forecast exists
    const forecast = state.weather.forecast();
    if (forecast && forecast.arrivesIn < 120) { // 120s = 0.5 sol
      triggerWarning(state, 'storm-inbound');
    } else {
      clearWarning(state, 'storm-inbound');
    }

    // Compute active warnings list for UI (transient)
    const active: WarningId[] = [];
    for (const id of Object.keys(t.warnings) as WarningId[]) {
      if (t.warnings[id]?.active) active.push(id);
    }
    t._activeWarnings = active;

    // Compute next hint: first incomplete milestone's hint, unless dismissed
    const hintForMilestone: Record<MilestoneId, HintId> = {
      'first-move': 'move-rover',
      'first-resource-found': 'find-resources',
      'first-mine': 'extract',
      'first-haul': 'bring-home',
      'first-build': 'build',
      'first-power': 'power',
      'first-water': 'life-support',
      'first-oxygen': 'life-support',
      'first-food': 'life-support',
      'first-automation': 'automate',
      'first-storm-survived': 'storm',
      'first-objective': 'objective',
    };

    let nextHint: HintId | null = null;
    if (!t.milestones['first-move'].completed) {
      nextHint = t.dismissedHints['welcome'] ? 'move-rover' : 'welcome';
    } else {
      for (const mid of ALL_MILESTONES) {
        if (!t.milestones[mid].completed) {
          const hid = hintForMilestone[mid];
          if (!t.dismissedHints[hid]) {
            nextHint = hid;
            break;
          }
        }
      }
    }

    // If active warnings, prioritize warning-related why hints
    if (active.includes('water-low') || active.includes('water-critical')) {
      if (!t.dismissedHints['why-water'] && t.milestones['first-water'].completed) {
        // Keep nextHint as is, but UI can show why
      }
    }

    t._nextHint = nextHint;
  }

  static onRoverMove(state: ColonyState): void {
    state.tutorial.stats.moves++;
  }

  static onMine(state: ColonyState): void {
    state.tutorial.stats.mines++;
  }

  static onHaul(state: ColonyState): void {
    state.tutorial.stats.hauls++;
  }

  static onBuild(state: ColonyState): void {
    state.tutorial.stats.builds++;
  }

  static onAutomation(state: ColonyState): void {
    state.tutorial.stats.automations++;
  }

  static onStormSurvived(state: ColonyState): void {
    state.tutorial.stats.stormsSurvived++;
  }

  static dismissHint(state: ColonyState, hintId: string): void {
    state.tutorial.dismissedHints[hintId] = true;
  }

  static seeHint(state: ColonyState, hintId: string): void {
    state.tutorial.seenHints[hintId] = true;
    state.tutorial.funnel.push({
      id: hintId,
      type: 'hint',
      sol: state.clock.sol,
      tick: state.ticksRun,
      at: state.simTime,
    });
  }

  static clear(state: ColonyState): void {
    // Called on new game or after time jump — reset transient only, keep milestones?
    // Milestones persist across save, but clear on new game is via emptyTutorialState
    state.tutorial._activeWarnings = [];
    state.tutorial._nextHint = null;
  }

  static afterTimeJump(state: ColonyState): void {
    // Time jump invalidates warning cooldowns
    for (const id of Object.keys(state.tutorial.warnings) as WarningId[]) {
      state.tutorial.warnings[id].lastSeenTick = -1e12;
    }
    state.tutorial._activeWarnings = [];
    state.tutorial._nextHint = null;
  }
}
