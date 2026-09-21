/**
 * Phase 5 — the bottleneck analyzer (COMMERCIAL-ROADMAP.md Phase 5,
 * re-baselined per COMMERCIAL-ROADMAP-REVIEW.md §5 P5: "one pure 'analyzer'
 * module in sim/ (testable without UI): inputs = history + current state;
 * outputs = ranked bottlenecks with contributing factors and *static*
 * solution suggestions per bottleneck type").
 *
 * Three kinds at first — water, oxygen, power — not a general solver. Food
 * arrives when the roadmap's scope does; the machinery here is the tame
 * version of a solver: a shortage detector (the P1 forecast utility), a
 * cause scrutineer (measured facts about producers, feeds, grid and fleet),
 * and a static advice table (`solutions.ts`).
 *
 * Determinism: pure function of `ColonyState` — no RNG, no DOM, no wall
 * clock. The same state ranks the same report twice; both transports compute
 * it in the projection, so worker and in-process agree and replays hash
 * identically. The analyzer *reads* the simulation's answers; it never feeds
 * one back, so no tick can depend on what the panel showed.
 *
 * The don't-auto-solve principle is architectural, not a comment: nothing
 * here holds a command, everything it emits is past-tense or could-tense.
 *
 * Display bounds: four factors and four solutions per bottleneck, matching
 * the roadmap mock's proportions — more rows than that is a spreadsheet,
 * and "no spreadsheet archaeology" is the phase's whole point.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { HistorySystem } from '../systems/HistorySystem';
import { forecastFluidWithRates } from '../forecast';
import { effectiveBuildingDef } from '../engineering/upgrades';
import { BUILDINGS, type BuildingKind, type FluidId } from '../defs';
import { POD_BATTERY_KWH, POWER_TIER_LABELS, SOL_HOURS } from '../config';
import { STATIC_SOLUTIONS, EXTRA_SOLUTIONS } from './solutions';
import type {
  BottleneckFactor,
  BottleneckReport,
  BottleneckSeverity,
  BottleneckSnapshot,
  BottleneckSolution,
} from './types';

/** Per-bottleneck display caps — the mock's three-factor / four-solution proportions. */
const MAX_FACTORS = 4;
const MAX_SOLUTIONS = 4;

/** A factor/solution pair raised from one machine the player's hands can fix. */
function repairEcho(kindLabel: string, b: Building): { factor: BottleneckFactor; solution: BottleneckSolution } {
  return {
    factor: { key: `damaged/${b.id}`, label: `${kindLabel} #${b.id} damaged — tripped offline`, entityId: b.id },
    solution: { key: `repair/${b.id}`, label: `Repair ${kindLabel} #${b.id}`, entityId: b.id },
  };
}

function switchedOffEcho(
  b: Building,
  kindLabel: string,
  onLabel = `Switch ${kindLabel} #%{id} back on`,
): { factor: BottleneckFactor; solution: BottleneckSolution } {
  return {
    factor: { key: `disabled/${b.id}`, label: `${kindLabel} #${b.id} switched off`, entityId: b.id },
    solution: {
      key: `switch-on/${b.id}`,
      label: onLabel.replace('#%{id}', `#${b.id}`),
      entityId: b.id,
    },
  };
}

/**
 * Where "the colony" is, for distance claims: the centroid of whatever has
 * been built, falling back to the colonist (who lands beside the pod).
 */
function colonyCenter(state: ColonyState): { x: number; z: number } {
  const built = state.buildings.filter((b) => b.state !== 'site');
  if (built.length === 0) return { x: state.colonist.x, z: state.colonist.z };
  let x = 0;
  let z = 0;
  for (const b of built) {
    x += b.x;
    z += b.z;
  }
  return { x: x / built.length, z: z / built.length };
}

/** Building kinds whose process makes the given fluid (water → extractor, …). */
function producerKinds(fluid: FluidId): BuildingKind[] {
  return (Object.keys(BUILDINGS) as BuildingKind[]).filter(
    (k) => (BUILDINGS[k].process?.fluidOut?.[fluid] ?? 0) > 0,
  );
}

// ------------------------------------------------------------- fluids ----

/**
 * Shared shape for the two fluid analyzers. Severity is the P1 forecast's
 * own warning tier — the advisor and the tutorial warning read the same
 * math, so the panel can never disagree with the banner about how bad it is.
 */
function fluidReport(
  state: ColonyState,
  fluid: FluidId,
  kind: 'water' | 'oxygen',
): Omit<BottleneckReport, 'title' | 'factors' | 'solutions'> | null {
  const producedPerSol = HistorySystem.flowRatePerSol(state, fluid, 'produced');
  const consumedPerSol = HistorySystem.flowRatePerSol(state, fluid, 'consumed');
  const amount = state.pools.amounts[fluid];
  const capacity = state.pools.capacity[fluid];
  const f = forecastFluidWithRates(amount, capacity, fluid, producedPerSol, consumedPerSol);
  // A colony burns fluid even while it saves: no depletion, no bottleneck.
  if (f.warningTier === 'ok') return null;
  return {
    kind,
    severity: f.warningTier as BottleneckSeverity, // 'watch' | 'warning' | 'critical'
    productionPerSol: producedPerSol,
    consumptionPerSol: consumedPerSol,
    unit: 'kg',
    projectedShortageSols: f.isDepleting ? f.solsToEmpty : null,
  };
}

/**
 * Scrutinize the producers of one fluid: what stands, what is offline, and
 * which *measured* reason keeps each machine from producing. Returns the
 * factors plus the concrete echo solutions those factors earn.
 */
function producerScrutiny(
  state: ColonyState,
  kinds: BuildingKind[],
  noneLabel: string,
  buildLabel: Omit<BottleneckSolution, 'entityId'>,
): { factors: BottleneckFactor[]; echoes: BottleneckSolution[] } {
  const factors: BottleneckFactor[] = [];
  const echoes: BottleneckSolution[] = [];
  const machines = state.buildings.filter((b) => kinds.includes(b.kind));

  if (machines.length === 0) {
    factors.push({ key: 'no-producer', label: noneLabel, entityId: null });
    echoes.push({ ...buildLabel, entityId: null });
    return { factors, echoes };
  }

  for (const b of machines) {
    const label = BUILDINGS[b.kind].label;
    if (b.state !== 'online') {
      if (b.state === 'site') {
        factors.push({ key: `site/${b.id}`, label: `${label} #${b.id} is still a marked site`, entityId: b.id });
      } else {
        factors.push({ key: `building/${b.id}`, label: `${label} #${b.id} still under construction`, entityId: b.id });
      }
      continue;
    }
    if (b.damaged) {
      const echo = repairEcho(label, b);
      factors.push(echo.factor);
      echoes.push(echo.solution);
      continue;
    }
    if (!b.enabled) {
      const echo = switchedOffEcho(b, label);
      factors.push(echo.factor);
      echoes.push(echo.solution);
      continue;
    }
    if (b.powerSat < 0.5) {
      factors.push({
        key: `starved/${b.id}`,
        label: `${label} #${b.id} power-starved — grid serving ${Math.round(b.powerSat * 100)}%`,
        entityId: b.id,
      });
    } else if (b.powerSat < 0.995) {
      factors.push({
        key: `throttled/${b.id}`,
        label: `${label} #${b.id} throttled — grid serving ${Math.round(b.powerSat * 100)}%`,
        entityId: b.id,
      });
    } else if (b.throughput <= 0.001 && b.idleReason) {
      factors.push({ key: `idle/${b.id}`, label: `${label} #${b.id} idle — ${b.idleReason}`, entityId: b.id });
    }
  }
  return { factors, echoes };
}

/** The water report. Ice is the feed; the fleet is the haul; the tank is the buffer. */
function analyzeWater(state: ColonyState): BottleneckReport | null {
  const report = fluidReport(state, 'water', 'water');
  if (!report) return null;
  const factors: BottleneckFactor[] = [];
  const solutions: BottleneckSolution[] = [];

  const scrutiny = producerScrutiny(
    state,
    producerKinds('water'),
    'No Water Extractor stands — the tap has no source',
    EXTRA_SOLUTIONS.buildProducer.water,
  );
  factors.push(...scrutiny.factors);
  solutions.push(...scrutiny.echoes);

  // The feed: a silo with no ice starves every extractor no matter how
  // healthy it is; the fleet's condition is why a seam sits untouched.
  const ice = state.storage.ice;
  if (ice < 1) {
    factors.push({ key: 'feed/empty', label: 'The silo holds no water ice — every extractor starves', entityId: null });
    const stranded = state.rovers.filter((r) => r.phase === 'disabled');
    for (const r of stranded.slice(0, 2)) {
      factors.push({ key: `stranded/${r.id}`, label: `${r.label} stranded — battery flat, one fewer pair of wheels`, entityId: r.id });
    }
  }
  // The haul: where the nearest ice actually is, whatever the fleet does.
  let nearestIceKm = Infinity;
  const centre = colonyCenter(state);
  for (const d of state.world.deposits) {
    if (d.resource !== 'ice' || d.amount < 10) continue;
    const km = Math.hypot(d.x - centre.x, d.z - centre.z) / 1000;
    if (km < nearestIceKm) nearestIceKm = km;
  }
  if (nearestIceKm < Infinity && nearestIceKm > 0.75) {
    factors.push({ key: 'feed/far', label: `Nearest water ice is ${nearestIceKm.toFixed(1)} km away — a long haul per fill`, entityId: null });
  }
  // The buffer: tankage that holds under two sols of burn forgives nothing.
  const tankage = state.pools.capacity.water;
  if (report.consumptionPerSol > 0.01 && tankage < report.consumptionPerSol * 2) {
    factors.push({ key: 'buffer/thin', label: `Tankage ${Math.round(tankage)} kg covers under two sols of burn`, entityId: null });
  }
  // The drinkers: the biggest nominal water consumer, when it matters.
  let thirstiest: { b: Building; perSol: number } | null = null;
  for (const b of state.buildings) {
    if (b.state !== 'online' || b.damaged || !b.enabled) continue;
    const draw = (effectiveBuildingDef(b).process?.fluidIn?.water ?? 0) * SOL_HOURS;
    if (draw > 0 && (!thirstiest || draw > thirstiest.perSol)) thirstiest = { b, perSol: draw };
  }
  if (thirstiest && thirstiest.perSol >= Math.max(1, report.consumptionPerSol * 0.15)) {
    factors.push({
      key: `consumer/${thirstiest.b.id}`,
      label: `${BUILDINGS[thirstiest.b.kind].label} #${thirstiest.b.id} draws ~${thirstiest.perSol.toFixed(1)} kg/sol`,
      entityId: thirstiest.b.id,
    });
  }

  solutions.push(...STATIC_SOLUTIONS.water.map((s) => ({ ...s, entityId: null })));
  return finalize({ ...report, title: 'WATER BOTTLENECK', factors, solutions });
}

/** The oxygen report. Same shape as water, with water itself as the feed. */
function analyzeOxygen(state: ColonyState): BottleneckReport | null {
  const report = fluidReport(state, 'oxygen', 'oxygen');
  if (!report) return null;
  const factors: BottleneckFactor[] = [];
  const solutions: BottleneckSolution[] = [];

  const scrutiny = producerScrutiny(
    state,
    producerKinds('oxygen'),
    'No Oxygen Generator stands — nothing electrolyses the air',
    EXTRA_SOLUTIONS.buildProducer.oxygen,
  );
  factors.push(...scrutiny.factors);
  solutions.push(...scrutiny.echoes);

  // The feed: O₂ is made of water. When water fails first, oxygen is a
  // symptom, and "increase oxygen production" is exactly the wrong advice.
  const waterReserve = HistorySystem.reserveSols(state, 'water');
  if (waterReserve < 1) {
    factors.push({ key: 'feed/water', label: 'Water runs out first — the generator starves with the tanks', entityId: null });
    solutions.push({ ...EXTRA_SOLUTIONS.feedWater, entityId: null });
  }
  const tankage = state.pools.capacity.oxygen;
  if (report.consumptionPerSol > 0.01 && tankage < report.consumptionPerSol * 2) {
    factors.push({ key: 'buffer/thin', label: `Tankage ${Math.round(tankage)} kg covers under two sols of breath`, entityId: null });
  }

  solutions.push(...STATIC_SOLUTIONS.oxygen.map((s) => ({ ...s, entityId: null })));
  return finalize({ ...report, title: 'OXYGEN BOTTLENECK', factors, solutions });
}

// -------------------------------------------------------------- power ----

/** Battery charge expressed in sols at the tick's measured drain rate. */
function powerReserveSols(state: ColonyState): number | null {
  const drainKw = -state.power.batteryFlowKw;
  if (drainKw <= 0.05) return null;
  const hours = state.power.storedKWh / drainKw;
  return hours / SOL_HOURS;
}

/**
 * Sols of night left. Sunrise/sunset are the clock's fixed quartiles (the
 * sun model in clock.ts: 0.25 up, 0.75 down); inside the day the answer is
 * zero — the bill arrives at nightfall instead.
 */
function solsUntilSunrise(state: ColonyState): number {
  const f = state.clock.frac;
  if (f < 0.25) return 0.25 - f;
  if (f < 0.75) return 0;
  return 1.25 - f;
}

function analyzePower(state: ColonyState): BottleneckReport | null {
  const p = state.power;
  const cap = p.capacityKWh;
  const frac = cap > 0 ? p.storedKWh / cap : 0;
  const reserveSols = powerReserveSols(state);
  const nightLeft = solsUntilSunrise(state);
  const diesBeforeDawn = nightLeft > 0 && reserveSols != null && reserveSols < nightLeft - 0.02;
  const deficit = p.demandKw - p.generationKw;

  let severity: BottleneckSeverity | null = null;
  if (p.firstShedTier === 0 || frac <= 0.05 || (reserveSols != null && reserveSols < 0.1)) {
    severity = 'critical';
  } else if (p.brownout || frac <= 0.15 || (reserveSols != null && reserveSols < 0.25) || diesBeforeDawn) {
    severity = 'warning';
  } else if (
    (frac <= 0.3 && p.batteryFlowKw < -0.05) ||
    (deficit > 0.5 && p.batteryFlowKw < -0.05)
  ) {
    severity = 'watch';
  }
  if (!severity) return null;

  const factors: BottleneckFactor[] = [];
  const solutions: BottleneckSolution[] = [];

  if (deficit > 0.5) {
    factors.push({
      key: 'deficit',
      label: `Demand outruns generation — ${p.demandKw.toFixed(1)} kW wanted · ${p.generationKw.toFixed(1)} kW made`,
      entityId: null,
    });
  }
  if (p.firstShedTier != null) {
    factors.push({
      key: `shed/${p.firstShedTier}`,
      label: `Brownout active — shedding from ${POWER_TIER_LABELS[p.firstShedTier]} down`,
      entityId: null,
    });
  }
  if (diesBeforeDawn && reserveSols != null) {
    factors.push({
      key: 'night/runs-out',
      label: `Battery runs out before dawn — ${reserveSols.toFixed(1)} sols of reserve · ${nightLeft.toFixed(1)} of night left`,
      entityId: null,
    });
  }
  if (frac <= 0.15) {
    factors.push({ key: 'reserve/low', label: `Battery reserve at ${Math.round(frac * 100)}%`, entityId: null });
  }
  // Dust only dims panels, and panels are already dark at night — so an
  // ordinary quiet night and a dim noon are different stones. And ambient
  // haze is not a factor: the advisor names the sky once the loss is a real
  // share of the light (a fifth), while the sun should be earning.
  const dust = state.weather.solarTransmission;
  if (dust < 0.8 && state.clock.sun.isDay) {
    factors.push({ key: 'sky/dust', label: `Dust dims the sky — sunlight reaching panels at ${Math.round(dust * 100)}%`, entityId: null });
  }
  // Producers: damaged or switched-off generation is measured, not guessed.
  for (const b of state.buildings) {
    const def = BUILDINGS[b.kind];
    if (def.powerProduceKw <= 0) continue;
    if (b.state !== 'online') continue;
    if (b.damaged) {
      const echo = repairEcho(def.label, b);
      factors.push(echo.factor);
      solutions.push(echo.solution);
    } else if (!b.enabled) {
      const echo = switchedOffEcho(b, def.label);
      factors.push(echo.factor);
      solutions.push(echo.solution);
    }
  }
  if (cap <= POD_BATTERY_KWH + 1) {
    factors.push({ key: 'storage/pod-only', label: `Only the pod's own pack — no Battery Bank takes the night`, entityId: null });
  }
  // The heaviest running machine, when it owns a real share of the demand:
  // the mock's "Refinery consuming excess power", with the number measured.
  let heaviest: { b: Building; kw: number } | null = null;
  for (const b of state.buildings) {
    if (b.state !== 'online' || b.damaged || !b.enabled) continue;
    if ((b.loadKw ?? 0) > 0 && (!heaviest || b.loadKw > heaviest.kw)) heaviest = { b, kw: b.loadKw };
  }
  if (heaviest && heaviest.kw >= Math.max(8, p.demandKw * 0.3)) {
    factors.push({
      key: `load/${heaviest.b.id}`,
      label: `${BUILDINGS[heaviest.b.kind].label} #${heaviest.b.id} is drawing ${heaviest.kw.toFixed(1)} kW — the heaviest machine on the grid`,
      entityId: heaviest.b.id,
    });
  }
  // Every generator solar → baseload row, when the night or storm is biting.
  const hasBaseload = state.buildings.some(
    (b) => BUILDINGS[b.kind].generation === 'baseload' && b.state === 'online' && !b.damaged && b.enabled,
  );
  if (!hasBaseload && (diesBeforeDawn || dust < 0.8)) {
    solutions.push({ ...EXTRA_SOLUTIONS.baseload, entityId: null });
  }

  solutions.push(...STATIC_SOLUTIONS.power.map((s) => ({ ...s, entityId: null })));
  return finalize({
    kind: 'power',
    title: 'POWER BOTTLENECK',
    severity,
    productionPerSol: p.generationKw * SOL_HOURS,
    consumptionPerSol: p.demandKw * SOL_HOURS,
    unit: 'kWh',
    projectedShortageSols: reserveSols,
    factors,
    solutions,
  });
}

// --------------------------------------------------------------- rank ----

function finalize(report: BottleneckReport): BottleneckReport {
  report.factors = report.factors.slice(0, MAX_FACTORS);
  report.solutions = report.solutions.slice(0, MAX_SOLUTIONS);
  return report;
}

const SEVERITY_RANK: Record<BottleneckSeverity, number> = { critical: 0, warning: 1, watch: 2 };
/**
 * Tie order between equally-tired systems: breath before water before grid —
 * "oxygen kills in hours, water in days" (the tutorial's own triage).
 */
const KIND_RANK = { oxygen: 0, water: 1, power: 2 } as const;

/** One full pass over the colony: measure, scrutinize, rank. Pure. */
export function bottleneckSnapshot(state: ColonyState): BottleneckSnapshot {
  const active = [analyzeOxygen(state), analyzeWater(state), analyzePower(state)].filter(
    (r): r is BottleneckReport => r !== null,
  );
  // Worst first: severity, then whichever empties soonest, then the triage
  // tie-break. All three keys are totals, so the order never flickers.
  active.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const sa = a.projectedShortageSols ?? Infinity;
    const sb = b.projectedShortageSols ?? Infinity;
    if (sa !== sb) return sa - sb;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  });
  return { bottlenecks: active, next: active[0] ?? null };
}
