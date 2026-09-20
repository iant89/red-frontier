# AUTONOMY — The Stat, Its Definition, and Its Rules

*Design spec v1. Referenced by the Commercial Roadmap Review (§4.1). Autonomy
appears in Phases 2, 3, 4, 9, and 11 of the commercial roadmap — the flagship
engineering project, the progression ladder, the dashboard headline, the
campaign's final chapter, and the end-of-run achievement. All five read the
same measured number. This document defines that number.*

---

## 1. Why this stat exists

The Red Frontier fantasy arc ends at:

> "I've built a system capable of keeping itself alive."

For that arc to land, the game must be able to *say* it, in one number, at
any moment, deterministically. "Autonomy" is that number. It is the score of
the game's central question — **how much can this colony do without me?** —
and every feature that talks about autonomy (projects, ladder, dashboard,
campaign, report) must be a different view of the same simulated quantity,
never a second opinion.

Design principles the definition must obey:

1. **Measured, not declared.** Computed from `ColonyState` every tick; the UI
   only reads the mirror.
2. **Deterministic.** Same seed + same command transcript → same autonomy
   history. It survives replay and hashing like everything else in the sim.
3. **Honest.** It must not accrue while the colony is failing, and it must not
   be farmable by ignoring the colony. Autonomy ≠ neglect.
4. **One definition, three faces.** One underlying mechanism, surfaced as
   three stats that answer three different player questions (§3).

---

## 2. The one-sentence definition

> **Autonomy is the measure of how long the colony keeps every critical need
> met — and how much of its work gets done — without a direct order from the
> player, while staying out of critical territory.**

Two clauses do the heavy lifting:

- *"without a direct order"* — the player may set policy, but not steer.
- *"while staying out of critical territory"* — the colony must actually be
  fine. A streak does not survive an oxygen emergency just because the player
  declined to intervene.

---

## 3. Three faces, one mechanism

| Facet | Question it answers | Headline form | Consumer |
|---|---|---|---|
| **Streak** (sols) | "How long has it run itself?" | `AUTONOMY 6.8 sols` | Dashboard headline, P2 project gate, P9 Chapter 8, P11 achievement |
| **Coverage** (%) | "How much of the work is self-directed?" | `Coverage 82%` | ENGINEER gate, dashboard trend, OPERATOR/ENGINEER/ARCHITECT label |
| **Resilience** (count) | "What still depends on one machine?" | `2 single points of failure` | REDUNDANT gate, dashboard risk row (Phase 13's input) |

Streak is behavioral (what happened), Coverage is attributional (who did the
work), Resilience is structural (what would break first). All three are plain
deterministic sim state.

---

## 4. Facet 1 — The Streak

### 4.1 Mechanics

A **streak window** is an interval of sim time that begins when the colony
enters hands-off operation and ends at the first **breaking event** (§4.3).

- Time is measured in sols from the sol clock (`clock.total()` — absolute
  sols, fractional). No wall clock anywhere.
- Paused sim time never accrues (the sim isn't advanced — engineering-panel
  pauses and the pause menu are free, matching existing UX).
- `current` = elapsed sim time in the open window, shown to one decimal.
- `best` = the longest finalized window this colony ever achieved. Monotone,
  saved, never reduced. Records matter because windows *will* break when the
  player resumes expanding — the record preserves the achievement.
- `lifetime` = total hands-off sols accrued across the whole run (report stat).

At colony founding: `startedAt = 0` — the colony begins accruing immediately.
The first build order lands within minutes and finalizes a tiny window; that
is honest (landing day is exactly when the player is the life-support system).

### 4.2 What counts as intervention (the command classification)

**Principle: a command that directs a specific action *now* is intervention.
A command that sets a persistent policy or configuration is not.** Setting a
thermostat is engineering; turning the valve every morning is operations.

Classification against the actual protocol (`src/sim/host/protocol.ts`):

| Command | Class | Rationale |
|---|---|---|
| `rover/move` `mine` `unload` `wait` `stop` `construct` `clean` `repair` `recover` `salvage` | **Intervention** | Directs a specific machine to act now |
| `building/place` | **Intervention** | Expanding the colony is the player working. Deliberate: autonomy windows are proven on a *stable* colony; expansion happens between windows |
| `building/toggle` | **Intervention** | Dawn/dusk furnace toggling is exactly the micro-management the ladder should pressure into automation ("run the furnace when the sun is up" → automate it) |
| `building/demolish` `maintain` `assemble` `recipe` | **Intervention** | Direct industrial action |
| `water/connect` `disconnect` `commission` | **Intervention** | Infrastructure work |
| `colonist/order` | **Intervention** | The player *is* the colonist's legs |
| `engineering/upgrade` `cancel` | **Intervention** | Changes what machines do now (cancel aborts work in progress) |
| `rover/rule` `repeatRoute` `chargeFloor` `lights` | Policy/config | Persistent standing instructions or switches, not acts |
| `engineering/paint` | Cosmetic | Changes nothing about behavior |
| *(future)* `rover/rename`, `policy/*` | Policy/config | A policy doing the work **is the fantasy working** — the whole point of Phase 3 |
| `dev/*` | **Never counted** | Authorial tools, not play. Tests may force storms freely |

Implementation notes:

- The hook is `applyCommand.ts` — the single choke point both transports
  (worker and in-process) already route through. A command is noted as
  intervention **only if the sim accepts it** (`SimAck.ok`). A refused order
  steered nothing.
- The note is written into `ColonyState` (a pending-break flag with reason
  `intervention`), which the tick-consuming system finalizes — keeping command
  application side-effect-free with respect to *timing*.

### 4.3 Breaking events (the streak also ends without a click)

The streak ends when the machine could not keep the colony alive — even if the
player stayed quiet. Autonomy must not be farmable by watching a colony drown.

The breaker set is an **explicit, versioned list** — *not* "any crit alert" —
so alert-copy evolution can never silently change the stat's meaning:

| # | Breaker | Reason code | Notes |
|---|---|---|---|
| B1 | A life-support fluid enters its **critical** alert state (`water-low` / `oxygen-low` / `food-low` at crit tier) | `life-support-critical` | Edge-triggered on the AlertBus raise *transition*, so one reset per incident, not continuous resets |
| B2 | `colonist-health` reaches critical | `colonist-critical` | The colonist is the thing autonomy exists to protect |
| B3 | `brownout-critical` becomes active | `power-critical` | Life-support power tiers (0–1) shedding. Ordinary industry shedding at night is **fine** and must never break a window — that's the designed rhythm |
| B4 | **Runway breach** — any fluid's projected time-to-empty < **1.0 sol** at its trailing net rate | `runway-critical` | The anti-coasting rule (§8). Uses the existing `FluidFlow` produced/consumed accumulators; projected exhaustion is a pure function of state |
| B5 | Direct-order command accepted | `intervention` | §4.2 |

Why edge-triggered on transitions: the AlertBus already raises once on
inactive → active and refreshes while held; the breaker consumes that
transition. A four-hour critical episode = one break, not a hundred.

Deliberately **not** breakers:

- A stranded rover (`warn` tier) — fleet trouble, not colony failure; the
  REDUNDANT rung (§6) is where fleet resilience is graded.
- `panels-dirty`, `storage-full`, `building-damaged` (warn/info) — friction,
  not failure. The runway rule (B4) is the safety net that catches slow
  degradations (a buried extractor shrinks water runway until it breaches).
- Riding a storm at 19 % battery with no life-support shedding — **that is the
  fantasy working.** Drama is allowed; failure is not.

### 4.4 The reset must teach

Every break stores a reason and is surfaced:

- Intervention: *"Intervention logged — ordered Rover 2 to mine. Streak ended
  at 6.8 sols."*
- Breaker: *"Oxygen reserve critical. The colony ran itself for 11.2 sols."*

This is Phase 1's warning philosophy applied to the meta-stat: the number is a
teacher, not a grade. `lastBreak` is part of saved state.

---

## 5. Facet 2 — Coverage

**Question:** of all the work the colony performed recently, how much was
self-directed?

The sim already attributes labor: every rover carries `autoTask`
(`true` when the rover chose its own task via auto-dispatch/rules, `false`
under player orders). Coverage formalizes it:

```
work(tick)   = seconds this tick in which the rover phase is 'moving' or 'working'
autoSec      = Σ work where rover.autoTask
orderSec     = Σ work where !rover.autoTask
coverage     = autoSec / (autoSec + orderSec)   over a trailing 3-sol window
```

- Sol-bucketed accumulator: 3 buckets of `{ autoSec, orderSec }`, rolled by the
  sol-rollover hook the clock already exposes (`advance` returns "a new sol
  began"). Window = last 3 buckets.
- Charging/idle seconds count as nothing (housekeeping, not work).
- Buildings are unattributed until Phase 3's policies exist (there is no
  policy toggle to attribute yet); when `policy/*` lands, building-on-time
  under policy counts as auto. The definition anticipates this; nothing
  retroactively changes.
- `coverage ∈ [0, 1]`, deterministic, saved with the buckets.

Note the honest wrinkle: `RoverRules` default **on** (`autoHaul`, `autoService`,
`stormShelter`, `autoRescue`), so a fresh colony reaches meaningful coverage
quickly. That is correct — the lander's flight software does basic chores. The
game's difficulty lives in the *upper* rungs (§6), not in pretending the first
rover can't fetch ice by itself.

---

## 6. Facet 3 — Resilience (single points of failure)

**Question:** what still kills the colony if one machine dies?

For each critical chain, count **independent producers currently online**:

| Chain | Independent producer | REDUNDANT gate |
|---|---|---|
| Power | Online generation buildings (`solar` arrays, RTG/descent stage, `battery` banks count separately) | ≥ 2 |
| Water | Online `extractor` (+ commissioned pump-fed sources) | ≥ 2 |
| Oxygen | Online `oxygenator` | ≥ 2 |
| Food | Online `greenhouse` | ≥ 2 |
| Fleet | Operational (non-disabled) rovers | ≥ 2 |
| Spares | Motors and circuit boards on the Workshop rack | ≥ 1 each |
| Recovery | An online `garage` (service path) | ≥ 1 |

Output: `singlePoints: string[]` (the chains below their gate) plus the count.
Pure predicate over `ColonyState` — no history needed, recomputed each tick or
on the history sample gate.

Buffers (storage/runway) are deliberately *not* part of the gate — they are
already rewarded through the streak (B4 won't break while reserves are deep).
Resilience grades **production redundancy** specifically; that separation is
what makes the two stats worth displaying side by side.

---

## 7. The progression ladder

The roadmap's MANUAL → ASSISTED → AUTOMATED → REDUNDANT → AUTONOMOUS ladder,
with each rung made measurable:

| Rung | Gate (all conditions, evaluated continuously) | Player-facing meaning |
|---|---|---|
| **MANUAL** | No self-chosen task completed yet this run | "You are the machine." Landing-day state |
| **ASSISTED** | ≥ 1 rover completes a self-chosen task (`autoTask`), or any rule has acted | "The flight software does chores." Effectively the tutorial-exit rung |
| **AUTOMATED** | `coverage ≥ 75%` **and** `best streak ≥ 1.0 sol` **and** all three fluid producers have been online through that sol | "The colony works a full sol cycle without being told to" — the gate includes a night by construction (a sol *is* a night) |
| **REDUNDANT** | AUTOMATED **and** zero single points of failure (§6 table satisfied on every row) | "No single machine can kill the colony" |
| **AUTONOMOUS** | REDUNDANT **and** current streak ≥ **10.0 sols** | "The colony no longer needs you" |

Rules:

- Rungs are **absolute** — not difficulty-scaled — so rungs are comparable
  across runs and screenshots. Difficulty scales the *project/campaign gates*
  instead (§9).
- The current rung **can drop** (an intervention doesn't drop it, but losing
  redundancy does: demolish your second extractor and you are AUTOMATED again
  until it's rebuilt). Dropping a rung is announced once, in the same
  teaching tone as a streak break.
- `bestRung` (monotone) is kept alongside for the report.

The OPERATOR / ENGINEER / COLONY ARCHITECT identity labels (roadmap Phase 3)
map onto the ladder, not onto coverage bands:

```
MANUAL, ASSISTED   →  OPERATOR
AUTOMATED, REDUNDANT →  ENGINEER
AUTONOMOUS         →  COLONY ARCHITECT
```

Shown as a small identity chip near the dashboard autonomy headline.

---

## 8. Anti-gaming review (why each loophole is closed)

| Strategy | Why it fails |
|---|---|
| AFK on huge stockpiles | Runway rule (B4): reserves cap the streak at (reserve / net-burn) + 1 sol. Coast, don't produce, and the window ends |
| Turn everything off, hide | Pools drain → B1/B2. Production without the player is the only indefinite strategy — which is the point |
| Manual dawn/dusk toggling forever | `building/toggle` is intervention (§4.2); the pressure to automate is intentional |
| Spam trivial orders to "claim" a window | Orders *end* windows; they can't preserve one |
| Do nothing while stable, call it autonomy | …that is exactly what autonomy is. Streak rewards hands-off stability; the ladder's upper rungs demand production and redundancy on top of it. Correct layering: streak = behavior, rungs = capability |
| Pause-spam (open menus to freeze time) | Paused sim time never accrues; also never breaks. Matching existing pause UX |
| Save/reload laundering | `best`/`bestRung`/`lifetime` are monotone and persisted; a reloaded window continues from its saved `startedAt` |

---

## 9. Difficulty & feature wiring

**Difficulty scaling** lives in the *gates that consume* the stat, not the
stat. The AUTONOMOUS rung is fixed at 10.0 sols; the Phase 2 project and
campaign consume difficulty-scaled thresholds:

| Difficulty | P2 project "AUTONOMOUS COLONY" gate |
|---|---|
| Settler | 3.0 sols |
| Pioneer | 5.0 sols |
| Survivor | 10.0 sols (matches the rung) |

| Feature | What it reads |
|---|---|
| P2 project | `current ≥ gate` while REDUNDANT — progress bar `min(current/gate, 1)` |
| P3 ladder + labels | `rung`, coverage trend, identity chip |
| P4 dashboard | `AUTONOMY 6.8 sols` headline, rung chip, `lastBreak` on hover, single-points row (resilience) |
| P9 Chapter 8 (INDEPENDENCE/AUTONOMY) | Win condition: `rung = AUTONOMOUS` held through ≥ 1 major storm (the storm's presence is observed, not scheduled — deterministic, since weather is seeded) |
| P11 report | Achievement `AUTONOMOUS COLONY — 42 sols` from `best`; lifetime hands-off sols line |
| P13 redundancy | The single-points list *is* the Phase 13 dashboard row |

---

## 10. State, persistence, placement

### 10.1 New state — `sim/state/AutonomyState.ts`

```ts
export type AutonomyBreakReason =
  | 'intervention' | 'life-support-critical' | 'colonist-critical'
  | 'power-critical' | 'runway-critical';

export type AutonomyRung =
  | 'manual' | 'assisted' | 'automated' | 'redundant' | 'autonomous';

export interface AutonomyState {
  startedAt: number;            // absolute sols when the open window began
  best: number;                 // longest finalized window (sols), monotone
  bestRung: AutonomyRung;       // monotone
  lifetimeSols: number;         // total hands-off sols ever accrued
  rung: AutonomyRung;           // current
  coverage: number;             // trailing 3-sol window, [0,1]
  coverageBuckets: Array<{ autoSec: number; orderSec: number }>; // 3, sol-bucketed
  lastBreak: { at: number; reason: AutonomyBreakReason; streak: number } | null;
  pendingBreak: AutonomyBreakReason | null;  // set by applyCommand, consumed by tick
  singlePoints: string[];       // chains below gate, e.g. ['water','oxygen']
}
```

(`current` streak = `clock.total() - startedAt`, computed for the mirror, not
stored twice.)

### 10.2 New system — `sim/systems/AutonomySystem.ts`

Ticked **after AlertSystem** (needs breaker transitions) and **before
HistorySystem/snapshot**. Per tick: consume `pendingBreak`, evaluate B1–B4,
roll coverage buckets on sol rollover, recompute rung/resilience on the
history sample gate (cheap), accrue `lifetimeSols`.

Command hook: one call in `applyCommand` for accepted, non-dev commands —
`sim.noteIntervention()` when the command class is intervention. Both
transports inherit correctness for free because the hook is in the shared
dispatch table.

### 10.3 Persistence — save **v13 → v14**

- New optional `autonomy` section. Migration from v13: `startedAt = current
  clock total`, `best = 0`, `bestRung = 'assisted'`, `lifetimeSols = 0` —
  **no retroactive credit**; the stat starts measuring from the migration.
- Add the section to `SaveSchema`, `SaveCodec`, `ColonyPersistence`, and a
  hostile-payload case in `save-validation` per the existing policy.
- Mirror/view: expose `autonomy: { current, best, rung, coverage,
  singlePoints, lastBreak }` on the view payload — the HUD never touches sim
  state, per the host seam.

---

## 11. Determinism & test plan

All quantities are functions of sim time and `ColonyState`. Therefore: same
seed + same transcript → identical autonomy history, identical hashes.

New suites (following the `@suite/@covers` convention):

1. **`sim/autonomy`** — classification table: every command type from the
   protocol asserted as intervention / policy / ignored; refused commands
   don't break; `dev/*` never breaks.
2. Breaker tests — force each breaker via `dev/` tools (which themselves
   don't break): crit pool, colonist critical, `brownout-critical`, runway
   breach (drain a pool's producer), and the negative case: *ordinary night-time
   industry shedding does not break a window*.
3. Edge-trigger test — a sustained critical condition yields exactly one
   break.
4. Coverage math — scripted tasks with `autoTask` true/false over a sol
   boundary; buckets roll correctly; idle/charging excluded.
5. Rung transitions — scripted promotion and the demolish-the-second-extractor
   demotion.
6. Determinism — a hands-off scenario transcript (build a minimal autonomous
   setup, then N sols of no commands) replays to a pinned end-state hash
   **including** the autonomy section; also pinned as the golden-colony
   companion case.
7. Persistence — v13 loads with defaults; v14 round-trip preserves
   `best`/`lifetimeSols`/`startedAt`.
8. Property tests — `0 ≤ current ≤ elapsed`; `best ≥ current`; coverage ∈
   [0,1]; no accrual while a breaker is active; buckets never negative.

---

## 12. UI copy (tone per Phase 1)

- Dashboard headline: `AUTONOMY 6.8 sols · ENGINEER` with the identity chip.
- Streak-break toast: the teaching lines from §4.4.
- Rung promotion: *"REDUNDANT reached — no single machine can end this
  colony."*
- Rung demotion: *"Water redundancy lost — the colony is AUTOMATED until a
  second extractor is online."*
- Project card (P2): *"AUTONOMOUS COLONY — Survive 5 sols without direct
  orders while fully redundant. 3.2 / 5.0 sols."*
- Report achievement (P11): *"AUTONOMOUS COLONY — the colony ran itself for
  42 sols."*

---

## 13. Tuning defaults (adjustable, all in one config block)

| Parameter | Default | Notes |
|---|---|---|
| Runway floor (B4) | 1.0 sol | Raise → less forgiving coasting |
| Coverage window | 3 sols | Longer → smoother, slower to respond |
| AUTOMATED coverage gate | 75 % | |
| AUTONOMOUS rung gate | 10.0 sols | Fixed across difficulties |
| Project gates | 3 / 5 / 10 sols | Settler / Pioneer / Survivor |

---

## 14. Open decisions (defaults chosen; override in review)

1. **`building/place` breaks windows** (chosen: yes). Alternative: treat
   expansion as non-breaking. Rejected for now — windows should prove a
   *stable* colony, and Chapter 8's drama depends on that tension. Revisit if
   playtests show players avoiding late-game expansion to protect a record
   (the `best`-is-monotone rule should mostly prevent this).
2. **`building/toggle` breaks windows** (chosen: yes). It is the strongest
   pressure toward Phase 3 policies ("keep the furnace on sun-hours"), but it
   is also the most common legit micro-optimization. Watch playtests.
3. **Runway floor at 1.0 sol** (chosen). A storm that halves production for a
   day can break a window via runway — intended ("the machine couldn't ride
   it out"), but if tests show routine storms breaking healthy colonies, gate
   B4's storm behavior rather than the floor.
4. **Rung gates absolute, project gates scaled** (chosen). Alternative:
   scale both; rejected — comparability of the rung across runs/screenshots is
   worth more than early accessibility, which the scaled project gate already
   provides.
