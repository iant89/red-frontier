/**
 * Player-facing string bundles — Phase 1 infrastructure.
 *
 * Externalize tutorial, warnings, projects, and narrative POIs so localization
 * later is a rewrite of this file, not a hunt through HUD.ts template literals.
 *
 * Per COMMERCIAL-ROADMAP-REVIEW.md §4.6: English-only at launch is fine;
 * unlocalizable is not. New player-facing copy must go through here.
 *
 * Convention:
 * - Copy that belongs to a **data table** lives with that table — blueprint
 *   labels in `src/sim/defs.ts`, project titles, blurbs and requirement labels
 *   in `src/sim/projects/catalog.ts`. Duplicating it here would let the two
 *   drift; this file is for copy that UI code would otherwise inline.
 * - Keys are dot-namespaced: `tutorial.*`, `warning.*`, `project.*`, `bottleneck.*`, `dashboard.*`, `autonomy.*`, `poi.*`, `report.*`
 * - Functions that format numbers take values, not pre-formatted strings, so translators can reorder.
 * - No DOM, no three.js, no sim imports — pure strings.
 */

export type StringKey =
  | `tutorial.${string}`
  | `warning.${string}`
  | `project.${string}`
  | `bottleneck.${string}`
  | `dashboard.${string}`
  | `autonomy.${string}`
  | `poi.${string}`
  | `report.${string}`
  | `alert.${string}`
  | `building.${string}`
  | `rover.${string}`;

export const STRINGS = {
  // Tutorial — situation → warning → player discovers fix (not click-here)
  'tutorial.welcome': 'Welcome to Mars. Your lander has 4 sols of air, water and rations. Everything after that you build.',
  'tutorial.firstMove': 'Move a rover: select it, then right-click the terrain.',
  'tutorial.findResources': 'Find resources: drive near deposits, they appear on the minimap.',
  'tutorial.extract': 'Extract: order a rover to mine. It will haul to storage automatically if a route is set.',
  'tutorial.bringHome': 'Bring it home: mining rovers unload at the pod or warehouse when full.',
  'tutorial.build': 'Build: pick from the palette, click terrain. Shift+click places several.',
  'tutorial.power': 'Generate power: solar arrays need sun, batteries carry the night. Watch the power tier.',
  'tutorial.lifeSupport': 'Manage life support: ice → water → oxygen → food. Oxygen kills in hours, water in days, food in weeks.',
  'tutorial.automate': 'Automate: per-rover rules auto-haul, auto-service, storm shelter, auto-rescue. Set a charge floor.',
  'tutorial.storm': 'Survive a small environmental problem: dust buries panels, storms dim sun, lightning singes hardware. Shelter rovers, charge batteries.',
  'tutorial.objective': 'Receive a meaningful colony objective: open the projects panel for your current engineering goal.',

  // Warnings — forecast-based, matches forecast.ts warningForFluid
  'warning.waterEmpty': (sols: string) => `Your water reserve will run dry in ${sols}.`,
  'warning.oxygenEmpty': (sols: string) => `Your oxygen reserve will run dry in ${sols}.`,
  'warning.foodEmpty': (sols: string) => `Your food reserve will run dry in ${sols}.`,
  'warning.waterLow': (sols: string, prod: string, cons: string) => `Water low — ${sols} remaining. Production ${prod} / consumption ${cons} kg/sol.`,
  'warning.oxygenLow': (sols: string, prod: string, cons: string) => `Oxygen low — ${sols} remaining. Production ${prod} / consumption ${cons} kg/sol.`,
  'warning.foodLow': (sols: string, prod: string, cons: string) => `Food low — ${sols} remaining. Production ${prod} / consumption ${cons} kg/sol.`,
  'warning.powerLow': 'Power low — batteries draining. Shed industry or add generation.',
  'warning.batteryReserve': (pct: string) => `Battery reserve < ${pct}%.`,
  'warning.solarDirty': 'Panels dirty — dust reducing output. Order cleaning.',
  'warning.stormInbound': (kind: string, sols: string) => `${kind} storm inbound — ${sols} lead. Shelter rovers, charge batteries.`,
  'warning.roverStranded': (label: string) => `${label} stranded — battery flat. Order recovery.`,
  'warning.buildingDamaged': (kind: string) => `${kind} damaged — tripped offline. Order repair.`,

  // Why this matters — per original roadmap "Why this matters explanations"
  'why.water': 'Water is the bridge into life support: extractor → water → oxygen generator → O₂ and greenhouse → food. No water, no air.',
  'why.oxygen': 'Oxygen kills in hours. The oxygenator burns water for O₂; the habitat recycles 55% of water. Keep both powered.',
  'why.power': 'Power is tiered: 0 life support, 1 water/oxygen, 2 industry, 3 rover charge. Industry browns out before you suffocate — by design.',
  'why.rover': 'Rovers are your hands. Two start, more are assembled in the garage from steel + motors + boards. Service drivetrains in the garage, replace motors/boards in the repair bay.',
  'why.automation': 'Automation is progression: manual → assisted → automated → redundant → autonomous. A policy doing the work is the fantasy working.',
  'why.exploration': 'Exploration is stories and decisions, not +100 iron. POIs give technology, information, locations, unique seams, challenges.',

  // Projects — Phase 2 data-driven, copy here
  'project.establishSurvival.title': 'Establish Survival',
  'project.establishSurvival.desc': 'Functional oxygen, water, food production, stable power. Colony enters Stable Operations.',
  'project.surviveFirstStorm.title': 'Survive the First Storm',
  'project.surviveFirstStorm.desc': 'Radar, emergency battery, sheltered rover, emergency reserve. Reward: storm forecasting.',
  'project.industrialize.title': 'Industrialize',
  'project.industrialize.desc': 'Refinery, workshop, mining operation, automated haul route. Reward: advanced automation.',
  'project.remoteOperations.title': 'Remote Operations',
  'project.remoteOperations.desc': 'Long-range rover, remote power, communications, emergency supplies. Reward: remote exploration.',
  'project.autonomousColony.title': 'Autonomous Colony',
  'project.autonomousColony.desc': 'Survive 10 sols without manual intervention. The defining challenge of Red Frontier.',

  // Dashboard — Phase 4
  'dashboard.title': 'Red Frontier Operations',
  'dashboard.power': 'Power',
  'dashboard.water': 'Water',
  'dashboard.oxygen': 'Oxygen',
  'dashboard.food': 'Food',
  'dashboard.rovers': 'Rovers',
  'dashboard.autonomy': 'Autonomy',
  'dashboard.nextBottleneck': 'Next Bottleneck',
  'dashboard.stable': 'Stable',
  'dashboard.warning': 'Warning',
  'dashboard.critical': 'Critical',
  'dashboard.operational': 'Operational',
  'dashboard.singlePoints': 'Single points of failure',
  'dashboard.noSinglePoints': 'None — every critical chain has a spare.',
  'dashboard.historyTitle': 'History',
  'dashboard.scope.live': 'Live',
  'dashboard.scope.sols': 'Sols',
  'dashboard.noSols': 'The long record begins when the first sol closes.',
  'dashboard.close': 'Close (Esc)',
  'dashboard.graph.power': 'Power',
  'dashboard.graph.water': 'Water',
  'dashboard.graph.oxygen': 'Oxygen',
  'dashboard.graph.food': 'Food',
  'dashboard.graph.ore': 'Ore',
  'dashboard.graph.utilization': 'Rover utilization',
  'dashboard.graph.battery': 'Battery reserves',
  'dashboard.graph.production': 'Production',
  'dashboard.graph.consumption': 'Consumption',
  'dashboard.legend.gen': 'generation',
  'dashboard.legend.load': 'load',
  'dashboard.sub.power': (gen: number, load: number) => `${gen.toFixed(1)} kW gen · ${load.toFixed(1)} kW load`,
  'dashboard.sub.fluid': (rate: number) => (rate > 0.005 ? `+${rate.toFixed(1)} kg/sol` : `${rate.toFixed(1)} kg/sol`),
  'dashboard.sub.rovers': (operational: number, total: number) => `${operational}/${total}`,
  'dashboard.sub.autonomy': (identity: string) => identity,
  'dashboard.bestAutonomy': (best: number) => `best ${best.toFixed(1)} sols`,

  // Bottleneck — Phase 5 (the advisor panel; copy the analyzer data tables
  // don't carry lives here, per this file's data-table convention)
  'bottleneck.water.title': 'Water Bottleneck',
  'bottleneck.power.title': 'Power Bottleneck',
  'bottleneck.oxygen.title': 'Oxygen Bottleneck',
  'bottleneck.title': 'Bottleneck Advisor',
  'bottleneck.close': 'Close (Esc)',
  'bottleneck.production': 'Production',
  'bottleneck.consumption': 'Consumption',
  'bottleneck.projectedShortage': 'Projected shortage',
  'bottleneck.shortageNone': 'not draining at the current rate',
  'bottleneck.contributing': 'Contributing factors',
  'bottleneck.solutions': 'Possible solutions',
  'bottleneck.severity.watch': 'Watch',
  'bottleneck.severity.warning': 'Warning',
  'bottleneck.severity.critical': 'Critical',
  'bottleneck.focus': 'Focus this machine',
  'bottleneck.oath': 'The advisor names the problem. Solving it stays yours.',
  'bottleneck.empty': 'No bottlenecks.',
  'bottleneck.emptySub': 'No reserve is draining and the grid is fed. The advisor speaks when something is short — and never fixes it for you.',
  'bottleneck.increaseMining': 'Increase mining',
  'bottleneck.reduceConsumption': 'Reduce consumption',
  'bottleneck.buildStorage': 'Build storage',
  'bottleneck.repairRover': (label: string) => `Repair ${label}`,

  // Autonomy — AUTONOMY.md
  'autonomy.streak': (sols: string) => `Autonomy ${sols}`,
  'autonomy.coverage': (pct: string) => `Coverage ${pct}`,
  'autonomy.rung.manual': 'Manual — you are the machine',
  'autonomy.rung.assisted': 'Assisted — flight software does chores',
  'autonomy.rung.automated': 'Automated — colony works a full sol without being told',
  'autonomy.rung.redundant': 'Redundant — no single machine can end this colony',
  'autonomy.rung.autonomous': 'Autonomous — colony no longer needs you',
  'autonomy.break.intervention': (action: string, streak: string) => `Intervention logged — ${action}. Streak ended at ${streak}.`,
  'autonomy.break.critical': (reason: string, streak: string) => `${reason}. The colony ran itself for ${streak}.`,
  'autonomy.promotion': (rung: string) => `${rung} reached`,
  'autonomy.demotion': (reason: string, rung: string) => `${reason} — colony is ${rung} until redundancy restored`,

  // POI / Exploration — Phase 6/7
  'poi.unknown.title': 'Unknown Anomaly',
  'poi.unknown.distance': (dist: string) => `Distance: ${dist}`,
  'poi.unknown.signal': (strength: string) => `Signal: ${strength}`,
  'poi.surveyComplete.title': 'Survey Complete',
  'poi.ironDeposit': 'Iron deposit',
  'poi.estimated': (range: string) => `Estimated: ${range}`,
  'poi.confidence': (pct: string) => `Confidence: ${pct}`,
  'poi.terrain': (kind: string) => `Terrain: ${kind}`,
  'poi.risk': (level: string) => `Risk: ${level}`,

  // Rover history — Phase 8
  'rover.history.title': (label: string) => `${label}`,
  'rover.history.distance': (dist: string) => `Distance traveled: ${dist}`,
  'rover.history.oreHauled': (kg: string) => `Ore hauled: ${kg}`,
  'rover.history.storms': (n: string) => `Storms survived: ${n}`,
  'rover.history.recoveries': (n: string) => `Recoveries: ${n}`,
  'rover.history.repairs': (n: string) => `Repairs: ${n}`,
  'rover.history.builtSol': (sol: string) => `Built Sol ${sol}`,

  // Report — Phase 11
  'report.title': 'Colony Report',
  'report.solSurvived': (n: string) => `Sol survived: ${n}`,
  'report.distanceExplored': (dist: string) => `Distance explored: ${dist}`,
  'report.resourcesProduced': 'Resources Produced',
  'report.rovers': 'Rovers',
  'report.majorIncidents': 'Major Incidents',
  'report.achievement': 'Achievement',
  'report.autonomous': (sols: string) => `Autonomous Colony — colony survived ${sols} without manual intervention`,

  // Alerts — existing copy, centralized here for future
  'alert.brownout': 'Brownout — power shortage',
  'alert.oxygenLow': 'Oxygen low',
  'alert.waterLow': 'Water low',
  'alert.foodLow': 'Food low',
  'alert.stormInbound': 'Storm inbound',
  'alert.roverDisabled': 'Rover disabled',
  'alert.buildingDamaged': 'Building damaged',
  'alert.panelsDirty': 'Panels dirty',
  'alert.storageFull': 'Storage full',
  'alert.lightningStrike': 'Lightning strike',
} as const;

export type Strings = typeof STRINGS;

/**
 * Get a string by key. If key not found, returns key itself (fail-safe).
 * If value is function, caller must invoke with args.
 */
export function getString<K extends keyof Strings>(key: K): Strings[K] {
  return STRINGS[key] ?? (key as any);
}

/**
 * Format a number for player-facing display.
 */
export function formatKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${Math.round(kg)} kg`;
}

export function formatKm(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export function formatPct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

export function formatSols(sols: number): string {
  if (!Number.isFinite(sols)) return '∞';
  if (sols < 0.1) return `${sols.toFixed(2)} sols`;
  if (sols < 10) return `${sols.toFixed(1)} sols`;
  return `${Math.round(sols)} sols`;
}
