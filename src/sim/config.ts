/** Global constants tuning the simulation. Design targets — easy to rebalance. */

export const SIM_TICK = 1 / 20; // 20 Hz fixed step (seconds)
export const TICKS_PER_SEC = 20;

export const SPEEDS = [0, 1, 2, 4] as const; // paused, 1x, 2x, 4x

// Playable region is [-WORLD_HALF, WORLD_HALF]^2 in world units.
export const WORLD_HALF = 320;

export const SPAWN_X = 0;
export const SPAWN_Z = 0;
export const SPAWN_RADIUS = 26; // flat buildable clear zone around landing

// Base stockpile capacity at the landing pad (kg).
export const BASE_STORAGE_CAPACITY = 400;

// Rover battery floor (fraction) before it refuses further work and recharges.
export const ROVER_CHARGE_THRESHOLD = 0.2;
export const ROVER_DISABLED_THRESHOLD = 0.01;
export const ROVER_CHARGE_RATE_KWH = 8; // kW draw from base charger

// Solar output cap (kW) — used once power loop arrives; panels store it now.
export const SOLAR_PANEL_KW = 10;

export const AUTOSAVE_INTERVAL_S = 45;
