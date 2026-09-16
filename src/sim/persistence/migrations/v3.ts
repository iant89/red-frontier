/**
 * v3 → v4 (Prototype 4). What changed: rovers grew a task queue, drivetrain
 * condition and automation rules; buildings (garages) grew an assembly slot.
 * Old rovers had a single `command` — it becomes the one task in the queue —
 * and the old `autoHaul` flag carries over as the matching rule. From there
 * the v4 → v5 step adds the position-lights switch.
 */
import { defaultRoverRules } from '../../state/RoverState';

export function migrateV3Save(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data, version: 4 };
  d.rovers = ((data as { rovers?: unknown[] }).rovers ?? []).map((r: unknown) => {
    const rover = r as Record<string, unknown>;
    const rules = defaultRoverRules();
    rules.autoHaul = (rover as { autoHaul?: unknown }).autoHaul !== false;
    return { ...(rover as object), pending: [], condition: 100, rules };
  });
  d.buildings = ((data as { buildings?: unknown[] }).buildings ?? []).map((b: unknown) => ({
    ...(b as object),
    assembly: null,
  }));
  return d;
}
