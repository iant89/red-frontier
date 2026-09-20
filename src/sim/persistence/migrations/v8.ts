/**
 * v8 → v9. P5 (Engineering) opens the industrial chain: the bulk ledger gains
 * `steel`, a *refined* resource that a Refinery smelts out of iron ore, and the
 * heavy blueprints downstream (Rover Garage, Weather Radar Station) start
 * costing it.
 *
 * The shape change is purely additive, so an old colony loads unchanged:
 *
 * - `storage` is restored as `{ ...emptyAmounts(), ...saved }`, which gives a
 *   v8 colony `steel: 0`. Nothing to convert, nothing to lose.
 * - Deposits are, and always were, seams of *mined* material. A v8 save cannot
 *   contain a steel seam; a hand-edited one is filtered out on restore rather
 *   than trusted (there is no such thing to mine).
 * - Buildings need no new field: the Refinery is an ordinary process building,
 *   and `BuildingSave.kind` is validated against the live blueprint table, so
 *   the new kind round-trips on its own.
 *
 * The migration therefore only states the version. It exists so the chain stays
 * honest and complete — every bump has a named step and a test, even when the
 * defaults do the work (TDD §15).
 */

export function migrateV8Save(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: 9 };
}
