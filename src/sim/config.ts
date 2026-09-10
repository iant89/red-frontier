/**
 * Global constants tuning the simulation. Design targets — easy to rebalance.
 *
 * ## Two time bases (important)
 *
 * The sim advances in **game seconds** at a fixed 20 Hz step. Two different
 * rates are expressed against that clock:
 *
 * - **Material flows** (mining kg/s, construction seconds) are authored in
 *   *game seconds*, because they are paced for the player's attention span.
 * - **Energy and life-support flows** (kW, kWh, kg of oxygen per sol) are
 *   authored in *Mars time*, because those numbers should read like real
 *   engineering figures. They are converted with {@link HOURS_PER_SEC} /
 *   {@link SOLS_PER_SEC}.
 *
 * So a 24 kW solar array really does deliver 24 kWh per Mars hour, while a sol
 * only takes four minutes of your life at 1× speed.
 */

export const SIM_TICK = 1 / 20; // 20 Hz fixed step (game seconds)
export const TICKS_PER_SEC = 20;

export const SPEEDS = [0, 1, 2, 4] as const; // paused, 1x, 2x, 4x

// ---------------------------------------------------------------- world ----

// Playable region is [-WORLD_HALF, WORLD_HALF]^2 in world units (1 unit = 1 m).
export const WORLD_HALF = 640;

export const SPAWN_X = 0;
export const SPAWN_Z = 0;
export const SPAWN_RADIUS = 26; // flat buildable clear zone around landing

// ----------------------------------------------------------------- time ----

/** Real Mars sol: 24 h 39 m 35 s. */
export const SOL_HOURS = 24.6597;

/** How many game seconds one sol takes at 1× speed. */
export const SOL_SECONDS = 240;

/** Mars hours elapsed per game second — the energy accounting bridge. */
export const HOURS_PER_SEC = SOL_HOURS / SOL_SECONDS;

/** Sols elapsed per game second — the life-support accounting bridge. */
export const SOLS_PER_SEC = 1 / SOL_SECONDS;

/** Sol fraction at which the sun crosses the horizon going up / down. */
export const SUNRISE_FRAC = 0.25;
export const SUNSET_FRAC = 0.75;

/** Mission starts mid-morning so the player gets a full day of light first. */
export const START_SOL_FRAC = 0.34;

// -------------------------------------------------------------- storage ----

/**
 * Bulk stockpile capacity of the landing pod, **per resource type** (kg).
 *
 * Storage is per-resource (TDD §5 `Storage(resourceType, amount, capacity)`)
 * rather than one shared pool. That is a deliberate choice: with a shared pool
 * a single rover-load of regolith can fill the colony and deadlock every other
 * supply chain, which reads as a bug rather than a bottleneck. Per-resource
 * silos keep storage a real constraint without ever making a seed unwinnable.
 */
export const BASE_STORAGE_PER_RESOURCE = 260;

// ------------------------------------------------------------ landing pod ----

/**
 * The descent stage is not scenery: it is the colony's first power plant,
 * shelter and warehouse. Its RTG is why you are alive on Sol 1, and its
 * modest output is why you cannot stay that way.
 */
export const POD_POWER_KW = 14; // baseload RTG on the descent stage
export const POD_BATTERY_KWH = 90;
export const POD_LIFE_SUPPORT_KW = 2; // pod's own scrubbers & heaters (tier 0)
export const POD_RADIUS = 8;

// --------------------------------------------------------------- rovers ----

/** Rover battery floor (fraction) before it refuses further work and recharges. */
export const ROVER_CHARGE_THRESHOLD = 0.2;
export const ROVER_DISABLED_THRESHOLD = 0.01;

/**
 * Charger output per rover (kW). Draws from the colony power grid.
 *
 * Sized so ONE rover charging at noon doesn't eat the whole daytime surplus:
 * a single array plus the pod must still have leftover to fill the batteries
 * for the night. Two rovers charging at once remains a strain the player
 * builds their way out of — that pressure is the game.
 */
export const ROVER_CHARGE_RATE_KW = 16;
/** A Rover Garage charges at this rate instead (kW) — always 2× the pod rate. */
export const GARAGE_CHARGE_RATE_KW = 32;

/** Power priority tier that rover charging sits on (lowest). */
export const ROVER_CHARGE_TIER = 3;

// ------------------------------------------- Prototype 4: wear & recovery ----

/**
 * Drivetrain condition. Rovers are stranded-not-destroyed machines: work and
 * storms grind their condition down, low condition halves their work rate, and
 * a garage services them back to health. Condition never disables a rover —
 * soft failure, per GDD §13.
 */
export const ROVER_CONDITION_SLOW = 45; // below this, work rate ramps down
export const ROVER_CONDITION_ALERT = 35; // below this, the HUD nags
export const ROVER_WEAR_WORK_S = 0.02; // condition lost per second of tool work
export const ROVER_WEAR_MOVE_S = 0.006; // condition lost per second of driving
export const ROVER_WEAR_STORM_S = 0.12; // condition lost per second, full storm
export const GARAGE_SERVICE_RATE = 1.5; // condition restored per second parked

/** Jump-start transfer rate while a rescuer is hooked up (kWh per second). */
export const RECOVER_TRANSFER_KW = 12;
/** A rescue that cannot deliver at least this much is refused outright (kWh). */
export const RECOVER_MIN_GIVE_KWH = 4;

/**
 * Position lights & headlights. Rovers carry them to stay visible at night
 * and in blowing dust; the switch is on by default and the sim lights them
 * automatically whenever it is dark or visibility is poor — while they are
 * lit they draw their `lightsPowerKw` straight off the rover's battery.
 *
 * Auto-on conditions: the sun is weaker than this irradiance (night and the
 * dim shoulder of dawn/dusk), **or** weather visibility has fallen below
 * this fraction (dust haze, storms). Ambient clear-sky visibility stays
 * above 0.85, so dust alone never flickers the lights on.
 */
export const LIGHTS_AUTO_IRRADIANCE = 0.25;
export const LIGHTS_AUTO_VISIBILITY = 0.8;

/** Route pause: a repeat route waits at the depot until the silo has this much room (kg). */
export const ROUTE_RESUME_ROOM_KG = 60;

// ---------------------------------------------------------------- power ----

/** Priority tiers, highest priority first. Tier 0 is shed last. */
export const POWER_TIERS = [0, 1, 2, 3] as const;
export type PowerTier = (typeof POWER_TIERS)[number];

export const POWER_TIER_LABELS: Record<PowerTier, string> = {
  0: 'Life support',
  1: 'Oxygen & water',
  2: 'Industry',
  3: 'Logistics',
};

/** Below this satisfaction a tier is considered browned out. */
export const BROWNOUT_THRESHOLD = 0.995;

// ---------------------------------------------------- solar & atmosphere ----

/**
 * Fraction of peak irradiance still reaching a panel when the sun is exactly on
 * the horizon (Mars has a thin but dusty atmosphere).
 */
export const HORIZON_EXTINCTION = 0.08;

/**
 * Baseline atmospheric dust transmission on a clear sol (1 = perfectly clear).
 * The weather system modulates transmission around this; TDD §11/§12's
 * `dustTransmission` term lives in `sim/weather.ts`.
 */
export const BASE_DUST_TRANSMISSION = 1;

// -------------------------------------------------------------- weather ----
// Prototype 3 (GDD §7, §16): wind, airborne dust, storms, and the degradation
// they cause. All rates are per game second unless stated; a sol is
// SOL_SECONDS game seconds, so "per sol" figures divide it out.

/** No storms may be scheduled before this many sols — you land in clear weather. */
export const WEATHER_CALM_SOLS = 2.2;

/** Weather is re-rolled on this cadence (game seconds ≈ 0.35 sol). */
export const WEATHER_ROLL_INTERVAL_S = 84;

/** Minimum quiet gap between the end of one storm and the next roll. */
export const WEATHER_STORM_COOLDOWN_S = 96;

/** Per-roll storm probabilities. Each is additionally gated by sol number. */
export const STORM_CHANCES = {
  devil: 0.1, // from sol 3
  regional: 0.045, // from sol 4
  severe: 0.012, // from sol 7
  planetary: 0.006, // from sol 12, grows slowly with each sol after
} as const;

/** The sol each storm class becomes possible (devils first, planetary last). */
export const STORM_UNLOCK_SOL = {
  devil: 3,
  regional: 4,
  severe: 7,
  planetary: 12,
} as const;

/**
 * Lead time before a storm's winds arrive, during which the forecast is known.
 * Long enough to charge batteries and recall crews; short enough to matter.
 */
export const STORM_WARN_LEAD_S = 60;

/**
 * Structural damage per game second: `intensity^1.5 × exposure × this`.
 * Tuned so a regional storm bruises exposed arrays and a severe one can trip
 * them offline — while a planetary event threatens everything except the pod.
 */
export const STORM_DAMAGE_K = 0.38;

/** A building at or below this health is damaged: offline until repaired. */
export const DAMAGED_HEALTH = 25;
/** Repair work that brings a damaged building back to this health restarts it. */
export const REPAIR_RESTART_HEALTH = 55;
export const BUILDING_MAX_HEALTH = 100;

/** Rover repair speed (health per game second). */
export const ROVER_REPAIR_RATE = 4.2;
/** Rover cleaning speed (cleanliness fraction per game second). */
export const ROVER_CLEAN_RATE = 0.075;

/** Cleanliness loss per sol for a panel under ambient dust `dust`. */
export const PANEL_DIRT_PER_SOL = 0.85;

/** Panels dirtier than this get an automatic cleaning dispatch. */
export const AUTO_CLEAN_THRESHOLD = 0.7;

/** Storm intensity at which rovers are recalled to shelter. */
export const STORM_SHELTER_INTENSITY = 0.55;
/** Storm intensity at which new EVAs are refused and outside crews recalled. */
export const STORM_EVA_INTENSITY = 0.4;
/** Rovers work at this fraction of rate while a storm is ramping past EVA level. */
export const STORM_WORK_MUL = 0.6;

/** Cleanliness never drops below this — dust dims, it never entombs. */
export const CLEANLINESS_FLOOR = 0.15;

// ------------------------------------------------------------- colonist ----

/** Per-sol consumption of one human. */
export const COLONIST_O2_PER_SOL = 0.84; // kg
export const COLONIST_WATER_PER_SOL = 4.0; // kg
export const COLONIST_FOOD_PER_SOL = 1.5; // kg

/** Fraction of a colonist's water use recovered by habitat reclamation. */
export const WATER_RECLAIM_FRACTION = 0.55;

/** EVA suit oxygen reserve (kg) — how long the human survives outside. */
export const SUIT_O2_CAPACITY = 0.42;

/** Health lost per sol while a need is unmet. */
export const HEALTH_LOSS_NO_O2 = 200;
export const HEALTH_LOSS_NO_WATER = 16;
export const HEALTH_LOSS_NO_FOOD = 6;

/** Health regained per sol when every need is satisfied. */
export const HEALTH_REGEN = 10;

/** Colonist walking speed (world units / game second). */
export const COLONIST_SPEED = 5.5;

/** Construction output a suited human contributes (rover baseline = 1.0). */
export const COLONIST_BUILD_POWER = 0.5;

// ------------------------------------------------------- developer mode ----

/**
 * Developer-mode building upgrades (runtime only — never written to the save
 * file). Each level above 1 multiplies a structure's output along every axis
 * the sim consults its definition for: generation, grid storage, silo and
 * tank capacity, process conversion rates, and garage work rates.
 */
export const DEV_UPGRADE_STEP = 0.35;
export const DEV_MAX_BUILDING_LEVEL = 5;

/** Output multiplier a building at `level` works at (1 at base level). */
export function devLevelMul(level: number): number {
  return 1 + DEV_UPGRADE_STEP * (Math.max(1, level) - 1);
}

// ---------------------------------------------------------- persistence ----

export const AUTOSAVE_INTERVAL_S = 45;

/** Current save schema version. Bump whenever the snapshot shape changes. */
export const SAVE_VERSION = 6;

// -------------------------------------------------------------- history ----

/** How many samples the HUD graphs retain, and how often the sim records one. */
export const HISTORY_SAMPLES = 120;
export const HISTORY_INTERVAL_S = 1;
