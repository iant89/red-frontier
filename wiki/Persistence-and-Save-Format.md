> ← [Home](Home.md)

# Persistence and Save Format

A save in Red Frontier is **simulation state and nothing else** — no renderer, no
dev overlays, no wording. The schema is versioned, additive, and refuses to guess.

| | |
|---|---|
| Current version | **`SAVE_VERSION = 13`** |
| Accepted range | **v3 … v13** — older is refused, newer is refused |
| Storage | `localStorage`, one named slot per expedition |
| Autosave | 45 s default; off / 30 / 45 / 60 / 120 s in settings |
| Code | [`src/sim/persistence/`](https://github.com/iant89/red-frontier/tree/main/src/sim/persistence) |

## The pieces

```
src/sim/persistence/
  SaveSchema.ts          the shape of a v13 save + CURRENT_SAVE_VERSION
  SaveCodec.ts           decodeSave(unknown) — THE untrusted boundary
  SaveValidator.ts       assertIsObject / extractVersion / field checks on `unknown`
  SaveMigrations.ts      runs the chain step by step
  migrations/v1…v12.ts   one additive step per file
  ColonyPersistence.ts   the field-by-field body (Phase 18)
  EngineeringPersistence.ts / WaterPersistence.ts
```

`Simulation.snapshot()` is a thin delegate; the payload is **built inside the
host**, where developer mode has no handle at all. That is not an optimisation, it
is the security model.

## The untrusted boundary

`decodeSave(unknown)` is the only door:

1. `assertIsObject` → throws `"empty save"` for null / undefined / non-object.
2. `extractVersion` → range-checks → `"unsupported save version X"`. A save from a
   **future** build is refused rather than guessed at.
3. `migrateSave` walks the chain up to the current version.
4. Gameplay code depends on `SaveState`, never on raw JSON; the validator uses
   `unknown` at the edge, never `any`.

The same `unknown`-first discipline protects the live command path: `fieldOk` in
`src/sim/host/protocol.ts` validates types, enums and ranges **before**
`applyCommand` ever sees a payload.

## The migration chain, v3 → v13

Each step is **additive**: an old colony gains the new thing by not having it.

| Step | Adds | What an older colony experiences |
|---|---|---|
| v4 | rover task queues, drivetrain condition, automation rules | fleet starts idle and healthy |
| v5 | position lights | lights default to the automatic rule |
| v6 | difficulty + world options | your colony is re-described as Pioneer/medium |
| v7 | exploration: POIs + drop schedule | sites are unscattered-but-unfound, a fresh drop schedule starts |
| v8 | weather lightning state (seeded strike RNG + difficulty multiplier) | simply gains a sky that can throw a bolt |
| v9 | refined material: `storage` gains `steel` | simply has not smelted anything yet |
| v10 | manufacturing: `components` rack, `recipe`, `craft` per building | arrives with an empty rack, every building on its first line, every bench empty |
| v11 | installed part health + Repair Bay jobs | arrives with healthy parts and no jobs |
| v12 | commissioned water tanks + paid pipe topology | keeps the shared water pool until you commission |
| v13 | engineering: permanent tiers, funded jobs, paint | defaults to stock hardware — nothing charged, nothing granted |

## Restore sanitises, it does not trust

Numbers that survive the trip are made valid on the way in:

- components **floor to whole non-negative units**;
- bench fractions **clamp to 0…1**;
- a non-integer or out-of-range `recipe` index **resolves to the first line**
  instead of taking the tick down;
- part health clamps to 0…100, missing parts default to **100%**;
- a maintenance job with an invalid rover/component, non-finite progress, or a
  non-bay owner is **dropped**; valid progress clamps to 0…1;
- a deposit row naming a **refined** resource is deleted — seams are mined material
  by definition, so such a row can only be hand-edited;
- `buildingSave.kind` is validated against the **live** blueprint table, which is how
  a removed building type fails safe instead of corrupting a colony.

Restore also **rehydrates execution state** that was never saved: rover `goal` /
`phase` are rebuilt by `RoverSystem.rehydrate` from `command` / `pending` plus the
world, and building `level` (developer-only) is reset to 1.

## What is deliberately *not* saved

| Excluded | Why |
|---|---|
| Renderer state, camera, selection | presentation, not colony |
| `DevMode` modifiers, keep-full battery pin, dev `level` marks | runtime overlay; the panel carries an `UNSAVED` badge to say so |
| Rover `goal` / `phase` | execution state, rebuilt on restore |
| Any status **wording** | wording is not state; a stored string can only drift |
| Dev-fabricated objects' *provenance* | the rover you spawned is a real rover now; how it arrived is not recorded |

Verified three ways: a sim suite, a host-suite snapshot check, and a live read of
the stored `localStorage` blob.

## Saving mechanics worth knowing

- **`snapshot()` writes `CURRENT_SAVE_VERSION`, not a literal** — a version bump
  cannot leave the snapshot stamping a stale schema.
- **Ordering is the fix, not retries.** Teardown runs only from the save's `onDone`
  callback, after the write has settled either way. Saving and disposing the host on
  consecutive lines is what used to reject an in-flight worker snapshot as
  *"the colony has shut down"*.
- **`saveContext: 'auto' | 'manual' | 'menu' | 'update'`** decides how a failure is
  reported. A hidden-tab autosave failure is a console line and a toast, never a
  modal; a failed save behind the update card is reported **on the card**, with
  retry / keep playing.
- Autosave is a player setting, plus `Ctrl/Cmd+S`, save-on-tab-hide, and the menu
  and update hand-offs.

## Adding a field (checklist)

1. Add it to `SaveSchema.ts` and bump `SAVE_VERSION` in `config.ts`.
2. Write `migrations/vN.ts` — **additive**: give older colonies a sane default,
   never a compensation.
3. Default/sanitise in the restore path (`ColonyPersistence.ts` or the feature's own
   persistence module).
4. Confirm `snapshot()` writes it and the hash *includes* it. The hash covers live
   state, not the snapshot — deliberate, so a live sim and its restored twin need not
   match until both advance.
5. Add the hostile-payload checks to `tests/sim/save-validation.test.ts` and the
   migration round-trip to `tests/sim/persistence.test.ts`.

`npm run test:check` will fail if a new suite is on disk but unlinked; the save
migrations are gated in CI by the build's `tsc` and locally by `npm test`.

## Related

- [Architecture Overview](Architecture-Overview.md) ·
  [Host and Worker Protocol](Host-and-Worker-Protocol.md) ·
  [Developer Mode](Developer-Mode.md)
