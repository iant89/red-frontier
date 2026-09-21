# Red Frontier — Commercial Phase 3: Automation as Progression

*Implementation spec for Phase 3 of COMMERCIAL-ROADMAP.md, per COMMERCIAL-ROADMAP-REVIEW.md §5 P3 and §4.1, against the design in `docs/design/AUTONOMY.md`.*
*Status: COMPLETE — slice 1 (the autonomy stat) and slice 2 (PolicySystem) shipped.*
*Branch: `arena/01a0c0f6-red-frontier` · save v17*

---

## Goal

> Make progression about moving from manual operation to autonomous colony
> management. MANUAL → ASSISTED → AUTOMATED → REDUNDANT → AUTONOMOUS;
> OPERATOR → ENGINEER → COLONY ARCHITECT.

The review's rule (§4.1): *define the autonomy metric before building anything
that displays it*. So this phase ships in two slices, stat first:

| Slice | What | Status |
|---|---|---|
| **1 — The stat** | `AutonomyState` + `AutonomySystem`: streak with breakers, coverage, resilience, the ladder and identity; save v16; HUD headline; P2 flagship retargeted onto it | **shipped** |
| **2 — PolicySystem** | Four standing orders that act *through the same paths a player's order takes* and are marked policy-issued: stockpile, night power, storm shelter, auto-maintain; `policy/*` commands; save v17; Standing Orders card gated on `advancedAutomation` | **shipped** |

---

## Slice 1 — one stat, three faces (AUTONOMY.md)

Everything is measured from `ColonyState`, every tick, deterministic. Nothing
is declared.

### Streak — "how long has it run itself?"

An open **window** starts at `autonomy.startedAt` (absolute sols) and ends at
the first breaker. `current = clock.solsElapsed − startedAt`; `best` and
`lifetimeSols` are monotone records.

| # | Breaker | Reason code |
|---|---|---|
| B1 | a life-support fluid's alert at **crit** (`water-low` / `oxygen-low` / `food-low`) | `life-support-critical` |
| B2 | `colonist-health` at crit | `colonist-critical` |
| B3 | `brownout-critical` (life-support tiers shed) — ordinary `brownout` never breaks | `power-critical` |
| B4 | any fluid's runway (`HistorySystem.reserveSols`) under **1.0 sol** — the anti-coasting rule | `runway-critical` |
| B5 | an **accepted** intervention command | `intervention` |

B1–B4 are **edge-triggered** on the transition into the condition
(`_holding`, transient, not saved), so a four-hour episode is one break.
B5 is classified by an explicit table in `AutonomySystem.classifyCommand`:
`rover/move|mine|…`, `building/*`, `water/*`, `colonist/order`,
`engineering/upgrade|cancel` are interventions; `rover/rule|repeatRoute|
chargeFloor|lights`, `engineering/paint`, `tutorial/dismiss` and anything
`policy/*` are policy; `dev/*` is ignored. Unknown player commands default to
intervention. The hook is `applyPlayerCommand` → `sim.noteCommandResult(type,
ack.ok)` — one line, both transports, refused orders don't count.

Every break stores `{at, reason, streak, detail}` and logs a teaching line
(*"Intervention logged — ordered a rover to mine. Streak ended at 6.8 sols."*),
suppressed under 0.1 sols so landing day stays readable.

### Coverage — "how much of the work is self-directed?"

Three sol-buckets of `{autoSec, orderSec}` rolled on the clock's new-sol flag;
a rover in `moving`/`working` adds `SIM_TICK` to one or the other by
`rover.autoTask`. Idle and charging count as nothing. Buildings are
unattributed until slice 2 gives them a policy to be attributed to.

### Resilience — "what still depends on one machine?"

`resilience(state)` returns the chains below their gate: power (online
solar/RTG/battery + the descent stage ≥ 2), water/oxygen/food (≥ 2 online
producers each), fleet (≥ 2 operational rovers), spares (≥ 1 motor and ≥ 1
board on the rack), recovery (an online garage).

### The ladder

| Rung | Gate |
|---|---|
| MANUAL | no rover has ever worked a self-chosen task |
| ASSISTED | `everAutoTask` |
| AUTOMATED | coverage ≥ 75 % **and** best ≥ 1.0 sol **and** the three fluid producers online ≥ 1.0 consecutive sol |
| REDUNDANT | AUTOMATED and `singlePoints` empty |
| AUTONOMOUS | REDUNDANT and current streak ≥ 10.0 sols (fixed across difficulties) |

Rungs can drop (lose a second extractor → AUTOMATED); `bestRung` is monotone.
Promotions and demotions each emit `autonomy/rung` once and one log line in
the §12 tone. Identity: MANUAL/ASSISTED → OPERATOR, AUTOMATED/REDUNDANT →
ENGINEER, AUTONOMOUS → COLONY ARCHITECT. All thresholds live in
`AUTONOMY_TUNING`.

### What the P2 flagship now reads

`solsWithoutOrder` evaluates the autonomy streak (whole sols), so *Autonomous
Colony* can no longer be earned by watching a colony drown — a breaker ends it
the same as a click. The difficulty-scaled 3/5/10 target is unchanged.
`lastDirectOrderSol` is kept (saved, hashed) as the v15 marker the migration
reads to carry an existing streak over.

---

## What shipped

| Layer | Files |
|---|---|
| State | `src/sim/state/AutonomyState.ts` (types, rung order, identity map, `coverageOf`) |
| System | `src/sim/systems/AutonomySystem.ts` (`tick`, `evaluateRung`, `break`, `noteCommand`, `afterTimeJump`, `resilience`, `classifyCommand`, `autonomySnapshot`, `AUTONOMY_TUNING`) |
| Tick | `Simulation.tick`: `… → evaluateAlerts → AutonomySystem → TutorialSystem → ObjectiveSystem → HistorySystem` |
| Commands | `applyPlayerCommand` calls `noteCommandResult` with the ack; `dev/time` restarts the window |
| Events | `autonomy/break`, `autonomy/rung` |
| Read model | `AutonomyView` in `viewModels.ts`; `SimView.autonomy`; projected in `projection.ts`, mirrored in `mirror.ts` |
| UI | `autonomyChip()` in `ProjectsPanel.ts` → `#auto-chip` on the vitals header (`Autonomy 6.8 sols · ENGINEER`, tooltip = rung, coverage, best, single points, last break); dev-panel M2 readout shows the streak and rung |
| Save | schema **v16**, `migrations/v15.ts`, shared sanitiser `persistence/autonomySave.ts`, validator warning |
| Hash | `autonomy` (minus `_holding`) in the core section — golden colony, canonical transcripts and the stress hash re-pinned |
| Tests | `tests/sim/autonomy.test.ts` (23): classification table, accepted/refused/policy/dev, B1–B4 + edge trigger, time jump, coverage math and bucket roll, resilience, every rung and both announcements, v16 round-trip, v15 migration, hostile block, determinism and property bounds |

Also: `tests/sim/transcript` "manual vs replay" now issues its order through
`applyCommand`, because an order is state (it ends a window) and a direct
method call is not.

---

## Slice 2 — PolicySystem (shipped)

Player-authored standing orders the colony satisfies by doing *what a player
would have done*, marked so the stat stays honest. No scripting language: each
policy is a fixed shape — a toggle and at most one number.

| Policy | Rule | Acts by | Marked how |
|---|---|---|---|
| **Stockpile** | keep `<resource>` above N kg | the same seam scorer as `dispatchSupplyRuns` (`pickHaul`) → `autoAssign(mine)` + seam claim, idle `autoHaul` rovers only, construction keeps its crew | `rover.autoTask = true` |
| **Night power** | after sunset, battery < N % | flips `enabled` on tier ≥ 2 industry that draws power (never the pod, never life support, never a charger) — the same flip `building/toggle` does; restored at sunrise or at floor + 10 % (hysteresis) | ids recorded in `policies.held`; only what it took is ever given back, and turning the policy off gives it back now |
| **Storm shelter** | a real storm (not a devil) is forecast or on site | re-arms every rover's `stormShelter` rule; idle rovers in the open head to a charger (`recharge = true`, the recall path `updateRover` already uses) | log line per action |
| **Auto-maintain** | building wear > N %, wear = max(1 − health/max, 1 − cleanliness) | the same `issueRepair` / `issueClean` `building/maintain` reaches — worst first, nearest idle rover, one per job, never mid-storm | `autoTask = true` after the issue |

**Honesty rules.** Nothing a policy does goes through `noteCommandResult`, so
the autonomy window never ends on a policy. Setting a policy is a `policy/*`
command, which `classifyCommand` already returned *policy* for. Policy rover
work is `autoTask`, so coverage counts it as self-directed (AUTONOMY.md §5).

**Tick position** (decided with ask-user): after `ConstructionSystem.assignBuilders`,
immediately before `FleetAutomationSystem.tick`. No existing system moved.
Construction keeps first pick of idle rovers, a stockpile run outranks generic
hauling, a night-power shed lands on the next `PowerSystem.tick`. Inside the
system: night power → shelter → maintain → stockpile (nothing sends a rover out
past a recall; repairs before hauling).

**Gate.** `Simulation.setPolicy` refuses (ack `ok:false`, one log line) until
`advancedAutomation` is in the unlock registry — Industrialize's reward, the
registry's second consumer. The card renders locked until then.

### What shipped

| Layer | Files |
|---|---|
| State | `src/sim/state/PolicyState.ts` (`PolicyState`, `POLICY_IDS`, `emptyPolicyState`, `anyPolicyOn`) |
| System | `src/sim/systems/PolicySystem.ts` (`tick`, `set`, the four `tickX` functions, `buildingWear`, `sheddable`, `describe`, `policySnapshot`, `POLICY_UNLOCK`, `POLICY_TUNING`) |
| Tick | `Simulation.tick`: `… → assignBuilders → PolicySystem → FleetAutomationSystem → …` |
| Protocol | `policy/stockpile {on,resource,minKg}`, `policy/nightPower {on,minBatteryPct}`, `policy/stormShelter {on}`, `policy/autoMaintain {on,maxWearPct}` — shapes in `COMMAND_SHAPES`, audio cue `ui`, dispatch in `applyCommand` → `sim.setPolicy` |
| Events | `policy/acted {policy, sol}` |
| Read model | `PolicyView` (`SimView.policies`): each policy's fields plus what it holds (`currentKg`, `shedding`, `worstWearPct`), `unlocked`, `actions`, one line per policy |
| UI | `renderPolicyHtml()` — the **Standing Orders** card under the projects; `ProjectsPanel` turns any input change into one whole-row `policy/*` command via `onPolicy`; won't repaint under a focused input |
| Save | schema **v17**, `migrations/v16.ts`, shared sanitiser `persistence/policySave.ts` (ghost `held` ids dropped), validator warning |
| Hash | `policies` in the core section — golden colony, canonical transcripts and the stress hash re-pinned |
| Tests | `tests/sim/policies.test.ts` (18): protocol + gate + no-break; each policy's positive and negative case (satisfied floor, autoHaul off, daylight, hand-switched building kept, hysteresis, dust devil, threshold, no double dispatch, worst-first, never mid-storm); round-trip, v16 migration, hostile block; hash determinism; snapshot. `ui/projects-panel` (+2), `hud/panels` (+1) |

## How to run

```bash
npm run typecheck
npm test                     # 96 suites (sim/autonomy, sim/policies new)
npm run test:replay          # re-pinned canonical hashes
npm run test:golden          # re-pinned golden colony
npm run dev                  # autonomy headline under the vitals title; Standing Orders under the projects
```
