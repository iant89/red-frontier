# Red Frontier — Commercial Phase 2: Engineering Projects

*Implementation spec for Phase 2 of COMMERCIAL-ROADMAP.md, re-baselined per COMMERCIAL-ROADMAP-REVIEW.md §5 P2 and §3.3.*
*Status: DONE — ObjectiveSystem + data-driven project table + unlock registry + projects panel shipped.*
*Branch: `arena/01a0c09f-red-frontier` · save v15 · suite 94 suites / 1080 checks*

---

## Goal

> Give the player meaningful objectives beyond "build whatever you want."

The five projects from the roadmap, all five shipped:

| Project | Requirements | Reward (unlock) |
|---|---|---|
| **Establish Survival** | oxygenator, extractor, greenhouse, battery bank online; grid covering demand | Stable Operations |
| **Survive the First Storm** | weather radar, 400 kWh of battery, garage (fleet shelter), 80 kg water | Storm Forecasting |
| **Industrialize** | refinery, workshop, 300 kg ore in the silo, one automated haul route | Advanced Automation |
| **Remote Operations** | three rovers, RTG online, garage online, 100 kg water, 120 kg rations | Remote Exploration |
| **Autonomous Colony** | ten sols without a manual order | Autonomous Colony |

Two design decisions the review forced, both kept:

- **The flagship is last** (§3.2). "Survive 10 sols without manual intervention"
  is unfair before the colony is legible, so `autonomousColony` closes the chain
  instead of sitting on the board at sol 1. `Establish Survival` opens it; the
  storm and industry branches run in parallel off survival.
- **Honest to today's entities** (§5 P2). Every requirement names something that
  already ships — Battery Bank, Weather Radar Station, per-rover rules,
  `rover/repeatRoute`. The first projects are completable with the shipping
  building set, which is what protects the demo cutline. Where the roadmap's
  wording had no counterpart ("Communications"), the requirement was written
  against the machine that does the job and labelled as such.

---

## The rule this phase is built on: content is data

> *no project logic in code, only in data tables* — review §3.4

A project is a plain record:

```ts
{
  id: 'industrialize',
  title: 'Industrialize',
  blurb: '…', why: '…',
  after: ['establishSurvival'],        // prerequisites
  requirements: [ { type: 'buildingOnline', building: 'refinery', count: 1, label: '…' }, … ],
  rewards: ['advancedAutomation'],
}
```

Requirements are **declarative** (`src/sim/projects/types.ts`) and evaluated by
one pure module (`requirements.ts`) that reads `ColonyState` and answers
*current / target / met*. A predicate function would have put campaign logic in
TypeScript and made Phase 9 another system; with this shape a chapter is a list
of records with different numbers.

Adding a project is adding a record to `src/sim/projects/catalog.ts`. Adding a
requirement *kind* is one branch in the evaluator plus a row in the test table —
and the catalogue integrity check fails the suite if a new project forgets a
label, targets zero, rewards an unknown unlock, or depends on a project that
does not exist.

### Requirement kinds

| Kind | Reads |
|---|---|
| `buildingOnline` | buildings of a kind that are finished, undamaged and switched on |
| `storage` / `components` / `fluidAmount` | the bulk (kg), counted (units) and fluid (kg) ledgers |
| `batteryCapacity` | grid storage from online batteries plus the pod's own pack |
| `powerStable` | not shedding, the reserve above a floor, **and generation covering demand** |
| `roverRule` / `repeatRoute` / `roverCount` | what the fleet has been told to do, and how much of it there is |
| `stormsSurvived` / `poisDiscovered` | lifetime counters and the discovery map |
| `solsWithoutOrder` | `state.clock.sol − state.lastDirectOrderSol` |

`powerStable` is the one that took a second pass. "Not browning out and the
battery above 15%" let a colony complete the first project on the tick before
its machines had even spun up. The requirement now also demands a load and
generation that covers it: a colony drawing nothing is not stable, it is idle.

---

## The unlock registry (`src/sim/unlocks.ts`)

Phases 2, 7 and 9 all grant something, and there was no gating concept anywhere
in the sim; without one registry each of them would invent its own (§3.3). So
the registry ships *first*, as a saved, deterministic set of `unlockId`s with a
sol stamp and the id of whatever granted it.

It is deliberately **inert**: nothing is locked behind an unlock yet, and every
blueprint stays available from sol 1 — the roadmap's own review insists the
first projects be completable with today's building set. The first consumers are
Phase 3's policies (`advancedAutomation`) and Phase 7's POI contents.

---

## What shipped

| Layer | Files |
|---|---|
| Content | `src/sim/projects/catalog.ts` (5 projects), `types.ts` (requirement records), `requirements.ts` (evaluator) |
| Registry | `src/sim/unlocks.ts` (5 unlocks, grant/has/list, pure) |
| State | `src/sim/state/ObjectiveState.ts`; `ColonyState.objectives`, `.unlocks`, `.lastDirectOrderSol` |
| System | `src/sim/systems/ObjectiveSystem.ts` — offer, evaluate, complete, pay, project the view |
| Tick | `Simulation.tick`: `… → evaluateAlerts → TutorialSystem → ObjectiveSystem → HistorySystem` |
| Commands | `applyCommand` records a direct order against the autonomy streak (the one path every order takes, so a replay is faithful) |
| Events | `objective/offered`, `objective/completed`, `unlock/granted` |
| Read model | `ObjectiveView` in `host/viewModels.ts`, projected in `projection.ts`, mirrored in `mirror.ts` |
| UI | `src/ui/ProjectsPanel.ts` + `#projects-panel` styles (docks beside the vitals; collapses to a headline on a phone) |
| Save | schema **v15**, migration `v14.ts`, snapshot/restore with sanitising, validator warnings |
| Hash | objectives / unlocks / `lastDirectOrderSol` in the `core` section — pinned hashes re-recorded |
| Tests | `tests/sim/objectives.test.ts` (22), `tests/ui/projects-panel.test.ts` (6) |

---

## The autonomy streak (a Phase 3 dependency, recorded from sol 1)

AUTONOMY.md owns the full three-faced autonomy stat in Phase 3. But its streak
face is measured from `lastDirectOrderSol`, and a colony that only starts
recording orders in Phase 3 can never have a ten-sol streak in Phase 2. So the
field exists now, written by the command dispatcher:

- **Direct orders** reset it: `rover/*`, `building/*`, `water/*`, `colonist/order`.
- **Everything else does not**: `tutorial/dismiss`, `engineering/*`, `dev/*`. The
  classification is an *allow-list*, so Phase 3's future `policy/*` commands fall
  outside it without anyone remembering to exclude them — a policy doing the work
  is the fantasy working.
- **`dev/time` moves the marker with the clock**, so a time jump cannot hand the
  flagship project to a cheater.

---

## Remaining Phase 2 work

- [ ] **Playtest (M2)**: can a player state their current project's goal
      unprompted? This is now measurable — the panel is on screen from sol 1.
- [ ] **Situation-driven pips on the HUD**: the panel carries the detail; the
      review also asked for a compact pip beside the vitals. Deferred because it
      is a HUD change, and the panel answers the same question today.
- [ ] **Difficulty-scaled autonomy**: `autonomousColony` asks for a flat 10 sols.
      The review suggests 3 (settler) / 5 (pioneer); that is a balance pass, and
      the number lives in the data table when it happens.
- [ ] **Blueprint gating**: nothing is locked behind an unlock yet, by design.
      Phase 3's policies and Phase 7's POI rewards are the first consumers.

## Definition of done (review §7)

- **M2**: playtesters can state their current project's goal unprompted — the
  panel is shipped and testable; the playtest itself is the open item.

## How to run

```bash
npm run typecheck
npm test                     # 94 suites / 1080 checks (sim/objectives, ui/projects-panel)
npm run test:replay          # canonical hashes including the new state sections
npm run test:golden          # golden colony hash
npm run dev                  # the projects card is beside the vitals from sol 1
```
