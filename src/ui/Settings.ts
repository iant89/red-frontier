/**
 * Persisted player settings — the "in-game settings" the pause menu edits.
 *
 * One small store, one place that knows the key names and the defaults, so the
 * HUD (which already persisted a couple of these) and the pause menu can never
 * drift onto different keys. The values are presentation and pacing choices —
 * nothing here reaches the simulation, and nothing here is saved in a colony
 * slot: a restored expedition picks up whatever the machine it is running on
 * has written down.
 *
 * Storage is the same localStorage the HUD already uses, with the same
 * try/catch posture: private browsing may refuse it, and the settings simply
 * fall back to their defaults for the session.
 */

export type RenderResolution = 'ultra' | 'high' | 'performance';

export const SETTINGS_KEYS = {
  /** Pause the sim when a *new* critical alert appears. */
  autopause: 'rf-autopause',
  /** Persist the colony when the tab is hidden. */
  saveOnTabHide: 'rf-save-on-hide',
  /** Seconds between autosaves, 0 = off. */
  autosaveInterval: 'rf-autosave-interval',
  /** Draw-buffer pixel-ratio ceiling ('ultra' = native, up to 2×). */
  renderResolution: 'rf-render-res',
  /** Renderer shadow maps on/off. */
  shadows: 'rf-shadows',
  /** Weather particle FX on/off. */
  weatherFx: 'rf-weather-fx',
  /** The HUD's "clear the screen" panel hiding. */
  hudHidden: 'rf-hud-hidden',
} as const;

export const AUTO_SAVE_INTERVALS: Array<{ label: string; sec: number }> = [
  { label: 'Off', sec: 0 },
  { label: 'Every 30 s', sec: 30 },
  { label: 'Every 45 s', sec: 45 },
  { label: 'Every 60 s', sec: 60 },
  { label: 'Every 2 min', sec: 120 },
];

export const RENDER_RESOLUTIONS: Array<{ id: RenderResolution; label: string; cap: number }> = [
  { id: 'ultra', label: 'Ultra — native resolution', cap: 2 },
  { id: 'high', label: 'High — up to 1.5× resolution', cap: 1.5 },
  { id: 'performance', label: 'Performance — 1× resolution', cap: 1 },
];

/** Pixel-ratio ceiling a resolution label maps to (see RENDER_RESOLUTIONS). */
export function renderResolutionCap(id: RenderResolution): number {
  return RENDER_RESOLUTIONS.find((r) => r.id === id)?.cap ?? 2;
}

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(): SettingsStorage {
  try {
    if (typeof localStorage === 'undefined') return memory;
    return localStorage;
  } catch {
    return memory;
  }
}

const memory: SettingsStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
})();

export class GameSettings {
  private readonly storage: SettingsStorage;

  constructor(storage?: SettingsStorage) {
    this.storage = storage ?? resolveStorage();
  }

  raw(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  write(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      /* a refused write just means the default holds for the session */
    }
  }

  private flag(key: string, fallback: boolean): boolean {
    const v = this.raw(key);
    if (v === '1') return true;
    if (v === '0') return false;
    return fallback;
  }

  /** Auto-pause the sim when a new critical alert appears. Default off. */
  autopauseOnCrit(): boolean {
    return this.flag(SETTINGS_KEYS.autopause, false);
  }

  setAutopause(on: boolean): void {
    this.write(SETTINGS_KEYS.autopause, on ? '1' : '0');
  }

  /** Persist the colony when the tab is hidden. Default on (TDD §23). */
  saveOnTabHide(): boolean {
    return this.flag(SETTINGS_KEYS.saveOnTabHide, true);
  }

  setSaveOnTabHide(on: boolean): void {
    this.write(SETTINGS_KEYS.saveOnTabHide, on ? '1' : '0');
  }

  /** Seconds between autosaves; 0 disables them. Default 45 (the TDD §20 budget). */
  autosaveIntervalSec(): number {
    const v = this.raw(SETTINGS_KEYS.autosaveInterval);
    if (v === null) return 45;
    const n = Number(v);
    const known = AUTO_SAVE_INTERVALS.some((o) => String(o.sec) === v);
    return known || Number.isFinite(n) && n >= 0 ? n : 45;
  }

  setAutosaveInterval(sec: number): void {
    this.write(SETTINGS_KEYS.autosaveInterval, String(Math.max(0, Math.round(sec))));
  }

  renderResolution(): RenderResolution {
    const v = this.raw(SETTINGS_KEYS.renderResolution);
    return v === 'high' || v === 'performance' ? v : 'ultra';
  }

  setRenderResolution(r: RenderResolution): void {
    this.write(SETTINGS_KEYS.renderResolution, r);
  }

  /** Renderer shadow maps. Default on (they are on at construction). */
  shadows(): boolean {
    return this.flag(SETTINGS_KEYS.shadows, true);
  }

  setShadows(on: boolean): void {
    this.write(SETTINGS_KEYS.shadows, on ? '1' : '0');
  }

  /** Weather particle FX (wind, storm grit, devils, rover trails). Default on. */
  weatherFx(): boolean {
    return this.flag(SETTINGS_KEYS.weatherFx, true);
  }

  setWeatherFx(on: boolean): void {
    this.write(SETTINGS_KEYS.weatherFx, on ? '1' : '0');
  }

  /** The HUD's hidden-panels mode. Default off. */
  hudPanelsHidden(): boolean {
    return this.flag(SETTINGS_KEYS.hudHidden, false);
  }

  setHudPanelsHidden(on: boolean): void {
    this.write(SETTINGS_KEYS.hudHidden, on ? '1' : '0');
  }
}
