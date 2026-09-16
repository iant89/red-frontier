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
    Navigation Optimization
        ↓
    PHASE 23
    Worker/View Optimization
        ↓
    PHASE 24
    Property Testing
        ↓
    PHASE 25
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
