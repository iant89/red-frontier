/**
 * New-game configuration: difficulty levels, world sizes and the advanced
 * world options the mission wizard collects before a colony is founded.
 *
 * Difficulties are *presets with teeth* — they scale life-support appetite,
 * storm frequency and storm damage. The advanced world options let the player
 * tune the same axes individually; where they overlap (storms, supplies) the
 * multipliers combine, so a Survivor on a brutal world is exactly as doomed
 * as it sounds.
 */

export type DifficultyId = 'settler' | 'pioneer' | 'survivor';

export interface DifficultyDef {
  id: DifficultyId;
  label: string;
  tagline: string;
  description: string;
  /** Multiplier on the colonist's per-sol consumption. */
  consumptionMul: number;
  /** Multiplier on storm roll probabilities. */
  stormMul: number;
  /** Multiplier on storm structural damage. */
  damageMul: number;
  /** Multiplier on the landing pod's starting life-support stores. */
  suppliesMul: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  settler: {
    id: 'settler',
    label: 'Settler',
    tagline: 'A gentler Mars',
    description:
      'Generous starting stores, a lighter appetite, and storms that mostly grumble. For learning the chains — or for a relaxed campaign.',
    consumptionMul: 0.85,
    stormMul: 0.55,
    damageMul: 0.6,
    suppliesMul: 1.35,
  },
  pioneer: {
    id: 'pioneer',
    label: 'Pioneer',
    tagline: 'The intended expedition',
    description:
      'The balanced campaign. Every chain matters, storms demand respect, and the margins are thin but fair.',
    consumptionMul: 1,
    stormMul: 1,
    damageMul: 1,
    suppliesMul: 1,
  },
  survivor: {
    id: 'survivor',
    label: 'Survivor',
    tagline: 'Mars at its worst',
    description:
      'Lean stores, a hungry crew, frequent storms that hit harder. For commanders who have already died here once.',
    consumptionMul: 1.2,
    stormMul: 1.5,
    damageMul: 1.4,
    suppliesMul: 0.75,
  },
};

export const DIFFICULTY_ORDER: DifficultyId[] = ['settler', 'pioneer', 'survivor'];

// ------------------------------------------------------------------ sizes ----

export type WorldSizeId = 'small' | 'medium' | 'large' | 'planet';

export interface WorldSizeDef {
  id: WorldSizeId;
  label: string;
  tagline: string;
  description: string;
  /** Half-extent of the playable square, in metres. */
  worldHalf: number;
  sizeLabel: string;
}

export const WORLD_SIZES: Record<WorldSizeId, WorldSizeDef> = {
  small: {
    id: 'small',
    label: 'Outpost',
    tagline: 'Small · tight & tense',
    description:
      'A compact survey zone. Deposits are close but finite — every placement counts and the horizon arrives fast.',
    worldHalf: 420,
    sizeLabel: '840 × 840 m',
  },
  medium: {
    id: 'medium',
    label: 'Territory',
    tagline: 'Medium · the classic campaign',
    description:
      'The standard expedition footprint. Room to spread out, far enough to make logistics interesting.',
    worldHalf: 640,
    sizeLabel: '1.28 × 1.28 km',
  },
  large: {
    id: 'large',
    label: 'Province',
    tagline: 'Large · room to roam',
    description:
      'A sprawling claim with distant, richer strikes. Long hauls reward cargo rovers and forward depots.',
    worldHalf: 960,
    sizeLabel: '1.92 × 1.92 km',
  },
  planet: {
    id: 'planet',
    label: 'Planetary Survey',
    tagline: 'Entire region · the long expedition',
    description:
      'The widest survey the descent stage can support — a vast regional claim. Trekking across it is an expedition in itself.',
    worldHalf: 1280,
    sizeLabel: '2.56 × 2.56 km',
  },
};

export const WORLD_SIZE_ORDER: WorldSizeId[] = ['small', 'medium', 'large', 'planet'];

// ---------------------------------------------------------- world options ----

export type StormLevel = 'calm' | 'normal' | 'brutal';
export type SupplyLevel = 'lean' | 'standard' | 'abundant';
export type RichnessLevel = 'poor' | 'standard' | 'rich';
export type DepositSpread = 'scarce' | 'standard' | 'plentiful';

export interface WorldOptions {
  /** Fraction of deposits placed in the "near" ring around the landing pad. */
  nearDeposits: number;
  stormLevel: StormLevel;
  supplies: SupplyLevel;
  richness: RichnessLevel;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  nearDeposits: 0.2,
  stormLevel: 'normal',
  supplies: 'standard',
  richness: 'standard',
};

export function stormMulFor(level: StormLevel): number {
  switch (level) {
    case 'calm':
      return 0.45;
    case 'brutal':
      return 1.8;
    default:
      return 1;
  }
}

export function suppliesMulFor(level: SupplyLevel): number {
  switch (level) {
    case 'lean':
      return 0.7;
    case 'abundant':
      return 1.4;
    default:
      return 1;
  }
}

export function richnessMulFor(level: RichnessLevel): number {
  switch (level) {
    case 'poor':
      return 0.65;
    case 'rich':
      return 1.5;
    default:
      return 1;
  }
}

export const DEPOSIT_SPREADS: Record<DepositSpread, { label: string; value: number; blurb: string }> = {
  scarce: { label: 'Scarce', value: 0.08, blurb: 'Long treks to the good seams.' },
  standard: { label: 'Standard', value: 0.2, blurb: 'The balanced scatter.' },
  plentiful: { label: 'Plentiful', value: 0.34, blurb: 'A forgiving first week.' },
};

// ------------------------------------------------------------ game config ----

/** Everything the New Expedition wizard collects before the world is built. */
export interface NewGameConfig {
  saveName: string;
  seedText: string;
  difficulty: DifficultyId;
  worldSize: WorldSizeId;
  /** Landing region name, or null for a random site. */
  region: string | null;
  options: WorldOptions;
}

/** FNV-1a string → uint32. Shared by the wizard preview and the game boot. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A readable random seed stamp, e.g. `ARES-7K2Q`. */
export function randomSeedText(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[(Math.random() * chars.length) | 0];
  return `ARES-${s}`;
}
