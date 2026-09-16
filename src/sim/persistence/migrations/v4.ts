/**
 * v4 → v5. Rovers grew position lights: a player switch that the sim honours
 * automatically at night and in blowing dust. Every existing rover is
 * assumed to have shipped with the switch armed.
 */
export function migrateV4Save(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data, version: 5 };
  d.rovers = ((data as { rovers?: unknown[] }).rovers ?? []).map((r: unknown) => {
    const rover = r as Record<string, unknown>;
    return { ...(rover as object), lightsOn: (rover as { lightsOn?: unknown }).lightsOn !== false };
  });
  return d;
}
