# Red Frontier — Save Compatibility Policy (Phase 0)

*Establishes the save-game compatibility contract the commercial roadmap's Phase 0 asks for.*
*Companion: `docs/SIMULATION-INVARIANTS.md`, `benchmarks/baseline.md`, `tests/golden-colony/`*

## Current schema

- `SAVE_VERSION = 15` (`src/sim/config.ts`)
- `CURRENT_SAVE_VERSION = SAVE_VERSION` (`src/sim/persistence/SaveSchema.ts`)
- Supported load range: **v3..v15 inclusive** (v3 is earliest kept migration, older is refused)
- Storage: localStorage named slots via `SaveStore` (`src/ui/SaveStore.ts`), one slot per expedition
- Future desktop: file-based saves + Steam Cloud (see commercial review §4.2), but codec/migration contract unchanged

## The rule

> Every schema bump ships:
> 1. A migration file `src/sim/persistence/migrations/vN.ts` (vN-1 → vN)
> 2. Wiring in `src/sim/persistence/SaveMigrations.ts` (the chain)
> 3. Updated `SAVE_VERSION` in `src/sim/config.ts`
> 4. Updated `SaveState` in `SaveSchema.ts` if shape changed
> 5. A hostile-payload case in `tests/sim/save-validation.test.ts` (or dedicated suite)
> 6. Updated pinned hashes if authoritative state changed (transcript + stress + golden colony)

This is already how v3→v13 was built. This doc codifies it so future phases can't skip it.

## Migration chain (additive by design)

| Version | What it added | Migration file | Additive? | Suite |
|---|---|---|---|---|
| v3 | Base kept migration | `v3.ts` | — | `sim/save-validation` |
| v4 | Task queues, drivetrain condition, automation rules | `v4.ts` | Yes | `sim/save-validation` |
| v5 | Position lights | `v5.ts` | Yes | `sim/save-validation` |
| v6 | Difficulty + world options | `v6.ts` | Yes | `sim/save-validation` |
| v7 | Exploration (POIs + drop schedule) | `v7.ts` | Yes | `sim/pois`, `sim/exploration-system` |
| v8 | Weather lightning state (rng + mul) | `v8.ts` | Yes, optional fields with defaults | `sim/weather-system`, `sim/storms` |
| v9 | Refined material `steel` (P5 slice 1) | `v9.ts` | Yes, `{...emptyAmounts(), ...saved}` | `sim/refining` |
| v10 | Manufacturing: `components` ledger + `recipe` + `craft` (P5 slice 2) | `v10.ts` | Yes, empty rack + recipe 0 + bench 0 | `sim/components`, `hud/workshop` |
| v11 | Rover maintenance: `parts` health + Repair Bay jobs (P5 slice 3) | `v11.ts` | Yes, healthy parts + empty jobs | `sim/maintenance` |
| v12 | Water utilities: `water` active/links/tanks (P5 slice 4) | `v12.ts` | Yes, uncommissioned + empty tanks | `sim/water` |
| v13 | Engineering: `upgrades`, `upgradeJob`, `paint`, 3 new components | `v13.ts` (implied via v12→13) | Yes, stock hardware defaults | `sim/engineering`, `hud/engineering` |
| v14 | Tutorial: `tutorial` milestones, warnings, hints, funnel, stats | `v13.ts` (v13→v14) | Yes, empty tutorial state | `sim/tutorial` |
| v15 | Engineering projects (Phase 2): `objectives` board, `unlocks` registry, `lastDirectOrderSol` | `v14.ts` | Yes — unknown project/unlock ids dropped; an old colony gets the opening project and a marker set to its own sol | `sim/objectives` |

Additive means: old save loads without losing progress, new fields default to empty/healthy/stock. Never throw away a field that old saves relied on.

## What a migration must do

- Take `unknown` or `Record<string, unknown>` at edge, return typed `SaveState` or next version.
- Sanitize, don't trust: clamp numbers, floor integers, drop invalid refs, default missing arrays.
- Example: `components` floor to whole ≥0, `craft` clamp 0..1, `recipe` reset if non-integer/negative, but keep out-of-range integer (resolved by `activeProcess`).
- Example: deposit with refined resource → drop row (seams are mined-only by definition).
- Example: building with invalid `recipe` → reset to 0; tank with invalid amount → clamp.

See `src/sim/persistence/SaveValidator.ts` — `decodeSave(unknown)` asserts object, checks version range, runs chain.

## Hostile-payload tests

`tests/sim/save-validation.test.ts` (26+ checks) covers:

- Empty save, missing version, unsupported version, non-object
- Invalid task shapes → coerced to idle
- Pending queue filtering
- Invalid building/rover/poi refs
- Negative storage flagged by invariants
- Fluid clamping, battery/cargo bounds
- Missing arrays defaulting
- Corrupt weather fallback, lightningMul fallback
- Invalid POI kind filtering, reservedBy coercion
- Historical migrations v3→v13 round-trip determinism
- v15 boards: unknown project ids dropped, duplicate ids collapsed, a completion
  with no sol stamp discarded, invented unlock ids refused, malformed blocks
  defaulted (`sim/objectives`)

Each new version must add at least one hostile case (e.g. hand-edited rack, future recipe index, orphan tank).

## Save file contents (what is and isn't saved)

Saved (authoritative, hashed):

- Seed, difficulty, worldHalf, region, worldOptions
- Sim time, ticksRun, clock
- Storage (bulk kg), components (integer rack), fluids (pools)
- WaterState active/links/tanks (v12)
- Rover: id, kind, pos, battery, cargo, command, pending, condition, parts, rules, autoTask, upgrades, paint, upgradeJob
- Building: id, kind, pos, state, remainingCost, progress, health, cleanliness, assembly, maintenance, recipe, craft, upgrades, paint, upgradeJob
- Deposits, POIs (discovered, salvage, burial), exploration nextDropSol
- Weather (rngState, lightningRngState, active/scheduled cells, dust, wind, muls)
- Alerts active + log
- Colonist
- Project board: `active` ids, `completed` with sol/tick stamps (v15)
- Unlock registry: sol, tick and the granting id per unlock (v15)
- `lastDirectOrderSol` — the sol the player last issued a direct order (v15)

Not saved (runtime-only, re-derived):

- Rover `goal`/`phase` (rebuilt by `RoverSystem.rehydrate`)
- Building `level` dev-only
- `statusText`, `idleReason` wording
- `remainder` tick accumulator, `dropRng` closure counter
- Particle FX, audio graph, renderer state
- DevMode modifiers (overlay pins) — only fabrications (spawned entities) are saved

## Snapshot header

`snapshotColony` writes `version: CURRENT_SAVE_VERSION` (not a literal), so a bump cannot stamp stale header. Enforced by `sim/persistence`.

## Determinism & hashing

- `StateHash.ts` hashes live state, not snapshot — so live vs just-restored differ (restore resumes at rest). Compare restored-vs-restored or after both advance.
- Pinned hashes: `CANONICAL_SCENARIOS` in `Transcript.ts`, `tests/sim/transcript.test.ts`, `tests/sim/large-colony-stress.test.ts`, `tests/golden-colony/` (Phase 0).
- Changing tick behavior must update hashes deliberately — PR-visible, reviewed. That's the Phase 0 change-control meaning of "freeze".

## Desktop / Steam future (§4.2 commercial review)

When file-based saves land:

- Keep `SaveCodec`/`SaveSchema`/`SaveMigrations` unchanged — only `SaveStore` changes from localStorage to file + Steam Cloud.
- Add file-based save tests (read/write round-trip) alongside localStorage ones.
- Keep `SaveValidator` hostile-payload tests — they are transport-agnostic.
- Update-checker behind build flag (`?updateCheckMs` already exists).

Do this before heaviest save-schema phases (P2/P3/P4 per review), not after, because those phases add objectives, policies, unlocks, rover stats, event log.

## How to bump version (checklist)

1. Add `src/sim/persistence/migrations/vN.ts` (N = old+1), export `migrateVN-1Save`.
2. Wire in `SaveMigrations.ts` (if chain).
3. Bump `SAVE_VERSION` in `src/sim/config.ts`.
4. Update `SaveState` in `SaveSchema.ts` if shape changed.
5. Update `ColonyPersistence.snapshotColony` / `restoreColony` if needed.
6. Add hostile-payload test in `save-validation` or dedicated suite.
7. Run `npm run test:replay` — re-pin canonical hashes if needed (both `Transcript.ts` and `transcript.test.ts`).
8. Run `npm run test:stress` — re-pin stress hash if needed.
9. Run `scripts/generate-golden-colony.mjs --write` — re-pin golden colony.
10. Update `benchmarks/baseline.md` if perf moved.
11. Update `docs/SIMULATION-INVARIANTS.md` if new invariant.
12. Grep docs for old version number (README, GDD §0, TDD §0/§3, mnemosyne.md, wiki pages).

See `ARCHITECTURAL-REFACTOR-ROADMAP.md` Phase 3 for persistence extraction gate.
