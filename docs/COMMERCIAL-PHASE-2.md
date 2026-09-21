# Red Frontier — Commercial Phase 2: Engineering Projects

*Implementation spec for Phase 2 of COMMERCIAL-ROADMAP.md, re-baselined per COMMERCIAL-ROADMAP-REVIEW.md §5 P2 and §3.3.*
*Status: DONE — ObjectiveSystem + data-driven project table + unlock registry + projects panel shipped; follow-ups (HUD pip, difficulty-scaled autonomy, blueprint gating mechanism, M2 playtest instrument) landed.*
*Branches: `arena/01a0c09f-red-frontier` (core), `arena/01a0c0f6-red-frontier` (follow-ups) · save v15 · suite 94 suites / 1091 checks*

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
| **Autonomous Colony** | 3 / 5 / 10 sols (settler / pioneer / survivor) without a manual order | Autonomous Colony |

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
| `solsWithoutOrder` | Phase 3's autonomy streak (`clock.solsElapsed − autonomy.startedAt`, whole sols) — ends on accepted orders *and* breakers; target is a `ScaledNumber` read by `state.difficulty` |

A requirement's target may be a **`ScaledNumber`** — a plain number, or a
`{ settler, pioneer, survivor }` table resolved by `scaledTarget()` against
`ColonyState.difficulty` (falling back to `pioneer`, then to whatever the table
carries, never to zero). That is how the review's difficulty-scaled autonomy
(§3.2) lives in the catalogue as data rather than as a branch in the evaluator;
any other requirement can adopt it by widening its field type.

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

It has one consumer today — **blueprint gating** — and the gate is empty by
design. `BuildingDef.requiresUnlock?: UnlockId` seals a blueprint until the
colony holds the unlock; one rule, `blueprintLock()`, is read by the sim's
siting authority (`ConstructionSystem.verdict`, which also covers `place` and
the dev backdoor), by the worker mirror's optimistic `placeVerdict` (from the
projected unlock list, so the ghost and the placement agree), and by the build
bar, which keeps the sealed blueprint visible with a 🔒 badge naming the
missing unlock and turns a click into a hintbar explanation instead of an armed
ghost. No shipping blueprint sets `requiresUnlock` — the roadmap's own review
insists the first projects be completable with today's building set, and the
catalogue integrity test asserts both that nothing is gated and that no project
could ever require the building its own reward unseals. Phase 3's policies
(`advancedAutomation`) and Phase 7's POI contents are the next consumers.

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
| UI | `src/ui/ProjectsPanel.ts` + `#projects-panel` styles (docks beside the vitals; header click collapses it to a headline, remembered in `rf-collapse-projects`) |
| HUD pip | `projectPip()` in `ProjectsPanel.ts`, rendered as `#proj-pip` on the vitals header: lead project + `met/total` (+N more), toned `idle / progress / near / done` by situation, tooltip names the next unmet requirement; click toggles the card |
| Gating | `BuildingDef.requiresUnlock`, `blueprintLock` / `blueprintLockReason` in `unlocks.ts`, enforced in `ConstructionSystem.verdict` and `ColonyMirror.placeVerdict`; `.build-btn.locked` + `.lock` badge in the HUD |
| Playtest | `docs/PLAYTEST-M2.md` protocol; dev panel **Playtest (M2)** section (`playtestReadout` / `playtestReadoutText`, copy-to-clipboard) |
| Save | schema **v15**, migration `v14.ts`, snapshot/restore with sanitising, validator warnings |
| Hash | objectives / unlocks / `lastDirectOrderSol` in the `core` section — pinned hashes re-recorded |
| Tests | `tests/sim/objectives.test.ts` (27), `tests/ui/projects-panel.test.ts` (9), `tests/hud/panels.test.ts` (+2 pip / lock), `tests/hud/devpanel.test.ts` (+1 readout) |

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

- [x] **Situation-driven pips on the HUD**: `#proj-pip` on the vitals header.
      The panel carries the detail; the pip carries the glance, and survives the
      card being collapsed.
- [x] **Difficulty-scaled autonomy**: `autonomousColony` asks for
      `{ settler: 3, pioneer: 5, survivor: 10 }` sols via `ScaledNumber` — the
      number stayed in the data table.
- [x] **Blueprint gating**: the mechanism (`requiresUnlock`) is in, enforced on
      both sides of the host boundary and shown on the build bar. The table
      gates nothing, and a test keeps it that way until a phase chooses to.
- [x] **Playtest (M2) — instrumented**: protocol in `docs/PLAYTEST-M2.md`;
      dev panel readout gives the facilitator the ground truth to score against.
- [ ] **Playtest (M2) — run it**: five or more sessions per the protocol. A
      human task; tick this with the session count and median score.

Also fixed on the way: a Settler (or "abundant supplies") start seeded the pod
with more oxygen than its tank holds, which the `fluid-range` invariant refused
on the first tick. Starting fluids are now clamped to pod capacity.

## Definition of done (review §7)

- **M2**: playtesters can state their current project's goal unprompted — the
  panel, the pip and the measuring instrument are shipped; the sessions are the
  open item.

## How to run

```bash
npm run typecheck
npm test                     # 94 suites / 1091 checks (sim/objectives, ui/projects-panel, hud/panels, hud/devpanel)
npm run test:replay          # canonical hashes including the new state sections
npm run test:golden          # golden colony hash
npm run dev                  # the projects card is beside the vitals from sol 1; the pip is on the vitals header
```
