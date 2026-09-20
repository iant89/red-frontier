> ← [Home](Home.md)

# Simulation Systems

`Simulation.ts` is a thin orchestrator: it owns `ColonyState`, wires hooks between
systems, and runs one authoritative tick order. Domain behaviour lives in
`src/sim/systems/`, where each system is a **static API over state** — no
instances, no hidden ownership, no DOM.

> **The tick order is load-bearing.** The header comment in
> [`src/sim/Simulation.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/Simulation.ts)
> says *"Authoritative tick order — preserve exactly (roadmap §22 / Phase 18). Do
> not reorder without ask-user."* Reordering is a behaviour change: a rover that
> moves before the power grid has resolved spends battery it does not have yet.

## Tick order (as-built)

| # | Call | Why it sits there |
|---|---|---|
| 1 | `ClockSystem.tick` | The sol and the authoritative `SunState` — everything downstream reads the sun |
| 2 | `WeatherSystem.tick` | Wind, dust, storm envelopes, lightning; needs the clock, feeds everyone else |
| 2b | `ExplorationSystem.tick` | Discovery, scheduled drops, burial clocks — independent of colony internals |
| 3–4 | `PowerSystem.tick` | The grid resolves generation → batteries → consumers by tier |
| | `WaterSystem.tick` | Pumped flow between commissioned tanks, scaled by supplied power |
| | `GarageSystem.tick` | Fast charge, drivetrain service, assembly line — all consume `powerSat` |
| | `UpgradeSystem.tick` | Paid refit/installation progress |
| | `MaintenanceSystem.tickBays` | Repair Bay jobs (power-scaled, one at a time) |
| 5 | `LifeSupportSystem.tick` | Fluid draw and the colonist's needs |
| 6–8 | `ConstructionSystem.tickSiteMaterials` → `assignBuilders` | Sites accumulate reserved mass, then crews are pulled from the fleet |
| | `FleetAutomationSystem.tick` | The job model and autonomous dispatch — must run before movement so a dispatched rover moves today |
| | `RoverSystem.tickLights` → `updateRover` → `moveRover` (per rover) | Orders resolve into a goal/phase, then the body executes and drives |
| | `LifeSupportSystem.tickColonist` | EVA progress and suit draw after movement |
| | `MaintenanceSystem.tickWear` | Wear accrues from the work actually done this tick |
| 9 | `evaluateAlerts` → `HistorySystem.tick` | Conditions become alerts, vitals get sampled |

Production (`ProductionSystem`) is invoked through the power and life-support
hooks rather than as its own numbered step: the grid asks a building what it
*wants* (`desiredThroughput`), then what it *earned* (`runProcess`).

## The systems

| System | Owns |
|---|---|
| `ClockSystem` | the sol, `SunState`, time-of-day, speed modes |
| `WeatherSystem` | storm roll cadence, envelopes, the spatial field, damage, the powered-radar capability, the forecast |
| `PowerSystem` | tiers, satisfaction, brownout shedding, battery flow |
| `ProductionSystem` | what a process wants, why it is idle, the mass it moves, the units it racks, which line a building runs |
| `LifeSupportSystem` | fluid pools, the colonist, EVA orders, shelter state |
| `ConstructionSystem` | siting verdicts, site materials, crews, progress, completion, refunds |
| `RoverSystem` | fleet commands, the task lifecycle, movement, every task body |
| `FleetAutomationSystem` | the job model + autonomous dispatch against reservations |
| `LogisticsSystem` | the bulk (kg) ledger, cargo, reservations — one owner |
| `ComponentSystem` | the manufactured-unit ledger: rack space, whole units |
| `MaintenanceSystem` | installed rover part wear + Repair Bay replacement jobs |
| `ExplorationSystem` | discovery, drops, burial, salvage rewards |
| `GarageSystem` | fast charge, drivetrain service, the assembly line |
| `UpgradeSystem` | permanent upgrade tiers, timed installation jobs, paint |
| `WaterSystem` | pipe topology, commissioning, pumped flow between tanks |
| `FailureSystem` | failure outcomes as domain events |
| `AlertSystem` | domain events → `state.alerts` (keys, dedupe, expiry) |
| `HistorySystem` | vitals time series + the flow-window roll |

## State

`src/sim/state/` holds **data with no behaviour**: `ColonyState` plus
`RoverState`, `BuildingState`, `PowerState`, `ResourceState`, `WaterState`,
`WeatherState`, `HistoryState`, `EntityStore`. The model is not a classic ECS —
the PDF's components map onto fields:

| PDF component | As-built |
|---|---|
| Transform | `x, z, rot` on entities (y from terrain) |
| Health | building `health` / colonist `health` |
| Inventory | rover cargo + per-resource base stockpiles |
| PowerConsumer / Producer | derived each tick from `BUILDINGS` defs + state |
| Storage | per-resource capacities (deliberately not one shared pool) |
| TaskController | rover `command` + `pending` queue |
| Maintenance | building health/dirt; rover `condition`, part health |
| NetworkNode | power only (implicit, via the global resolver) + commissioned water topology |
| ResearchNode | **OUT** — no `research` symbol exists in `src/` |

## Two channels out of the sim

- **Domain events** (`sim/domainEvents.ts`) are per-tick, structured, plain
  serializable records (`rover/disabled`, `building/placed`, …) pushed into a
  collector the host drains after a step. It is *not* a pub/sub bus.
- **Alerts** (`sim/alerts.ts`) keep *conditions that are currently true* (raised
  once, cleared once) distinct from *events that happened* (streamed to the log).
  That separation is what stops a brownout producing 200 identical log lines.

## Rules shared across the boundary

[`src/sim/rules.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/rules.ts)
holds `evaluateSite` (siting verdicts) and `maintenanceNeed`. Both sides of the
worker run the *same* function, which is why the placement ghost and the
simulation can never disagree about whether a pad fits — one tick of lag at most,
never a different rule.

## Adding a system

1. Add `src/sim/systems/<Name>System.ts` exporting a static API over `ColonyState`.
2. Call it from the tick in the slot where the data it needs already exists.
3. Persist anything it owns (see [Persistence and Save Format](Persistence-and-Save-Format.md))
   and add a migration step if the shape changed.
4. Add a suite per system — the project has one per extracted system
   (`tests/sim/power-system.test.ts`, `…/rover-system.test.ts`, …) pinning the
   moved behaviour, exactly as the refactor phases did.
