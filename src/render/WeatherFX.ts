/**
 * The weather FX controller: presentation-side counterpart to `sim/weather.ts`.
 *
 * The sim stays authoritative and GPU-free — it only ever reports wind, dust,
 * storm class and intensity. This controller reads those readings every frame
 * and drives the particle emitters (ambient wind dust, storm grit, dust
 * devils, rover wheel trails) that make the sky *visible*. It also derives the
 * one thing the sim doesn't report: how fast the wind is rising, which is what
 * spins a dust devil up ahead of a declared storm.
 *
 * Like the old dust field it replaces, FX runs on **sim time**: `dt <= 0`
 * (paused) freezes every particle exactly where it is, and emission rates are
 * per sim second so the air looks the same at 1× and 4×.
 *
 * The input is a narrow structural interface rather than `Simulation`, so the
 * controller stays decoupled and unit-testable with stub weather + rovers.
 */

import * as THREE from 'three';
import { ParticlePool, type Rand } from './particles/ParticlePool';
import {
  WindEmitter,
  StormEmitter,
  DevilManager,
  RoverTrailEmitter,
  dustField,
  type DustField,
  type FxContext,
  type TrailRover,
} from './particles/effects';
import { ParticlePoints } from './particles/ParticlePoints';
import type { StormKind } from '../sim/weather';

export interface WeatherFxWeather {
  windSpeed: number;
  windDirRad: number;
  dust: number;
  visibility: number;
  storm: StormKind;
  stormIntensity: number;
}

export interface WeatherFxRover {
  id: number;
  x: number;
  z: number;
  heading: number;
  phase: string;
}

export interface WeatherFxInput {
  /** Absolute sim time (seconds). */
  time: number;
  weather: WeatherFxWeather;
  rovers: ReadonlyArray<WeatherFxRover>;
  heightAt: (x: number, z: number) => number;
  /**
   * Terrain colour at a point (0..1 RGB) — dust devils pick their dust up off
   * the ground they stand on and wear its tint. Optional.
   */
  tintAt?: (x: number, z: number) => { r: number; g: number; b: number } | null;
}

export interface WeatherFxOptions {
  maxParticles?: number;
  rand?: Rand;
}

const _dir = new THREE.Vector3();

/**
 * Where the dust field sits this frame: the ground point under the middle of
 * the view — where the player is looking — plus the half-diagonal of the
 * ground footprint the frustum covers there.
 *
 * The centre is not under the camera itself: at the default zoom the camera
 * sits ~120 units from its target, so camera-centred dust would fall outside
 * the viewed area entirely. The radius is what sizes the emission field: the
 * frustum's vertical spread, widened by the aspect for the horizontal, and
 * stretched by the view's grazing angle (a low camera sees a footprint that
 * runs away toward the horizon). Looking at the horizon the footprint is
 * unbounded — the field clamps itself at its ceiling instead.
 */
function viewGeometry(cam: THREE.PerspectiveCamera): { x: number; z: number; radius: number } {
  cam.getWorldDirection(_dir);
  const grazing = _dir.y > -0.05;
  const t = grazing ? 0 : Math.min(900, (cam.position.y - 2) / -_dir.y);
  const x = cam.position.x + _dir.x * t;
  const z = cam.position.z + _dir.z * t;
  const dist = Math.max(8, grazing ? 900 : t);
  const spread = Math.tan((cam.fov * Math.PI) / 360);
  const width = dist * spread * Math.max(1, cam.aspect);
  const depth = (dist * spread) / Math.max(0.3, -_dir.y);
  return { x, z, radius: Math.hypot(width, depth) };
}

export class WeatherFX {
  private readonly pool: ParticlePool;
  private readonly points: ParticlePoints;
  private readonly wind = new WindEmitter();
  private readonly stormFx = new StormEmitter();
  private readonly devils = new DevilManager();
  private readonly trails = new RoverTrailEmitter();
  private readonly rand: Rand;
  /** Previous rover positions, for deriving speed (the sim stores none). */
  private readonly prev = new Map<number, { x: number; z: number; t: number }>();
  /** Last wind reading, for deriving d(windSpeed)/dt. */
  private prevWind: { speed: number; t: number } | null = null;
  /**
   * Smoothed wind acceleration (m/s per sim second). Lightly filtered so a
   * single frame's jump — a dev-mode storm snapping in with no lead, say —
   * doesn't read as a gust front arriving.
   */
  private windRamp = 0;
  /** Weather particle master switch (graphics settings). */
  private fxOn = true;

  constructor(scene: THREE.Scene, opts: WeatherFxOptions = {}) {
    this.rand = opts.rand ?? Math.random;
    this.pool = new ParticlePool(opts.maxParticles ?? 9000, this.rand);
    this.points = new ParticlePoints(this.pool.capacity);
    scene.add(this.points.points);
  }

  /**
   * Graphical setting: master switch for every weather particle (wind, storm
   * grit, devils, rover trails). Hidden while off rather than drained — the
   * pool stays warm so switching back needs no re-priming — and the update is
   * skipped entirely, so "off" costs one boolean, not 9000 dead particles.
   */
  setVisible(on: boolean): void {
    if (this.fxOn === on) return;
    this.fxOn = on;
    this.points.points.visible = on;
    if (on) {
      // Derivatives (rover speed, wind ramp) are read from the last *visible*
      // frame; a stale baseline would turn re-enabling into a one-frame gust.
      this.prev.clear();
      this.prevWind = null;
    }
  }

  /** Live particles in the pool. */
  get alive(): number {
    return this.pool.alive;
  }

  /** Particles pushed to the GPU by the last sync. */
  get rendered(): number {
    return this.points.count;
  }

  /** Dust devils currently spun up. */
  get devilCount(): number {
    return this.devils.activeCount;
  }

  private focusX = 0;
  private focusZ = 0;
  private viewR = 0;
  private fieldNow: DustField = dustField(0);

  /** Emission centre used by the last sync (ground under the view centre). */
  get focus(): { x: number; z: number } {
    return { x: this.focusX, z: this.focusZ };
  }

  /**
   * Half-diagonal of the viewed ground footprint from the last sync — what
   * sized the emission field. Clamped inside the emitters (`dustField`).
   */
  get viewRadius(): number {
    return this.viewR;
  }

  /** The emission field envelope the last sync drove (and wrapped to). */
  get field(): DustField {
    return this.fieldNow;
  }

  /** Call on resize (drawing-buffer height × camera FOV). */
  setViewport(viewportHeightPx: number, fovDeg: number): void {
    this.points.setPerspective(viewportHeightPx, fovDeg);
  }

  sync(input: WeatherFxInput, camera: THREE.PerspectiveCamera, dt: number): void {
    // Master switch off: no particles, no bookkeeping — nothing to derive.
    if (!this.fxOn) return;
    const dtc = Math.min(0.5, Math.max(0, dt));
    // Paused (or a zero-length frame): frozen, exactly like the old field.
    if (dtc <= 0) return;

    const w = input.weather;
    // The sim's compass convention is atan2(x, z) — the drift vector is
    // (sin, cos) of the bearing, same mapping the old field used.
    const drift = w.windSpeed * 0.45;
    // How fast the wind is rising, per sim second. Devils spin up off the
    // ramp itself — the gust front arrives before the storm is declared.
    const inst =
      this.prevWind && input.time > this.prevWind.t
        ? (w.windSpeed - this.prevWind.speed) / (input.time - this.prevWind.t)
        : 0;
    this.prevWind = { speed: w.windSpeed, t: input.time };
    this.windRamp += (inst - this.windRamp) * Math.min(1, dtc / 1.2);
    const focus = viewGeometry(camera);
    const field = dustField(focus.radius);
    this.focusX = focus.x;
    this.focusZ = focus.z;
    this.viewR = focus.radius;
    this.fieldNow = field;
    const ctx: FxContext = {
      time: input.time,
      dt: dtc,
      camX: focus.x,
      camZ: focus.z,
      windX: Math.sin(w.windDirRad) * drift,
      windZ: Math.cos(w.windDirRad) * drift,
      windSpeed: w.windSpeed,
      windRamp: this.windRamp,
      dust: w.dust,
      storm: w.storm,
      stormIntensity: w.stormIntensity,
      viewRadius: focus.radius,
      heightAt: input.heightAt,
      groundTint: input.tintAt,
      rand: this.rand,
    };

    // Rover speeds fall out of position deltas over sim time. Only rovers the
    // sim reports as `moving` can trail — a rover sliding on a charger or
    // being placed must not puff.
    const movers: TrailRover[] = [];
    const seen = new Set<number>();
    for (const r of input.rovers) {
      seen.add(r.id);
      const p = this.prev.get(r.id);
      let speed = 0;
      if (p && input.time > p.t) {
        speed = Math.hypot(r.x - p.x, r.z - p.z) / Math.max(1e-3, input.time - p.t);
      }
      this.prev.set(r.id, { x: r.x, z: r.z, t: input.time });
      if (r.phase === 'moving' && speed > 0.05) {
        movers.push({ id: r.id, x: r.x, z: r.z, heading: r.heading, speed: Math.min(30, speed) });
      }
    }
    for (const id of [...this.prev.keys()]) {
      if (!seen.has(id)) this.prev.delete(id);
    }

    this.wind.update(ctx, this.pool);
    this.stormFx.update(ctx, this.pool);
    this.devils.update(ctx, this.pool);
    this.trails.update(ctx, this.pool, movers);

    this.pool.update(dtc, input.time);
    // Keep the camera field populated: without this, storm grit travelling
    // 100+ units downwind in one life would evacuate the viewed area. The
    // wrap box and the rim feather share the field's half-extent, so the
    // feather hides the box at every zoom.
    this.pool.wrapAmbient(focus.x, focus.z, field.half);
    this.pool.setFalloff(focus.x, focus.z, field.r0, field.half);
    this.points.sync(this.pool);
  }

  dispose(scene?: THREE.Scene): void {
    if (scene) scene.remove(this.points.points);
    this.points.dispose();
    this.pool.clear();
    this.prev.clear();
    this.prevWind = null;
    this.windRamp = 0;
    this.viewR = 0;
    this.fieldNow = dustField(0);
  }
}
