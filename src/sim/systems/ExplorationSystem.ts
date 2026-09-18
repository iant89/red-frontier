/**
 * Phase 14 — Extract ExplorationSystem
 *
 * Goal per roadmap §18: separate exploration/POI logic from Simulation, and
 * keep world generation separate from discovery.
 *
 * ---------------------------------------------------------------------------
 * The distinction
 * ---------------------------------------------------------------------------
 *
 *   World
 *       =  the physical planet: terrain, deposits, scattered sites (pois.ts
 *          generators + World.generatePois). Sites exist whether or not anyone
 *          ever finds them; the same seed always scatters the same planet.
 *
 *   ExplorationSystem
 *       =  what the player has discovered about it: discovery radius, the
 *          supply-drop schedule and burial clock, surviving-cell rewards, and
 *          the alerts/events those transitions raise.
 *
 * That split is what lets a later pass add scanned regions, hidden resources,
 * science and mapping without touching terrain generation.
 *
 * ---------------------------------------------------------------------------
 * Responsibilities (roadmap §18)
 * ---------------------------------------------------------------------------
 *   - POI discovery          tickDiscovery — a site joins the map when a rover
 *                            or the colonist gets within POI_DISCOVER_M
 *   - exploration state      nextDropSol / dropRng (owned by ColonyState;
 *                            advanced here)
 *   - salvage (site side)    takeSalvage / recoverSiteCells — depleting a site
 *                            and handing surviving cells to the grid. The
 *                            *rover task* (drive out, cut, haul) stays in
 *                            RoverSystem (Phase 10): same split as mining vs
 *                            LogisticsSystem.
 *   - discoveries / rewards  the opportunity alert on find; cell recovery
 *   - exploration events     supply-drop landing, burial, aborted mission
 *
 * ---------------------------------------------------------------------------
 * What deliberately does NOT live here
 * ---------------------------------------------------------------------------
 *   - **World generation** (`World.generatePois`, `makePoi`, `pickPoiKind`):
 *     the planet is World’s; this module only reads and marks it.
 *   - **The salvage task body** (`RoverSystem.issueSalvage` / `doSalvage`):
 *     pathing, hold fill, unload ping-pong and drivetrain wear are rover
 *     domain. They call into here for the site-side kg / cell arithmetic.
 *   - **pois.ts pure helpers** (`salvageTotalKg`, `isPickedClean`,
 *     `burialRate`, `makeSupplyDrop`, `rollDropRing`): content tables and
 *     seeded constructors stay data-shaped, exactly as `weather.ts` stays
 *     next to WeatherSystem.
 *
 * Determinism: discovery is geometric (no RNG); drops consume `state.dropRng`
 * alone — never the world / deposit / weather streams (roadmap §9 Important).
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Poi } from '../pois';
import type { ResourceId } from '../defs';
import {
  burialRate,
  isPickedClean,
  makeSupplyDrop,
  POI_KINDS,
  rollDropRing,
  salvageTotalKg,
  takeSalvage as takeSalvagePure,
} from '../pois';
import {
  DROP_GAP_SOL_MAX,
  DROP_GAP_SOL_MIN,
  POI_DISCOVER_M,
  SIM_TICK,
  SOLS_PER_SEC,
} from '../config';
import { batteryCapacityKWh } from '../state/PowerState';
import type { Severity } from '../alerts';

export class ExplorationSystem {
  // -------------------------------------------------------------- tick ----

  /**
   * The world past the base (GDD §06, §10). Runs straight after the weather,
   * because the only thing that decides how fast a landed container disappears
   * is the sky.
   */
  static tick(state: ColonyState): void {
    ExplorationSystem.tickDiscovery(state);
    ExplorationSystem.tickSupplyDrops(state);
  }

  /**
   * GDD §06: "the map begins mostly unknown." A site joins the map when a rover
   * or the colonist gets within {@link POI_DISCOVER_M} of it — and says so out
   * loud, because a find the player never hears about is a find that never
   * happened. Discovery is permanent: finding something does not un-find it when
   * the rover drives away.
   */
  static tickDiscovery(state: ColonyState): void {
    for (const p of state.world.pois) {
      if (p.discovered) continue;
      const near = (x: number, z: number) => Math.hypot(x - p.x, z - p.z) <= POI_DISCOVER_M;
      const seen =
        state.rovers.some((r) => r.phase !== 'disabled' && near(r.x, r.z)) ||
        near(state.colonist.x, state.colonist.z);
      if (!seen) continue;
      p.discovered = true;
      const info = POI_KINDS[p.kind];
      const kg = salvageTotalKg(p);
      state.domainEvents.push({
        type: 'poi/discovered',
        poiId: p.id,
        kind: p.kind,
      });
      state.alerts.raise(
        `poi-found-${p.id}`,
        'opportunity',
        `${info.icon} ${info.label} found`,
        kg > 1 ? `${info.blurb} About ${Math.round(kg)} kg of salvage.` : info.blurb,
        state.simTime,
        state.clock.format(),
      );
    }
  }

  /**
   * Earth cargo missions (GDD §10): they arrive at uncertain locations, are
   * marked by a transponder, and the dust takes them if nobody comes.
   *
   * Three things happen here, in this order: book the next mission, land it when
   * its sol arrives, and run down the burial clock on whatever is on the ground.
   * The clock runs at `burialRate(stormIntensity)` times normal inside a storm,
   * which is the entire design of the feature — the drop is not lost because
   * time passed, it is lost because the sky came in and the player had to choose
   * between it and the arrays.
   */
  static tickSupplyDrops(state: ColonyState): void {
    const solNow = state.clock.sol + state.clock.frac;
    if (solNow >= state.nextDropSol) ExplorationSystem.landSupplyDrop(state);

    const dtSols = SIM_TICK * SOLS_PER_SEC;
    const rate = burialRate(state.weather.stormIntensity);
    for (const p of state.world.pois) {
      if (p.kind !== 'supplyDrop') continue;

      /**
       * A drop is finished either way — buried by the dust or stripped by a
       * rover — and either way its deadline alert has to go. Clearing only on
       * burial would leave a recovered container on the alert board forever,
       * counting down a sol it no longer has.
       */
      if (p.buried || isPickedClean(p)) {
        state.alerts.clear(`drop-live-${p.id}`, state.simTime, state.clock.format());
        continue;
      }

      p.solsToBury -= dtSols * rate;
      if (p.solsToBury > 0) {
        // One standing alert per live drop, with the clock in it, so the HUD
        // reads as a deadline rather than a rumour. `raise` only logs on the
        // transition, so re-asserting it every tick is not log spam.
        const sols = p.solsToBury;
        state.alerts.raise(
          `drop-live-${p.id}`,
          sols < 1 ? 'crit' : 'opportunity',
          `📦 Supply drop — ${p.manifest}`,
          `${Math.round(salvageTotalKg(p))} kg at ${Math.round(p.x)}, ${Math.round(p.z)}. ` +
            `Buried in ${sols.toFixed(1)} sols${rate > 1 ? ' — the storm is filling it in fast' : ''}.`,
          state.simTime,
          state.clock.format(),
          p.id,
        );
        continue;
      }

      p.solsToBury = 0;
      p.buried = true;
      state.alerts.clear(`drop-live-${p.id}`, state.simTime, state.clock.format());
      event(
        state,
        'warn',
        `The dust took the ${p.manifest.toLowerCase()} drop — ${Math.round(salvageTotalKg(p))} kg left under the regolith.`,
      );
    }
  }

  /**
   * Put one container on the ground. The site is chosen inside a ring — far
   * enough out that recovery is an expedition, close enough in that it is not a
   * fool's errand on a flat battery (GDD §10's "uncertain locations").
   */
  static landSupplyDrop(state: ColonyState): void {
    const rng = state.dropRng;
    const ring = rollDropRing(rng, state.world.half);
    let x = 0;
    let z = 0;
    let placed = false;
    for (let t = 0; t < 48 && !placed; t++) {
      const ang = rng() * Math.PI * 2;
      const d = ring.min + rng() * (ring.max - ring.min);
      x = Math.cos(ang) * d;
      z = Math.sin(ang) * d;
      placed = state.world.canDrive(x, z);
    }
    state.nextDropSol =
      state.clock.sol + state.clock.frac + DROP_GAP_SOL_MIN +
      rng() * (DROP_GAP_SOL_MAX - DROP_GAP_SOL_MIN);
    if (!placed) {
      event(state, 'info', 'Earth reports a cargo mission aborted before landing.');
      return;
    }
    const id = state.world.nextPoiSlot;
    const drop = makeSupplyDrop(id, x, z, rng);
    state.world.addPoi(drop);
    event(
      state,
      'opportunity',
      `Transponder contact: a ${drop.manifest.toLowerCase()} container landed at ${Math.round(x)}, ${Math.round(z)} — ` +
        `${Math.round(salvageTotalKg(drop))} kg, and the dust is already working on it.`,
    );
  }

  // ------------------------------------------------- salvage (site side) ----

  /**
   * kg of salvage a rover takes per game second, spread across the site's
   * contents. Thin wrap over the pure helper so site depletion has one named
   * owner; RoverSystem's doSalvage still drives the hold fill and the task.
   */
  static takeSalvage(
    p: Poi,
    roomKg: number,
    rateKgS: number,
    dtS: number,
  ): { takenKg: number; perResource: Partial<Record<ResourceId, number>> } {
    return takeSalvagePure(p, roomKg, rateKgS, dtS);
  }

  /** Hand surviving cells to the grid store once the bulk cargo is stripped. */
  static recoverSiteCells(state: ColonyState, p: Poi): void {
    if (p.energyKWh <= 0.5) return;
    const cap = batteryCapacityKWh(state);
    const took = Math.max(0, Math.min(p.energyKWh, cap - state.storedKWh));
    const lost = p.energyKWh - took;
    state.storedKWh += took;
    p.energyKWh = 0;
    if (took > 0.5) {
      event(state, 'ok', `Recovered from the site: ${Math.round(took)} kWh of cells.`);
    }
    if (lost > 0.5) {
      event(
        state,
        'warn',
        `${Math.round(lost)} kWh of the site's cells would not fit — the batteries were already full.`,
      );
    }
  }
}

/** Local alert-bus event helper — same shape RoverSystem's `log` uses. */
function event(state: ColonyState, severity: Severity, text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}

