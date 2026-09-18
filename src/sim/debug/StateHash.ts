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
      level: b.level,
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
