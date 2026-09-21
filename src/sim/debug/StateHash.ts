/**
 * Deterministic simulation state hashing — refactor roadmap Milestone 1
 * (§58) pulled forward from Phase 27, where the same idea serves replay
 * testing.
 *
 * `hashSimulation(sim)` compresses the colony's authoritative state into a
 * short hex string with the property that matters for refactoring:
 *
 *     same seed + same commands + same delivered time  ⇒  same hash
 *     any divergence in simulation state               ⇒  different hash
 *
 * That turns "did the extraction change behavior?" into a string comparison.
 * The planned use: pin hashes for canonical scenarios before an extraction,
 * compare after (Phase 26's transcripts will feed exactly this function).
 *
 * Design notes:
 *
 *  - **Live state, not the save.** The projection reads the sim directly
 *    rather than `snapshot()`, so a persistence bug and a simulation bug
 *    don't hide behind each other, and Phase 3's codec rework can't perturb
 *    the tool that's supposed to police it.
 *  - **Wording is excluded.** `idleReason`, entity labels and other wording
 *    are presentation strings; hashing them would make the hash churn on a
 *    reword that changes no behavior. Everything that can steer a future
 *    tick is in.
 *  - **Two limits, documented honestly:**
 *      * `remainder` (the sub-tick frame accumulator, private) and the
 *        `dropRng` closure's internal counter are not observable and are
 *        left out. `remainder` never changes how many ticks delivered time
 *        produces; a `dropRng` divergence surfaces as a real `nextDropSol`
 *        / drop difference one roll later, which *is* hashed.
 *      * The hash compares *live* state, and a save deliberately drops the
 *        in-flight runtime of rovers and buildings (they resume *at rest*:
 *        goal/nav/chargeSat reset, powerSat recomputed, history cleared).
 *        So a live sim and its just-restored twin are NOT expected to hash
 *        equal — compare restored sims after they have advanced, or compare
 *        two restorations of the same save against each other.
 *      * Numbers hash exactly (bit-for-bit doubles). Deterministic runs
 *        produce identical doubles, so this maximises sensitivity; it also
 *        means the hash is a *same-machine, same-build* comparison tool,
 *        not a cross-platform checksum.
 */

import type { Simulation } from '../Simulation';

/** Format marker, so a hash always says which projection produced it. */
const FORMAT = 'rf1';

// ------------------------------------------------------------------ hash ----

/**
 * cyrb53 — a small, fast, well-distributed 53-bit string hash (public
 * domain). Integer math only (`Math.imul`), so it is deterministic on every
 * JS engine. We run two lanes with different seeds for ~106 bits; collision
 * risk is not the point, but a fluke collision would mask a regression.
 */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Canonical JSON: object keys sorted at every level, arrays kept in order.
 * Makes the serialization independent of property-insertion order, so the
 * hash depends only on the state itself.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

// ------------------------------------------------------------ projection ----

const byId = <T extends { id: number }>(list: T[]): T[] =>
  [...list].sort((a, b) => a.id - b.id);

/** The authoritative state of `sim`, as plain data in a fixed shape. */
function project(sim: Simulation): unknown {
  const wx = sim.weather;
  return {
    v: FORMAT,
    seed: sim.seed,
    difficulty: sim.difficulty,
    worldOptions: sim.worldOptions,
    world: { half: sim.world.half, region: sim.world.region },
    simTime: sim.simTime,
    gameOver: sim.gameOver,

    clock: { sol: sim.clock.sol, frac: sim.clock.frac },

    // The weather snapshot carries both RNG streams; the extra fields are
    // the live derived readings, deterministic at a tick boundary.
    weather: {
      ...(wx.snapshot() as Record<string, unknown>),
      time: wx.time,
      storm: wx.storm,
      stormIntensity: wx.stormIntensity,
      solarTransmission: wx.solarTransmission,
      visibility: wx.visibility,
    },

    storedKWh: sim.storedKWh,
    storage: sim.storage,
    // P5: the component rack is state, not presentation — two runs that craft a
    // different number of motors are different colonies.
    components: sim.components,
    water: { active: sim.state.water.active, links: sim.state.water.links, tanks: sim.state.water.tanks },
    // P2: which projects the colony has been handed, which it has landed, and
    // what it has earned. Content lives in data tables; this is the board.
    objectives: {
      active: sim.state.objectives.active,
      completed: sim.state.objectives.completed,
    },
    unlocks: sim.state.unlocks,
    lastDirectOrderSol: sim.state.lastDirectOrderSol,
    // P3: the autonomy stat is measured state — two colonies with different
    // streaks are different colonies. The transient edge memory is excluded.
    autonomy: (() => {
      const { _holding: _t, ...rest } = sim.state.autonomy;
      return rest;
    })(),
    // P3: standing orders are colony state — two colonies run to different
    // policies diverge on the next tick.
    policies: sim.state.policies,
    tutorial: {
      milestones: sim.state.tutorial.milestones,
      warnings: sim.state.tutorial.warnings,
      seenHints: sim.state.tutorial.seenHints,
      dismissedHints: sim.state.tutorial.dismissedHints,
      funnel: sim.state.tutorial.funnel,
      stats: sim.state.tutorial.stats,
    },
    componentCapacity: sim.componentCapacity(),
    fluids: sim.pools.amounts,
    fluidCapacity: sim.pools.capacity,
    flows: sim.flows,

    nextDropSol: sim.nextDropSol,
    // `name` is wording, not state — deliberately left out, like rover labels.
    colonist: {
      id: sim.colonist.id,
      x: sim.colonist.x,
      y: sim.colonist.y,
      z: sim.colonist.z,
      heading: sim.colonist.heading,
      health: sim.colonist.health,
      suitO2: sim.colonist.suitO2,
      inside: sim.colonist.inside,
      shelterId: sim.colonist.shelterId,
      activity: sim.colonist.activity,
      order: sim.colonist.order,
      gx: sim.colonist.gx,
      gz: sim.colonist.gz,
      starved: sim.colonist.starved,
      dead: sim.colonist.dead,
    },
    history: sim.history,
    solHistory: sim.solHistory,
    journal: sim.journal,

    rovers: byId(sim.rovers).map((r) => ({
      id: r.id,
      kind: r.kind,
      x: r.x,
      y: r.y,
      z: r.z,
      heading: r.heading,
      battery: r.battery,
      cargo: r.cargo,
      phase: r.phase,
      command: r.command,
      pending: r.pending,
      goal: r.goal,
      gx: r.gx,
      gz: r.gz,
      gid: r.gid,
      recharge: r.recharge,
      lowBatteryNotified: r.lowBatteryNotified,
      chargeSat: r.chargeSat,
      autoTask: r.autoTask,
      condition: r.condition,
      parts: r.parts,
      upgrades: r.upgrades ?? {}, upgradeJob: r.upgradeJob ?? null, paint: r.paint ?? null,
      rules: r.rules,
      routePaused: r.routePaused,
      blockNotified: r.blockNotified,
      sheltered: r.sheltered,
      lightsOn: r.lightsOn,
      lightsActive: r.lightsActive,
      navPath: r.navPath,
      navI: r.navI,
    })),

    buildings: byId(sim.buildings).map((b) => ({
      id: b.id,
      kind: b.kind,
      x: b.x,
      z: b.z,
      rot: b.rot,
      state: b.state,
      remainingCost: b.remainingCost,
      needsMaterials: b.needsMaterials,
      progress: b.progress,
      buildTime: b.buildTime,
      workerId: b.workerId,
      enabled: b.enabled,
      powerSat: b.powerSat,
      throughput: b.throughput,
      genKw: b.genKw,
      loadKw: b.loadKw,
      health: b.health,
      cleanliness: b.cleanliness,
      damaged: b.damaged,
      assembly: b.assembly,
      maintenance: b.maintenance,
      level: b.level,
      recipe: b.recipe,
      craft: b.craft,
      upgrades: b.upgrades ?? {}, upgradeJob: b.upgradeJob ?? null, paint: b.paint ?? null,
    })),

    deposits: byId(sim.world.deposits).map((d) => ({
      id: d.id,
      resource: d.resource,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
      reservedBy: d.reservedBy ?? null,
    })),

    pois: byId(sim.world.pois).map((p) => ({
      id: p.id,
      kind: p.kind,
      x: p.x,
      z: p.z,
      salvage: p.salvage,
      energyKWh: p.energyKWh,
      discovered: p.discovered,
      solsToBury: p.solsToBury,
      buried: p.buried,
      manifest: p.manifest,
    })),
  };
}

// ----------------------------------------------------------------- public ----

export type StateSection =
  | 'core'
  | 'weather'
  | 'resources'
  | 'rovers'
  | 'buildings'
  | 'colonist'
  | 'world';

export interface StateDiffEntry {
  path: string;
  valA: unknown;
  valB: unknown;
}

/**
 * Return the authoritative plain-data state projection for inspection or comparison.
 */
export function projectSimulation(sim: Simulation): unknown {
  return project(sim);
}

/**
 * Hash a specific simulation subsystem section.
 */
export function hashSimulationSection(sim: Simulation, section: StateSection): string {
  const p = project(sim) as Record<string, unknown>;
  let sectionData: unknown;
  switch (section) {
    case 'core':
      sectionData = {
        v: p.v,
        seed: p.seed,
        difficulty: p.difficulty,
        worldOptions: p.worldOptions,
        world: p.world,
        simTime: p.simTime,
        gameOver: p.gameOver,
        clock: p.clock,
        nextDropSol: p.nextDropSol,
        history: p.history,
        // Phase 4: the saved long records. Both outlive the 120-sample ring,
        // so hashing them pins long-run determinism the ring no longer can.
        // `_solAcc` stays out — derived transient, rebuilt on restore.
        solHistory: (p as any).solHistory,
        journal: (p as any).journal,
        objectives: (p as any).objectives,
        unlocks: (p as any).unlocks,
        lastDirectOrderSol: (p as any).lastDirectOrderSol,
        tutorial: (p as any).tutorial,
      };
      break;
    case 'weather':
      sectionData = p.weather;
      break;
    case 'resources':
      sectionData = {
        storedKWh: p.storedKWh,
        storage: p.storage,
        components: p.components,
        water: p.water,
        componentCapacity: p.componentCapacity,
        fluids: p.fluids,
        fluidCapacity: p.fluidCapacity,
        flows: p.flows,
      };
      break;
    case 'rovers':
      sectionData = p.rovers;
      break;
    case 'buildings':
      sectionData = p.buildings;
      break;
    case 'colonist':
      sectionData = p.colonist;
      break;
    case 'world':
      sectionData = {
        deposits: p.deposits,
        pois: p.pois,
      };
      break;
  }
  const text = canonicalJson(sectionData);
  const a = cyrb53(text, 0x9e3779b9);
  const b = cyrb53(text, 0x85ebca6b);
  return `${FORMAT}-${section}-${a.toString(16).padStart(14, '0')}-${b.toString(16).padStart(14, '0')}`;
}

/**
 * Compute section-by-section hashes across all simulation domains.
 */
export function hashSimulationSections(sim: Simulation): Record<StateSection, string> {
  return {
    core: hashSimulationSection(sim, 'core'),
    weather: hashSimulationSection(sim, 'weather'),
    resources: hashSimulationSection(sim, 'resources'),
    rovers: hashSimulationSection(sim, 'rovers'),
    buildings: hashSimulationSection(sim, 'buildings'),
    colonist: hashSimulationSection(sim, 'colonist'),
    world: hashSimulationSection(sim, 'world'),
  };
}

/**
 * Perform a deep structural comparison between the projected states of two simulations.
 * Returns an array of paths that diverged along with their values.
 */
export function diffSimulationState(simA: Simulation, simB: Simulation): StateDiffEntry[] {
  const pA = project(simA);
  const pB = project(simB);
  const diffs: StateDiffEntry[] = [];

  function compare(a: unknown, b: unknown, currentPath: string): void {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      diffs.push({ path: currentPath, valA: a, valB: b });
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      diffs.push({ path: currentPath, valA: a, valB: b });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        diffs.push({ path: `${currentPath}.length`, valA: a.length, valB: b.length });
      }
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        compare(a[i], b[i], `${currentPath}[${i}]`);
      }
      return;
    }
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(objA), ...Object.keys(objB)])).sort();
    for (const k of keys) {
      const nextPath = currentPath ? `${currentPath}.${k}` : k;
      if (!(k in objA)) {
        diffs.push({ path: nextPath, valA: undefined, valB: objB[k] });
      } else if (!(k in objB)) {
        diffs.push({ path: nextPath, valA: objA[k], valB: undefined });
      } else {
        compare(objA[k], objB[k], nextPath);
      }
    }
  }

  compare(pA, pB, '');
  return diffs;
}

/**
 * Human-readable explanation of simulation state divergences.
 */
export function explainStateDivergence(simA: Simulation, simB: Simulation, maxDiffs = 10): string[] {
  const diffs = diffSimulationState(simA, simB);
  if (diffs.length === 0) return ['No state divergence detected.'];
  const lines = diffs.slice(0, maxDiffs).map(d =>
    `  ${d.path}: ${JSON.stringify(d.valA)} vs ${JSON.stringify(d.valB)}`
  );
  if (diffs.length > maxDiffs) {
    lines.push(`  ... and ${diffs.length - maxDiffs} more divergence(s)`);
  }
  return lines;
}

/**
 * Hash the colony's authoritative state into a stable string
 * (`rf1-<13 hex>-<13 hex>`). Read-only; safe to call anywhere the
 * invariants are safe to call.
 */
export function hashSimulation(sim: Simulation): string {
  const text = canonicalJson(project(sim));
  const a = cyrb53(text, 0x9e3779b9);
  const b = cyrb53(text, 0x85ebca6b);
  // Each lane spans [0, 2^53) — 14 hex digits.
  return `${FORMAT}-${a.toString(16).padStart(14, '0')}-${b.toString(16).padStart(14, '0')}`;
}
