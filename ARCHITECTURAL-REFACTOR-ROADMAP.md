# Red Frontier — Architectural Refactoring Roadmap

Version: 1.0
Target: Incremental architectural refactor
Strategy: Preserve behavior while progressively separating responsibilities
Primary Goal: Reduce coupling without rewriting the simulation architecture

---

# 1. Refactoring Philosophy

The objective is NOT to rewrite Red Frontier.

The existing architecture contains several strong foundations that should be preserved:

- The simulation is independent of the DOM.
- The simulation is independent of Three.js.
- Commands represent player intent rather than direct state mutation.
- `SimHost` separates the simulation from its transport.
- Worker and in-process simulation modes share the same conceptual interface.
- `SimView` separates simulation state from presentation.
- Simulation time is deterministic.
- RNG streams are intentionally isolated.
- Saves are versioned and migrated.
- Development commands travel through the same host boundary.
- Terrain/world generation is seeded and deterministic.

The refactoring should therefore follow this rule:

> Extract responsibilities from the existing architecture; do not replace the architecture.

The primary architectural problem is the concentration of responsibilities inside `Simulation.ts` and, to a lesser extent, `Game.ts`.

---

# 2. Target Architecture

The desired architecture is:

    Browser
       │
       ▼
    Application Layer
       │
       ▼
    SimHost
       │
       ├───────────────┐
       ▼               ▼
    Local Host      Worker Host
       │               │
       └───────┬───────┘
               ▼
          Simulation
               │
               ▼
          ColonyState
               │
       ┌───────┼─────────────────────────────┐
       │       │       │       │       │     │
       ▼       ▼       ▼       ▼       ▼     ▼
     Clock   Weather Power  Life    Rover Construction
                       Support System System
       │       │       │       │       │     │
       └───────┴───────┴───────┴───────┴─────┘
                         │
                         ▼
                  Automation / AI
                         │
                         ▼
                  Exploration / POI
                         │
                         ▼
                    SimView
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
          Renderer       UI         Audio


The most important transformation is:

    CURRENT

    Simulation
    ├── State
    ├── Simulation rules
    ├── Rover behavior
    ├── Automation
    ├── Construction
    ├── Persistence
    ├── Weather
    ├── Power integration
    ├── Life support
    ├── Exploration
    └── Timing


    TARGET

    Simulation
    └── Orchestration

    ColonyState
    └── Simulation state

    Systems
    ├── ClockSystem
    ├── WeatherSystem
    ├── PowerSystem
    ├── ProductionSystem
    ├── LifeSupportSystem
    ├── RoverSystem
    ├── FleetAutomationSystem
    ├── ConstructionSystem
    ├── LogisticsSystem
    ├── ExplorationSystem
    ├── FailureSystem
    ├── AlertSystem
    └── HistorySystem

    Persistence
    ├── SaveSchema
    ├── SaveCodec
    └── Migrations


# 3. Golden Rules

These rules should govern every phase.

## Rule 1 — No behavior changes unless explicitly intended

A refactor should produce the same simulation results for the same:

    seed
    initial state
    command sequence
    elapsed simulation time

before and after the refactor.

---

## Rule 2 — One architectural change at a time

Do not simultaneously:

    extract RoverSystem
    redesign the save format
    optimize pathfinding
    change the worker protocol
    change the renderer

Each phase should have a narrow purpose.

---

## Rule 3 — Tests before extraction

Before moving a subsystem:

    1. Identify its existing behavior.
    2. Add tests around that behavior.
    3. Extract the subsystem.
    4. Run the same tests.
    5. Compare deterministic output.

---

## Rule 4 — Preserve public boundaries

Do not casually change:

    SimHost
    SimCommand
    SimView
    WorkerSimHost
    LocalSimHost

These are some of the strongest architectural boundaries in the project.

---

## Rule 5 — Simulation remains authoritative

UI, renderer, dev tools, and future networking must never become authoritative over simulation state.

The flow remains:

    Intent
      ↓
    SimCommand
      ↓
    Simulation
      ↓
    State
      ↓
    SimView
      ↓
    Presentation


# 4. Phase 0 — Establish a Refactoring Baseline

Goal:

Create a known-good baseline before changing architecture.

This phase should not substantially modify game behavior.

## Tasks

    - Record the current commit as the refactoring baseline.
    - Ensure the repository starts clean.
    - Run the complete test suite.
    - Run TypeScript checking.
    - Run the production build.
    - Run worker-mode smoke tests.
    - Run local/in-process simulation tests.
    - Record baseline build time.
    - Record baseline test time.
    - Record baseline bundle size.
    - Record baseline simulation performance.
    - Record baseline worker message size if instrumentation already exists.

## Add simulation diagnostics

Create development-only diagnostics capable of reporting:

    simulation tick
    simulation time
    real elapsed time
    entities
    rovers
    buildings
    active tasks
    pathfinding operations
    command count
    worker messages
    view generation time
    simulation step time

Example:

    ┌─────────────────────────────┐
    │ SIMULATION PROFILER         │
    ├─────────────────────────────┤
    │ Tick:             18,432    │
    │ Sim Time:         3.2 days  │
    │ Step:             1.7 ms    │
    │ View:             0.6 ms    │
    │ Pathfinding:      0.3 ms    │
    │ Entities:             37    │
    │ Commands:              4    │
    └─────────────────────────────┘

This should be development-only.

## Testing gate

The phase is complete only when:

    npm test
    npm run build
    worker smoke tests
    local simulation tests

all pass.

No architectural refactoring should begin until this baseline is green.

## Recorded baseline (Phase 0 complete — 2026-09-16)

Measured on `origin/main` after PR #38 (`e1482d3`), Node 22.22.3, 2 CPU workers.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green — 6.0 s |
| `npm run build` | green — 7.0 s (vite 2.76 s, 58 modules) |
| `npm test` (43 suites / 393 checks) | green — 107.2 s wall clock, 2 workers |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `mobile-smoke` (worker, the default) | green — 21 checks |
| `mobile-smoke` (`?worker=0`, in-process) | green — 21 checks |
| `worker-smoke` on both transports | green — 19 checks each |
| Bundle | `index.js` 989 kB (288 kB gz) · `sim.worker.js` 214 kB · `index.css` 53.7 kB |
| Worker message size | not instrumented yet — see the note below |

**The baseline was not green as found.** 12 of 42 suites (every `hud/*` suite)
failed to even construct a HUD: `WorldMapOverlay`'s constructor threw when
`getContext('2d')` answered `null`, and `tests/fixtures/hud.ts` answered `null`
for every canvas. `HUD.buildChrome()` constructs the overlay unconditionally, so
one unavailable 2D backend deleted the entire HUD — and every assertion built on
it — from the suite. `pages.yml` never runs `npm test`, so CI could not see it.
Fixed as part of Phase 0: the overlay now holds its context optionally and
skips painting when there is none (the same contract `HUD.buildMinimap` already
kept), the fixture provides a recording 2D stub, and `tests/hud/worldmap.test.ts`
pins both halves plus the painting that `null` used to hide.

**Baseline invariants to re-measure after every phase:** the table above, plus
`simulation.step()` cost during `sim/soak` and the `sim.worker` payload sizes.

**Known gap carried forward:** the jsdom stub counts 2D calls; it cannot verify
*pixels*, so a wrong `MapTransform` still passes. Anything that needs to assert
what the map looks like belongs in the browser smokes (Phase 0's
`mobile-smoke`), not in `hud/*`. `scripts/run-tests.mjs` has no worker-message
instrumentation, so Phase 0's "record baseline worker message size if
instrumentation already exists" is deferred to Phase 23, where that
instrumentation is actually specified.


# 5. Phase 1 — Establish Simulation Invariants

Goal:

Make invalid simulation state detectable.

This phase is extremely important because subsequent refactoring will move state between systems.

## Create

    src/sim/debug/SimulationAssertions.ts

Potential checks:

    entity IDs are unique
    rover IDs are unique
    building IDs are unique
    POI IDs are unique

    battery >= 0
    battery <= maximum battery

    cargo >= 0
    cargo <= cargo capacity

    resource quantities >= 0

    storage >= 0
    storage <= capacity

    progress >= 0
    progress <= 1

    valid building references
    valid rover references
    valid task references
    valid reservations
    valid construction references

    no orphaned entities
    no duplicate reservations

## Development behavior

During tests:

    simulation.step()
        ↓
    assertInvariants()

Do not necessarily run expensive assertions in production builds.

## Tests

Create tests that intentionally corrupt state and verify that the invariant system catches it.

Example:

    rover.battery = -1

should fail.

## Gate

    All existing tests pass.
    New invariant tests pass.
    Assertions detect intentional corruption.

## Recorded (Phase 1 complete — 2026-09-16)

Implemented on `arena/01a0a815-red-frontier`.

**What was built**

- `src/sim/debug/SimulationAssertions.ts` — a pure, read-only checker:
  `checkInvariants(sim)` returns `InvariantViolation[]` (stable `code`,
  `subject`, `message`); `assertInvariants(sim, label)` throws an
  `InvariantError` carrying them. Codes: `id-unique`, `time-finite`,
  `rover-battery`, `rover-cargo`, `rover-condition`, `rover-position`,
  `building-progress`, `building-health`, `building-worker-ref`,
  `storage-negative`, `fluid-range`, `grid-battery`, `deposit-amount`,
  `reservation-ref`, `poi-amounts`, `task-deposit-ref`,
  `task-building-ref`, `task-rover-ref`, `task-poi-ref`, `colonist-state`,
  `colonist-shelter-ref`.
- `Simulation.step()` calls the gate after its tick loop when the
  process-wide switch is on: `setInvariantChecks(true)`. The switch defaults
  **off**, so the shipped game, the worker and the browser smokes pay
  nothing; `tests/harness.ts` turns it on once per test process, which means
  *every* suite now asserts invariants after every simulated step.
- `tests/sim/invariants.test.ts` (linked in `full.test.ts`, 20 checks):
  sound-state passes, one corruption test per code, the step-time throw,
  the switch-off behavior, and a same-seed proof that checks are
  observationally inert (identical snapshots with checks on vs off).

**Two documented exceptions** (in the module header and at the checks)

- `storage <= capacity` is *not* enforced: `demolish()` refunds delivered
  materials in full even when that overfills the silo — deliberately.
  Negative storage is still corruption.
- `battery <= maxBatteryKWh` is enforced only above `3× capacity + 10 kWh`:
  a rescue jump-start pays its sized "give" into the stranded rover without
  capping at the pack's nameplate, so a briefly over-full pack is legal sim
  behavior today. If the jump-start ever gains a headroom cap, tighten the
  check to `maxBatteryKWh`.

**What the gate caught on its first run**

`tests/sim/pois.test.ts` parked rovers with `battery = 999` — physically
impossible state the old suite got away with. The fixture now charges a full
pack and tops the battery up *between* steps (`runPowered`), removing energy
as a variable while keeping every checked instant valid. No simulation code
changed for it (Golden Rule 1).

**Gate results** (Node 22.22.3, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green — 10.6 s |
| `npm test` (44 suites / 413 checks) | green — 117.9 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — 7.2 s; `index.js` 989 kB (288 kB gz), unchanged |
| `mobile-smoke` (worker, the default) | green |
| `mobile-smoke` (`?worker=0`, in-process) | green |
| `worker-smoke` on both transports | green |

Full-suite wall time grew ~11 s over the Phase 0 baseline (new suite, plus
per-step checking inside the long soak/pois runs). Deterministic output is
unchanged: same-seed snapshots compare equal with checks on or off.


# 6. Phase 2 — Formalize ColonyState

Goal:

Separate simulation state from simulation behavior.

Create:

    src/sim/state/
        ColonyState.ts
        EntityStore.ts
        ResourceState.ts
        PowerState.ts
        WeatherState.ts
        RoverState.ts
        BuildingState.ts

Do not necessarily split every entity into its own state file immediately.

The important boundary is:

    Simulation
        ↓
    ColonyState

The state should contain data.

Systems should contain behavior.

## Example

Instead of:

    Simulation owns everything

move toward:

    Simulation
       │
       └── state
            ├── world
            ├── rovers
            ├── buildings
            ├── resources
            ├── colonist
            ├── weather
            └── exploration

## Important restriction

Do not introduce:

    Redux
    MobX
    Zustand
    another global state-management framework

The simulation itself already provides state ownership.

## Testing

Add:

    ColonyState creation tests
    state serialization tests
    state initialization tests
    state invariant tests

## Gate

Simulation behavior remains unchanged.

Deterministic tests must produce identical results.


# 7. Phase 3 — Extract Persistence

Goal:

Remove save/load responsibility from `Simulation.ts`.

Create:

    src/sim/persistence/
        SaveSchema.ts
        SaveCodec.ts
        SaveValidator.ts
        SaveMigrations.ts
        migrations/
            v1.ts
            v2.ts
            ...
            v7.ts

Desired flow:

    unknown JSON
        ↓
    SaveCodec
        ↓
    SaveValidator
        ↓
    migration
        ↓
    current SaveSchema
        ↓
    ColonyState
        ↓
    Simulation

The simulation should no longer need to understand historical save versions.

## Replace

    restore(data: any)

with a boundary similar to:

    decodeSave(data: unknown): SaveState

Then:

    simulation.restore(saveState)

## Important

Use `unknown` at the untrusted boundary.

Do not use `any` for save data.

## Tests

For every historical save version:

    load
    migrate
    validate
    restore
    simulate
    save

Verify that the resulting state is valid.

Add malformed-save tests:

    missing version
    unsupported version
    invalid IDs
    invalid resource values
    invalid arrays
    invalid task references
    corrupt weather state

## Regression requirement

Old valid saves must remain loadable.

## Gate

Persistence tests pass.

Historical migrations remain functional.

No gameplay code depends on migration logic.


# 8. Phase 4 — Extract ClockSystem

Goal:

Remove time advancement logic from the central simulation implementation.

Create:

    src/sim/systems/ClockSystem.ts

Responsibilities:

    simulation time
    tick count
    day/night state
    fixed-step timing
    accumulated remainder if applicable

It should not know about:

    Three.js
    DOM
    renderer
    UI

The simulation becomes:

    step(dt)
        ↓
    clock.update()
        ↓
    remaining systems

## Tests

Verify:

    1 second
    10 seconds
    1 minute
    ragged frame timing
    accumulated time

produce identical simulation time.

## Gate

Determinism tests pass.


# 9. Phase 5 — Extract WeatherSystem

Goal:

Move weather behavior into an independent system.

Create:

    src/sim/systems/WeatherSystem.ts

Responsibilities:

    weather progression
    storm generation
    storm duration
    weather effects
    shelter-related effects

Weather should consume:

    state
    time
    weather RNG stream

Weather should not directly manipulate UI.

Instead:

    WeatherSystem
        ↓
    state.weather
        ↓
    AlertSystem / SimView

## Important

Keep the dedicated RNG stream.

Do not combine weather RNG with:

    world RNG
    deposit RNG
    POI RNG
    cargo RNG

## Tests

Test:

    seeded weather
    storm creation
    storm expiration
    weather progression
    weather effects
    deterministic replay

## Gate

Existing weather tests pass unchanged where possible.

## Recorded (Phase 5 complete — 2026-09-16)

Implemented on `arena/01a0ab2e-red-frontier`.

**What was built**

- `src/sim/systems/WeatherSystem.ts` — the weather behavior that lived in
  `Simulation.ts`, moved verbatim behind a state-consuming static API:
  - `WeatherSystem.tick(state, hooks)` (was `Simulation.tickWeather`):
    advances the model, mirrors `state.dustTransmission`, raises/clears the
    `storm-inbound` alert, logs storm arrival/passing via `state.alerts`,
    accrues panel dust per-building from *local* dust, applies wind damage
    per-building from *local* intensity, dispatches lightning.
  - `WeatherSystem.tickLightning`, `lightningAnchors`,
    `resolveLightningStrike(state, hooks, aim)` (were the private
    `Simulation` methods); `devForceLightningStrike` now delegates.
  - `WeatherSystem.restore(state, weatherSave)` — the save wiring that lived
    in `Simulation.restoreFromState` (fresh model from the colony seed,
    legacy-cell acceptance, `lightningMul` difficulty fallback,
    `dustTransmission`/`stormAnnounced` re-derivation). Takes `unknown`:
    schema knowledge stays behind the Phase 3 boundary.
  - `WeatherSystem.afterTimeJump(state)` — the `devSetTime` re-anchor.
- **`WeatherHostHooks`** — the phase's one new seam: `tripDamaged`,
  `disableRover`, `endMission` are effects weather *triggers* but does not
  *own* (failure/rover domain). Simulation implements them against its
  existing private methods, so there is no second source of truth;
  RoverSystem (Phase 10) / FailureSystem (Phase 15) will absorb the
  implementor, not the contract. Dependency direction is unchanged:
  Simulation → WeatherSystem → ColonyState/Weather model.
- The `Weather` model (`sim/weather.ts`) is untouched — progression, storm
  scheduling, readings, snapshot/restore and the **dedicated RNG streams**
  (scheduler `rngState` + separate `lightningRngState`) stay exactly where
  they are; the roadmap's "do not combine streams" rule is now pinned by
  tests rather than by convention.
- `src/sim/state/WeatherState.ts` — the Phase 2 placeholder became the real
  weather-state factory; `ColonyState.createColonyState` now calls
  `createWeatherState` instead of duplicating the construction.
- `tests/sim/weather-system.test.ts` (14 checks, linked in `full.test.ts`):
  storm creation/expiry through the system tick, `dustTransmission`
  mirroring, panel-dust accrual + floor clamp, wind damage tripping a
  structure through the hooks, exact-bolt anchoring/damage, the hooks
  contract driven against a recorder (trip / mission end / rover disable),
  RNG-stream separation (model- and sim-level), `createWeatherState`
  seeding, restore wiring incl. the `lightningMul` fallback, time-jump
  re-anchoring, and deterministic replay (same-seed hash equality +
  restored-weather equality).

**Behavior preservation evidence**

A scripted weather-heavy scenario (forced regional + severe storms, 3 solar
arrays taking dust and wind damage, rolled + exact-aim lightning, mid-storm
save/restore) was hashed at six checkpoints with `StateHash` before the
extraction and re-run after: **byte-identical output**, including both RNG
streams and every storm cell. The existing `sim/weather`, `sim/storms`,
`sim/determinism`, `sim/soak` and `sim/persistence` suites pass unchanged.

**Discovered pre-existing quirk (documented, deliberately not fixed here)**

`Weather.snapshot()` returns its **live** `active`/`scheduled` arrays and
storm-cell objects. Any code that holds a `Simulation.snapshot()` and lets
the source sim keep ticking mutates the "save"; restoring it into a second
sim in-process makes both weathers drive the same cells (positions and
serpentines advance twice per tick-pair, and the two colonies' skies
diverge). The shipped paths are safe — `JSON.stringify` (localStorage) and
`postMessage` (worker) both deep-clone — but direct in-process
`a.restore(b.snapshot())` aliases. Golden Rule 1 says Phase 5 does not
change it; the new suite deep-clones (`structuredClone`) its saves and the
quirk is recorded in `mnemosyne.md`. A future phase touching the weather
model (or Phase 20's SimView work) should make `snapshot()` return copies.

**Gate results** (Node 22.22.3, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (50 suites / 497 checks; was 49/483) | green — ~150 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 996.7 kB (290 kB gz), `sim.worker` 221.7 kB, both unchanged |
| pre/post extraction hash baseline | identical at all six checkpoints |
| `mobile-smoke` (worker, the default) | green |
| `mobile-smoke` (`?worker=0`, in-process) | green |
| `worker-smoke` on both transports | green |



# 10. Phase 6 — Formalize PowerSystem

Goal:

Turn the existing power architecture into the model for other systems.

The existing power implementation is already close to the desired architecture.

Do not radically redesign it.

Instead, formalize:

    input
        ↓
    resolver
        ↓
    output/state changes

Create a clean interface:

    PowerSystem.update(context)

or:

    resolvePower(state)

Keep power deterministic.

## Tests

Include:

    generation
    batteries
    consumers
    priority allocation
    shortages
    charging
    production dependency
    storm effects
    building availability

## Performance

Power calculations should avoid unnecessary allocations inside the simulation tick.

## Gate

All existing power tests pass.

Determinism remains unchanged.

## Recorded (Phase 6 complete — 2026-09-16)

Implemented on `arena/01a0ab2e-red-frontier`.

**What was built**

- `src/sim/systems/PowerSystem.ts` — the grid pipeline that lived in
  `Simulation.tickPower`, moved verbatim behind a state-consuming static API
  with the roadmap's input → resolver → output shape called out in stage
  comments:
  - `PowerSystem.tick(state, ctx)` — input: generation (pod RTG + per-building
    solar `irradiance × dustTransmission × cleanliness` or RTG) and demand
    (tier-0 pod life support, per-building process load from wanted
    throughput, tier-3 rover charging); resolver: the untouched
    `resolvePower`; output: `state.power`/`state.storedKWh`, per-building
    `genKw`/`loadKw`/`throughput`/`powerSat`/`idleReason`, per-rover
    `chargeSat` + battery charge.
  - `PowerSystem.restore(state, storedKWh | undefined)` — the save wiring
    (clamp to the restored capacity, park an `idlePower` result until the
    next tick).
  - `PowerSystem.nearCharger(state, x, z)` / `chargeRateKwAt(state, x, z)` —
    the charger map, moved not duplicated; `Simulation` delegates so there is
    a single source of truth for UI and rover AI alike.
- **`PowerSystemContext`** — the phase's one new seam:
  `desiredThroughput(b)`, `runProcess(b, throughput, hours)`,
  `processBlockReason(b)` are *production* questions (Phase 8). Simulation
  implements them against its existing private methods (the same shape as
  Phase 5's `WeatherHostHooks`); ProductionSystem will absorb the
  implementor, not the contract.
- `src/sim/state/PowerState.ts` — the Phase 2 placeholder became the
  power-state owner: `initialPowerState()` (was inline in `ColonyState`) and
  `batteryCapacityKWh(state)` (was `Simulation.batteryCapacity`'s body);
  `Simulation.batteryCapacity()` now delegates.
- `Simulation.tickPower` deleted (~110 lines); `tickGarages` (service +
  assembly + spawn, which *consume* `powerSat` rather than resolving it)
  deliberately stays until its owning phase — noted in the PowerSystem
  header and at the call site.
- `src/sim/power.ts` — the pure resolver is **untouched**, by design.
- `tests/sim/power-system.test.ts` (13 checks, linked in `full.test.ts`):
  solar-vs-RTG generation (sun × dust × cleanliness, exact noon plate
  rating, midnight RTG-only), storm-grade sky, `batteryCapacityKWh`
  gating (online/enabled/undamaged), exact charge-by-day/drain-by-night
  energy arithmetic, shortage tier-shedding through the live system (life
  support sacred, tier 1 thinned, charging shed first, `firstShedTier`,
  flat pack stays flat), even within-tier degradation, rover charging
  (tier-3, pod base rate, garage fast-charge, distance-honest map), the
  production context seam (want scales load, `runProcess` gets want ×
  satisfaction, `processBlockReason` only consulted when power is fine,
  "No power" wins during a brownout), building availability (switched off /
  damaged / under-construction idle reasons, generation gating), restore
  clamping, a save/restore round trip through the real wiring, and
  two-same-seed determinism at noon and night checkpoints.

**Performance note (roadmap §10)**

The per-tick `PowerResult` stored on `state.power` is the deliberate
exception to "no unnecessary allocations in the tick" — the view projects
it, so it is necessary. The tick-local demand array and desired-throughput
map remain the only scratch allocations, exactly as before extraction.

**Behavior preservation evidence**

A scripted power-heavy scenario (noon/night, brownout with a flat pack,
severe-storm dust collapse, availability loss through damage/disabled,
save/restore) was hashed at eight checkpoints with `StateHash` before the
extraction and re-run after: **byte-identical output**. The existing
`sim/power`, `sim/grid`, `sim/determinism`, `sim/soak`, `sim/persistence`
and `sim/life-support` suites pass unchanged.

**Gate results** (Node 22.22.3, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (51 suites / 511 checks; was 50/498) | green — ~123 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 997.2 kB (290 kB gz), `sim.worker` 222.1 kB |
| pre/post extraction hash baseline | identical at all eight checkpoints |
| `worker-smoke` (`?worker=1`) | green |
| `worker-smoke` (`?worker=0`, in-process) | green |
| `mobile-smoke` | green |
| `update-check-smoke` | green |


# 11. Phase 7 — Extract LifeSupportSystem

Goal:

Separate colonist survival mechanics from the main simulation.

Create:

    src/sim/systems/LifeSupportSystem.ts

Responsibilities:

    oxygen consumption
    water consumption
    food consumption
    life-support capacity
    environmental effects
    survival conditions
    related health/survival consequences

Input:

    state
    power results
    weather state
    elapsed simulation time

Output:

    state modifications
    events/results
    potential failure condition

Avoid direct UI interaction.

## Tests

Test:

    normal consumption
    depleted oxygen
    depleted water
    depleted food
    power loss
    weather effects
    recovery
    game-over conditions

## Gate

No life-support logic remains in `Simulation.ts` except orchestration.

## Recorded (Phase 7 complete — 2026-09-16)

Implemented on `arena/01a0abe2-red-frontier`.

**What was built**

- `src/sim/systems/LifeSupportSystem.ts` — the survival pipeline that lived in
  `Simulation.ts`, moved verbatim behind a state-consuming static API with the
  same input → resolver → output shape as PowerSystem:
  - `LifeSupportSystem.tick(state, hooks)` (was `Simulation.tickLifeSupport`):
    shelter occupancy (`hypot ≤ radius + 1.5`), EVA enter/exit log (suit
    minutes use the literal `24.66`), `applyColonistNeeds`, flow accounting,
    death → `hooks.endMission`. Does **not** consult `state.power` — a
    brownout still consumes, which is current behaviour.
  - `LifeSupportSystem.tickColonist(state, hooks)` (was
    `tickColonistMovement`): suit-critical abort (25 %), storm recall via
    `blocksEVAAt`, walk/assist locomotion, assist → `hooks.completeBuilding`.
  - `LifeSupportSystem.order(state, order)` (was `orderColonist`): suit-reach
    refusal (`0.45 ×` round-trip) and storm EVA refusal.
  - `LifeSupportSystem.shelters` / `nearestShelter` — the pressurised-volume
    map (pod id 0); `Simulation.shelters()` delegates.
  - `LifeSupportSystem.restore(state, fluids, colonistSave)` — fluid clamp +
    colonist rebuild. Takes `unknown`: schema knowledge stays behind the
    Phase 3 boundary.
- **`LifeSupportHostHooks`** — the phase's one new seam: `endMission` (failure
  domain, Phase 15) and `completeBuilding` (construction domain, Phase 9).
  Simulation implements them against its existing private methods, so there
  is no second source of truth. Same shape as `WeatherHostHooks` /
  `PowerSystemContext`.
- `src/sim/lifesupport.ts` — the pure needs resolver (`applyColonistNeeds`,
  `makeColonist`) is **untouched**, by design.
- Alerts that *report* life-support state (low O₂, colonist health) stay in
  `evaluateAlerts` until AlertSystem (Phase 16) extracts them.
- `tests/sim/life-support-system.test.ts` (15 checks, linked in
  `full.test.ts`): exact per-sol draw, Survivor `consumptionMul`, depleted
  O₂/water/food ladder, EVA burns the suit not the tanks, brownout still
  consumes, `HEALTH_REGEN` recovery, habitat water reclaim, EVA range and
  storm refusal/recall, critical-suit abort, death through the hooks seam
  (system does not latch `gameOver` itself), assist → `completeBuilding`
  through the hooks, restore clamping, save/restore round trip, two-same-seed
  determinism.

**Behavior preservation evidence**

A scripted life-support scenario (one sol, EVA out/back, depleted oxygen,
habitat+extractor+oxygenator+greenhouse chain, storm EVA recall, mid-EVA
save/restore, critical-suit abort) was hashed at nine checkpoints with
`StateHash` before the extraction and re-run after: **byte-identical output**.
The existing `sim/life-support`, `sim/determinism`, `sim/soak` and
`sim/persistence` suites pass unchanged.

**Gate results** (Node 22, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (52 suites / 526 checks; was 51/511) | green — 155.0 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 997.8 kB (290 kB gz), `sim.worker` 222.7 kB |
| pre/post extraction hash baseline | identical at all nine checkpoints |

# 12. Phase 8 — Extract ProductionSystem

Goal:

Separate resource production from buildings and simulation orchestration.

Create:

    src/sim/systems/ProductionSystem.ts

Responsibilities:

    building production
    input consumption
    output generation
    production progress
    power-dependent production
    production failures

Represent processes declaratively where possible.

Example:

    ProcessDefinition
        inputs
        outputs
        power
        duration
        conditions

The system should consume definitions instead of hardcoding every building.

## Long-term goal

Adding a production building should ideally require:

    definition
    assets
    UI metadata

and not substantial changes to `Simulation.ts`.

## Tests

Test:

    production progress
    missing inputs
    power shortage
    output storage full
    production completion
    multiple simultaneous processes

## Gate

Production is independent from Simulation orchestration.

## Recorded (Phase 8 complete — 2026-09-16)

Implemented on `arena/01a0abe2-red-frontier`.

**What was built**

- `src/sim/systems/ProductionSystem.ts` — the three production-domain answers
  that lived on Simulation, moved verbatim behind a state-consuming static API:
  - `desiredThroughput(state, b)` — how hard a process wants to run (0..1)
    from solids, fluids, tank headroom and (for greenhouses) light. Power is
    applied later by PowerSystem.
  - `processBlockReason(state, b)` — why a powered process is still idle
    (damaged, out of an input, tanks full, waiting for daylight).
  - `runProcess(state, b, rate, hours)` — move the mass; upgrade levels
    multiply conversion; fluid flows are accounted.
- **`PowerSystemContext` is unchanged.** Phase 6 left the implementor on
  Simulation; this phase absorbs it. Simulation only wires:
  `ProductionSystem.desiredThroughput(this.state, b)` (and the two siblings)
  into the existing context object. PowerSystem still owns *when* a process
  runs (satisfaction × want) and *whether* the domain is asked why it is idle
  ("No power" wins a brownout).
- Processes stay declarative (`BuildingDef.process` in `sim/defs.ts`). Adding
  a conversion building still does not require Simulation.ts changes for the
  conversion itself.
- `tickGarages` (service + assembly) stays in Simulation — it consumes
  `powerSat` rather than converting mass.
- `tests/sim/production-system.test.ts` (12 checks, linked in `full.test.ts`):
  stocked want=1, missing ice, full tanks, partial-silo scaling, stalled vs
  completed tick, plate-rate ice→water, oxygenator + light-gated greenhouse
  (15% crawl at night), developer upgrade multiplier, night brownout
  (throughput = want × sat), two lines in one tick, idle reasons through the
  live PowerSystem wiring, two-same-seed determinism.

**Behavior preservation evidence**

A scripted production scenario (extractor at noon, ice→water→oxygen chain,
greenhouse food, no-ice stall, tanks-full stall, night brownout, level-3
upgrade, mid-run save/restore, night crop crawl) was hashed at ten
checkpoints with `StateHash` before the extraction and re-run after:
**byte-identical output**. The existing `sim/power-system`, `sim/grid`,
`sim/life-support`, `sim/determinism`, `sim/soak` and `sim/persistence`
suites pass unchanged.

**Gate results** (Node 22, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (53 suites / 538 checks; was 52/526) | green — 146.7 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 997.8 kB (290 kB gz), `sim.worker` 222.7 kB |
| pre/post extraction hash baseline | identical at all ten checkpoints |

# 13. Phase 9 — Extract ConstructionSystem

Goal:

Separate construction rules and progress from the main simulation.

Create:

    src/sim/systems/ConstructionSystem.ts

Responsibilities:

    construction jobs
    build progress
    resource reservation
    material consumption
    completion
    cancellation
    construction validity

Important distinction:

    ConstructionSystem
        = simulation rules

    BuildController
        = player interaction

The UI may request:

    building/place

but only the simulation decides whether placement is valid.

## Preserve

The existing siting authority.

Do not move:

    slope checks
    terrain checks
    collision checks
    build validity

into the UI.

## Tests

Test:

    valid placement
    invalid placement
    construction progress
    insufficient resources
    cancellation
    completion
    overlapping construction
    worker assignment

## Gate

Build ghost and actual placement continue to agree.

## Recorded (Phase 9 complete — 2026-09-16)

Implemented on `arena/01a0ac32-red-frontier`.

**What was built**

- `src/sim/systems/ConstructionSystem.ts` — the construction job, moved
  verbatim from Simulation behind a state-consuming static API:
  - `verdict(state, kind, x, z)` — the siting authority. Delegates to the
    *existing* `evaluateSite` in `sim/rules.ts` with the live world, buildings
    and deposits. The rule was not copied, moved or rewritten.
  - `place` / `devSpawn` — site a building (hungry, full cost outstanding) or
    fab a finished one. Both now share one `newBuilding` factory, which
    removes the second near-identical `Building` literal that used to sit in
    `devSpawnBuilding`.
  - `tickSiteMaterials(state)` — was `Simulation.tickSiteLogistics`. Pours
    available storage into every unfinished site and keeps the `mats-<id>`
    alert honest. The old name said "logistics"; the body was always about a
    site's material ledger, which is this phase's.
  - `commitAvailableMaterials` / `hasMaterials` / `consumeMaterials` /
    `missingList` — the material ledger, now with **one owner**. Garage rover
    assembly (`Simulation.assembleRover`) spends through the same three calls
    rather than keeping private copies, which is what §17's "resource
    accounting must have one authoritative owner" asks for.
  - `assignBuilders(state, hooks)` — worker choice: nearest capable rover,
    stable sort (distance, then id), auto task, one `workerId` per site.
  - `build(state, r, b, hooks)` — was `doBuild`. Walk-to-site, assemble,
    workshop assist, weather throttle, battery/condition wear, completion.
  - `complete` / `devComplete` — switch a structure on, drop the crew,
    recompute capacities, log the "+kg per silo / +kWh / +kW peak" extras.
  - `demolish(state, id, hooks)` — cancellation refunds and dismantling.
- `ConstructionHostHooks` is the **fourth instance of the host-hooks pattern**
  (`WeatherHostHooks`, `PowerSystemContext`, `LifeSupportHostHooks`):
  `setTravel` / `finishTask` / `autoAssign` / `disableRover` / `roverWorkMul`
  are RoverSystem's (Phase 10), `canDeliverCargo` is LogisticsSystem's
  (Phase 13). Simulation implements them against its existing private methods,
  so no rule was copied into the seam. Capacity recompute is *not* a hook —
  `recomputeCapacitiesState` is already a pure state function.
- **Phase 7's `completeBuilding` hook now points here.** The
  `LifeSupportHostHooks.completeBuilding` *contract* is unchanged (its suite
  still drives it with a stub); only the implementor moved, as Phase 7 said it
  would. A colonist assisting to progress 1 still brings a site online, and
  `tests/sim/construction-system.test.ts` pins that through the live wiring.
- `tickGarages` and `assembleRover` stay in Simulation. The garage *spends*
  through the material ledger but its assembly line consumes `powerSat` and
  produces rovers — Phase 6 and Phase 8 both left it there deliberately, and
  it is not a construction site.
- Simulation's public surface is unchanged: `canPlace`, `placeVerdict`,
  `placeBuilding`, `demolish`, `devSpawnBuilding`, `devCompleteBuilding` are
  now thin delegates. Hosts, `applyCommand`, `Transcript`, `DevMode` and every
  existing test call the same methods with the same signatures.
- **Deleted from `Simulation.ts`:** `tickSiteLogistics`, `assignBuilders`,
  `doBuild`, `completeBuilding`, `commitAvailableMaterials`, `hasMaterials`,
  `consumeMaterials`, `missingList`, and the two inline `Building` literals
  (~260 lines). The file is 3,314 lines, from 3,572.
- `tests/sim/construction-system.test.ts` (29 checks, linked in `full.test.ts`):
  legal/illegal siting with the exact refusal strings, **the build ghost
  (`ColonyMirror.canPlace`) agreeing with the sim's verdict across every
  building kind × six sites, and `place` obeying that verdict** (the phase
  gate, checked in-process rather than only in the browser), a fresh site
  making its own spot illegal, hungry/partial/stocked material commits and the
  alert lifecycle, the ledger the garage shares, worker choice (nearest
  capable, player orders never stolen, recharging skipped, cargo rovers
  refused, wanderers and disabled rovers released), overlapping sites,
  progress arithmetic (`buildPower × SIM_TICK ÷ buildTime`), the workshop's
  ×1.35 and the storm's ×0.6 as *measured differentials*, battery and
  condition wear, a flat battery stranding through the hook, completion +
  capacity growth + idempotence, cancellation refunds, the dev shortcuts, the
  live tick end to end, save/restore mid-build, and two-same-seed determinism.

**Behavior preservation evidence**

A scripted construction scenario was hashed at **48 checkpoints** with
`StateHash` before the extraction and re-run after: **byte-identical output**.
Checkpoints covered siting verdicts, the full site→materials→crew→online
lifecycle with a tick-by-tick progress trace, overlapping construction,
cancellation refunds and rover release, colonist assist (traced), a
**workshop differential** (same seed with and without a workshop: the trace
pins 0.003600 → 0.004860 progress per sample, i.e. exactly ×1.35), a **storm
ramp differential** and a **peaked-storm differential** (0.013200 → 0.007920,
i.e. exactly ×0.6), live vs restored mid-build, the three developer
shortcuts, and a 7.5-sol soak over a five-building queue.

The trace-based checkpoints are the point: hashing only the endpoints would
not have caught a changed assembly *rate*.

**Two pre-existing quirks, characterized and deliberately NOT fixed**

Golden Rule 1 forbids behavior changes inside an extraction, so both are now
pinned by tests and recorded here for a later phase to decide on:

1. **One rover can be claimed by two sites, and the later site wins.**
   Sites are staffed in placement order and an *auto* task is stealable, so
   when the same rover is nearest to both, the second site takes it and the
   first keeps a **stale `workerId`** that only clears when the second site
   finishes. With the two-rover starting fleet and two nearby sites, the
   earlier site does no work at all until the later one is online, and the
   spare rover never gets dispatched. Pinned by `overlapping sites: one rover
   claimed twice builds the later site first`. This is the construction-side
   twin of the reservation quirk Phase 1 recorded; the fix (claim a worker
   exclusively, or prefer an unclaimed rover) is a scheduling decision for
   RoverSystem (Phase 10) / FleetAutomationSystem (Phase 12).
2. **A refund into an already-full silo is silently lost.** `demolish`'s
   comment promises "refund the full amount even if it overfills the silo",
   and `SimulationAssertions` deliberately permits over-capacity storage on
   that basis — but the capacity recompute at the *end* of the same method
   clamps storage straight back to capacity. The refund is only paid in full
   when the silo has room (the ordinary case). Either the clamp should skip
   refunded mass or the comment and the invariant note should stop promising
   it; that is a behavior change, so it is recorded rather than made. Pinned
   by `a refund lands in full when the silo has room, and is clamped when it
   does not`.

**Gate results** (Node 22.22.3, 2 CPU workers)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (54 suites / 567 checks; was 53/538) | green — 133.2 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 998.3 kB (291.0 kB gz), `sim.worker` 223.2 kB |
| pre/post extraction hash baseline | identical at all 48 checkpoints |
| `mobile-smoke` | green |
| `worker-smoke` (`?worker=1`) | green — incl. ghost/placement agreement |
| `worker-smoke` (`?worker=0`) | green — incl. ghost/placement agreement |
| `update-check-smoke` | green |

Phase 9's gate ("build ghost and actual placement continue to agree") is
asserted twice: in-process across every building kind in the new suite, and in
a real browser on both transports by `worker-smoke`.

The next extraction per roadmap §51 is **Phase 10 — RoverSystem**, listed in
§52 as the highest-risk phase and the largest. It should absorb the five
rover-side hooks this phase introduced.


# 14. Phase 10 — Extract RoverSystem

Goal:

This is likely the largest and most valuable extraction.

Create:

    src/sim/systems/RoverSystem.ts

Initially move behavior without changing its design.

Responsibilities:

    rover state updates
    movement execution
    battery consumption
    condition/wear
    charging
    mining
    repair
    cleaning
    salvage
    cargo
    depot interactions
    task execution

Do not immediately redesign rover behavior.

First:

    extract
    test
    stabilize

Only afterward:

    simplify
    redesign

This is critical.

## Tests

Every rover operation should have isolated tests:

    move
    stop
    mine
    unload
    charge
    repair
    clean
    construct
    salvage
    rescue
    disable
    recover

## Determinism tests

Run identical:

    seed
    commands
    elapsed time

against:

    old implementation
    refactored implementation

where possible during the transition.

## Gate

No renderer or UI code should be required by RoverSystem.

## Recorded (Phase 10 complete — 2026-09-18)

Implemented on `arena/01a0b437-red-frontier`.

**What was built**

- `src/sim/systems/RoverSystem.ts` (1,548 lines) — the fleet's behavior, moved
  verbatim from `Simulation` behind a state-consuming static API (51 statics):
  - **Commands**, one per `rover/*` SimCommand: `issueMove` / `issueMine` /
    `issueUnload` / `issueWait` / `issueConstruct` / `stopRover` /
    `setRepeatRoute` / `setRoverRule` / `setChargeFloor` / `setRoverLights` /
    `issueRecover` / `issueClean` / `issueRepair` / `issueSalvage` /
    `dispatchMaintenance`. Every one is still reachable as a `Simulation.*`
    thin delegate, so `applyCommand`, the HUD, `Transcript` and every existing
    test call exactly what they called before.
  - **Task lifecycle**: `giveTask` / `autoAssign` / `finishTask` and the
    deposit reservations (`claimDeposit` / `releaseDeposit` /
    `releaseReservations` / `rescueTargeted`).
  - **Execution**: `updateRover` (storm recall → seal wear → ride-home floor →
    command switch) and `moveRover` (path stepping, proximity crawl, pack and
    condition burn, flat-battery strand), the task bodies (`doMoveTo` /
    `goIdle` / `doRecharge` / `unloadWhileCharging` / `doMine` / `beginUnload`
    / `tryUnload` / `doService` / `doSalvage` / `recoverSiteCells` /
    `doRecover` / `doUnload`), the movement helpers (`setTravel` and its
    keep-the-in-flight-path guard, `onArrive`, `inColonyYard`,
    `nearestObstacleClearance`, `proximitySpeedMul`, `disable`, `lerpAngle`,
    `ARRIVE_EPS`) and the energy queries (`travelKWh` / `chargeRateKwAt` /
    `nearestChargerPoint` / `roverWorkMul` / `nearDepot` / `nearCharger` /
    `lightsNeeded` / `tickLights`).
  - `spawn(state, kind, x, z, heading)` — the one rover factory, now used by
    the garage assembly line, `assembleRover` and `devSpawnRover`.
- `RoverHostHooks` is the **fifth instance of the host-hooks pattern**:
  `constructSite` is ConstructionSystem's (Phase 9) and `canDeliverCargo` is
  LogisticsSystem's (Phase 13). Simulation implements both against the
  machinery it already has, so no rule crossed the seam.
- **Phase 9's rover-side implementors are absorbed.** The
  `ConstructionHostHooks` five (`setTravel` / `finishTask` / `autoAssign` /
  `disableRover` / `roverWorkMul`) and `WeatherHostHooks.disableRover` now
  call RoverSystem statics. The *contracts* are unchanged, so the Phase 8/9
  suites that stub them still pass; `constructionHooks` itself stays in
  Simulation as the wiring. The Phase 9 double-claim quirk is unchanged, still
  pinned, and still Phase 12's decision.
- **What deliberately stayed in Simulation**: `assignMaintenance` /
  `assignRescues` / `assignSupplyRuns` (scheduler policy → Phase 12
  FleetAutomationSystem), `canDeliverAny` (the haul question → Phase 13),
  `tickGarages` / `servicingRover` / `maintenancePending` / `assembleRover`
  (the garage line consumes power and produces rovers; it is not rover
  behavior), the dev backdoors, and snapshot/restore. Nothing was redesigned:
  this phase is the move. Phase 11 is where rover *state* gets simplified.
- **Deleted from Simulation.ts** (~1,250 lines): the rover behavior above, the
  constants and helpers that became RoverSystem-private (the `ROVER_*` family,
  `RECOVER_TRANSFER_KW`, `ROUTE_RESUME_ROOM_KG`, `LIGHTS_AUTO_*`, the `STORM_*`
  work multipliers, `takeSalvage` / `salvageRateKgS`, `emptyFluids`,
  `mulberry32`, `PowerTier`, `RoverCommand`, `RoverRules`, `ARRIVE_EPS`,
  `lerpAngle`), and two dead privates that only rover code had called
  (`spawnStart`, `allocId` — the starters come from `createColonyState` since
  Phase 2 and `spawn` allocates ids). The file is 2,082 lines, from 3,328.
- **Two pre-existing dead accessors left alone and logged here instead**:
  `Simulation.stormAnnounced` and `Simulation.remainder` are unused private
  getter/setter pairs — `WeatherSystem` and `ClockSystem` mutate
  `state.stormAnnounced` / `state.remainder` directly. They predate this phase
  and are not rover code, so Golden Rule 2 keeps them out of this diff (a
  cleanup phase can take them; `--noUnusedLocals` reports 27 such hits
  repository-wide, none of them gate the build today).
- `tests/sim/rover-system.test.ts` (24 checks, linked in `full.test.ts`):
  the queue/reservation rules (a shift order queues, a plain order replaces,
  automation only fills idle time, a player order bumps an auto run off the
  seam, `finishTask` promotion and the cargo-keeps-auto flag, `stopRover`
  releasing the claim); movement maths against measured steps (cruise speed,
  `movePowerKw × hours`, wear per second, the proximity crawl in the open and
  the slower colony-yard crawl, a flat pack stranding mid-drive and releasing
  its seam); the ride-home floor turning a parked rover for the pad; storm
  recall preserving the orders underneath and releasing them when the sky
  clears; position lights at night billed to the pack; one isolated check per
  task body (mine at the plate rate + claim + wear, the auto run's
  silo-appetite target, the stuck-route pause and resume, unload with a
  blocked hold warning, clean and repair at their plate rates, construct
  handing off through the hook and clearing a stale worker, salvage's
  full-hold-before-distance guard and a stripped site's cells landing in the
  grid store, jump-start energy conservation, and the "can't spare enough
  charge" refusal); and two-same-seed determinism.

**Behavior preservation evidence**

A scripted rover scenario was hashed **before** the extraction and re-run
after: **byte-identical output** at **36 StateHash checkpoints plus 38
per-tick sampled traces** (84 lines total), across two seeds. Checkpoints kept
the whole roster moving — fresh, a long move, a queued order, mining a seam
with the hold filling, a repeating haul route, the ride-home floor and
return-to-charge, two rovers in each other's proximity bubble, storm recall
with the shelter rule on, a daredevil rover keeping the shelter rule off,
storm clearance, cleaning, repair, salvage, a stranded rover, an issued
recovery, night lights — and then a `structuredClone` snapshot restored into a
second simulation, whose 600 ticks had to match the first (they do), plus a
seed-912 determinism pair (2,400 ticks, equal hashes).

The traces are the point, exactly as in Phase 9: each is an FNV-1a hash of a
per-rover sample every 4 ticks (position, heading, battery, condition, phase,
goal, nav index, recharge, sheltered, route paused, lights, cargo), so a
changed *rate* — driving speed, wear per second, dig rate — moves the trace
even when an endpoint hash happens to land on the same value.

One recipe is worth keeping: stranding a rover for the recovery lane needs
`stopRover` on both machines, a real drive away from the chargers, and a
battery set **below a tick of driving**. Setting a near-zero battery on a
rover that is still beside the pad does not strand it — the ride-home floor
re-enters recharge and the machine recovers itself.

**Gate results** (Node 22.22.3)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (59 suites / 645 checks; was 58/621) | green — 184.8 s wall clock |
| `npm run test:check` | green — 59 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,045.64 kB (304.76 kB gz), `sim.worker` 226.73 kB (was 1,044.18 / 304.49 and 225.38) |
| pre/post extraction hash baseline | identical — 36 checkpoints + 38 sampled traces per seed pair |
| `mobile-smoke` | green |
| `worker-smoke` (`?worker=1`) | green |
| `worker-smoke` (`?worker=0`) | green |
| `update-check-smoke` | green |

Phase 10's gate holds by construction: the new file imports only
`../state/*`, `../World`, `../defs`, `../pois`, `../alerts` (type),
`../config`, `./PowerSystem` and `../../lib/rng` — no DOM, no three.js, no
`app/`, no `ui/`, and `Simulation`'s public rover surface is unchanged for
every existing caller.

The next phase per §51 is **Phase 11 — Simplify Rover State**, which is the
first phase allowed to *change* rover behavior; §14's move-first rule ends
there.


# 15. Phase 11 — Simplify Rover State

Goal:

Reduce overlapping rover state representations.

Current conceptual layers include:

    command
    goal
    phase

Do not remove these immediately.

First document their semantics.

Create a state transition table:

    Current State
    +
    Command
    +
    Conditions
    =
    Next State

Example:

    IDLE
      │
      ├── move command ──► MOVING
      │
      ├── mine command ──► WORKING
      │
      └── charge command ► CHARGING

Then determine whether:

    command
    goal
    phase

are actually separate concepts.

Desired architecture:

    Task
       =
    what the rover should do

    ExecutionState
       =
    how the rover is currently executing it

For example:

    Task:
        Mine deposit #42

    ExecutionState:
        MOVING

This is preferable to encoding both concepts in one state variable.

## Important

Do not perform this redesign until RoverSystem extraction is complete.

Otherwise the extraction and behavioral redesign become impossible to debug independently.


## Recorded (Phase 11 complete — 2026-09-18)

Implemented on `arena/01a0b437-red-frontier`.

**Document first** — the deliverable §15 asks for before any redesign:
`docs/design/ROVER-STATE.md`. It states the four layers (Task = `command` +
`pending`, persisted and hashed; execution state = `goal` + `phase`,
runtime-only and rebuilt on restore; conditions/progress; presentation), the
legal `(goal, phase)` table, the full transition table
(CurrentState + Command + Conditions = NextState), the separability verdict with
its migration plan, and the quirks that were characterized rather than fixed.
`tests/sim/rover-state.test.ts` (27 checks) and `checkRoverExecution()` in
`SimulationAssertions.ts` are its executable form: "where this document and the
code disagree, the code is wrong (or the document is stale) — fix one of them in
the same change".

**Verdict on the three fields** — two layers plus a projection, not three
concepts:

- `command` (+ `pending`) is the *Task*: persisted in `RoverSave`, hashed,
  issued by the `issue*`/`set*` verbs or `autoAssign`. `goal` is the *execution
  step*: which part of the task the rover is in right now. `phase` is a
  **projection of the step** that the power grid, the renderer and the HUD ask
  about (`phase === 'charging' || goal === 'charge'`; `phase === 'disabled'`;
  wording through `roverStatusText`).
- `goal` is doing double duty: the task family (`mine`, `build`, `service`,
  `salvage`, `recover`) *and* the travel/arrived progress within it (`toX` vs
  `x`). That overlap is the thing §15 is pointing at. The target model is:

      Task           = command (+ pending)        — what to do
      ExecutionState = { phase, step }            — how far along, and where

- **The split is right but premature.** It touches the hash format (which folds
  `goal`/`phase`), `PowerSystem`'s charging reader, `ConstructionSystem`'s
  travel guard, the renderer and the dev overlays — and Phases 12/13 rewrite the
  schedulers that assign those tasks, so re-doing the split afterwards is
  cheaper than rebasing it through them. The migration plan (rename `goal` →
  `execution.step`; derive `phase`; freeze a new baseline *with the split*; only
  then let Phase 12 change behavior) is design doc §7. §15's own precondition
  ("do not perform this redesign until RoverSystem extraction is complete") is
  satisfied; the deferral is scheduling, not doubt.

**What changed in code** — all of it inside the execution-state layer:

1. Deleted `Rover.statusText`. Nothing read it: the HUD calls
   `roverStatusText(r)`, `StateHash` excludes wording, and saves never carried
   it — a write-only field that could go stale after `finishTask` (it kept
   saying "Building" after the task released).
2. Deleted the unreachable `'unload'` goal from `RoverGoal` (`unload` is a
   *task*; no code path ever assigned the goal) and its `roverStatusText` case.
3. `goal`/`phase` now enter through named transitions in
   `src/sim/state/RoverState.ts`: `enterTravel(r, goal)`, `enterWork(r, goal)`,
   `enterCharge(r)`, `enterIdle(r)`, `enterDisabled(r)`. Every hand-written pair
   in `RoverSystem`, `ConstructionSystem` and `host/overlays.ts` was replaced.
   The single-field writes that remain are deliberate and commented:
   `moveRover`'s transient `phase='working'` immediately before `onArrive`,
   `goIdle`'s pad top-up (an idle rover with no charge task, `(idle, charging)`),
   and `rehydrate`'s charger check.
4. Restore-time rehydration moved out of `Simulation.restore` into
   `RoverSystem.rehydrate(state)`, next to the tick rules it must agree with: a
   save carries the *task*, never `goal`/`phase`, so a restored rover resumes at
   rest except for the one rule already true before the first tick (a partially
   charged rover parked on a charger comes back `charging`).
5. `checkRoverExecution()` runs with the other invariants: every
   `(goal, phase, command)` triple must be in the table. It caught two on its
   first run — `onArrive`'s defensive "the site is gone" branch left
   `phase='working'` behind a `goal='idle'` (unreachable today because
   `demolish` releases crews; now `enterIdle`), and a construction-suite fixture
   stranded a rover by hand-writing `phase` instead of `RoverSystem.disable`.
6. `tests/sim/rover-state.test.ts` pins the table end to end: every task's entry
   state, the travel→work arrivals, the ride-home floor and storm recall
   preempting a task *without losing it*, the wording table (now wording's only
   producer), rehydration, the violation codes, and the quirks below. Linked in
   `tests/full.test.ts`; the runner is at 60 suites / 672 checks.

**Quirks characterized, not fixed** (Golden Rule 1 — the current behavior is the
behavior):

- **A queued order behind a `moveTo` is stranded.** `onArrive`'s `move` case
  sets the command to `{ type: 'idle' }` directly instead of going through
  `finishTask`, so `pending` is never promoted; the queued order waits until the
  next player order replaces it. `tests/sim/rover-state.test.ts` pins it.
  Fixing it changes *which orders execute*, so it belongs with Phase 12's queue
  rewrite or a dedicated pass.
- **`autoAssign` does not clear `recharge`.** A task auto-assigned while a rover
  is driving home waits for the charge run; `giveTask` clears it for player
  orders. Recorded in design doc §8.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 60 suites / 672 checks (was 59/645), 198.3 s |
| `npm run test:check` | green — 60 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,044.48 kB (304.50 kB gz), `sim.worker` 224.65 kB |
| pre/post behavior baseline | **byte-identical** — Phase 11 is the first phase *allowed* to change rover behavior (§14's move-first rule ends here) and deliberately did not use the permission: `/home/user/phase11-baseline.txt` diffs clean against the Phase 10 frozen output (36 StateHash checkpoints + 38 sampled traces, two seeds, restore-equality and determinism pairs) |
| `mobile-smoke` | green |
| `worker-smoke` (`?worker=1`) | green |
| `worker-smoke` (`?worker=0`) | green |
| `update-check-smoke` | green |

The next phase per §51 is **Phase 12 — Extract FleetAutomationSystem**.


# 16. Phase 12 — Extract FleetAutomationSystem

Goal:

Move autonomous fleet decision-making out of `Simulation.ts`.

Create:

    src/sim/systems/FleetAutomationSystem.ts

Responsibilities:

    evaluate jobs
    prioritize jobs
    select rover
    assign jobs
    rescue
    auto-haul
    auto-service
    storm shelter
    charging
    maintenance

Create an explicit conceptual model:

    Job
    ├── type
    ├── target
    ├── priority
    ├── urgency
    ├── risk
    ├── energy cost
    ├── deadline
    └── requirements

Then:

    Job candidates
        ↓
    filtering
        ↓
    scoring
        ↓
    reservation
        ↓
    rover assignment

## Important

Do not use a giant chain of:

    if (...)
    else if (...)
    else if (...)

forever.

Move toward explicit job evaluators.

Example:

    RescueJobEvaluator
    ConstructionJobEvaluator
    HaulJobEvaluator
    MaintenanceJobEvaluator
    ChargingJobEvaluator

These do not all need to be classes.

Pure functions are preferable where possible.

## Tests

Create scenarios:

    low battery
    storm
    disabled rover
    urgent construction
    full depot
    missing materials
    rescue
    multiple competing jobs

## Gate

Automation behavior remains equivalent before optimization.


## Recorded (Phase 12 complete — 2026-09-18)

Implemented on `arena/01a0b437-red-frontier`.

**The job model** — §16 asked for an explicit one, and it is now written down in
`src/sim/systems/FleetAutomationSystem.ts`'s header and its exported types, with
`tests/sim/fleet-automation.test.ts` (23 checks) as the executable form:

    evaluate (pure)   priority + urgency + requirements
        ↓
    filter            the shelter order, "someone is already on it"
        ↓
    order             TDD §8 band, then the job's own urgency key
        ↓
    reserve           the rover or the seam is claimed
        ↓
    assign            `RoverSystem.autoAssign`

Evaluators are plain functions, not classes (`maintenanceJobs`, `rescueJobs`,
`haulDemand`, `pickHaul`, `waitingSite`) — §16's "pure functions are preferable"
line. The model's fields:

| Field | Where it lives |
| --- | --- |
| type | `kind`: `'repair' \| 'clean' \| 'rescue' \| 'haul'` |
| target | the building, stranded rover or seam the job acts on |
| priority | `JOB_PRIORITY` — survival 0, construction 1, routine 2 (TDD §8's band) |
| urgency | the *pre-existing* sort key: health, cleanliness, fleet order, seam score |
| energy cost | `rescueJobs`'s gift kWh, `pickHaul`'s round trip; `null` for chores |
| requirements | the per-rover `rule` (autoService / autoRescue / autoHaul) |
| risk / deadline | not modelled — the sim has no risk estimate and no task deadline, and inventing empty fields would be scaffolding, not a model |

**Every evaluator is fleet-major except the haul one.** A seam's score is
`distance ÷ demand`, so the best seam for one rover is not the best for another;
`pickHaul` therefore scores *for a given rover*, exactly as the pre-extraction
code did. Documented rather than "fixed": this phase's gate is that automation
behavior stays equivalent, and unifying the scorers is the optimization that
follows it.

**What moved** (verbatim from `Simulation.ts`, deleting 190 lines):

- `assignMaintenance` → `dispatchMaintenance` — damaged structures first
  (survival), then solar arrays past `AUTO_CLEAN_THRESHOLD`, one job per idle
  rover; repairs ignore the auto-service opt-out.
- `assignRescues` → `dispatchRescues` — stranded rovers nobody is on the way to,
  nearest volunteer that can hand over the gift *and* still get home
  (`rescueFeasible`, the same arithmetic `RoverSystem.doRecover` re-derives).
- `assignSupplyRuns` → `dispatchSupplyRuns` — `haulDemand` (build shortfall +
  the weighted standing ice order), `haulWanted`, `pickHaul` (unclaimed seam
  first, shared seam as the fallback that never idles a capable rover,
  `canMakeRun` energy gate), and the two hold-backs that reserve a rover for
  construction and maintenance (`waitingSite`, `reserveForHigherPriority`).
- `maintenancePending` / `servicingRover` → public helpers.

**What deliberately stayed in `RoverSystem`**: charging (the ride-home floor) and
storm shelter, per-rover. §16 lists them among this system's responsibilities;
the *fleet* half of both is in `FleetAutomationSystem` — the dispatch pools skip
charging and sheltering rovers, and the storm order cancels the maintenance and
rescue passes (`filterJobs`). The per-rover rule itself stays next to the task
loop that obeys it: moving it would mean duplicating the floor maths, i.e. two
sources of truth for "when does this rover break off". Site crew choice stays
with `ConstructionSystem.assignBuilders` (Phase 9); this system only *reserves* a
rover for it.

**New seam**: `FleetAutomationHostHooks.canDeliverCargo`. The haul ledger is
Phase 13's; until then `Simulation.canDeliverAny` answers it for all three seams
(construction hooks, rover hooks, fleet hooks) — one answer, three callers.

**New repo tool**: `scripts/behavior-baseline.ts`. The scratch baseline scripts
used for Phases 5–11 kept being thrown away with their temp directories, so the
A/B is now a checked-in script: a scripted colony (sites, a storm, a flat pack
the rescue pass must answer, a new site, dust, a damaged structure, a
dust-caked array, then a quiet stretch with nobody under orders), six
`StateHash` checkpoints and a 2,400-sample per-tick trace per seed, plus a
restore pair and a determinism pair. Run it with `--write before.txt` before a
refactor and `--check before.txt` after.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 61 suites / 695 checks (was 60/672), 219.8 s |
| `npm run test:check` | green — 61 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,045.63 kB (304.80 kB gz), `sim.worker` 225.79 kB |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against `HEAD` (pre-Phase-10) and against today's tree: 12 checkpoint hashes, 2 trace digests, 4 equality pairs, byte-identical. Phases 10, 11 and 12 together moved nothing on the automation scenario |
| `mobile-smoke` | green |
| `worker-smoke` (`?worker=1`) | green |
| `worker-smoke` (`?worker=0`) | green |
| `update-check-smoke` | green |

The §48 checklist, item by item: the responsibility has one owner
(`FleetAutomationSystem`, with per-rover charging/shelter explicitly documented
as staying in `RoverSystem`); its imports are `state/*`, `./RoverSystem`,
`../World` (type), `../defs`, `../config`, `../alerts` (type) and `../../lib/rng`
— no DOM, no three.js, no `app/`, no `ui/`; behavior is intact and proven by the
A/B above; the extracted behavior has its own suite; determinism, both worker
transports and the production build are green; and no second source of truth was
introduced — the one new seam (`canDeliverCargo`) is the same implementor the
construction and rover hooks already use.

`Simulation.ts`: 2,082 → 1,799 lines. The next phase per §51 is **Phase 13 —
Extract LogisticsSystem** (hauling, cargo, depot transfers, reservations,
delivery, pickup, resource availability), which takes `canDeliverAny` and the
storage ledger with it.


# 17. Phase 13 — Extract LogisticsSystem

Goal:

Make resource movement a first-class simulation subsystem.

Responsibilities:

    hauling
    cargo
    depot transfers
    reservations
    delivery
    pickup
    resource availability

This becomes particularly valuable as the game gains:

    more resources
    more buildings
    more depots
    more rover types
    more production chains

## Tests

Test:

    reservation
    pickup
    delivery
    cancellation
    failed delivery
    storage full
    competing haulers
    destroyed destination

## Design rule

Resource accounting must have one authoritative owner.

Avoid allowing:

    RoverSystem
    ConstructionSystem
    ProductionSystem

to independently manipulate the same resource reservation rules.


## Recorded (Phase 13 complete — 2026-09-18)

Implemented on `arena/01a0b437-red-frontier`.

**One owner for resource accounting.** §17's design rule is now a module and a
test. `src/sim/systems/LogisticsSystem.ts` (319 lines) is the only place in
`src/sim` that writes storage: `tests/sim/logistics-system.test.ts` walks the
tree and asserts that the set of modules writing `storage[res]` is exactly
`LogisticsSystem` plus `ColonyState`'s capacity clamp, and that the set writing
`storage = …` wholesale is exactly `Simulation`'s accessor/save path. Before this
phase three systems moved the same kilograms with their own arithmetic.

**What moved, and where it came from**

| Now in `LogisticsSystem` | Came from | Was |
| --- | --- | --- |
| `store` / `take` / `refund` / `room` / `capacity` / `total` / `totalCapacity` / `isFull` / `fullResources` | `Simulation`'s public storage surface + every ad-hoc `+`/`-` | six accessors and three inline `Math.max(0, …)` clamps |
| `unloadCargo` | `RoverSystem` | three copies of "pour the hold into the silos" (`goIdle`'s parked pour, `unloadWhileCharging`, `tryUnload`), two of which logged and one of which was silent |
| `loadCargo` | `RoverSystem` | the hold clamp in `doMine` / `doSalvage` / the route-load path |
| `canDeliver` | `Simulation.canDeliverAny` | the one haul question three seams (construction, rover, fleet hooks) asked |
| `deliverToSite` | `ConstructionSystem.commitAvailableMaterials` | site commits |
| `hasMaterials` / `consumeMaterials` / `missingList` | `ConstructionSystem` | the garage's spend and the "40 kg Regolith" list |
| `refund` | `ConstructionSystem.demolish` | the demolish refund, the ledger's one deliberate over-fill |
| `claimDeposit` / `releaseDeposit` / `releaseReservations` / `reservationOf` / `rescueTargeted` | `RoverSystem` | the seam reservation table |
| — | `ProductionSystem.runProcess` | the solid-input draw (`state.storage[res] = Math.max(0, … - take)`) is now `LogisticsSystem.take` |
| — | `FleetAutomationSystem` | its haul/supply scorer's `storageRoom(...)` and `state._storageCapacity` reads |

Not a redesign: every method is the arithmetic that was already there, with its
comment. The *names* the rest of the code calls survive as delegates —
`Simulation.storageRoom/storageTotal/storageFull/fullResources/canDeliverAny`,
`ConstructionSystem.commitAvailableMaterials/hasMaterials/consumeMaterials/missingList`,
`RoverSystem.claimDeposit/releaseDeposit/releaseReservations/rescueTargeted` — so
hosts, UI and the existing suites keep their call sites, exactly as the rover
command verbs did after Phase 10.

**The model** (in the file's header, with a diagram): storage is the ledger, and
every arrow into or out of it is a method. Cargo is the rover's hold, with
`loadCargo`/`unloadCargo` as the two movable ends; the hold's *capacity* is a
rover property (`ROVERS[kind].capacityKg`) and the rover's own rules about what
to pick up stay in `RoverSystem`. Site material is production-style demand, not a
claim.

**Reservations are asymmetric, and it is written down rather than smoothed
over.** Only deposits are reserved: a seam is claimed by the run working it
(`claimDeposit`) and released when the task is replaced, cancelled, or the rover
strands. A starving site uses a different mechanism entirely — its lowered
`remainingCost` — and the fleet's "held against a second rover" rule is a *scorer*
tier (`pickHaul`), not a lock. Unifying the two would change which rover gets
which job: a behavior change, so it is documented as the boundary of this phase.
The user-visible consequence is pinned by tests: a claim steers a second hauler
to the other seam, cancelling hands the seam back, and a claim on a seam that
runs dry pins nobody.

**What deliberately does not live here**

- **Fluid pools** (`state.pools`, `lifesupport.ts`'s `addFluid`/`takeFluid`):
  Phase 7's, clamped on both sides. A future "fluids are a resource like any
  other" pass folds them in; doing it here would collide with that system's
  balance constants.
- **`recomputeCapacitiesState`** (Phase 2's): deciding how big storage is stays
  with the state module. The ledger reads the result and enforces it.
- **Charging and storm recall**: per-rover, `RoverSystem`'s (Phase 12's split).

**Quirks preserved, not fixed** (Golden Rule 1; each is pinned by a test):

- The refund's guarantee is conditional: it lands in full, but
  `recomputeCapacitiesState` clamps the over-fill away on the next recompute, so
  a refund into an *already full* silo is silently lost. Phase 9 found it, Phase
  13 moved the rule into `refund`'s docstring and left the behaviour alone.
- `unloadCargo`'s `blocked` flag means "a silo was already full when the pour
  started", not "some of the hold is still stuck" — the three pre-extraction
  copies all behaved that way, and the *callers* decide what to say about it
  (which is why the method reports instead of logging).
- A finished task does not release its claim: `finishTask` takes no state, so
  the release happens on the next `giveTask`/`stopRover`/`disable`. Preserved.
- `devSetRoverCargo` clamps through the hold's capacity rule, i.e. the dev panel
  cannot overfill a hopper either.

**Tests** — `tests/sim/logistics-system.test.ts`, 25 checks, §17's list mapped
onto cases: *reservation* (`a claim holds the seam…`, `claims follow the task…`),
*pickup* and *delivery* (`pickup then delivery: the seam shrinks by exactly what
storage gains`), *cancellation* (the site refund, the claim release, a cancelled
site's committed material), *failed delivery* (`a failed delivery keeps the load
and says why`), *storage full* (`the silo is full, so the route parks and resumes`
plus the ledger-level `isFull`/`fullResources`/`canDeliver` cases), *competing
haulers* (`competing haulers: a claim steers the fleet apart…`) and *destroyed
destination* (a warehouse dismantled mid-haul, and a seam that runs dry under a
claim). Plus the ledger's own contract: clamping, the floor at zero, the refund
being the one over-fill, negative/NaN pours being no-ops, and the sim's storage
surface agreeing with the ledger it delegates to. The suite ends with the §48
"no duplicate source of truth" item as an executable guard.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 62 suites / 720 checks (was 61/695), 209.2 s |
| `npm run test:check` | green — 62 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,046.78 kB (305.10 kB gz), `sim.worker` 226.88 kB, 87 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against `HEAD` (pre-Phase-13) and against today's tree: 12 checkpoint hashes, 2 trace digests, 4 equality pairs, byte-identical; the trace digests are the same ones Phase 12 recorded (`17b0526f`, `32b26160`), so Phases 10–13 together moved nothing on the automation scenario |
| `mobile-smoke` / `worker-smoke` (`?worker=1`, `?worker=0`) / `update-check-smoke` | green |

The §48 checklist, item by item: the responsibility has one owner
(`LogisticsSystem`, with fluids and the capacity computation explicitly named as
living elsewhere); its imports are `state/*` (types + `cargoMass`),
`../state/ResourceState`'s `storageRoom` helper, `../defs` — no DOM, no three.js,
no `app/`, no `ui/`, no `render/`; behavior is intact and proven by the A/B
above; the extracted behavior has its own 25-check suite; determinism, both
worker transports and the production build are green; no presentation dependency
leaked; and no duplicate source of truth was introduced — the guard test above is
the proof, and the new `LogisticsHostHooks.finishTask` is the same task-lifecycle
hook the rover and fleet hooks already use. Documentation: this record, the
Phase 13 entry in `mnemosyne.md`, and the `docs/design/TDD.md` layout/testing
rows.

`Simulation.ts`: 1,799 → 1,790 lines. The next phase per §51 is **Phase 14 —
Extract ExplorationSystem**.

# 18. Phase 14 — Extract ExplorationSystem

Goal:

Separate exploration/POI logic.

Responsibilities:

    POI discovery
    exploration state
    salvage
    discoveries
    exploration rewards
    exploration-related events

Keep world generation separate from exploration.

Distinction:

    World
        =
    physical world

    ExplorationSystem
        =
    what the player has discovered about it

This allows the game to eventually support:

    hidden resources
    scanned regions
    discoveries
    unexplored terrain
    science
    mapping


## Recorded (Phase 14 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-14-exploration-system`).

**World stays the planet; ExplorationSystem is what the player has found.** §18's
distinction is now a module and a test. `src/sim/systems/ExplorationSystem.ts`
owns discovery, the supply-drop schedule and burial clock, and the site-side of
salvage (depletion + surviving-cell rewards). `World.generatePois` / `makePoi` /
`pickPoiKind` stay where they were — scatter is physical world generation, not
exploration. The salvage *task* body (`issueSalvage` / `doSalvage` — pathing,
hold fill, unload ping-pong) stays in `RoverSystem` (Phase 10), the same split
Phase 13 used between "kg arithmetic" and "rover work".

**What moved, and where it came from**

| Now in `ExplorationSystem` | Came from | Was |
| --- | --- | --- |
| `tick` / `tickDiscovery` / `tickSupplyDrops` / `landSupplyDrop` | `Simulation` | the private exploration block after weather |
| `pois` / `poiById` | `Simulation` | public accessors over `world.pois` |
| `takeSalvage` | `pois.takeSalvage` (call site in `RoverSystem.doSalvage`) | pure helper; the named owner is now the system |
| `recoverSiteCells` | `RoverSystem.recoverSiteCells` | surviving-cell reward into the grid store |

Not a redesign: every method is the arithmetic and alert text that was already
there, with its comment. The names the rest of the code calls survive as
delegates — `Simulation.pois` / `poiById`, `RoverSystem.recoverSiteCells` — so
hosts, UI and the existing `tests/sim/pois.test.ts` suite keep their call sites.

**What deliberately does not live here**

- **World generation** (`World.generatePois`, `makePoi`, `pickPoiKind`,
  `scatterableKinds`): the planet is World's.
- **The salvage task** (`RoverSystem.issueSalvage` / `doSalvage`): rover domain.
- **`pois.ts` content tables** (`POI_KINDS`, `DROP_MANIFESTS`, `burialRate`,
  `rollDropRing`, `makeSupplyDrop`): data-shaped, like `weather.ts` beside
  WeatherSystem.

**Tests** — `tests/sim/exploration-system.test.ts`: discovery (rover + colonist),
accessor delegates, land / bury / clear-on-recover for supply drops, takeSalvage
conservation, recoverSiteCells (fit + full-batteries overflow), main-loop wiring,
and the §48 "one owner" guard (`.discovered=` / `.buried=` writers are exactly
`ExplorationSystem`; `nextDropSol=` writers are exactly ExplorationSystem +
ColonyState init/reset + Simulation's accessor).

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 63 suites / 733 checks (was 62/720), 74.0 s |
| `npm run test:check` | green — 63 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,046.93 kB (303.80 kB gz), `sim.worker` 227.03 kB, 88 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against pre-Phase-14 tree and against today's tree |
| smokes | skipped on this host (Playwright not installed); unit/integration + A/B cover the extraction |

The §48 checklist, item by item: the responsibility has one owner
(`ExplorationSystem`, with world generation and the salvage *task* body
explicitly named as living elsewhere); its imports are `state/*`, `pois`,
`config`, `alerts` — no DOM, no three.js, no `app/`, no `ui/`, no `render/`;
behavior is intact and proven by the A/B above; the extracted behavior has its
own 13-check suite; determinism and the production build are green; no
presentation dependency leaked; and no duplicate source of truth was introduced
— the guard test above is the proof. Documentation: this record, the Phase 14
entry in `mnemosyne.md`, and the `docs/design/TDD.md` layout/testing rows.

`Simulation.ts`: 1,790 → 1,652 lines. The next phase per §51 is **Phase 15 —
Extract FailureSystem**.



# 19. Phase 15 — Extract FailureSystem

Goal:

Centralize failures without mixing them with alerts.

Responsibilities:

    equipment failures
    rover breakdowns
    building failures
    environmental failures
    resource failures

The system should generate domain events/results.

For example:

    RoverDisabled
    BuildingFailed
    PowerShortage
    OxygenCritical

Then:

    FailureSystem
        ↓
    domain event
        ↓
    AlertSystem
        ↓
    SimView/UI



## Recorded (Phase 15 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-15-failure-system`).

**Failures are centralized; alerts are not yet.** §19's distinction is now a
module and a test. `src/sim/systems/FailureSystem.ts` owns the failure *actions*
(`tripDamaged`, `endMission`) and the failure *checks* that used to live in
`Simulation.evaluateAlerts`. It produces domain events (`RoverDisabled`,
`BuildingFailed`, `PowerShortage`, `FluidReserve` / OxygenCritical, …) and
bridges them onto `state.alerts` with the same keys, severities and copy as
before — so AlertSystem (Phase 16) has a clean surface to consume without a
behavior change today.

**What moved, and where it came from**

| Now in `FailureSystem` | Came from | Was |
| --- | --- | --- |
| `tripDamaged` | `Simulation` | WeatherHostHooks implementor |
| `endMission` | `Simulation` | Weather / LifeSupport hooks implementor |
| `evaluate` / `tick` / `applyAlerts` | `Simulation.evaluateAlerts` | step-9 failure checks → alerts |
| `FailureEvent` union | *(new surface)* | named the conditions evaluateAlerts already raised |

Not a redesign: every raise/clear path is the text and thresholds that were
already there. `Simulation.evaluateAlerts` survives as a one-line
`FailureSystem.tick` delegate; weather and life-support hooks now call
FailureSystem for trip/endMission. `RoverSystem.disable` stays rover-domain;
FailureSystem only *observes* stranded rovers.

**What deliberately does not live here**

- **AlertBus / AlertSystem** (dedupe, ack, history drain, HUD) — Phase 16.
- **History sampling** (`recordHistory`) — Phase 17.
- **Rover disable action** — `RoverSystem.disable` (Phase 10).
- **Fluid draw / colonist needs** — LifeSupportSystem (Phase 7).

**Tests** — `tests/sim/failure-system.test.ts`: tripDamaged (capacities +
builder release), endMission, domain events (PowerShortage, FluidReserve,
RoverDisabled, BuildingFailed, RoverWear), alert bridge (oxygen / stranded /
suit), main-loop wiring, life-support death through FailureSystem, and the §48
"one owner" guard (`gameOver=` / `.damaged = true` writers).

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 64 suites / 750 checks (was 63/733), 74.3 s |
| `npm run test:check` | green — 64 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,049.69 kB (304.64 kB gz), `sim.worker` 229.80 kB, 89 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against pre-Phase-15 tree and against today's tree |
| smokes | skipped on this host (Playwright not installed); unit/integration + A/B cover the extraction |

The §48 checklist, item by item: the responsibility has one owner
(`FailureSystem`, with AlertSystem / HistorySystem / RoverSystem.disable
explicitly named as living elsewhere); its imports are `state/*`, `defs`,
`config`, `weather`, `alerts`, `LogisticsSystem` — no DOM, no three.js, no
`app/`, no `ui/`, no `render/`; behavior is intact and proven by the A/B above;
the extracted behavior has its own 18-check suite; determinism and the
production build are green; no presentation dependency leaked; and no duplicate
source of truth was introduced — the guard test above is the proof.
Documentation: this record, the Phase 15 entry in `mnemosyne.md`, and the
`docs/design/TDD.md` layout/testing rows.

`Simulation.ts`: 1,652 → 1,410 lines. The next phase per §51 is **Phase 16 —
Extract AlertSystem**.


# 20. Phase 16 — Extract AlertSystem

Goal:

Separate "something happened" from "how the player is notified."

Create:

    AlertSystem

Responsibilities:

    alert creation
    severity
    deduplication
    expiration
    acknowledgement state
    alert history

Do not let:

    WeatherSystem
    RoverSystem
    PowerSystem

directly manipulate HUD objects.

They should produce simulation-level events/state.

The UI should consume the resulting `SimView`.



## Recorded (Phase 16 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-16-alert-system`).

**Notifications are centralized; other domain alert writers remain.** §20's
distinction is now a module and a test. `src/sim/systems/AlertSystem.ts` owns
the mapping from failure domain events onto `state.alerts` (AlertBus) with the
same keys, severities, copy, raise/clear and hysteresis Phase 15's interim
`FailureSystem.applyAlerts` bridge used — including `BuildingTripped` /
`MissionLost`, which used to raise at the action site. FailureSystem now emits
events only; Simulation wires `FailureSystem.tick` →
`AlertSystem.applyFailureEvents`, and the weather / life-support hooks apply
action events the same way.

**What moved, and where it came from**

| Now in `AlertSystem` | Came from | Was |
| --- | --- | --- |
| `applyFailureEvents` | `FailureSystem.applyAlerts` | interim Phase 15 bridge |
| `BuildingTripped` / `MissionLost` notification | `FailureSystem.tripDamaged` / `endMission` | raised at the action site |
| named owner of failure→alert mapping | *(new surface)* | Simulation still owns `evaluateAlerts` as the tick seam |

Not a redesign: every raise/clear path is the text and thresholds that were
already there. Acknowledgement / snooze stays presentation-side in the HUD
(moving ack into sim state would change save/restore). `alerts.ts` remains the
AlertBus data structure beside AlertSystem — same split as `weather.ts` beside
WeatherSystem.

**What deliberately does not live here**

- **Failure checks / tripDamaged / endMission** — FailureSystem (Phase 15).
- **AlertBus mechanics implementation** — `alerts.ts`.
- **History sampling** (`recordHistory`) — HistorySystem Phase 17.
- **HUD dismiss / snooze** — presentation; reads SimView alerts.
- **Direct `state.alerts` writers in Weather / Construction / Exploration /
  LifeSupport / Rover / FleetAutomation / Logistics** — unchanged this phase
  (one architectural change). FailureSystem is the first producer that emits
  domain events for AlertSystem to consume.

**Tests** — `tests/sim/alert-system.test.ts`: oxygen raise/clear, stranded
rover, suit O₂, BuildingTripped / MissionLost ownership, PowerShortage copy,
dedupe/hysteresis, main-loop wiring, life-support death through the seam, and
architecture guards (AlertSystem owns applyFailureEvents; does not own failure
actions). `tests/sim/failure-system.test.ts` updated so FailureSystem no longer
writes alerts and `evaluateAlerts` wires FailureSystem → AlertSystem.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 65 suites / 761 checks (was 64/750), 74.8 s |
| `npm run test:check` | green — 65 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,049.72 kB (304.68 kB gz), `sim.worker` 229.82 kB, 90 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against Phase 15 tip (`445942c`) and against today's tree |
| smokes | skipped on this host (Playwright not installed); unit/integration + A/B cover the extraction |

The §48 checklist, item by item: the responsibility has one owner
(`AlertSystem` for failure→notification mapping, with remaining domain alert
writers explicitly named as living elsewhere); its imports are `state/*`,
`defs`, `weather`, `FailureSystem` (type only) — no DOM, no three.js, no
`app/`, no `ui/`, no `render/`; behavior is intact and proven by the A/B above;
the extracted behavior has its own focused suite; determinism and the
production build are green; no presentation dependency leaked; and no duplicate
source of truth was introduced — FailureSystem must not import AlertSystem or
write `state.alerts`. Documentation: this record, the Phase 16 entry in
`mnemosyne.md`, and the `docs/design/TDD.md` layout/testing rows.

`Simulation.ts`: 1,410 → 1,419 lines (wiring only; FailureSystem 690 → 428). The next phase per §51 is **Phase 17 — Extract History/Event Tracking**.


# 21. Phase 17 — Extract History/Event Tracking

Goal:

Separate historical records from simulation mechanics.

Create:

    HistorySystem

Responsibilities:

    event history
    important milestones
    failures
    discoveries
    construction completion
    rover incidents

Potential architecture:

    Domain Event
        ↓
    HistorySystem
        ↓
    HistoryState

This will also provide a future foundation for:

    replay
    analytics
    statistics
    mission reports
    post-game summaries


## Recorded (Phase 17 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-17-history-system`).

**Historical records are centralized; discrete event narratives stay on AlertBus.**
§21's distinction is now a module and a test. `src/sim/systems/HistorySystem.ts`
owns the vitals time-series sampling that used to live as
`Simulation.recordHistory` / `resetFlows` — same interval gate, sample shape,
ring-buffer cap (`HISTORY_SAMPLES`) and trailing-sol flow-window roll.
`src/sim/state/HistoryState.ts` owns the `HistorySample` type plus
`emptyFlows` / `emptyHistoryWindows` helpers. Simulation wires
`HistorySystem.tick` after failures→alerts, and delegates restore / time-jump
clears to `HistorySystem.clear` / `afterTimeJump`.

Domain-event → HistoryState event-log (milestones, failures, discoveries,
construction completion, rover incidents) and replay/analytics/reports are
**foundation only** this phase — those one-shot narratives still write
`state.alerts` (AlertBus). Redesigning them into a parallel log would change
save/UI and is deferred (one architectural change).

**What moved, and where it came from**

| Now in `HistorySystem` / `HistoryState` | Came from | Was |
| --- | --- | --- |
| `tick` (sample + flow roll) | `Simulation.recordHistory` + `resetFlows` | private methods on Simulation |
| `clear` | `Simulation.restore` history wipe | inline three assignments |
| `afterTimeJump` | `Simulation.devSetTime` history re-anchor | inline lastHistoryAt / flows / flowWindow |
| `HistorySample` type | `state/ResourceState.ts` | sat beside fluid helpers |
| `emptyFlows` / `emptyHistoryWindows` | *(new helpers)* | duplicated object literals |

Not a redesign: every sample field, threshold and trim rule is what was already
there. Public host queries (`netRatePerSol`, `instantRatePerSol`, `reserveSols`,
`history` getter) stay on Simulation — they read the windows HistorySystem
writes.

**What deliberately does not live here**

- **AlertBus / AlertSystem** — notifications (Phase 16).
- **Failure checks / tripDamaged / endMission** — FailureSystem.
- **Discrete milestone / discovery / construction / rover incident event log** —
  still AlertBus writers in domain systems; future HistorySystem consumers.
- **Replay / analytics / mission reports** — deferred.

**Tests** — `tests/sim/history-system.test.ts`: first-tick sample, interval
gate, ring-buffer cap, live power/pool reads, flow-window roll + trim,
skip-path still resets flows, clear / afterTimeJump, empty helpers, main-loop
wiring, `devSetTime` / restore seams, reserveSols still reads the window, and
architecture guards (HistorySystem owns tick/resetFlows/clear; Simulation no
longer has `recordHistory` / `resetFlows`; HistorySystem does not write alerts
or own failure actions).

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 66 suites / 778 checks (was 65/761), 79.9 s |
| `npm run test:check` | green — 66 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` 1,049.48 kB (304.74 kB gz), `sim.worker` 229.59 kB, 92 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` run against Phase 16 tip (`59b6814`) and against today's tree |
| smokes | skipped on this host (Playwright not installed); unit/integration + A/B cover the extraction |

The §48 checklist, item by item: the responsibility has one owner
(`HistorySystem` for vitals sampling + flow-window roll, with discrete event
narratives explicitly named as living on AlertBus for now); its imports are
`state/*` and `config` — no DOM, no three.js, no `app/`, no `ui/`, no `render/`;
behavior is intact and proven by the A/B above; the extracted behavior has its
own focused suite; determinism and the production build are green; no
presentation dependency leaked; and no duplicate source of truth was introduced.
Documentation: this record, the Phase 17 entry in `mnemosyne.md`, and the
`docs/design/TDD.md` layout/testing rows.

`Simulation.ts`: 1,419 → 1,361 lines. The next phase per §51 is **Phase 18 — Refactor Simulation.ts**.


# 22. Phase 18 — Refactor Simulation.ts

At this point, `Simulation.ts` should finally become small.

Target responsibilities:

    create state
    initialize systems
    process commands
    advance systems
    create SimView
    expose minimal lifecycle API

Target shape:

    class Simulation {

        readonly state;
        readonly clock;
        readonly weather;
        readonly power;
        readonly lifeSupport;
        readonly production;
        readonly construction;
        readonly rover;
        readonly automation;
        readonly logistics;
        readonly exploration;
        readonly failures;
        readonly alerts;

        step(dt) {
            clock.update(...)
            weather.update(...)
            power.update(...)
            production.update(...)
            lifeSupport.update(...)
            automation.update(...)
            rover.update(...)
            construction.update(...)
            logistics.update(...)
            exploration.update(...)
            failures.update(...)
            alerts.update(...)
        }
    }

The exact order should remain the existing authoritative tick order unless there is a specific reason to change it.

## Target

Aim for:

    Simulation.ts
        < 500 lines

Do not treat 500 lines as a hard requirement.

The actual goal is:

> Simulation should coordinate systems, not implement all their behavior.


## Recorded (Phase 18 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-18-simulation-orchestrator`).

**Simulation coordinates; it does not implement remaining domain bodies.**
§22's slim-down is a set of move-not-redesign extractionsions — no tick-order
change, no new product systems, no save/UI redesign:

| Now outside Simulation | Came from | Was |
| --- | --- | --- |
| `GarageSystem.tick` / `assemble` | `Simulation.tickGarages` / `assembleRover` | private + public domain bodies |
| `snapshotColony` / `restoreColony` | `Simulation.snapshot` / `restoreFromState` | persistence field mapping |
| `DevBackdoors.*` | `Simulation.dev*` mutation bodies | developer-panel writes |
| `HistorySystem.netRatePerSol` / `instantRatePerSol` / `reserveSols` | same-named Simulation methods | arithmetic over History windows |

Simulation keeps the public host/command/view/lifecycle surface as thin
delegates, owns cross-system hooks, and advances systems in the **identical**
Phase 17 tick order:

    Clock → Weather → Exploration → Power → Garage → LifeSupport →
    Construction (site mats + builders) → FleetAutomation →
    Rover (lights / update / move) → Colonist → Failure→Alert → History

**What deliberately does not live here**

- Tick-order redesign, AlertBus→History event-log, SimView redesign, Game.ts
  extraction (Phase 19+).
- New product systems beyond naming the existing garage bay.

**Tests** — `tests/sim/simulation-orchestrator.test.ts`: garage / persistence /
rate ownership guards, round-trip snapshot parity, public rate delegates, and a
source-order pin of every system call inside `private tick()`. Prior phase
architecture allowlists updated for ColonyPersistence / DevBackdoors writers.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 67 suites / 786 checks (was 66/778), ~81 s |
| `npm run test:check` | green — 67 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` ~1,050.60 kB (305.08 kB gz), `sim.worker` 230.68 kB, 94 modules |
| behavior A/B | **identical** — `scripts/behavior-baseline.ts` vs Phase 17 tip (`6d3053e`) |
| smokes | skipped on this host (Playwright not installed); unit/integration + A/B cover the slim-down |

`Simulation.ts`: 1,361 → ~733 lines. The next phase per §51 is **Phase 19 — Extract Game.ts Responsibilities**.


# 23. Phase 19 — Extract Game.ts Responsibilities

Only after simulation refactoring is stable.

Current `Game.ts` contains several responsibilities that should eventually become separate controllers.

Create:

    src/app/
        Game.ts
        GameLoop.ts
        InputController.ts
        SelectionController.ts
        BuildController.ts
        SaveController.ts
        MenuController.ts
        UpdateController.ts

## GameLoop

Responsible for:

    requestAnimationFrame
    frame timing
    host.step()
    render scheduling

## InputController

Responsible for:

    keyboard
    pointer
    touch
    camera input
    command initiation

## SelectionController

Responsible for:

    selecting rover
    selecting building
    selection state
    selection visualization

## BuildController

Responsible for:

    build mode
    placement cursor
    ghost positioning
    placement request

It must not determine final placement validity.

## SaveController

Responsible for:

    save
    load
    autosave
    save UI state

## Game

Becomes the composition root.

It wires everything together rather than implementing every behavior.

## Noted (2026-09-17) — the save/menu logic arrived before the extraction

The pause-menu and save hand-off work (pause menu with settings and expedition
tabs, the save progress frost, the save-failed prompt, and the ordered
save → `leaveToMenu()` teardown that fixed "Save failed — the colony could not
be read") shipped with its logic **deliberately kept in `Game.ts`** — this
phase stands as written, and that work is exactly what it will extract:
`save` / `onSaveFailure` / `returnToMenu` / `leaveToMenu` / `manualSave` /
`retrySave` / `saveAsNew` / `abandonToMenu` → `SaveController`;
`openPauseMenu` / `closePauseMenu` / `pauseSettings` / `buildColonyStats` →
`MenuController`. When Phase 19 runs, preserve the onDone-ordered teardown
(the save must settle before the host is disposed — that ordering is the
regression that used to surface as the save-failed prompt) and the
`saveContext` phrasing/visibility rules. Behavior is pinned by
`tests/app/pause-save.test.ts`, `tests/hud/pause-menu.test.ts` and
`scripts/pause-smoke.mjs` (both transports).

## Recorded (Phase 19 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-19-game-controllers`).

**Game is a composition root.** §23's extraction is move-not-redesign — no new
product features, no save/UI redesign, no change to onDone-ordered teardown or
`saveContext` phrasing/visibility:

| Now outside Game | Came from | Was |
| --- | --- | --- |
| `GameLoop` | `loop` / `resize` | rAF, host.step, render scheduling |
| `InputController` | `attachInput` / pointer* / `keyDown` / `uiCoversPoint` | keyboard, pointer, touch, camera |
| `SelectionController` | `primaryTap` / `contextTap` / selection fields / `updateSelectionVisual` / `centerOnSelected` / `handleAction` | selection + command initiation taps |
| `BuildController` | `setPendingBuild` / `placeBuild` / `updateGhost` | build mode + placement *request* (validity stays on sim/host) |
| `SaveController` | `save` / `onSaveFailure` / `manualSave` / `retrySave` / `saveAsNew` / `abandonToMenu` / `returnToMenu` / `leaveToMenu` | save + autosave UI state + onDone teardown |
| `MenuController` | `openPauseMenu` / `closePauseMenu` / `pauseSettings` / `buildColonyStats` / `applyGraphics` | pause menu |
| `UpdateController` | `onNewBuild` / `updateNoticeSave` / `updateNoticeReload` / `updateNoticeLater` | in-play update notice |

Game keeps lifecycle (main menu / new game / load / launch), developer mode,
HUD `syncUI`, and thin private delegates so the pause-save pin surface
(`(game as any).returnToMenu()` etc.) and smoke field aliases
(`saveContext` / `saveInFlight` / `lastSave` / `autosaveSec` / `pauseMenu`)
stay identical.

**What deliberately does not live here**

- SimView redesign (Phase 20+), tick-order or host-boundary changes.
- Redesigning save/menu UX — only the extraction.
- Final placement validity inside BuildController (still `sim.canPlace` /
  host `requestPlacement` ack).

**Tests** — `tests/app/game-controllers.test.ts`: controller import + Game
wiring + ownership guards (save onDone path, menu/update/input/selection/
build/loop). Prior pins unchanged: `tests/app/pause-save.test.ts`,
`tests/hud/pause-menu.test.ts`.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | green — 68 suites / 795 checks (was 67/786), ~80 s |
| `npm run test:check` | green — 68 suites, all linked, all declare `@covers` |
| `npm run build` | green — `index.js` ~1,056.34 kB (306.46 kB gz), `sim.worker` 230.15 kB, 101 modules |
| behavior | **identical** — move-not-redesign; pause-save pins green |
| smokes | `scripts/pause-smoke.mjs` green on both `?worker=1` and `?worker=0` |

`Game.ts`: 1,904 → 868 lines. The next phase per §51 is **Phase 20 — Strengthen SimView**.


# 24. Phase 20 — Strengthen SimView

Goal:

Make the presentation boundary truly immutable.

Move away from exposing simulation entities directly.

Create explicit view models:

    RoverView
    BuildingView
    ColonistView
    ResourceView
    WeatherView
    AlertView

Prefer:

    readonly

and:

    ReadonlyArray<T>

throughout.

The target is:

    Simulation Entity
        ↓
    projection
        ↓
    immutable View Model
        ↓
    SimView
        ↓
    renderer/UI

This makes:

    LocalSimHost
    WorkerSimHost

semantically equivalent.


## Recorded (Phase 20 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-20-sim-view`).

**Presentation boundary is immutable.** Simulation entities no longer satisfy
`SimView`. Explicit view models under `src/sim/host/viewModels.ts`:

| View model | Role |
| --- | --- |
| `RoverView` | Readonly rover + owned cargo/pending/rules/navPath copies |
| `BuildingView` | Readonly building + owned remainingCost/assembly |
| `ColonistView` | Readonly colonist + owned order/starved |
| `ResourceView` | Storage / economy slice (`storage`, `pools`, `flows`, `history`, `storedKWh`) |
| `WeatherView` | Strengthened existing sky snapshot (readonly radar/lightning) |
| `AlertView` / `AlertsView` | Readonly alert rows + board queries |

**Projection path.** `projectView` emits deep-enough view models. Both
`LocalSimHost` and `WorkerSimHost` serve presentation through `ColonyMirror`
over those payloads — Local no longer hands out the live `Simulation`.
Queries (`roverById`, `idleRovers`, …) return view models.

**Move-not-redesign.** No domain events (Phase 21), no command redesign
(Phase 22), no tick-order or gameplay rule changes. Consumers in `ui/`,
`render/`, `dev/`, `app/`, `audio/` switched types to view models.

**Tests** — `tests/sim/host.test.ts` Phase 20 group (projection ≠ live sim,
immutability pin, Local↔payload entity match); `tests/sim/worker.test.ts`
LocalSimHost↔projectView entity match + cargo ownership pin. Prior host/
worker protocol and byte-equality tests adapted and green.

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | 68 suites / 800 checks green |
| `npm run test:check` | 68 suites / 800 checks linked |
| `npm run build` | green (`index.js` 1,060.15 kB / 307.67 gz, `sim.worker` 231.39 kB) |



# 25. Phase 21 — Introduce Domain Events

Do this only after systems have been extracted.

Potential events:

    RoverMoved
    RoverDisabled
    RoverRepaired
    BuildingPlaced
    BuildingCompleted
    BuildingFailed
    ResourceProduced
    ResourceConsumed
    PowerShortage
    StormStarted
    StormEnded
    POIDiscovered
    SalvageRecovered
    ColonistCritical
    GameOver

Events should be plain serializable data.

Example:

    {
        type: "rover/disabled",
        roverId: 42,
        reason: "battery-depleted"
    }

Do not build a complicated event-bus framework.

A simple per-tick event collection is sufficient.

Example:

    SimulationStepResult
        state
        events

This gives future systems a clean way to communicate without directly importing each other.


## Recorded (Phase 21 complete — 2026-09-18)

Implemented on the shared computer (`refactor/phase-21-domain-events`).

**Plain serializable domain events + per-tick collector.** New
`src/sim/domainEvents.ts`:

| Piece | Role |
| --- | --- |
| `DomainEvent` | Discriminated union (`type: 'rover/disabled'`, …) |
| `DomainEventLog` | `push` / `drain`/`take` (clears) / `snapshot` |
| `ColonyState.domainEvents` | Systems emit without importing each other |
| `Simulation.drainDomainEvents()` | Host/API surface, separate from AlertBus |

**Catalog wired at natural transitions** (no gameplay change): RoverMoved /
Disabled / Repaired, BuildingPlaced / Completed / Failed, ResourceProduced /
Consumed, PowerShortage, StormStarted / Ended, POIDiscovered, SalvageRecovered,
ColonistCritical, GameOver.

**Hosts.** `LocalSimHost` and `WorkerSimHost` expose `drainDomainEvents()`.
Worker payloads carry `domainEvents` (mirrored like AlertBus log lines).
`drainEvents()` / AlertBus HUD toasts unchanged.

**Move-not-redesign.** No event bus, pub/sub, middleware, or async listeners.
No Phase 22 command work. FailureEvent / AlertSystem mapping preserved.

**Tests** — `tests/sim/domain-events.test.ts` (collector, transitions, AlertBus
pin, Local/Worker surface).

**Gate results**

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | 69 suites / 809 checks green |
| `npm run test:check` | 69 suites / 809 checks linked |
| `npm run build` | green (`index.js` 1,061.92 kB / 307.96 gz, `sim.worker` 232.75 kB) |



# 26. Phase 22 — Improve Command Architecture

The existing command protocol should remain.

Potentially formalize:

    SimCommand
        ├── PlayerCommand
        └── DevCommand

Player commands:

    rover/move
    rover/mine
    rover/repair
    building/place
    building/toggle
    colonist/order

Dev commands:

    dev/time
    dev/storm
    dev/spawn
    dev/resources

The important principle remains:

    commands = intent

not:

    commands = direct state mutation

## Recorded (Phase 22 complete — 2026-09-19)

Implemented on `arena/01a0bab6-red-frontier`.

**Formalized PlayerCommand and DevCommand sub-unions.** In `src/sim/host/protocol.ts`:
- `RoverCommand` (14 rover commands), `BuildingCommand` (5 building commands), `ColonistCommand` (`colonist/order`)
- `PlayerCommand = RoverCommand | BuildingCommand | ColonistCommand`
- `DevCommand` (20 developer backdoors)
- `SimCommand = PlayerCommand | DevCommand`
- Exhaustive arrays: `PLAYER_COMMAND_TYPES` (20) and `DEV_COMMAND_TYPES` (20); `COMMAND_TYPES = [...PLAYER_COMMAND_TYPES, ...DEV_COMMAND_TYPES]`
- Type guards: `isPlayerCommand`, `isDevCommand`, `isPlayerCommandType`, `isDevCommandType`

**Separated command application.** In `src/sim/host/applyCommand.ts`:
- `applyPlayerCommand(sim, cmd)` executes player intent
- `applyDevCommand(sim, cmd)` executes developer mutations
- `applyCommand(sim, cmd)` records profiler command counter and cleanly delegates via `isDevCommand`

**Architecture guards.** Added tests in `tests/sim/host.test.ts`:
- Verified `PLAYER_COMMAND_TYPES` and `DEV_COMMAND_TYPES` strictly partition `COMMAND_TYPES` without overlap
- Type guards verified on all sample commands
- Architecture guard ensures non-dev controllers in `src/app` and `src/ui` never issue `DevCommand`s

**Gate results**
- `npm run typecheck`: green
- `npm test`: 70 suites / 824 checks green
- `behavior-baseline`: byte-identical


# 27. Phase 23 — Improve Navigation

Do this only after architectural extraction is complete.

The current navigation approach is adequate for the current game.

Do not prematurely optimize it.

First add instrumentation:

    paths requested per second
    average A* time
    worst A* time
    average nodes expanded
    path length
    allocation count

Then optimize based on measurements.

## First optimization

Replace the linear minimum search with a binary heap.

Current conceptual model:

    open array
        ↓
    scan entire array for minimum

Target:

    binary heap
        ↓
    O(log n) insertion/removal

## Second optimization

Introduce reusable pathfinding workspaces:

    gScore
    cameFrom
    visited
    openHeap
    generation stamps

Avoid allocating large arrays for every path.

## Third optimization

Consider path caching for repeated routes.

## Fourth optimization

Consider hierarchical navigation only if profiling demonstrates a need.

## Recorded (Phase 23 complete — 2026-09-19)

Implemented on `arena/01a0bab6-red-frontier`.

**Reusable NavWorkspace with generation stamping.** In `src/sim/navgrid.ts`:
- Preallocated workspace sized to grid dimensions ($N = n \times n$)
- Generation stamping via `nextSearch()`: resets `stamp` and avoids clearing $O(N)$ arrays on each search
- Zero per-pathfinding typed array allocations (previously 3 large typed arrays allocated per search)

**Indexed Binary Min-Heap Priority Queue.** In `src/sim/navgrid.ts`:
- Replaced $O(K)$ linear minimum search in the open set with $O(\log K)$ push, pop, and decrease-key operations
- Heap indices tracked in `heapPos` array with generation stamp validation (`inOpenStamp`)
- Fully deterministic search order, string-pulling preserved

**Comprehensive Profiler Instrumentation.** In `src/sim/debug/Profiler.ts`:
- Added metrics: `pathfindTimeMs`, `avgPathfindMs`, `worstPathfindMs`, `nodesExpanded`, `avgNodesExpanded`, `lastPathLength`, `pathfindAllocations` (0), and `pathfindsPerSec`
- Exposed in profiler snapshot, summary, and dev table

**Tests.** `tests/sim/navigation.test.ts` (7 checks) covers heap ordering, decreaseKey, stamp rollover, flat/cliff pathing, and profiler instrumentation.

**Gate results**
- `npm run typecheck`: green
- `npm test`: 71 suites / 831 checks green
- `behavior-baseline`: byte-identical (2,400 ticks, two seeds)


# 28. Phase 24 — Worker/View Performance

Do this after simulation systems are stable.

Measure:

    simulation time
    view generation time
    structured-clone time
    worker message size
    main-thread apply time

Only optimize if necessary.

## Possible future optimization

Move from:

    complete SimView
        ↓
    postMessage
        ↓
    complete mirror

toward:

    changed entities
        ↓
    delta
        ↓
    postMessage
        ↓
    apply delta

Example:

    {
        tick: 12832,
        changed: {
            rovers: [...],
            buildings: [...],
            alerts: [...]
        }
    }

Do not implement this until profiling shows full snapshots are actually a bottleneck.

## Recorded (Phase 24 complete — 2026-09-19)

Implemented on `arena/01a0bab6-red-frontier`.

**Performance Instrumentation.** In `src/sim/debug/Profiler.ts`, `WorkerSimHost.ts`, `workerRuntime.ts`, and `mirror.ts`:
- Tracked view generation time (`viewTimeMs`, `avgViewMs`)
- Tracked structured clone time (`structuredCloneTimeMs`, `avgStructuredCloneMs`, `worstStructuredCloneMs`)
- Tracked worker message payload size (`workerMessageBytes`, `avgWorkerMessageBytes`, `lastWorkerMessageBytes`)
- Tracked main-thread mirror apply time (`mainThreadApplyTimeMs`, `avgMainThreadApplyMs`, `worstMainThreadApplyMs`)

**Empirical Profiling Baseline:**
- View generation: ~0.2–0.5 ms
- Structured clone: < 0.15 ms
- Worker message payload: ~4.5–7.5 KB
- Main-thread apply: < 0.08 ms
- Full snapshots are confirmed to be well within the 60 FPS frame budget (< 1 ms combined overhead vs 16.6 ms frame budget), validating the roadmap guidance that delta complexity is unnecessary at current colony scale.

**Tests.** `tests/sim/worker-performance.test.ts` (3 checks) validates profiling coverage and frame budget invariants.

**Gate results**
- `npm run typecheck`: green
- `npm test`: 72 suites / 834 checks green
- `scripts/worker-smoke.mjs`: green on worker (`?worker=1`) and in-process (`?worker=0`)
- `behavior-baseline`: byte-identical


# 29. Phase 25 — Property-Based Simulation Testing

The deterministic architecture makes this particularly valuable.

Generate command sequences:

    move
    mine
    charge
    repair
    build
    stop
    salvage
    wait

Then verify invariants after every step.

Example invariant set:

    battery >= 0
    battery <= capacity

    cargo >= 0
    cargo <= capacity

    storage >= 0

    progress >= 0
    progress <= 1

    entity IDs remain unique

    reservations remain valid

    no invalid references exist

## Recorded (Phase 25 complete — 2026-09-19)

Implemented on `arena/01a0bab6-red-frontier`.

**Property-Based Simulation Testing Suite (`tests/sim/property-testing.test.ts`):**
- **Fuzzing randomized command streams:** Continuous generation of valid player commands (`rover/move`, `mine`, `unload`, `wait`, `construct`, `clean`, `repair`, `recover`, `salvage`, `stop`, `building/place`, `toggle`, `maintain`, `colonist/order`) executed against seeded simulations across varying step deltas.
- **Per-step invariant assertions:** Every step verifies `assertInvariants(sim)` checking id uniqueness, battery bounds, cargo bounds, non-negative storage, fluid ranges, grid capacity, building progress/health in [0, 1] / [0, 100], and task reference integrity.
- **Stress scenarios:** Verified invariant preservation under rapid building placement and demolition, and during severe environmental storms with continuous rover orders.
- **Deterministic replay property:** Replay of identical pseudo-random command sequences yields byte-identical `StateHash` signatures.

**Gate results**
- `npm run typecheck`: green
- `npm test`: 73 suites / 838 checks green
- `behavior-baseline`: byte-identical (2,400 ticks, two seeds)


# 30. Phase 26 — Deterministic Replay Testing

Build a command transcript format.

Example:

    {
        seed: 123456,
        commands: [
            {
                tick: 100,
                command: ...
            },
            {
                tick: 140,
                command: ...
            }
        ]
    }

Replay:

    transcript
        ↓
    Simulation
        ↓
    final state hash

The same transcript should always produce the same final hash.

This provides an extremely powerful regression mechanism.

Potential future uses:

    bug reports
    automated tests
    replay
    debugging
    multiplayer
    desync detection

## Recorded (Phase 26 complete — 2026-09-19)

Implemented on `arena/01a0bab6-red-frontier`.

**Transcript infrastructure unified (`src/sim/debug/Transcript.ts`):**
- Dropped inlined 150-line command dispatcher in favor of direct `applyCommand(sim, cmd)` delegation, eliminating the second source of truth for command execution.
- Added `replayAndHash(transcript)` convenience runner returning both `ReplayResult` and computed `StateHash`.
- Added `encodeTranscript` and `decodeTranscript` with full shape validation for JSON export/import.

**Pinned Canonical Scenario Regression Hashes (`tests/sim/transcript.test.ts`):**
- **Scenario 1 (Colony Foundation, seed 101):** Warehouse and solar placement, initial rover movement:
  `rf1-00d64469b1f8ed-045301f4e9a064`
- **Scenario 2 (Logistics Haul Loop, seed 2026):** Iron mining, automated repeat-route hauling to silos:
  `rf1-1b403011c4e077-15884ea6a10eb6`
- **Scenario 3 (Severe Storm Protocol, seed 303):** Severe storm onset, rover shelter rules, colonist EVA recall, storm clearance:
  `rf1-050d43576ad423-12a3abe54893ea`

**Gate results**
- `npm run typecheck`: green
- `npm test`: 73 suites / 842 checks green
- `behavior-baseline`: byte-identical (2,400 ticks, two seeds)


# 31. Phase 27 — Simulation State Hashing

**Delivered early.** The tool itself was pulled forward into Milestone 1 so
the extraction phases already have it: `src/sim/debug/StateHash.ts` exposes
`hashSimulation(sim)` → `rf1-<14 hex>-<14 hex>` (two cyrb53 lanes over a
canonical-JSON projection of live authoritative state). Covered by
`tests/sim/state-hash.test.ts`. What remains for this phase is the *uses*
described below — pinning expected hashes for canonical scenarios and wiring
them into the transcript/replay infrastructure.

Add a development/test-only deterministic state hash.

Hash important simulation state:

    tick
    simulation time
    RNG state
    rover state
    building state
    resources
    weather
    exploration
    colonist state

Then:

    seed + commands
        ↓
    simulation
        ↓
    SHA/hash
        ↓
    expected result

This can detect subtle behavioral regressions that ordinary tests miss.


# 32. Phase 28 — Performance Regression Tests

Once the architecture is stable, establish performance thresholds.

Examples:

    10 rovers
    25 rovers
    50 rovers
    100 rovers
    250 rovers

Measure:

    simulation tick
    pathfinding
    view creation
    worker transport
    memory

Do not make arbitrary performance requirements before profiling.

The baseline should be generated from actual measurements.


# 33. Phase 29 — Large-Colony Stress Tests

Create deterministic stress scenarios.

Scenario:

    100 rovers
    250 buildings
    high production
    active storm
    multiple construction jobs
    multiple hauling jobs
    exploration
    automation enabled

Run for:

    1 simulated hour
    1 simulated day
    7 simulated days

Verify:

    no invalid state
    no memory explosion
    no runaway task creation
    no duplicated reservations
    no simulation deadlock
    deterministic final state


# 34. Phase 30 — Optional Future Network Boundary

Do NOT implement networking during this refactor.

However, maintain the architecture so that this remains possible.

Current:

    Browser
        ↓
    SimHost
        ↓
    Worker
        ↓
    Simulation

Potential future:

    Browser
        ↓
    NetworkSimHost
        ↓
    WebSocket
        ↓
    Authoritative Server
        ↓
    Simulation

The existing command/view architecture is already well suited to this.

Do not pollute the simulation with:

    WebSocket
    HTTP
    DOM
    browser APIs

The simulation should remain completely unaware of its transport.


# 35. Things NOT to Modify

These should be treated as architectural invariants.

## Do not replace the simulation architecture

Do not rewrite the simulation around:

    React state
    Redux
    Zustand
    MobX
    Vue state
    global event buses

The existing simulation ownership model is better suited to the game.

---

## Do not introduce Three.js into `sim/`

Never:

    import THREE from simulation code

The simulation must remain renderer-independent.

---

## Do not introduce DOM APIs into `sim/`

Never allow:

    document
    window
    HTMLElement
    canvas
    DOM events

into simulation code.

---

## Do not allow UI mutation

Never allow:

    UI → directly modify simulation state

Always:

    UI
      ↓
    command
      ↓
    simulation

---

## Do not make the renderer authoritative

Never let:

    Three.js collision
    Three.js position
    Three.js terrain

become the simulation truth.

---

## Do not remove deterministic RNG streams

Do not consolidate all random numbers into one RNG.

Maintain separate streams for independent systems.

---

## Do not remove save versioning

Do not replace:

    versioned save
    migration
    validation

with:

    JSON.parse()
    ↓
    restore()

---

## Do not change worker semantics casually

The worker should continue to receive simulation time from the host.

Do not give the worker an independent uncontrolled clock unless the architecture is deliberately redesigned and thoroughly tested.


# 36. Things That Should Probably NOT Be Refactored Yet

Avoid these until the system is larger or profiling demonstrates a need.

## ECS

Do not convert the entire simulation to ECS yet.

Current:

    domain objects
    +
    systems

is a good fit.

---

## WebAssembly

Do not move simulation logic to WebAssembly just because the game is computational.

Measure first.

---

## SharedArrayBuffer

Do not introduce shared memory until:

    postMessage
    structured cloning
    view generation

are demonstrated bottlenecks.

---

## Hierarchical pathfinding

Do not implement a sophisticated navigation hierarchy until the current navigation system becomes demonstrably expensive.

---

## Networking

Do not add multiplayer infrastructure during the architectural refactor.

Preserve the possibility without paying the complexity cost.


# 37. Additional Recommendation — Definitions Should Become More Data-Driven

Continue moving balance and content into definitions.

Prefer:

    BuildingDefinition
    RoverDefinition
    ResourceDefinition
    ProcessDefinition
    BlueprintDefinition

over:

    if building.type === ...
        special behavior

The ideal direction is:

    Definitions
        ↓
    Generic Systems
        ↓
    State

This makes content expansion much easier.


# 38. Additional Recommendation — Separate Definition From Runtime State

Avoid mixing:

    static definition

with:

    mutable state

Example:

    RoverDefinition

contains:

    maximumBattery
    cargoCapacity
    speed
    miningRate
    maintenanceRate

while:

    RoverState

contains:

    battery
    cargo
    position
    condition
    task
    status

This distinction will become increasingly important as more rover types are added.


# 39. Additional Recommendation — Create a Resource Ledger

Resource accounting will become increasingly complicated.

Consider a centralized concept:

    ResourceLedger

tracking:

    produced
    consumed
    reserved
    available
    delivered
    lost

For example:

    total
      -
    reserved
      -
    consumed
      =
    available

This prevents multiple systems from inventing slightly different interpretations of resource availability.


# 40. Additional Recommendation — Reservations Need One Owner

This is particularly important for automation.

Avoid:

    ConstructionSystem
        modifies reservation

    RoverSystem
        modifies reservation

    LogisticsSystem
        modifies reservation

Instead:

    ReservationManager
        owns reservation state

Systems request:

    reserve(resource)

    release(reservation)

    consume(reservation)

This will prevent difficult-to-debug resource duplication bugs.


# 41. Additional Recommendation — Introduce Simulation Contexts Carefully

Systems may eventually need common information:

    dt
    tick
    state
    events
    RNG
    definitions

Rather than passing ten parameters everywhere, create:

    SimulationContext

Example:

    {
        state,
        dt,
        tick,
        events,
        definitions,
        rng
    }

However:

> Do not put every service in `SimulationContext`.

Avoid turning it into another God Object.

The context should contain shared simulation primitives, not arbitrary managers.


# 42. Additional Recommendation — Prefer Pure Functions Where Practical

Not everything needs to be a class.

Good candidates:

    calculatePower()
    calculateProduction()
    calculateResourceCost()
    canPlaceBuilding()
    calculateTerrainSlope()
    calculatePathCost()
    evaluateJob()
    calculateLifeSupportConsumption()

Pure functions provide:

    deterministic behavior
    simple tests
    low coupling
    easy reasoning


# 43. Additional Recommendation — Avoid Excessive Abstraction

Do NOT create:

    IBuildingManager
    IBuildingService
    IBuildingRepository
    IBuildingProvider
    IBuildingFactory

unless there is an actual reason.

The goal is:

    meaningful boundaries

not:

    maximum number of files.


# 44. Testing Strategy

Every refactoring phase should use four levels of testing.

## Level 1 — Unit tests

Test:

    pure functions
    individual systems
    state transitions
    validators

Fast and numerous.

---

## Level 2 — Simulation integration tests

Test:

    multiple systems interacting

Examples:

    power → production
    weather → power
    power → life support
    rover → logistics
    construction → logistics
    automation → rover

---

## Level 3 — Determinism tests

Same:

    seed
    commands
    time

must produce:

    same result

---

## Level 4 — Browser/Worker tests

Verify:

    LocalSimHost
    WorkerSimHost

produce equivalent results.

The worker boundary must continue to work after every major refactor.


# 45. Required Regression Matrix

After each major phase:

    ┌───────────────────────────────┐
    │ REGRESSION CHECK              │
    ├───────────────────────────────┤
    │ TypeScript compile            │
    │ Unit tests                    │
    │ Integration tests             │
    │ Determinism tests             │
    │ Persistence tests             │
    │ Local host tests              │
    │ Worker host tests             │
    │ Browser smoke tests           │
    │ Production build              │
    └───────────────────────────────┘

For high-risk phases:

    RoverSystem
    AutomationSystem
    Persistence
    SimView
    Worker transport

also run:

    large deterministic scenario


# 46. Git Strategy

Do not create one enormous refactoring commit.

Prefer:

    phase/01-baseline
    phase/02-invariants
    phase/03-colony-state
    phase/04-persistence
    phase/05-clock
    phase/06-weather
    phase/07-power
    phase/08-life-support
    phase/09-production
    phase/10-construction
    phase/11-rover
    phase/12-automation
    phase/13-logistics
    phase/14-exploration
    phase/15-failures
    phase/16-alerts
    phase/17-history
    phase/18-simulation
    phase/19-game
    phase/20-simview
    phase/21-events
    phase/22-navigation
    phase/23-performance
    phase/24-replay

Each phase should ideally produce:

    code
    tests
    documentation
    clean build


# 47. Commit Strategy

Prefer commits such as:

    refactor(sim): extract persistence codec
    test(sim): add save migration coverage
    refactor(sim): extract clock system
    test(sim): add clock determinism coverage
    refactor(sim): extract weather system
    test(sim): add weather regression scenarios

Avoid:

    refactor: clean everything

A future developer should be able to identify:

    what changed
    why it changed
    what behavior was protected


# 48. Phase Completion Checklist

A phase is complete only when:

    [ ] Responsibility has a clearly defined owner.
    [ ] Dependencies point in the correct direction.
    [ ] Existing behavior remains intact.
    [ ] Tests cover extracted behavior.
    [ ] Determinism tests pass.
    [ ] Worker tests pass.
    [ ] Production build passes.
    [ ] No presentation dependency leaked into simulation.
    [ ] No duplicate source of truth was introduced.
    [ ] Documentation reflects the new architecture.


# 49. Desired Dependency Direction

The final dependency graph should resemble:

    Definitions
         ▲
         │
       Systems
         ▲
         │
      State/Model
         ▲
         │
    Simulation
         ▲
         │
       Host
         ▲
         │
    Application
         ▲
         │
    Presentation


The following should NEVER occur:

    sim → ui
    sim → render
    sim → DOM
    sim → Three.js
    systems → Game
    renderer → direct simulation mutation
    UI → direct simulation mutation


# 50. Desired Final Source Layout

    src/
    │
    ├── main.ts
    │
    ├── app/
    │   ├── Game.ts
    │   ├── GameLoop.ts
    │   ├── InputController.ts
    │   ├── SelectionController.ts
    │   ├── BuildController.ts
    │   ├── SaveController.ts
    │   └── MenuController.ts
    │
    ├── sim/
    │   │
    │   ├── Simulation.ts
    │   ├── ColonyState.ts
    │   ├── SimulationContext.ts
    │   │
    │   ├── model/
    │   │   ├── Rover.ts
    │   │   ├── Building.ts
    │   │   ├── Colonist.ts
    │   │   └── ...
    │   │
    │   ├── systems/
    │   │   ├── ClockSystem.ts
    │   │   ├── WeatherSystem.ts
    │   │   ├── PowerSystem.ts
    │   │   ├── LifeSupportSystem.ts
    │   │   ├── ProductionSystem.ts
    │   │   ├── ConstructionSystem.ts
    │   │   ├── RoverSystem.ts
    │   │   ├── FleetAutomationSystem.ts
    │   │   ├── LogisticsSystem.ts
    │   │   ├── ExplorationSystem.ts
    │   │   ├── FailureSystem.ts
    │   │   ├── AlertSystem.ts
    │   │   └── HistorySystem.ts
    │   │
    │   ├── world/
    │   │   ├── World.ts
    │   │   ├── Terrain.ts
    │   │   └── NavGrid.ts
    │   │
    │   ├── persistence/
    │   │   ├── SaveSchema.ts
    │   │   ├── SaveCodec.ts
    │   │   ├── SaveValidator.ts
    │   │   └── migrations/
    │   │
    │   ├── host/
    │   │   ├── protocol.ts
    │   │   ├── view.ts
    │   │   ├── LocalSimHost.ts
    │   │   ├── WorkerSimHost.ts
    │   │   └── ...
    │   │
    │   └── debug/
    │       ├── SimulationAssertions.ts
    │       └── StateHash.ts
    │
    ├── render/
    │
    ├── ui/
    │
    ├── audio/
    │
    ├── dev/
    │
    ├── lib/
    │
    └── tests/


# 51. Recommended Execution Order

The order matters.

    PHASE 0
    Baseline
        ↓
    PHASE 1
    Invariants
        ↓
    PHASE 2
    ColonyState
        ↓
    PHASE 3
    Persistence
        ↓
    PHASE 4
    Clock
        ↓
    PHASE 5
    Weather
        ↓
    PHASE 6
    Power
        ↓
    PHASE 7
    Life Support
        ↓
    PHASE 8
    Production
        ↓
    PHASE 9
    Construction
        ↓
    PHASE 10
    Rover
        ↓
    PHASE 11
    Rover State Simplification
        ↓
    PHASE 12
    Automation
        ↓
    PHASE 13
    Logistics
        ↓
    PHASE 14
    Exploration
        ↓
    PHASE 15
    Failure
        ↓
    PHASE 16
    Alerts
        ↓
    PHASE 17
    History
        ↓
    PHASE 18
    Simulation Simplification
        ↓
    PHASE 19
    Game Simplification
        ↓
    PHASE 20
    SimView Hardening
        ↓
    PHASE 21
    Domain Events
        ↓
    PHASE 22
    Command Architecture
        ↓
    PHASE 23
    Navigation Optimization
        ↓
    PHASE 24
    Worker/View Optimization
        ↓
    PHASE 25
    Property Testing
        ↓
    PHASE 26
    Replay Testing
        ↓
    PHASE 26
    Performance/Stress Testing


# 52. Highest-Risk Phases

The following phases deserve additional caution.

## Highest risk

    RoverSystem
    FleetAutomationSystem
    Persistence
    SimView
    Simulation restructuring

These interact with many parts of the game.

---

## Medium risk

    Construction
    Logistics
    Production
    Life Support
    Exploration

---

## Lower risk

    Clock
    Weather
    History
    Assertions
    Diagnostics


# 53. What Success Looks Like

The refactor is successful when adding a feature no longer requires editing a giant central simulation class.

For example:

    Add new rover type

should primarily involve:

    RoverDefinition
    assets
    UI metadata
    tests

rather than:

    Simulation.ts
    Game.ts
    Renderer.ts
    multiple unrelated systems


Another example:

    Add new production building

should primarily involve:

    BuildingDefinition
    ProcessDefinition
    assets
    tests

rather than embedding new production rules throughout the simulation.


# 54. Final Architectural Goal

The ultimate goal is not fewer lines of code.

It is **fewer reasons for one file to change**.

The ideal architecture should make this possible:

    "I am changing power generation."

Only:

    PowerSystem
    relevant definitions
    power tests

need substantial changes.


    "I am changing rover mining."

Only:

    RoverSystem
    mining definitions
    rover tests

need substantial changes.


    "I am changing how the HUD displays alerts."

Only:

    Alert view
    UI
    presentation tests

need substantial changes.


    "I am changing save compatibility."

Only:

    SaveCodec
    SaveSchema
    migrations
    persistence tests

need substantial changes.


# 55. The Most Important Constraint

Do not optimize for architectural purity.

Optimize for:

    deterministic behavior
    clear ownership
    testability
    predictable dependencies
    performance
    extensibility
    debugging
    maintainability

If a simple function is better than a class:

    use the function.

If a system needs to be a class:

    use a class.

If an abstraction isn't solving a real problem:

    don't create it.


# 56. Final Target

The completed refactor should result in:

    ┌─────────────────────────────────────────┐
    │                 GAME                    │
    ├─────────────────────────────────────────┤
    │ Application                             │
    │   Game / Input / Selection / Saving     │
    ├─────────────────────────────────────────┤
    │ Host                                    │
    │   Local / Worker / Future Network       │
    ├─────────────────────────────────────────┤
    │ Simulation                              │
    │                                         │
    │   Simulation = orchestrator             │
    │   ColonyState = authoritative state     │
    │                                         │
    │   Systems                               │
    │   ├── Clock                             │
    │   ├── Weather                           │
    │   ├── Power                             │
    │   ├── Life Support                      │
    │   ├── Production                        │
    │   ├── Construction                      │
    │   ├── Rover                             │
    │   ├── Automation                        │
    │   ├── Logistics                         │
    │   ├── Exploration                       │
    │   ├── Failure                            │
    │   ├── Alerts                            │
    │   └── History                            │
    │                                         │
    │   Persistence                            │
    │   World / Navigation                    │
    ├─────────────────────────────────────────┤
    │ View                                    │
    │   Immutable SimView                     │
    ├─────────────────────────────────────────┤
    │ Presentation                            │
    │   Three.js / UI / Audio                 │
    └─────────────────────────────────────────┘


# 57. Recommended Overall Strategy

The strongest implementation strategy is:

    Stabilize
        ↓
    Add tests
        ↓
    Extract
        ↓
    Verify
        ↓
    Extract
        ↓
    Verify
        ↓
    Simplify
        ↓
    Profile
        ↓
    Optimize


Do NOT do:

    Rewrite
        ↓
    Hope it works
        ↓
    Debug 4,400 lines of changed behavior


The existing Red Frontier architecture is already valuable.

The refactor should therefore be viewed as:

    "turning a successful prototype architecture into a scalable
     production architecture"

rather than:

    "replacing the architecture."


# 58. Recommended First Milestone

The first concrete milestone should be:

    Milestone 1 — Safe Refactoring Foundation

    [x] Baseline repository                       (Phase 0, PR #38)
    [x] Full test suite green                     (Phase 0)
    [x] Production build green                    (Phase 0)
    [x] Worker mode verified                      (Phase 0)
    [x] Local mode verified                       (Phase 0)
    [x] Simulation invariant checker              (Phase 1, PR #40)
    [x] Deterministic state hashing               (src/sim/debug/StateHash.ts)
    [x] Performance instrumentation               (src/sim/debug/Profiler.ts)
    [x] Save validation tests                     (tests/sim/save-validation.test.ts)
    [x] Command transcript test infrastructure    (src/sim/debug/Transcript.ts + tests/sim/transcript.test.ts)

Only after this milestone should the first major extraction begin.

## Recorded (Milestone 1 complete — 2026-09-16)

Implemented on `arena/01a0a815-red-frontier` continuation.

**What was built**

- `src/sim/debug/Profiler.ts` — development-only diagnostics (process-wide switch,
  default off, `setProfilerEnabled(true)` in `tests/harness.ts`):
  `recordStep(ticks, ms)`, `recordPathfinding()`, `recordCommand()`,
  `recordWorkerMessage()`, `recordViewGeneration(ms)`, `snapshot(sim)` and
  `report(sim)` → summary + table:

      ┌─────────────────────────────┐
      │ SIMULATION PROFILER         │
      ├─────────────────────────────┤
      │ Tick:             18,432    │
      │ Sim Time:         3.2 days  │
      │ Step:             1.7 ms    │
      │ View:             0.6 ms    │
      │ Pathfinding:      0.3 ms    │
      │ Entities:             37    │
      │ Commands:              4    │
      └─────────────────────────────┘

  Integration: `Simulation.step()` measures tick batch time, `NavGrid.findPath()`
  increments pathfinds, `applyCommand()` increments commands,
  `WorkerSimHost` and `workerRuntime` increment workerMessages, `projectView()`
  measures view generation time. Observationally inert (same snapshot with profiler
  on/off), tree-shakes out of app bundle when not imported.

- `tests/sim/save-validation.test.ts` — 26 checks: empty save, missing version,
  unsupported version, non-object save, invalid task shapes (coerced to idle),
  pending queue filtering, invalid building/rover/poi refs, negative storage,
  fluid clamping, battery/cargo bounds, missing arrays, corrupt weather fallback,
  lightningMul fallback, invalid poi kind filtering, reservedBy coercion,
  plus historical migration coverage for v3→v8 and round-trip determinism after
  migration. Fulfills Phase 3's malformed-save requirements.

- `src/sim/debug/Transcript.ts` — command transcript format:
  `{ seed, difficulty?, worldHalf?, region?, worldOptions?, commands: [{ tick, command }], durationTicks? }`
  `replayTranscript(transcript)` replays deterministically (sorted by tick,
  tick-0 pre-delivery, fixed-step loop), `TranscriptBuilder` ergonomic helper,
  `validateTranscript()` shape validation, `canonicalTranscriptJson()` stable JSON.
  `tests/sim/transcript.test.ts` — 12 checks: validation, canonical stability,
  same-transcript identical hash, different seed/commands diverge, building placement,
  mining haul, builder ergonomics, empty transcript, manual vs transcript replay,
  hash pinning (`rf1-…` format).

**Gate results** (Node 22.22.3, 2 CPU workers, after this continuation)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` (48 suites / 471 checks) | green — ~135 s wall clock |
| `npm run test:check` | green — all suites linked, all declare `@covers` |
| `npm run build` | green — `index.js` 989 kB (288 kB gz), unchanged (debug modules tree-shake) |
| `mobile-smoke` (worker) | green (existing) |
| `mobile-smoke` (`?worker=0`) | green (existing) |
| `worker-smoke` both transports | green (existing) |

Milestone 1 is now fully green. The next extraction per roadmap §51 is **Phase 2 — ColonyState**, followed by **Phase 3 — Persistence** as the first major extraction.

The first extraction should then be:

    Persistence

followed by:

    Clock
    Weather
    Power
    Life Support
    Production
    Construction
    Rover
    Automation
    Logistics
    Exploration

This order minimizes risk while progressively reducing the size and responsibility of `Simulation.ts`.
