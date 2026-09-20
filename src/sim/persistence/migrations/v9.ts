/**
 * v9 → v10. P5 slice 2 adds the manufactured-component layer: a second,
 * *counted* ledger beside the weighed one, and the first building that can run
 * more than one line.
 *
 * Additive again, so an older colony loads unchanged and simply has not built
 * anything yet:
 *
 * - `components` is restored as `{ ...emptyComponents(), ...saved }`, so a v9
 *   colony arrives with an empty rack. Capacity is derived (workshop slots), so
 *   there is nothing to migrate there either.
 * - Buildings gain `recipe` (which line is running) and `craft` (the fraction of
 *   the next unit, kept on the bench). A v9 building has neither: `recipe`
 *   defaults to 0 — the first recipe, or ignored entirely by a kind with no
 *   recipe list — and `craft` defaults to zeros, i.e. a bench with nothing
 *   half-made, which is exactly what a colony that has never crafted has.
 * - Rover blueprints gained `componentCost`, but that is content, not state: a
 *   v9 save's already-built rovers are unaffected, and the next one the garage
 *   assembles simply asks for motors.
 *
 * As with v8, the step exists so the chain stays honest and complete — every
 * bump has a named step and a test, even when the defaults do the work (TDD §15).
 */

export function migrateV9Save(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: 10 };
}
