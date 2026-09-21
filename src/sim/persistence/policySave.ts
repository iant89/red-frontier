/**
 * The policies block's one sanitiser, shared by the v16 migration and the
 * restorer (SAVE-COMPATIBILITY.md: sanitise, don't trust). A missing or
 * hostile block is the default — every policy off — never a throw.
 */
import type { PolicyState } from '../state/PolicyState';
import { emptyPolicyState } from '../state/PolicyState';
import { RESOURCES } from '../defs';
import type { ResourceId } from '../defs';

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  if (!Number.isFinite(v as number)) return fallback;
  const n = Number(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function sanitisePolicies(saved: unknown, validBuildingIds: ReadonlySet<number>): PolicyState {
  const out = emptyPolicyState();
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, Record<string, unknown> | unknown>;
  const block = (k: string): Record<string, unknown> =>
    s[k] && typeof s[k] === 'object' ? (s[k] as Record<string, unknown>) : {};

  const sp = block('stockpile');
  out.stockpile.on = bool(sp.on, false);
  if (typeof sp.resource === 'string' && sp.resource in RESOURCES) out.stockpile.resource = sp.resource as ResourceId;
  out.stockpile.minKg = num(sp.minKg, out.stockpile.minKg, 0, 5000);

  const np = block('nightPower');
  out.nightPower.on = bool(np.on, false);
  out.nightPower.minBatteryPct = num(np.minBatteryPct, out.nightPower.minBatteryPct, 0, 100);

  out.stormShelter.on = bool(block('stormShelter').on, false);

  const am = block('autoMaintain');
  out.autoMaintain.on = bool(am.on, false);
  out.autoMaintain.maxWearPct = num(am.maxWearPct, out.autoMaintain.maxWearPct, 0, 100);

  if (Array.isArray(s.held)) {
    const seen = new Set<number>();
    for (const id of s.held) {
      if (Number.isInteger(id) && validBuildingIds.has(id as number) && !seen.has(id as number)) {
        seen.add(id as number);
        out.held.push(id as number);
      }
    }
  }
  out.actions = Math.floor(num(s.actions, 0, 0, Number.MAX_SAFE_INTEGER));
  return out;
}
