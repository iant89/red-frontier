/**
 * Named save slots, persisted in localStorage.
 *
 * The original prototype kept a single autosave blob. The menu overhaul keeps
 * a *library*: each expedition has a metadata record (name, sol, difficulty,
 * timestamps) plus its full simulation snapshot, stored under separate keys
 * so listing saves never parses megabytes of colony.
 */

import type { DifficultyId, WorldSizeId } from '../sim/difficulty';

const INDEX_KEY = 'red-frontier-saves-v1';
const SLOT_PREFIX = 'red-frontier-slot-v1:';
const LEGACY_KEY = 'red-frontier-save-v4';

/** Minimal storage surface — storage, or memory when that is missing. */
interface SlotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createMemoryStorage(): SlotStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/**
 * Browser storage, with an in-memory stand-in when storage is missing
 * (unit tests, SSR) or hostile (private browsing where even probing the API
 * throws). The game keeps running either way; only persistence across reloads
 * is lost.
 */
function resolveStorage(): SlotStorage {
  try {
    if (typeof localStorage === 'undefined') return createMemoryStorage();
    localStorage.setItem('red-frontier-probe', '1');
    localStorage.removeItem('red-frontier-probe');
    return localStorage;
  } catch {
    return createMemoryStorage();
  }
}

const storage: SlotStorage = resolveStorage();

export interface SaveMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 1-based sol number, for the list row. */
  sol: number;
  difficulty: DifficultyId;
  worldSize: WorldSizeId;
  region: string | null;
  seedText: string;
}

export interface SaveRecord {
  meta: SaveMeta;
  data: unknown;
}

function loadIndex(): SaveMeta[] {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SaveMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
  } catch {
    return [];
  }
}

function writeIndex(list: SaveMeta[]): void {
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('Save index write failed', e);
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface NewSaveInput {
  name: string;
  difficulty: DifficultyId;
  worldSize: WorldSizeId;
  region: string | null;
  seedText: string;
}

export class SaveStore {
  private metas: SaveMeta[];

  constructor() {
    this.metas = loadIndex();
    this.adoptLegacySave();
  }

  /** Most recently played first. */
  list(): SaveMeta[] {
    return [...this.metas].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SaveMeta | null {
    return this.metas.find((m) => m.id === id) ?? null;
  }

  mostRecent(): SaveMeta | null {
    const all = this.list();
    return all.length > 0 ? all[0] : null;
  }

  read(id: string): SaveRecord | null {
    const meta = this.get(id);
    if (!meta) return null;
    try {
      const raw = storage.getItem(SLOT_PREFIX + id);
      if (!raw) return null;
      return { meta, data: JSON.parse(raw) };
    } catch (e) {
      console.error('Save read failed', e);
      return null;
    }
  }

  /** Create a slot for a brand-new expedition. Returns its id. */
  create(input: NewSaveInput, snapshot: object, sol = 1): string {
    const now = Date.now();
    const meta: SaveMeta = {
      id: makeId(),
      name: input.name.trim() || 'Unnamed Expedition',
      createdAt: now,
      updatedAt: now,
      sol,
      difficulty: input.difficulty,
      worldSize: input.worldSize,
      region: input.region,
      seedText: input.seedText,
    };
    this.metas.push(meta);
    writeIndex(this.metas);
    this.writeSlot(meta.id, snapshot);
    return meta.id;
  }

  /** Overwrite a slot's snapshot (autosave, manual save, tab-hide). */
  update(id: string, snapshot: object, sol: number): boolean {
    const meta = this.get(id);
    if (!meta) return false;
    meta.updatedAt = Date.now();
    meta.sol = sol;
    writeIndex(this.metas);
    this.writeSlot(id, snapshot);
    return true;
  }

  rename(id: string, name: string): boolean {
    const meta = this.get(id);
    const clean = name.trim();
    if (!meta || clean.length === 0) return false;
    meta.name = clean.slice(0, 60);
    meta.updatedAt = Date.now();
    writeIndex(this.metas);
    return true;
  }

  remove(id: string): boolean {
    const idx = this.metas.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.metas.splice(idx, 1);
    writeIndex(this.metas);
    try {
      storage.removeItem(SLOT_PREFIX + id);
    } catch {
      /* already gone */
    }
    return true;
  }

  private writeSlot(id: string, snapshot: object): void {
    try {
      storage.setItem(SLOT_PREFIX + id, JSON.stringify(snapshot));
    } catch (e) {
      console.error('Save write failed (storage full?)', e);
      throw e;
    }
  }

  /**
   * The pre-menu prototype kept one blob under a fixed key. Adopt it as a
   * named slot once, so no colony is lost to the upgrade.
   */
  private adoptLegacySave(): void {
    let raw: string | null = null;
    try {
      raw = storage.getItem(LEGACY_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let sol = 1;
    try {
      const data = JSON.parse(raw) as { clock?: { sol?: number } };
      sol = (data?.clock?.sol ?? 0) + 1;
    } catch {
      /* keep sol 1; restore() will surface the real problem on load */
    }
    const now = Date.now();
    const meta: SaveMeta = {
      id: makeId(),
      name: 'Recovered Colony',
      createdAt: now,
      updatedAt: now,
      sol,
      difficulty: 'pioneer',
      worldSize: 'medium',
      region: null,
      seedText: '',
    };
    try {
      storage.setItem(SLOT_PREFIX + meta.id, raw);
      storage.removeItem(LEGACY_KEY);
    } catch {
      return;
    }
    this.metas.push(meta);
    writeIndex(this.metas);
  }
}

/** "2h ago", "3d ago", or a short date — for save rows. */
export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
