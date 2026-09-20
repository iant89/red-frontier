> ← [Home](Home.md)

# Architecture Overview

Six boxes and one rule: **nothing outside the host touches the simulation.**

```
   Intent  →  SimCommand  →  Simulation  →  ColonyState  →  SimView  →  Presentation
   (input)      (host)          (sim/)        (sim/state)      (host)     (app/ ui/ render/ audio/ dev/)
```

The rule is enforced three ways: the compiler (a `SimView` has no mutators and is
`readonly` all the way down), a test that greps the tree (`tests/sim/host.test.ts`
fails if anything re-imports `Simulation`), and the save path (the payload is built
inside the host, where developer mode has no handle at all).

## Layers

| Layer | Responsibility | Runtime | Source |
|---|---|---|---|
| **UI** | HUD, minimap/world map, menus, palette, alerts | main thread DOM/CSS + 2D canvas | `src/ui` |
| **Input** | desktop/mobile gesture normalisation | main thread | `src/app/gestures.ts`, `InputController.ts` |
| **Renderer** | camera, terrain, entities, FX, overlays | three.js WebGL2 | `src/render` |
| **Simulation** | world state, economy, AI, weather, utilities | **worker** or main | `src/sim` |
| **World** | terrain, deposits, POIs | inside sim; re-derived from seed on the mirror | `src/sim/World.ts` |
| **Persistence** | versioned snapshots | `sim/persistence` codec + `localStorage` slots | `src/ui/SaveStore.ts` |
| **Audio** | ambience, machinery, cues | procedural Web Audio | `src/audio` |
| **Dev tools** | runtime-only edits | `dev/*` commands on the host | `src/dev` |
| **Debug harness** | invariants, state hash, profiler, transcripts, benchmarks | dev-only, tree-shaken out of the bundle | `src/sim/debug` |

The renderer never owns authoritative state. UI sends commands and receives
views and events.

## The seam

`app/`, `ui/`, `render/` and `dev/` hold a `SimHost` interface. Two
implementations exist and they are interchangeable:

- **`LocalSimHost`** — the live `Simulation`, narrowed to a view; used by every
  unit suite and by `?worker=0`.
- **`WorkerSimHost`** — a colony inside a module worker, mirrored on this side
  from view payloads, with terrain derived locally from the seed the worker
  reported. **This is the default** (`WORKER_DEFAULT = true` in `createHost.ts`).

Two rules make the worker honest rather than merely faster:

1. **A command publishes the world.** The worker applies a command batch and
   answers with a fresh view instead of waiting for the next `advance` — because
   the obvious moment to order a rover is while *paused*, and a paused client
   posts no advances. The in-process host gets this for free, so anything less is
   a divergence between transports (and it was a real bug: an order given to a
   paused colony was applied by the sim and invisible to the HUD until you
   unpaused).
2. **The client sets the pace.** Both hosts are stepped one `advance{dt}` per
   delivered frame. There is deliberately **no `setInterval` in the worker**: a
   timer in a hidden tab is throttled to ~1 Hz and the colony would race ahead
   unseen. An advance still in flight banks its `dt` rather than queueing, so a
   stutter delivers one bigger tick — which is exactly what the fixed-substep
   accumulator assumes.

State crosses as data in one shape: entities are spread whole into a
`ViewPayload` (a field-picked list always drifts), `satisfaction` travels as
entries so a payload stays JSON-printable, and terrain is *not* sent — heights,
slope and surface geology are pure functions of the seed, which is what lets the
build ghost answer `canPlace` synchronously by running the same `evaluateSite`
the simulation runs. One tick of lag, never a different rule.

## Determinism is enforced, not hoped for

- Fixed step `SIM_TICK = 1/20` s, integer tick counter, stable iteration order,
  seeded PRNG from `src/lib/rng.ts`.
- The tick accumulator holds its remainder in `[0, step)` and telescopes, so 60 s
  delivered in 3 600 ragged browser frames runs **exactly as many ticks** as 60 s
  delivered in one call. There is a test for precisely this.
- **Three independent random streams**: world/weather rolls, the storm field's
  fine noise, and a separate `weather.lightningRoll` — so a strike never
  perturbs a weather roll and a forced dev strike never moves the sky.
- `debug/StateHash.ts` compresses live state to `rf1-<14hex>-<14hex>` over
  canonical JSON (sorted keys, entity arrays sorted by id), and
  `debug/Transcript.ts` records a colony as *seed + difficulty + world options +
  timed commands* that `npm run test:replay` re-runs against pinned hashes.

The hash covers **live state**, not `snapshot()` — so a live sim and its
just-restored twin do *not* hash equal (restore resumes entities at rest).
Compare restored-vs-restored, or both after one advance.

## Data drives content

Resources, fluids, blueprints, processes, power tiers and balance live in
[`src/sim/defs.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/defs.ts)
and [`config.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/config.ts),
outside game logic. The payoff: the Refinery and `steel` arrived with the command
decoder untouched, because a new blueprint or bulk resource is validated against
the tables (`buildingKind` against `BUILDINGS`, `resourceId` against `RESOURCES`).
**New content is cheaper than new intent.**

Two accounting rules follow from that:

- **Storage is per-resource**, not one shared pool — a shared pool lets a single
  rover-load of regolith deadlock every other supply chain, which reads as a bug
  rather than a bottleneck.
- **One bulk ledger.** Refined `steel` is a `ResourceId` on the same ledger as
  ore — hauled, siloed, reserved and spent by the same code. The only difference
  is `origin`: a *mined* resource has seams on the planet; a *refined* one is made
  by a building and can never be scattered, mined, or surveyed in.

## The project's golden rules

From [`ARCHITECTURAL-REFACTOR-ROADMAP.md`](https://github.com/iant89/red-frontier/blob/main/ARCHITECTURAL-REFACTOR-ROADMAP.md)
§3 — all 30 phases are complete, and these rules still govern new work:

1. **No behavior changes unless explicitly intended.** Same seed, initial state,
   command sequence and elapsed time ⇒ same results.
2. **One architectural change at a time.** Do not extract a system, redesign the
   save format and rework the renderer in one commit.
3. **Tests before extraction.** Pin the behaviour, move it, re-run, compare the
   deterministic output.
4. **Preserve public boundaries** — `SimHost`, `SimCommand`, `SimView`,
   `WorkerSimHost`, `LocalSimHost`. These are the strongest seams in the project.
5. **Simulation remains authoritative** — UI, renderer, dev tools and any future
   networking must never become the source of truth.

## Module layout

```
src/
  main.ts            entry point
  app/               composition root: Game + the controllers it wires
  audio/             procedural Web Audio soundscape — presentation only
  sim/               framework-agnostic simulation (no DOM, no three.js)
    config.ts defs.ts difficulty.ts clock.ts power.ts lifesupport.ts weather.ts
    pois.ts terrain.ts marsGlobe.ts marsDem.ts navgrid.ts rules.ts World.ts
    Simulation.ts DevBackdoors.ts alerts.ts domainEvents.ts
    state/           ColonyState and the entity/record shapes (data, no behavior)
    systems/         extracted tick responsibilities, each a static API over state
    persistence/     schema v13, codec, validator, migration steps v1…v12
    host/            the seam: protocol, view, applyCommand, hosts, mirror, ports
    debug/           invariants, state hash, profiler, transcripts, benchmarks
  render/            three.js renderer (terrain, entities, FX, overlays)
  ui/                DOM HUD, menus, wizard, world map, save store, settings
  lib/               deterministic RNG + simplex noise
tests/               87 suites / 983 checks
scripts/           esbuild test runner, Playwright smokes, benchmarks, screenshots
```

Read [`TDD §2–§3`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md)
for the annotated version of this tree, then
[Simulation Systems](Simulation-Systems.md) for who does what each tick.

## Deliberate design locks

Do not "fix" these without a design change (GDD §0):

- Bulk solids ride rovers; **fluids never do**.
- **A process earns its output** — bounded by the input that actually arrived.
- **Soft failure** — rovers strand and get jump-started; a bolt bruises, it does
  not delete the colony.
- Developer-mode *modifiers* never enter the save; *fabricated objects* do.
- **Audio and particles are presentation.** They read the sim, never write it, and
  animate on *sim time* — so a save/replay stays byte-for-byte deterministic with
  the sound on.
- **Lightning has its own seeded RNG stream.**
