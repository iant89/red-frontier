/**
 * The command protocol: **every write** the presentation layers are allowed to
 * perform on the colony, expressed as plain serializable data.
 *
 * This is the contract a Web Worker needs (TDD §16: "Commands = player
 * intent"). Anything that cannot cross `postMessage` cannot live here — which
 * is the point: the moment a command type is data, the worker can apply it, and
 * the moment a mutation is *not* expressible as a command, the compiler tells
 * us it is still reaching into the sim by hand.
 *
 * Two rules keep the protocol honest:
 *
 *  1. **Commands are intent, not instructions.** They name what the player asked
 *     for; the simulation decides whether that is legal and how it lands. A
 *     command never carries a pre-clamped value, a resolved target, or a field
 *     assignment.
 *  2. **Nothing here is UI state.** Selection, the armed blueprint, the camera
 *     target and hover live in `app/Game.ts`, never in a command — the sim must
 *     not know what panel the player is looking at.
 *
 * `decodeCommand()` is the runtime gate on the same table the types describe.
 * Today it guards against a typo at a call site; across a worker boundary it is
 * the trust boundary (TDD §24: validate bounds/enums on import), which is why
 * the shape is declared once and used for both.
 */

import type { BuildingKind, ResourceId, RoverKind } from '../defs';
import { BUILDINGS, RESOURCES, ROVERS } from '../defs';
import type { ColonistOrder } from '../lifesupport';
import type { StormKindReal } from '../weather';

/** The per-rover automation switches, named as the sim names them. */
export type RoverRule = 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue';

// -------------------------------------------------------------- commands ----

/**
 * The union of every legal write. `type` is the discriminator so a dispatcher
 * can switch on it, and every payload is primitives-only (numbers, booleans,
 * strings, and the two plain-data records `ColonistOrder` allows).
 */
export type SimCommand =
  // --- rover orders (TDD §8) ---
  | { type: 'rover/move'; roverId: number; x: number; z: number; queue: boolean }
  | { type: 'rover/mine'; roverId: number; depositId: number; queue: boolean }
  | { type: 'rover/unload'; roverId: number; queue: boolean }
  | { type: 'rover/wait'; roverId: number; seconds: number; queue: boolean }
  | { type: 'rover/construct'; roverId: number; buildingId: number; queue: boolean }
  | { type: 'rover/clean'; roverId: number; buildingId: number; queue: boolean }
  | { type: 'rover/repair'; roverId: number; buildingId: number; queue: boolean }
  | { type: 'rover/recover'; roverId: number; strandedId: number; queue: boolean }
  | { type: 'rover/stop'; roverId: number }
  | { type: 'rover/repeatRoute'; roverId: number; on: boolean }
  | { type: 'rover/rule'; roverId: number; rule: RoverRule; on: boolean }
  | { type: 'rover/chargeFloor'; roverId: number; pct: number }
  | { type: 'rover/lights'; roverId: number; on: boolean }
  // --- structures (TDD §7) ---
  | { type: 'building/place'; kind: BuildingKind; x: number; z: number }
  | { type: 'building/toggle'; buildingId: number; enabled: boolean }
  | { type: 'building/demolish'; buildingId: number }
  | { type: 'building/maintain'; buildingId: number }
  | { type: 'building/assemble'; buildingId: number; kind: RoverKind }
  // --- the human ---
  | { type: 'colonist/order'; order: ColonistOrder }
  // --- developer backdoors (TDD §22) — never persisted, never implicit ---
  | { type: 'dev/time'; sol: number; frac: number }
  | { type: 'dev/storm/force'; kind: StormKindReal }
  | { type: 'dev/storm/clear' }
  | { type: 'dev/storm/scheduler'; on: boolean }
  | { type: 'dev/dust'; frac: number }
  | { type: 'dev/spawn/rover'; kind: RoverKind; x: number; z: number }
  | { type: 'dev/spawn/building'; kind: BuildingKind; x: number; z: number }
  | { type: 'dev/spawn/deposit'; resource: ResourceId; x: number; z: number; kg: number }
  | { type: 'dev/building/complete'; buildingId: number }
  | { type: 'dev/building/level'; buildingId: number; level: number }
  | { type: 'dev/building/health'; buildingId: number; pct: number }
  | { type: 'dev/building/damaged'; buildingId: number; on: boolean }
  | { type: 'dev/building/cleanliness'; buildingId: number; frac: number }
  | { type: 'dev/rover/battery'; roverId: number; frac: number }
  | { type: 'dev/rover/cargo'; roverId: number; resource: ResourceId; kg: number }
  | { type: 'dev/rover/cargoClear'; roverId: number }
  | { type: 'dev/rover/condition'; roverId: number; pct: number }
  | { type: 'dev/colonist/health'; pct: number }
  | { type: 'dev/colonist/suit' };

export type SimCommandType = SimCommand['type'];

/** Every command the protocol accepts — the allow-list `decodeCommand` checks. */
export const COMMAND_TYPES: readonly SimCommandType[] = [
  'rover/move',
  'rover/mine',
  'rover/unload',
  'rover/wait',
  'rover/construct',
  'rover/clean',
  'rover/repair',
  'rover/recover',
  'rover/stop',
  'rover/repeatRoute',
  'rover/rule',
  'rover/chargeFloor',
  'rover/lights',
  'building/place',
  'building/toggle',
  'building/demolish',
  'building/maintain',
  'building/assemble',
  'colonist/order',
  'dev/time',
  'dev/storm/force',
  'dev/storm/clear',
  'dev/storm/scheduler',
  'dev/dust',
  'dev/spawn/rover',
  'dev/spawn/building',
  'dev/spawn/deposit',
  'dev/building/complete',
  'dev/building/level',
  'dev/building/health',
  'dev/building/damaged',
  'dev/building/cleanliness',
  'dev/rover/battery',
  'dev/rover/cargo',
  'dev/rover/cargoClear',
  'dev/rover/condition',
  'dev/colonist/health',
  'dev/colonist/suit',
];

const ROVER_RULES: readonly string[] = ['autoHaul', 'autoService', 'stormShelter', 'autoRescue'];
const STORM_KINDS: readonly string[] = ['devil', 'regional', 'severe', 'planetary'];

// ------------------------------------------------------------------ acks ----

/**
 * The simulation's answer to a command. Only the commands that genuinely need
 * one bother with it — most of the protocol is fire-and-forget.
 *
 * `ok` means **the sim accepted and acted on the intent**. It is false only for
 * a refusal — an illegal building site, a malformed payload, a colony that has
 * stopped. A command that found nothing to do (cleaning a panel that is already
 * clean) is `ok: true`, because the sim did answer it; what it thought about
 * that is the log line it wrote, not a second channel of truth. Keeping that
 * distinction in one place is what stops every button in the UI from
 * second-guessing the simulation.
 *
 * `entityId` is the id the sim *allocated* for a creation (so the UI can select
 * what it just built), and `value` is a number the sim *landed on* after
 * clamping (a cargo load, an upgrade level). Both are the sim's business, which
 * is precisely why they come back through an ack instead of being computed by
 * the caller.
 */
export interface SimAck {
  ok: boolean;
  entityId?: number;
  value?: number;
  /**
   * A reason worth showing the player, when the sim has one — never an
   * exception across the wire. Optional by design: some refusals are already
   * explained by the log line the command wrote (nothing to clean, no garage to
   * build in), and duplicating that as a second string invites them to drift.
   */
  error?: string;
}

// ------------------------------------------------------------- validation ----

/**
 * How one payload field is validated. Bounds are deliberately loose: the sim
 * clamps what matters (a charge floor, a health percentage), and duplicating
 * those rules here would let the two drift.
 */
type FieldKind =
  | 'id' // integer entity/deposit id, >= 0
  | 'coord' // finite world position — the landing site is the origin, so either sign
  | 'amount' // finite, >= 0 (kg, seconds)
  | 'pct' // 0..100
  | 'unit' // 0..1
  | 'bool'
  | 'buildingKind'
  | 'roverKind'
  | 'resourceId'
  | 'stormKind'
  | 'rule'
  | 'order';

interface CommandShape {
  /** field → kind. Every field must be listed; unknown keys are rejected. */
  [field: string]: FieldKind;
}

/**
 * The single source of truth for command shape. `decodeCommand` enforces it,
 * the type union above describes it, and a test pins that the two agree — so a
 * new command with no entry here fails the suite rather than the player's run.
 */
export const COMMAND_SHAPES: Record<SimCommandType, CommandShape> = {
  'rover/move': { roverId: 'id', x: 'coord', z: 'coord', queue: 'bool' },
  'rover/mine': { roverId: 'id', depositId: 'id', queue: 'bool' },
  'rover/unload': { roverId: 'id', queue: 'bool' },
  'rover/wait': { roverId: 'id', seconds: 'amount', queue: 'bool' },
  'rover/construct': { roverId: 'id', buildingId: 'id', queue: 'bool' },
  'rover/clean': { roverId: 'id', buildingId: 'id', queue: 'bool' },
  'rover/repair': { roverId: 'id', buildingId: 'id', queue: 'bool' },
  'rover/recover': { roverId: 'id', strandedId: 'id', queue: 'bool' },
  'rover/stop': { roverId: 'id' },
  'rover/repeatRoute': { roverId: 'id', on: 'bool' },
  'rover/rule': { roverId: 'id', rule: 'rule', on: 'bool' },
  'rover/chargeFloor': { roverId: 'id', pct: 'pct' },
  'rover/lights': { roverId: 'id', on: 'bool' },
  'building/place': { kind: 'buildingKind', x: 'coord', z: 'coord' },
  'building/toggle': { buildingId: 'id', enabled: 'bool' },
  'building/demolish': { buildingId: 'id' },
  'building/maintain': { buildingId: 'id' },
  'building/assemble': { buildingId: 'id', kind: 'roverKind' },
  'colonist/order': { order: 'order' },
  'dev/time': { sol: 'id', frac: 'unit' },
  'dev/storm/force': { kind: 'stormKind' },
  'dev/storm/clear': {},
  'dev/storm/scheduler': { on: 'bool' },
  'dev/dust': { frac: 'unit' },
  'dev/spawn/rover': { kind: 'roverKind', x: 'coord', z: 'coord' },
  'dev/spawn/building': { kind: 'buildingKind', x: 'coord', z: 'coord' },
  'dev/spawn/deposit': { resource: 'resourceId', x: 'coord', z: 'coord', kg: 'amount' },
  'dev/building/complete': { buildingId: 'id' },
  'dev/building/level': { buildingId: 'id', level: 'pct' },
  'dev/building/health': { buildingId: 'id', pct: 'pct' },
  'dev/building/damaged': { buildingId: 'id', on: 'bool' },
  'dev/building/cleanliness': { buildingId: 'id', frac: 'unit' },
  'dev/rover/battery': { roverId: 'id', frac: 'unit' },
  'dev/rover/cargo': { roverId: 'id', resource: 'resourceId', kg: 'amount' },
  'dev/rover/cargoClear': { roverId: 'id' },
  'dev/rover/condition': { roverId: 'id', pct: 'pct' },
  'dev/colonist/health': { pct: 'pct' },
  'dev/colonist/suit': {},
};

export type DecodeResult =
  | { ok: true; command: SimCommand }
  | { ok: false; error: string };

function bad(what: string): DecodeResult {
  return { ok: false, error: `malformed command: ${what}` };
}

function fieldOk(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'id':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    case 'coord':
      return typeof value === 'number' && Number.isFinite(value);
    case 'amount':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'pct':
    case 'unit':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
    case 'bool':
      return typeof value === 'boolean';
    case 'buildingKind':
      return typeof value === 'string' && value in BUILDINGS;
    case 'roverKind':
      return typeof value === 'string' && value in ROVERS;
    case 'resourceId':
      return typeof value === 'string' && value in RESOURCES;
    case 'stormKind':
      return typeof value === 'string' && STORM_KINDS.includes(value);
    case 'rule':
      return typeof value === 'string' && ROVER_RULES.includes(value);
    case 'order':
      return isColonistOrder(value);
  }
}

/** `pct`/`unit` share a branch above, but 0..1 fractions must not accept 100. */
function withinRange(value: unknown, kind: FieldKind): boolean {
  if (kind === 'unit') return typeof value === 'number' && value >= 0 && value <= 1;
  return true;
}

/**
 * Colonist orders are already plain data (TDD §14), so they are the one nested
 * payload the protocol allows. Checked by shape, not by reference identity.
 */
function isColonistOrder(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.type === 'shelter') return true;
  if (o.type === 'moveTo') return fieldOk(o.x, 'coord') && fieldOk(o.z, 'coord');
  if (o.type === 'assist') return fieldOk(o.buildingId, 'id');
  return false;
}

/**
 * Validate an untrusted payload against {@link COMMAND_SHAPES}. Returns the
 * command on success, or a reason on failure — a refusal must be loggable, not
 * throwable, because a dropped gesture should never take the colony down.
 */
export function decodeCommand(raw: unknown): DecodeResult {
  if (!raw || typeof raw !== 'object') return bad('not an object');
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !COMMAND_SHAPES[type as SimCommandType]) {
    return bad(`unknown command type "${String(type)}"`);
  }
  const shape = COMMAND_SHAPES[type as SimCommandType];
  const keys = Object.keys(shape);
  for (const field of keys) {
    if (!fieldOk(obj[field], shape[field]) || !withinRange(obj[field], shape[field])) {
      return bad(`${type}.${field}`);
    }
  }
  // Strict: an unexpected key means the sender and this table have diverged.
  for (const k of Object.keys(obj)) {
    if (k !== 'type' && !keys.includes(k)) return bad(`${type} carries "${k}"`);
  }
  return { ok: true, command: obj as unknown as SimCommand };
}
