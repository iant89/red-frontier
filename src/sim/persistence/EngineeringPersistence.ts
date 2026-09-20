/** Sanitise and own permanent engineering fields at the untrusted-save boundary. */
import {
  PAINTS,
  MAX_UPGRADE_TIER,
  type EngineeringState,
  type UpgradeId,
} from '../engineering/upgrades';
export function copyEngineering(e: EngineeringState): EngineeringState {
  return {
    upgrades: { ...e.upgrades },
    upgradeJob: e.upgradeJob ? { ...e.upgradeJob } : null,
    paint: e.paint ?? null,
  };
}
export function restoreEngineering(
  raw: EngineeringState,
  allowed: UpgradeId[],
): EngineeringState {
  const upgrades: NonNullable<EngineeringState['upgrades']> = {};
  for (const id of allowed) {
    const n = raw.upgrades?.[id];
    if (
      typeof n === 'number' &&
      Number.isInteger(n) &&
      n > 0 &&
      n <= MAX_UPGRADE_TIER
    )
      upgrades[id] = n;
  }
  const j = raw.upgradeJob;
  const valid =
    j &&
    allowed.includes(j.upgrade) &&
    Number.isInteger(j.tier) &&
    j.tier === (upgrades[j.upgrade] ?? 0) + 1 &&
    j.tier <= MAX_UPGRADE_TIER &&
    Number.isFinite(j.progress) &&
    j.progress >= 0 &&
    j.progress < 1 &&
    (j.facilityId === null ||
      (Number.isInteger(j.facilityId) && j.facilityId >= 0));
  return {
    upgrades,
    upgradeJob: valid ? { ...j } : null,
    paint:
      typeof raw.paint === 'string' &&
      (PAINTS as readonly string[]).includes(raw.paint)
        ? raw.paint
        : null,
  };
}
