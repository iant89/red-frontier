# Rover state model — command, goal, phase

Refactor roadmap **Phase 11 — Simplify Rover State**.

Phase 10 moved the fleet's behavior into `src/sim/systems/RoverSystem.ts`. Before
that file grows a second set of responsibilities, this document states what the
rover's state fields *mean*, which transitions are legal, and which of the
overlapping representations are actually separate concepts. It is the reference
for `RoverSystem`, `RoverState`, the persistence round-trip and the dev
overlays; `tests/sim/rover-state.test.ts` and `checkRoverExecution()` in
`src/sim/debug/SimulationAssertions.ts` are its executable form.

Where this document and the code disagree, the code is wrong (or the document is
stale) — fix one of them in the same change.

## 1. The four layers

| Layer | Fields | Persisted? | In `StateHash`? | Owner |
| --- | --- | --- | --- | --- |
| **Task** — *what the rover should do* | `command`, `pending` | yes (`RoverSave`) | yes | `RoverSystem` (issued by player commands, fleet automation, or `autoAssign`) |
| **Execution state** — *how it is doing it right now* | `goal`, `phase` | **no** — rebuilt on restore | yes | `RoverSystem` |
| **Conditions & progress** — *what the world is doing to it / what it holds* | `recharge`, `sheltered`, `routePaused`, `autoTask`, `gid`, `gx`, `gz`, `navPath`, `navI`, `battery`, `cargo`, `condition`, `chargeSat`, `lightsOn`, `lightsActive`, `lowBatteryNotified`, `blockNotified` | mixed: battery/cargo/condition/rules/flags persist, `gid`/`gx`/`gz`/`navPath`/`navI`/`chargeSat`/`lightsActive` do not | mostly yes | `RoverSystem`, `PowerSystem`, `ConstructionSystem` |
| **Presentation** — *wording* | *(none stored)* | — | no | `roverStatusText(r)` in `state/RoverState.ts` |

Two consequences fall straight out of that table:

1. **`goal`/`phase` are runtime execution state, not saved state.** A save round
   trip rebuilds them from `command`/`pending` plus the world (`RoverSystem.rehydrate`).
   Any rule about "what a restored rover is doing" therefore has to match the rules
   the live tick uses — which is why rehydration now lives next to them in
   `RoverSystem` instead of inline in `Simulation.restore`.
2. **Wording is not state.** There is no `statusText` field any more: the sim used
   to store one, but nothing in the game ever read it (the HUD calls
   `roverStatusText(r)` directly, the hash excludes wording, and saves never
   carried it), so it could only drift out of date. Phase 11 deleted it.

## 2. Task layer

`command` is the active task; `pending` is the queue behind it. Both are the
union `RoverTask` in `state/RoverState.ts`:

    idle | moveTo | mine{repeat?} | construct | clean | repair | recover{give,given} | salvage | unload | wait{seconds}

- **Issued by** the fifteen `RoverSystem.issue*` / `set*` verbs, `autoAssign`
  (the fleet's own dispatch), queue promotion in `finishTask`, and the dev
  backdoors. A `giveTask` order replaces the task and drops the queue unless it
  is queued behind player work (`giveTask`); `autoAssign` always replaces.
- **`repeat`** turns a mining task into a haul route. **`give`/`given`** are the
  jump-start transfer's plan and progress; they make the task the *only* place
  that knows how far a recovery has got.
- Assigning a task does **not** touch execution state: the next `updateRover`
  derives it. Between an order and the next tick, `goal`/`phase` still describe
  the previous task. That is deliberate — the order is intent, the tick is
  action.
- A task is complete when its body calls `finishTask` (promote the queue, or
  idle). `finishTask` never touches reservations: `giveTask` and `releaseReservations`
  own those, because a *replaced* task must drop its claim and a *completed* one
  already has.

## 3. Execution layer

`goal` is the **execution step**: which part of the current task the rover is
in. `phase` is the **coarse mode** the renderer, HUD, power grid and schedulers
ask about.

| `goal` | legal `phase` | meaning | entered by |
| --- | --- | --- | --- |
| `idle` | `idle`, `charging`, `disabled` | nothing in hand (charging: parked at a charger; disabled: flat pack) | initial state, `finishTask`, `stopRover`, `goIdle`, `onArrive` default, a completed rescue of *this* rover |
| `move` | `moving` | driving to an ordered point | `doMoveTo` → `setTravel('move')` |
| `mine` | `moving`, `working` | walking to a seam, or digging it | `doMine` → `setTravel('mine')` / arrives |
| `toDepot` | `moving` | hauling the hold home | `beginUnload`, `doUnload` |
| `toCharge` | `moving` | driving to a charger | `doRecharge` → `setTravel('toCharge')` |
| `charge` | `charging` | plugged in (or sheltering on a pad) | `doRecharge` arrival, storm recall |
| `toSite` | `moving` | walking to a build site | `ConstructionSystem.build` → `setTravel('toSite')` |
| `build` | `working` | assembling the site | `ConstructionSystem.build` at reach |
| `toService` | `moving` | walking to the building to service | `doService` → `setTravel('toService')` |
| `service` | `working` | cleaning or repairing | `doService` at reach |
| `toSalvage` | `moving` | walking to a wreck or drop | `doSalvage` → `setTravel('toSalvage')` |
| `salvage` | `working` | cutting the site apart | `doSalvage` at reach |
| `toRecover` | `moving` | responding to a stranded rover | `doRecover` → `setTravel('toRecover')` |
| `recover` | `working` | jumper cables connected, transferring | `doRecover` at hook-up range |

Every pair in this table is written by exactly one function — the named
transitions in `state/RoverState.ts` (`enterTravel`, `enterWork`, `enterCharge`,
`enterIdle`, `enterDisabled`); see §6.

`goal='x'` and `goal='toX'` are a **travel/arrived pair** for five tasks
(charge, site→build, service, salvage, recover). `mine` is the exception: it has
no `toMine` — the walk out uses `goal='mine'` with `phase='moving'`, which is why
`mine` is the one goal with two legal phases.

`toDepot` has no arrived twin either: arrival *is* `tryUnload`, which either
parks for a repeat route, sends the rover out again, or finishes the task.
`move` likewise ends in `finishTask` rather than an arrived state.

`unload` was a `RoverGoal` member that no code path ever assigned — a state that
cannot be entered. Phase 11 deleted it.

### Speed is derived, not stored

Nothing in the rover's state records how fast it is going. `moveRover` computes it
per tick as `def.cruiseSpeed × proximitySpeedMul(state, r)`, where the multiplier is
the proximity crawl from issue #11: 1 when the hull-clearance bubble
(`ROVER_PROXIMITY_CLEARANCE_M = 1.5`, or `…COLONY_CLEARANCE_M = 3.0` inside the pad
yard) is empty, otherwise an immediate drop to 28 % / 15 % — never 0, so a
nose-to-nose pair keeps inching. Three consequences for this state model:

1. There is **no new field** to persist, rehydrate, or hash — a restored rover
   re-derives its crawl from wherever it happens to be standing.
2. It changes **speed only**, never `goal` or `phase`: a crawling rover is still
   `moving` on the same task. No re-path, no alert, no interruption.
3. The current goal's **destination is exempt** once inside arrival reach, which is
   load-bearing: without it a builder crawling up to its own site (or a rescuer
   closing on a stranded rover) never reaches arrival and the job hangs. Move power
   scales with the multiplier so a crawl is a brake, not a battery tax; drivetrain
   wear does not (the wheels are still turning).

### Conditions that outrank the task

`updateRover` consults these **before** the command switch, which is why a rover
can hold a mining task and still be in `goal='toCharge'`:

- **Storm recall** (`rules.stormShelter`, weather at the rover, not already at a
  charger): sets `sheltered`, reuses the charge path (`recharge = true`), and the
  task waits underneath. Clearing the storm releases both.
- **Ride-home floor** (`rules.chargeFloorPct`, clamped up by the distance to the
  nearest charger): sets `recharge` and the rover drives home. `chargeFloorPct`
  is the player's rule; the clamp is the sim's.
- **Flat pack** (battery reaches 0 in `moveRover`, a task body, or `tickLights`):
  `disable()` strands the rover — `phase='disabled'`, `goal='idle'`, claims
  released. The tick loop skips disabled rovers entirely, so nothing re-derives
  execution state until a rescue lands (`doRecover` resets the stranded rover).

`PowerSystem` reads `phase === 'charging' || goal === 'charge'` to decide which
rovers draw charge; the renderer reads `phase === 'disabled'` and `lightsActive`;
the HUD reads `phase` through `roverStatusText`. Those are the readers that make
`phase` more than a convenience.

## 4. Transition table

Row = state, columns = what happens, cell = next state. "Work" means the task's
own body runs that tick; tasks re-evaluate every tick, so every transition is
re-entrant and idempotent.

    (idle, idle) ── moveTo order ───────────────► (move, moving) ── arrive ──► (idle, idle)
                 ── mine at seam ───────────────► (mine, working)
                 ── mine far away ──────────────► (mine, moving) ── arrive ─► (mine, working)
                 ── unload, hold empty ─────────► (idle, idle)
                 ── unload, away from depot ────► (toDepot, moving) ── arrive ─► unload
                 ── construct far ──────────────► (toSite, moving) ── arrive ─► (build, working)
                 ── clean/repair far ───────────► (toService, moving) ─ arrive ► (service, working)
                 ── salvage far ────────────────► (toSalvage, moving) ─ arrive ► (salvage, working)
                 ── recover far ────────────────► (toRecover, moving) ─ arrive ► (recover, working)
                 ── wait ───────────────────────► (idle, idle) [seconds tick down]

    (mine, moving|working)
        hold at target ──► (toDepot, moving)      seam dry, hold empty ──► (idle, idle)
        route + silo full ──► (idle, idle) with routePaused=true
        route/seam dry ──► (idle, idle) after logging completion

    (toDepot, moving) ── arrive ──► tryUnload
        repeat route / unfinished player mine / unfinished salvage ──► (idle, idle) [will re-plan]
        hold empty or single-trip ──► finishTask ──► (idle, idle) or the next queued task

    (toCharge, moving) ── arrive ──► (charge, charging)
    (charge, charging) ── battery ≥ 98 % (and not sheltering) ──► recharge=false, (idle, idle)
        storm still on and on a pad ──► stays (charge, charging), statusText "Sheltering from storm"

    (toSite, moving) ── arrive ──► (build, working) | (idle, idle) if the site is gone
    (build, working) ── progress 1 ──► ConstructionSystem.complete ──► (idle, idle)
        materials missing / worker stolen ──► finishTask ──► (idle, idle)

    (toService, moving) ── arrive ──► (service, working)
    (service, working) ── cleanliness ≥ 0.999 | health full ──► (idle, idle)

    (toSalvage, moving) ── arrive ──► (salvage, working)
    (salvage, working) ── hold full ──► beginUnload / tryUnload ──► (toDepot, moving) or parked
        site picked clean ──► cells to the grid store ──► (idle, idle)

    (toRecover, moving) ── arrive ──► (idle, idle) [onArrive's default; the next tick re-plans or hooks up]
    (recover, working) ── transfer complete ──► stranded rover reset, both recharge ──► (idle, idle)
        can't spare the charge ──► finishTask, (idle, idle)

    any ── storm recall ──► recharge=true ──► (toCharge, moving) ─► (charge, charging)
    any ── battery 0 ──► (idle, disabled)
    (idle, idle) at a charger, partially charged ──► (idle, charging)

## 5. Determination: are `command`, `goal` and `phase` separate concepts?

**Yes — but the boundary is in the wrong place.** Evidence:

- `command` (+`pending`) is *persisted*, `goal`/`phase` are not, and `goal`/`phase`
  are rebuilt from the task and the world on restore. They are already two layers,
  not one state variable wearing three names.
- `phase` is *almost* derivable from `goal`: the pairs in §3 give one legal phase
  per goal except `mine` (two). It survives as a field because it is what the
  power grid, renderer and HUD ask about, and because a stored field is cheaper to
  read than a derived one in the tick loop. It is a **projection of execution
  state**, not an independent concept.
- `goal` currently carries **two** things: the task family (`mine`, `build`,
  `service`, `salvage`, `recover`) and the travel/arrived progress within it
  (`toX` vs `x`). The desired split is:

      Task            = command (+ pending)      — what to do
      ExecutionState  = { phase, step }          — how far along, and where
          phase ∈ idle | moving | working | charging | disabled
          step  = the task-specific progress (at-seam, at-site, hooked-up, …)

  Today that "step" is encoded in `goal`'s `toX`/`x` naming; the target model
  would keep the task family only in `command` and make `goal` a pure progress
  enum (`travel`, `arrive`, `work`, `return`…) or fold it into `phase` itself.

**Not done in this phase**, on purpose: §15 says not to remove these
immediately, and Phase 10's whole value was proving the move changed nothing.
The split touches the save-free execution state, `StateHash` (which hashes
`goal`/`phase`), `PowerSystem`, `ConstructionSystem`'s travel guard, the renderer
and the dev overlays; doing it inside the same phase that first writes the table
down would make both changes hard to review. §6 records the migration.

## 6. What Phase 11 changed

1. **Deleted the stored `statusText`.** `roverStatusText(r)` is the single
   producer of rover wording; the field was write-only (no UI read it, saves
   never carried it, `StateHash` excludes wording) and could go stale after
   `finishTask`.
2. **Deleted the unreachable `unload` goal** from `RoverGoal` and from
   `roverStatusText`.
3. **`goal`/`phase` enter through named transitions.** `enterTravel(r, goal)`,
   `enterWork(r, goal)`, `enterCharge(r)`, `enterIdle(r)` and `enterDisabled(r)`
   in `state/RoverState.ts` are the only writers of a `(goal, phase)` pair, so
   the table above has one implementation; `RoverSystem`, `ConstructionSystem`
   and the dev overlays all go through them. The single-field writes that remain
   are deliberate and commented in place: `moveRover`'s transient
   `phase='working'` immediately before `onArrive`, `goIdle`'s pad top-up (an
   idle rover with no charge task, `(idle, charging)`), and `rehydrate`'s
   charger check.
4. **Restore-time rehydration moved into `RoverSystem.rehydrate(state)`**, next
   to the runtime rules it has to agree with, instead of living inline in
   `Simulation.restore`.
5. **The table is machine-checked**: `checkRoverExecution()` in
   `SimulationAssertions.ts` runs with the other invariants in tests and fails
   loudly on an impossible `(goal, phase, command)` combination. It caught two
   on its first run: `onArrive`'s defensive "the site is gone" branch left
   `phase='working'` behind a `goal='idle'` (unreachable today — `demolish`
   releases crews — but now `enterIdle`), and a construction-suite fixture
   stranded a rover by hand-writing `phase` instead of calling
   `RoverSystem.disable`.

## 7. Migration plan for the Task/ExecutionState split

Do it **after** Phase 12 (FleetAutomationSystem) and Phase 13 (LogisticsSystem)
have moved the schedulers that assign tasks, not before: both phases rewrite
large parts of the task lifecycle, and re-doing this split afterwards is cheaper
than rebasing it through them.

*Both are now complete (2026-09-18 — see the roadmap's Phase 12 and Phase 13
records), so the precondition above is met. The split is still deliberately
unscheduled: it changes rover state shape, and Phase 13's rule was one
architectural change per phase. Give it its own phase, and re-freeze the
behavior baseline around it.*

Steps when it happens:

1. Rename `goal` → `execution.step` (or `step`), drop the task-family words from
   it, and keep `command` as the only place a task's identity lives.
2. Make `phase` derived (`executionPhaseOf(rover)`) once `step` exists, and keep
   it in the hash as the derived value it is — every reader named in §3 keeps
   working.
3. Freeze a new behavior baseline *with the split in place* and diff against the
   Phase 10/11 hash, exactly like this phase did: the split must not move a rover.
4. Then, and only then, Phase 12's automation can be allowed to change rover
   behavior (roadmap §14 "only afterward: simplify, redesign").

## 8. Known quirks (characterized, not fixed)

- **A queued order behind a `moveTo` is stranded.** `onArrive`'s `move` case
  sets the command to `{ type: 'idle' }` directly instead of going through
  `finishTask`, so `pending` is never promoted and the queue waits for the next
  player order to replace it. Pinned by `tests/sim/rover-state.test.ts`; fixing
  it changes *which orders execute*, so it waits for Phase 12's queue rewrite or
  a dedicated pass.
- **`toRecover` arrival falls through `onArrive`'s default** to `(idle, idle)`;
  the next tick's `doRecover` re-travels or hooks up. Harmless today (the rover
  re-plans within one tick) but it is why `toRecover` has no arrived twin.
- **Recharge preemption can leave a stale `goal` for one tick.** An order that
  lands while a rover is driving home to charge does not clear `recharge`; the
  next tick either resumes the new task or drives home first (`giveTask` clears
  `recharge` for player orders, but `autoAssign` does not).
- **`routePaused` and `blockNotified` are per-trip notification conditions**, not
  execution state: `finishTask` clears both, and `routePaused` is also set by the
  salvage body when the silos are full. They exist so the HUD and the log can say
  "Route paused — silo full" without re-warning every tick.
- **`gid` is a sticky last-target id** (building, POI or rover), not cleared when
  a task ends; it is only meaningful alongside the goal that set it.
- **`autoTask` is provenance**, not state the rover acts on: it marks "the fleet
  chose this", and it is what makes an order stealable by a player.
