/**
 * Phase 5 — Extract WeatherSystem
 *
 * Goal per roadmap §9: Move weather behavior into an independent system.
 *
 * Responsibilities:
 *   - weather progression into colony state (per-tick weather → state.weather,
 *     state.dustTransmission, storm arrival/passing announcements)
 *   - storm generation / duration / expiry (delegated to the Weather model's
 *     scheduler — the dedicated seeded RNG streams live there and stay there)
 *   - weather effects on the colony: dust settling on solar arrays, wind
 *     damage to exposed structures, lightning strikes
 *   - shelter-related effects are *queried* from the Weather model by the
 *     rover/EVA code; this system owns the sky, not the decisions
 *   - save/restore wiring and clock-jump re-anchoring for weather state
 *
 * Weather consumes: ColonyState (state.weather, state.simTime, state.clock)
 * and its own RNG streams inside the Weather model. Those streams are never
 * combined with the world / deposit / POI / cargo RNG (roadmap §9 "Important").
 *
 * Does NOT know about:
 *   - Three.js, DOM, renderer, UI
 *   - Simulation, hosts, persistence schema
 *
 * Flow (roadmap §9):
 *
 *     WeatherSystem.tick(state, hooks)
 *        ↓
 *     state.weather  →  AlertSystem (state.alerts) / SimView
 *
 * Cross-domain side effects the weather triggers but does not own (a building
 * tripping offline, a rover stranded by a flat battery, mission end) cross the
 * {@link WeatherHostHooks} seam so no second source of truth is introduced.
 * RoverSystem (Phase 10) and FailureSystem (Phase 15) will absorb them.
 */

import { BUILDINGS, ROVERS } from '../defs';
import { lightningVulnerability } from '../state/BuildingState';
import type { Building } from '../state/BuildingState';
import type { Rover } from '../state/RoverState';
import type { ColonyState } from '../state/ColonyState';
import { Weather, stormLabel } from '../weather';
import type { Severity } from '../alerts';
import {
  SIM_TICK,
  SOLS_PER_SEC,
  CLEANLINESS_FLOOR,
  PANEL_DIRT_PER_SOL,
  DAMAGED_HEALTH,
  LIGHTNING_ANCHOR_CHANCE,
  LIGHTNING_STRIKE_RADIUS,
  LIGHTNING_CORE_RADIUS,
  LIGHTNING_AIM_JITTER,
  LIGHTNING_DAMAGE_K,
  LIGHTNING_ROVER_CONDITION,
  LIGHTNING_ROVER_BATTERY_FRAC,
  LIGHTNING_COLONIST_DAMAGE,
} from '../config';
import { DIFFICULTIES } from '../difficulty';

/**
 * Side effects weather triggers but does not own. Implemented by Simulation
 * (which already owns the rover/failure machinery); later phases replace the
 * implementor, not the contract.
 */
export interface WeatherHostHooks {
  /** A structure has been knocked offline by weather (failure domain). */
  tripDamaged(b: Building, cause?: string): void;
  /** A rover's battery has gone flat (rover domain). */
  disableRover(r: Rover): void;
  /** The mission is over (colonist lost). */
  endMission(reason: string): void;
}

export class WeatherSystem {
  /**
   * Advance the weather, then let it work on the colony: solar panels gather
   * dust, wind chews on exposed structures, and storms interrupt work.
   *
   * Runs immediately after ClockSystem.tick in the fixed-step loop (TDD §4),
   * so `state.simTime` is already the new tick's time.
   */
  static tick(state: ColonyState, hooks: WeatherHostHooks): void {
    const wx = state.weather;
    wx.tick(SIM_TICK, state.simTime, state.clock.sol);
    state.dustTransmission = wx.solarTransmission;

    // ---- forecast announcements ------------------------------------------
    const fc = wx.forecast();
    if (fc) {
      const mins = Math.max(1, Math.round((fc.arrivesIn / 60)));
      state.alerts.raise(
        'storm-inbound',
        fc.kind === 'severe' || fc.kind === 'planetary' ? 'crit' : 'warn',
        `${stormLabel(fc.kind)} forecast`,
        `Winds arrive in about ${mins} min. Charge batteries, shelter the crews, clean the arrays.`,
        state.simTime,
        state.clock.format(),
      );
    }

    // ---- storm arrival / passing ------------------------------------------
    if (wx.current() && !state.stormAnnounced) {
      state.stormAnnounced = true;
      state.alerts.clear('storm-inbound', state.simTime, state.clock.format());
      const active = wx.current()!;
      const sev: Severity =
        active.kind === 'severe' || active.kind === 'planetary'
          ? 'crit'
          : active.kind === 'devil'
            ? 'info'
            : 'warn';
      state.alerts.event(
        sev,
        `${stormLabel(active.kind)} on site — solar output falling, crews recalled.`,
        state.simTime,
        state.clock.format(),
      );
    }
    if (!wx.current() && state.stormAnnounced) {
      state.stormAnnounced = false;
      state.alerts.event(
        'ok',
        'The storm has passed. Dust is settling; solar recovers as the air clears.',
        state.simTime,
        state.clock.format(),
      );
    }

    // ---- dust settles on the panels ---------------------------------------
    // Ambient dust grinds in slowly; a storm sandblasts the array. Each panel
    // accretes the dust in the air *where it stands*, not the colony's average
    // — an array caught in the gust front dirties faster than one in the lee.
    const sols = SIM_TICK * SOLS_PER_SEC;
    for (const b of state.buildings) {
      if (b.state !== 'online') continue;
      const def = BUILDINGS[b.kind];
      if (def.generation !== 'solar') continue;
      if (b.cleanliness > CLEANLINESS_FLOOR) {
        const dirt = wx.localDust(b.x, b.z) * PANEL_DIRT_PER_SOL * sols;
        b.cleanliness = Math.max(CLEANLINESS_FLOOR, b.cleanliness - dirt);
      }
    }

    // ---- wind damage --------------------------------------------------------
    // The damage a structure takes is its *local* weather, so two arrays on
    // opposite sides of the yard can age differently through the same storm.
    for (const b of state.buildings) {
      if (b.state !== 'online' || b.damaged) continue;
      const rate = wx.damageRateAt(b.x, b.z);
      if (rate <= 0) continue;
      const def = BUILDINGS[b.kind];
      const before = b.health;
      b.health = Math.max(0, b.health - rate * def.exposure * SIM_TICK);
      if (b.health <= DAMAGED_HEALTH && before > DAMAGED_HEALTH) {
        hooks.tripDamaged(b);
      }
    }

    // ---- lightning ----------------------------------------------------------
    // Static from the dust: strike chance rises with the storm. Runs last in
    // the weather block so a bolt that trips a structure does it before the
    // power resolve sees the building.
    WeatherSystem.tickLightning(state, hooks);
  }

  /**
   * Roll the lightning hazard once this tick and, if the sky fires, resolve
   * a strike. The chance is a Poisson arrival from {@link Weather.lightningHazard},
   * drawn from the weather's own seeded stream so a replayed storm strikes
   * the same bolts at the same instants.
   */
  static tickLightning(state: ColonyState, hooks: WeatherHostHooks): void {
    const hazard = state.weather.lightningHazard();
    if (hazard <= 0) return;
    const p = 1 - Math.exp(-hazard * SIM_TICK);
    if (state.weather.lightningRoll() >= p) return;
    WeatherSystem.resolveLightningStrike(state, hooks);
  }

  /**
   * The entities a bolt would rather hit than empty regolith: exposed
   * structures (weighted by exposure × vulnerability), rovers out in the
   * open, and a colonist on EVA. Each carries a weight for the weighted pick.
   */
  static lightningAnchors(state: ColonyState): Array<{ x: number; z: number; w: number }> {
    const out: Array<{ x: number; z: number; w: number }> = [];
    for (const b of state.buildings) {
      if (b.state !== 'online' || b.damaged) continue;
      const def = BUILDINGS[b.kind];
      out.push({ x: b.x, z: b.z, w: def.exposure * lightningVulnerability(def) });
    }
    for (const r of state.rovers) {
      if (r.phase === 'disabled') continue;
      out.push({ x: r.x, z: r.z, w: 1 });
    }
    const c = state.colonist;
    if (!c.dead && !c.inside) out.push({ x: c.x, z: c.z, w: 0.8 });
    return out;
  }

  /**
   * Resolve one lightning strike: pick a landing spot (mostly a random point,
   * sometimes aimed at an exposed entity), damage whatever is under it, flash
   * the renderer via `weather.lastStrike`, and write the log line.
   *
   * `aim === 'exact'` is the developer-panel path: it drops the bolt dead on
   * the most exposed thing standing, with no jitter and no RNG, so a test (or
   * a dev) can reproduce a hit at will.
   */
  static resolveLightningStrike(
    state: ColonyState,
    hooks: WeatherHostHooks,
    aim: 'roll' | 'exact' = 'roll',
  ): void {
    const wx = state.weather;
    const half = state.world.half;
    const anchors = WeatherSystem.lightningAnchors(state);

    let x = 0;
    let z = 0;
    let aimed = false;

    if (aim === 'exact' && anchors.length > 0) {
      const target = anchors.slice().sort((a, b) => b.w - a.w || a.x - b.x || a.z - b.z)[0];
      x = target.x;
      z = target.z;
      aimed = true;
    } else if (anchors.length > 0 && wx.lightningRoll() < LIGHTNING_ANCHOR_CHANCE) {
      const total = anchors.reduce((s, a) => s + a.w, 0);
      let r = wx.lightningRoll() * total;
      let chosen = anchors[anchors.length - 1];
      for (const a of anchors) {
        r -= a.w;
        if (r <= 0) {
          chosen = a;
          break;
        }
      }
      x = chosen.x + (wx.lightningRoll() * 2 - 1) * LIGHTNING_AIM_JITTER;
      z = chosen.z + (wx.lightningRoll() * 2 - 1) * LIGHTNING_AIM_JITTER;
      aimed = true;
    } else {
      x = (wx.lightningRoll() * 2 - 1) * half;
      z = (wx.lightningRoll() * 2 - 1) * half;
    }

    // ---- damage ------------------------------------------------------------
    let hurtBuildings = 0;
    let tripped = false;
    for (const b of state.buildings) {
      if (b.state !== 'online') continue;
      const def = BUILDINGS[b.kind];
      const d = Math.hypot(b.x - x, b.z - z);
      const reach = LIGHTNING_STRIKE_RADIUS + def.radius;
      if (d > reach) continue;
      const falloff = 1 - d / reach;
      const damage = LIGHTNING_DAMAGE_K * def.exposure * lightningVulnerability(def) * falloff * wx.damageMul;
      if (damage <= 0.01) continue;
      const before = b.health;
      b.health = Math.max(0, b.health - damage);
      hurtBuildings++;
      if (b.health <= DAMAGED_HEALTH && before > DAMAGED_HEALTH) {
        hooks.tripDamaged(b, 'lightning');
        tripped = true;
      }
    }

    let hurtRovers = 0;
    for (const r of state.rovers) {
      if (r.phase === 'disabled') continue;
      const d = Math.hypot(r.x - x, r.z - z);
      if (d > LIGHTNING_STRIKE_RADIUS) continue;
      const falloff = 1 - d / LIGHTNING_STRIKE_RADIUS;
      r.condition = Math.max(0, r.condition - LIGHTNING_ROVER_CONDITION * falloff);
      hurtRovers++;
      // A near-direct hit can flash a chunk of the pack away; a flat battery
      // strands the rover exactly like the ride home would.
      if (d <= LIGHTNING_CORE_RADIUS) {
        r.battery = Math.max(0, r.battery - ROVERS[r.kind].maxBatteryKWh * LIGHTNING_ROVER_BATTERY_FRAC);
        if (r.battery <= 0) hooks.disableRover(r);
      }
    }

    let hurtColonist = false;
    const c = state.colonist;
    if (!c.dead && !c.inside) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d <= LIGHTNING_STRIKE_RADIUS) {
        const falloff = 1 - d / LIGHTNING_STRIKE_RADIUS;
        c.health = Math.max(0, c.health - LIGHTNING_COLONIST_DAMAGE * falloff);
        hurtColonist = true;
        if (c.health <= 0) {
          c.dead = true;
          hooks.endMission(`${c.name} was struck by lightning on EVA.`);
        }
      }
    }

    wx.lastStrike = { x, z, t: state.simTime };

    // ---- log ---------------------------------------------------------------
    const at = aimed ? 'near the colony' : `${Math.round(x)}, ${Math.round(z)}`;
    if (hurtColonist || tripped) {
      state.alerts.event(
        'crit',
        `⚡ Lightning struck at ${at} — ${tripped ? 'a structure is down' : `${c.name} took the hit`}.`,
        state.simTime,
        state.clock.format(),
      );
    } else if (hurtBuildings > 0 || hurtRovers > 0) {
      state.alerts.event(
        'warn',
        `⚡ Lightning struck at ${at} — ${hurtBuildings + hurtRovers} machine${hurtBuildings + hurtRovers === 1 ? '' : 's'} singed.`,
        state.simTime,
        state.clock.format(),
      );
    } else {
      state.alerts.event(
        'info',
        `⚡ Lightning struck the regolith at ${at}.`,
        state.simTime,
        state.clock.format(),
      );
    }
  }

  // ----------------------------------------------------- lifecycle seams ----

  /**
   * Rebuild weather state from a save. Owns the wiring that used to live in
   * Simulation.restoreFromState: fresh Weather from the colony seed, model
   * restore (which accepts both the current cell lists and legacy v≤6 single
   * storms), the difficulty fallback for saves predating `lightningMul`, and
   * the derived colony flags (`dustTransmission`, `stormAnnounced`).
   *
   * `weatherSave` is deliberately `unknown`: schema knowledge stays behind the
   * persistence boundary (Phase 3); the model's own restore coerces.
   */
  static restore(state: ColonyState, weatherSave: unknown): void {
    const wx = new Weather(state.seed ^ 0x77e711e);
    wx.time = state.simTime;
    if (weatherSave) wx.restore(weatherSave);
    if (!Number.isFinite((weatherSave as { lightningMul?: unknown })?.lightningMul as number)) {
      wx.lightningMul = (DIFFICULTIES[state.difficulty] ?? DIFFICULTIES.pioneer).lightningMul;
    }
    state.weather = wx;
    state.dustTransmission = wx.solarTransmission;
    state.stormAnnounced = !!wx.current();
  }

  /**
   * After a developer time jump the clock is re-anchored but the weather
   * model's time mirror is not — re-sync it so forecast countdowns and the
   * storm envelopes stay coherent with the new sim time.
   */
  static afterTimeJump(state: ColonyState): void {
    state.weather.time = state.simTime;
  }
}
