# Red Frontier — Commercial Implementation Tracker

*Tracks progress against `COMMERCIAL-ROADMAP.md` (verbatim) and `COMMERCIAL-ROADMAP-REVIEW.md` (re-baseline).*
*This file is the living tracker; the two roadmap docs are the preserved source.*

Last updated: 2026-09-21
Branch: `arena/01a0c3fd-red-frontier`
Save version: 18 (v16 autonomy, v17 standing orders, v18 long records — see SAVE-COMPATIBILITY.md; Phase 5 derives everything, no bump)
Test suite: 100 suites / 1192 checks (after Phase 5: bottleneck analyzer + advisor)

---

## North-star

> Turn Red Frontier from "A technically impressive Mars-colony simulation"
> into "A polished engineering/automation strategy game where players build
> a Mars colony that gradually becomes autonomous."

Core loop: DISCOVER → BUILD → AUTOMATE → SURVIVE → EXPAND → SOLVE ENGINEERING PROBLEMS → BECOME AUTONOMOUS → GO FARTHER → DISCOVER

---

## Phase 0 — Freeze the Foundation (DONE, 2026-09-20)

**Original goal:** Stop expanding simulation temporarily and establish stable baseline.

**Re-baselined verdict (review §2):** ~80% done before this pass. Remaining 2-4 days codified here.

### What already existed (pre-Phase-0)

- 87 suites / 983 checks incl. determinism, transcript replay to pinned hash, state-hash, property-based, soak, perf regression, large-colony stress
- Save migrations v3→v13 with hostile-payload tests
- Systems extracted under `sim/systems/` with explicit orchestrator
- Benchmarks (`test:bench`, `test:stress`) exist
- Resource model: one bulk ledger (mined + refined), one counted ledger (components), fluids as tank pools
- Rover fundamentals: task queue, automation rules, haul routes, charge floors, proximity crawl, garage service/assembly, repair bay
- Worker/sim architecture: worker default, in-process fallback, NetworkPort adapter, immutable SimView, domain events

### What this Phase 0 pass adds (review §4.7)

- [x] **CI runs full suite on PRs** — `.github/workflows/pages.yml` now runs `npm test` + `npm run test:replay` + `golden-colony --check` before smokes and build. Highest-leverage item in review.
- [x] **Golden colony = canonical transcript + pinned hash + save** — `tests/golden-colony/`:
  - `golden-colony.transcript.json` — seed 9001, pioneer, 11 buildings (warehouse, solar, battery, extractor, oxygenator, greenhouse, refinery, workshop, garage, waterTank, pumpStation) via deterministic findSpot, dev-completed, plus ice/iron/silicon hauling, 5 sols = 24000 ticks
  - `golden-colony.hash.txt` — `rf1-08708ac02b9217-143e488a41e1c5` (pinned)
  - `golden-colony.save.json` — snapshot for manual inspection
  - `golden-colony.meta.json` + `README.md`
  - Generator: `scripts/generate-golden-colony.mjs --write|--check`
  - Suite: `tests/sim/golden-colony.test.ts` (7 checks) — replay to pinned hash, save restore invariants, restored-vs-restored determinism, viable shape
- [x] **Simulation invariants doc** — `docs/SIMULATION-INVARIANTS.md` lists each invariant code with suite that pins it (28 codes, plus determinism/replay/worker/perf/stress invariants)
- [x] **Save compatibility policy** — `docs/SAVE-COMPATIBILITY.md`:
  - Supported range v3..CURRENT (13)
  - Every bump ships migration + hostile test + hash re-pin checklist
  - Migration table v3→v13 additive
  - What is/isn't saved, header rule, desktop/Steam future
- [x] **Baseline perf** — `benchmarks/baseline.md`:
  - Fleet scaling table (10/25/50/100/250 rovers) from `test:bench`
  - Stress run (4800 ticks, 100 rovers/255 buildings, severe storm) from `test:stress`
  - Canonical replay hashes from `test:replay`
  - Golden colony hash
  - Build sizes
  - Update procedure

### Definition of done (original)

> Major gameplay changes can be made without constantly worrying about breaking the simulation.

**Met:** suite green on every PR, golden transcript pinned in CI, invariant map exists, save policy written, baseline recorded. Change-control = "freeze" — new content lands, but tick-output moves require deliberate hash update (PR-visible).

### Exit criteria (review §7)

- M0: suite green on every PR; golden transcript pinned in CI — DONE

---

## Phase 1 — Make the First 30 Minutes Excellent (DONE, awaiting playtest)

**Goal:** Make game immediately understandable to someone who has never played it.

First 30 min should teach:
1. Move a rover
2. Find resources
3. Extract something
4. Bring it home
5. Build something
6. Generate power
7. Manage life support
8. Automate a task
9. Survive a small environmental problem
10. Receive a meaningful colony objective

Desired reaction: "I'm building a machine that keeps itself alive."

### Re-baselined additions (review §5 P1)

- (a) **Forecast utility** — pure deterministic function `resource → sols-to-empty / sols-to-shortage` living in `sim/`, consumed by tutorial warnings (P1), dashboard (P4), bottleneck panel (P5). Build once, three phases early. Review §3.1. — **DONE** `src/sim/forecast.ts` + `tests/sim/forecast.test.ts`
- (b) **String externalization** — `src/ui/strings.ts` (or JSON bundles) convention, require new player-facing copy through it. English-only at launch fine, unlocalizable not. Review §4.6. — **DONE** `src/ui/strings.ts` + `tests/ui/strings.test.ts`
- (c) **First-session funnel instrumentation** — opt-in anonymized milestone events `first-power`, `first-water-chain`, `first-storm-survived` etc. so "where do new players quit" is data, not vibes. — **DONE** funnel bounded 200 in TutorialState, domainEvents `tutorial/*`, persisted
- (d) Focus on minutes 5–30 (between pod landed and water→oxygen chain understood). Descent intro + mission wizard already decent first 5 min.

### Tasks (from original + review)

- [x] Forecast utility (`src/sim/forecast.ts`) — pure, deterministic, uses `emptyFlows` / `HistoryState` flow windows — DONE
- [x] Strings externalization (`src/ui/strings.ts`) — DONE
- [x] Contextual tutorials (situation → warning → player discovers fix, NOT click-here chain) — DONE `TutorialSystem` + `TutorialPanel`
- [x] First-time hints — DONE `TutorialPanel` with HINT_COPY using STRINGS, why explanations
- [x] Recommended actions — DONE via hint actions (onAction -> handleAction)
- [x] Clear warnings — exemplar: "Your water reserve will run dry in 1.8 sols." — DONE via TutorialSystem reserveSols <1.0 critical / <2.5 low + TutorialPanel warning copy
- [x] "Why this matters" explanations — DONE in strings + TutorialPanel .tut-h-why
- [x] Simplified early-game UI — DONE TutorialPanel sits top-left near vitals, progress bar, dismissible, not modal
- [x] Guided first engineering project (hands first objective from wizard) — DONE by P2: `emptyObjectiveState()` puts `Establish Survival` on the board at sol 0, so the colony has an objective before the player has clicked anything
- [x] Funnel milestone events (dev menu first, playtest builds later) — DONE funnel in TutorialState, domainEvents, persisted, bounded
- [ ] Playtest: give to someone who never played, don't explain, watch. Repeated questions = UX problems. — NEXT (manual)

### Structure shipped

```
/src/sim/forecast.ts                 DONE — pure forecast math (sols-to-empty, runway breach)
/src/ui/strings.ts                   DONE — player-facing copy bundles
/src/sim/state/TutorialState.ts      DONE — milestones, warnings, hints, funnel, stats, transient
/src/sim/systems/TutorialSystem.ts   DONE — milestone tracking, warnings via forecast ctx, cooldown, funnel
/src/sim/persistence/ColonyPersistence.ts DONE — snapshot/restore tutorial with migration from old saves
/src/sim/host/viewModels.ts          DONE — TutorialView
/src/sim/host/view.ts                DONE — tutorial in SimFields
/src/sim/host/projection.ts          DONE — ViewPayload.tutorial
/src/sim/host/mirror.ts              DONE — get tutorial()
/src/sim/host/protocol.ts            DONE — tutorial/dismiss command
/src/sim/host/applyCommand.ts        DONE — dispatch
/src/sim/Simulation.ts               DONE — dismissTutorialHint + get tutorial()
/src/ui/TutorialPanel.ts             DONE — situation-driven hints, not modal click-chain
/src/style.css                       DONE — #tutorial-panel styles
/src/audio/AudioSystem.ts            DONE — cue for tutorial/dismiss
/src/sim/domainEvents.ts             DONE — tutorial/* types
/src/sim/DevBackdoors.ts             DONE — afterTimeJump clears transient
/tests/sim/forecast.test.ts          DONE
/tests/ui/strings.test.ts            DONE
/tests/sim/tutorial.test.ts          DONE — 12 checks
/tests/sim/host.test.ts              DONE — SAMPLES includes tutorial/dismiss
```

### Definition of done

- ≥7 of 10 unguided playtesters reach "water → oxygen chain stable" within 45 min without external help; other 3 all fail at same step (then fix that step) — review §7 M1 — AWAITING PLAYTEST

See `docs/COMMERCIAL-PHASE-1.md` for full spec and remaining work.

---

## Phase 2 — Engineering Projects (DONE, 2026-09-20)

**Goal:** Give player meaningful objectives beyond "build whatever you want."

All five roadmap projects shipped, in the review's dependency-honest order.
Full spec: `docs/COMMERCIAL-PHASE-2.md`.

### What shipped

- [x] **`ObjectiveSystem`** (`src/sim/systems/ObjectiveSystem.ts`) — ticked after alerts and tutorial, before history, so a project completes against the same state the player sees. Offers, evaluates, completes, pays, and projects the view.
- [x] **Project definitions as data** (`src/sim/projects/`) — `catalog.ts` (5 projects), `types.ts` (declarative requirement records), `requirements.ts` (one pure evaluator). No project logic in code (§3.4): a chapter in P9 is a list of these records.
- [x] **Unlock registry** (`src/sim/unlocks.ts`) — the shared primitive P2/P7/P9 need (§3.3). Saved, deterministic, sol-stamped, with the granting id. **Inert on purpose**: no blueprint is gated yet, so the first projects stay completable with today's building set.
- [x] **First projects honest to existing entities** — Battery Bank, Weather Radar Station, RTG, garage, per-rover rules, `rover/repeatRoute`. Where the roadmap's wording had no counterpart ("Communications"), the requirement names the machine that does the job.
- [x] **The flagship is last** (§3.2) — `autonomousColony` closes the chain; `Establish Survival` opens it and the storm/industry branches run in parallel off it.
- [x] **UI** — `src/ui/ProjectsPanel.ts` + `#projects-panel` styles: the board beside the vitals on desktop, a headline-and-bar chip on a phone. Situation-driven pips on the HUD remain open (see the spec's remaining work).
- [x] **Autonomy streak recorded from sol 1** — `ColonyState.lastDirectOrderSol`, written by the command dispatcher. Direct orders (`rover/*`, `building/*`, `water/*`, `colonist/order`) reset it; `dev/*`, `engineering/*` and `tutorial/dismiss` never do; `dev/time` moves the marker with the clock. AUTONOMY.md (P3) owns the full stat.
- [x] **Save v15** — `objectives` + `unlocks` + `lastDirectOrderSol`, migration `v14.ts`, sanitising restore, validator warnings, hostile-payload cases, re-pinned hashes.
- [x] **State hash** — objectives/unlocks/lastDirectOrderSol in the `core` section; transcript, golden-colony and stress hashes re-recorded.
- [x] **Tests** — `tests/sim/objectives.test.ts` (22 checks), `tests/ui/projects-panel.test.ts` (6 checks), both linked in `full.test.ts`.

### Re-baselined notes (review §5 P2)

| Note | Status |
|---|---|
| `ObjectiveSystem` in `sim/systems/`, ticked after alerts, writing to `ColonyState.objectives` | DONE |
| Project definitions in data table (`sim/projects/`), never in code (§3.4) | DONE |
| Progress predicates read only deterministic sim state | DONE — declarative requirements over `ColonyState` |
| Rewards route through unlock registry (§3.3) | DONE |
| First projects completable with today's building set | DONE — verified by the completion test (seed 9001, survival chain) |
| UI: projects panel + situation-driven pips on HUD | Panel DONE; pips open (deferred — HUD change) |
| Hidden dependency: unlock registry (shared with P7/P9) | DONE — shipped one phase early, deliberately inert |

### Definition of done (review §7)

- M2: playtesters can state their current project's goal unprompted — the panel ships; the playtest is the open item.

---

## Phase 3 — Make Automation the Progression System (DONE, 2026-09-20, PR #72)

**Goal:** Progression about moving from manual → autonomous.

MANUAL → ASSISTED → AUTOMATED → REDUNDANT → AUTONOMOUS
Player: OPERATOR → ENGINEER → COLONY ARCHITECT

Both slices shipped per `docs/COMMERCIAL-PHASE-3.md` (the full spec):

- [x] **Slice 1 — the stat** (`AutonomyState` + `AutonomySystem`): streak with the five breakers (edge-triggered), three-bucket coverage, resilience/single-points, the five-rung ladder with OPERATOR/ENGINEER/COLONY ARCHITECT identity, command classification (intervention/policy/dev, refused ≠ intervention), `autonomy/break` + `autonomy/rung` events, HUD `Autonomy 6.8 sols · ENGINEER` chip, P2 flagship retargeted onto the measured streak. Save v16.
- [x] **Slice 2 — PolicySystem**: four standing orders — stockpile (seam scorer + seam claim), night power (tier ≥ 2 shed with hysteresis), storm shelter (re-arm + recall), auto-maintain (worst-first repair/clean) — acting through the same seams a player's order takes, marked policy-issued so the stat stays honest. `policy/*` commands + protocol shapes; Standing Orders card gated on `advancedAutomation`; `policy/acted` events. Save v17.
- [x] **Re-baselined notes all met**: policies act inside the sim (transcripts/determinism survive — never via noteCommandResult); 4 policies, no scripting language; the identity label is measured from the stat; AUTONOMY.md defined first (§4.1).
- [x] Tests: `tests/sim/autonomy.test.ts` (23), `tests/sim/policies.test.ts` (18+); hashes re-pinned.

---

## Phase 4 — Build the Colony Operations Dashboard (DONE, 2026-09-21)

**Goal:** Let players understand what increasingly complex colony is doing.

Full spec: `docs/COMMERCIAL-PHASE-4.md`. All three re-baselined pieces shipped
plus the review's P13 rider:

- [x] **Extended history** — `HistorySample` widened: ore (mined bulk), steel, components, `roverUtil` (the AUTONOMY work split: moving/working ÷ fleet), and `prod`/`cons` trailing-sol rates per fluid (the existing flow-window arithmetic split by direction).
- [x] **Sol-bucketed downsampling** — `SolHistoryRow` ring (`SOL_HISTORY_ROWS = 240`): sol-average gen/load/utilization, sol-worst battery, end-of-sol pools/ledgers, per-fluid sol totals. The within-sol accumulator is derived (unsaved, unhashed, reset with the windows); rows feed nothing back.
- [x] **Persisted event journal (§3.5)** — `state.journal`, bounded (`EVENT_JOURNAL_MAX = 300`), sol-stamped. `DomainEventLog.sink` (one-line hook) journals at push time: every system writes it unknowingly. Streaming types (resource/produced|consumed, rover/moved) are refused by `journalWorthy`, and the restorer re-applies the list to hostile saves. P11/P12 aggregate later.
- [x] **Dashboard UI** — `src/ui/DashboardPanel.ts`: pure model + pure markup + canvas, overlay on the alert-history frame. Six rows matching the roadmap mock (POWER/WATER/OXYGEN/FOOD %, ROVERS n/m, AUTONOMY streak·identity), the nine graph checkboxes with a Live/Sols scope toggle (live ring vs `solHistory`), persisted choices. Topbar 📊 button + `O` hotkey + Esc chain. Reads the mirror only — no command path exists out of it.
- [x] **P13 single-points-of-failure row** — chains below their redundancy gate named on the card (measured, via AutonomySystem resilience), or "None — every critical chain has a spare."
- [x] **"NEXT BOTTLENECK" withheld** — P5's panel; description/advice stay separate (pinned in `ui/dashboard`).
- [x] **Save v18** — `history: { sols, journal }` block, `migrations/v17.ts`, shared sanitiser `persistence/historySave.ts` (rings re-bounded, streaming refused), validator warnings. Range v3..v18.
- [x] **State hash** — `solHistory` + `journal` in `core` (both outlive the 120-sample ring: long-run determinism pinned); `_solAcc` excluded (derived). Transcript, golden colony and stress hashes deliberately re-pinned — shape change only, no tick output moved.
- [x] **Tests** — `sim/history-system` +9, `sim/event-journal` (12, new), `ui/dashboard` (14, new); 98 suites / 1170 checks green; browser smoke: dashboard opens, rows/graphs/scope/checks behave, zero console errors.

### Definition of done (review §7)

- M4: for any observed failure, playtesters can answer "why failing" from the dashboard alone — the panel ships; the playtest is the open item.

---

## Phase 5 — Build the Bottleneck System (DONE, 2026-09-21)

**Goal:** Turn raw simulation info into useful engineering decisions.

Mock: WATER BOTTLENECK panel with production/consumption, projected shortage, contributing factors, possible solutions (static suggestions, NOT auto-solve).

Re-baselined: one pure analyzer module in sim/ (testable without UI): inputs = history + current state; outputs = ranked bottlenecks with contributing factors and static solution suggestions per bottleneck type. Scope: 3 types at first (water, power, oxygen), not general solver.

Secretly needed by P1 — forecast utility is P1 infra (§3.1).

### What this Phase 5 pass shipped (full spec: `docs/COMMERCIAL-PHASE-5.md`)

- [x] **Pure analyzer** — `src/sim/bottlenecks/`: `types.ts` (plain-JSON report/snapshot), `solutions.ts` (static advice as data — mock lines echoed: "Increase mining", "Reduce consumption", "Build storage", repair echoes), `analyzer.ts` (the measurement: P1 forecast tiers for fluids, the grid resolver's own books for power, producer scrutiny, feed/buffer/consumer factors, ranked severity → projection → triage order oxygen/water/power; capped at 4 factors + 4 solutions — the mock's proportions, never a spreadsheet)
- [x] **Three kinds only** — water, oxygen, power. `BOTTLENECK_KINDS` is a 3-item tuple: not a general solver, per the review.
- [x] **Measured factors only** — every cause is read out of state and entity-linked ("pick the machine it names"): damaged (`repair` echo), switched off (`switch-on` echo), starved/throttled/idle with the sim's own idleReason, empty ice silo + stranded rovers, nearest-ice distance from the build centroid, thin tankage, the thirstiest consumer, demand/generation gap, brownout shed tier, battery-dies-before-dawn runway (vs the clock's own sun model), daylight dust, pod-only pack, the heaviest running machine with its measured draw (the mock's "Refinery consuming excess power"). Oxygen correctly degrades to a symptom when water fails first ("Fix water first" outranks another generator).
- [x] **Don't-auto-solve is architecture** — factors/solutions are strings + entity ids; the payload field is read-only; the panel's only interaction is `focus` (the alert-card gesture); each card ends with the oath ("The advisor names the problem. Solving it stays yours."). The P4 dashboard remains advice-free (its "NEXT BOTTLENECK" absence stays pinned).
- [x] **Advisor panel** — `src/ui/AdvisorPanel.ts`: roadmap-mock cards (headline + severity, per-sol rates, projected shortage with sub-sol breach styling, dashed factors, careted solutions), pure model/render/badge functions + shell class. Entry: `B` hotkey + ⚠ topbar button + Esc-chain slot. **Badge**: count in worst-severity tone, hidden when clear — the one place a shortage shouts with the panel closed.
- [x] **Boundary wiring** — `bottlenecks` on the projection payload, `BottlenecksView` in viewModels/view, mirror getter, `Simulation.bottlenecks` parity getter — same four seams P3's policies used; worker and in-process agree by construction, restore paints before the first tick.
- [x] **No save bump, no hash move** — the advisory is fully derived (first commercial phase with no migration). Transcript/golden/stress hashes pass untouched.
- [x] **P13 rider** — single-points-of-failure surfacing shipped with Phase 4 (dashboard SPOF strip) rather than rebuilt here.
- [x] **Tests** — `sim/bottlenecks` (15: quiet-when-healthy, water critical + mock factors/solutions, repair/switch-on echoes, caps, oxygen-as-symptom, power tiers 10%/4%, deficit numbers, dead-before-dawn, pod-pack advice, advice-is-sentences, ranking, determinism + JSON roundtrip, transport parity) + `ui/advisor` (7: mock formatting, units, breach flag, badge, section order, markers/focus/oath, escaping, empty state). 100 suites / 1192 checks green.

### Definition of done

- For any of the three watched shortages the player can answer "why" from the panel (measured, machine-linked factors) and has ≥3 distinct moves to consider. Playtest confirmation rides the shared M1–M9 batch.

---

## Phases 6–18 — Summary with ordering fixes (review §6)

```
P0'  Codify freeze (CI suite gate, golden transcript, invariant doc)  [DONE]
P1'  First 30 min + Forecast utility + strings externalization        [DONE]
P2'  ObjectiveSystem (data-driven) + Unlock registry                  [DONE] ← shared primitive
P3'  PolicySystem (colony standing orders) + AUTONOMY stat
P4'  Event log persistence + Dashboard + extended history
P5'  Bottleneck analyzer (3 types)                                          [DONE]
P13' Single-points-of-failure surfacing (one dashboard row — ride along with P5)  [DONE with P4]
P6'  Survey confidence + expedition planning                                 [NEXT]
P7'  POI consequences (narrative first, unlocks second)
P8'  Rover history & naming                                           [cheap, slot anywhere]
P11' Colony report (shareable card) — after event log, before campaign
P9'  Campaign (EA: chapters 1–3)
P10' Scenarios
P16' Vertical slice  ← needs Packaging workstream done
P12' Incident reports
P17' Playtests → P15' Polish → P18' Launch
```

Plus:

- Phase 16a — Packaging workstream (desktop/Steam, file saves + Steam Cloud, update-check flag, packaging CI) — deadline before vertical slice (review §4.2)
- Mobile policy: "desktop-first, mobile playable but not release-gating" (review §4.3)
- Transcript export + funnel milestones for playtests (review §4.5)

---

## Commercial gaps filled

- [x] Save compatibility policy — DONE `docs/SAVE-COMPATIBILITY.md`
- [x] Invariant doc — DONE `docs/SIMULATION-INVARIANTS.md`
- [x] Baseline perf — DONE `benchmarks/baseline.md`
- [x] Golden colony + CI gate — DONE `tests/golden-colony/` + `.github/workflows/pages.yml`
- [x] Forecast utility (P1 infra, secretly needed by P5) — DONE `src/sim/forecast.ts` (review §3.1)
- [x] Strings externalization (P1 infra) — DONE `src/ui/strings.ts` (review §4.6)
- [ ] Packaging workstream — TODO, before vertical slice (review §4.2)
- [ ] Mobile role decision — TODO, one-line policy (review §4.3)
- [ ] Telemetry/transcript export plan — TODO, P1/P17 (review §4.5)
- [ ] Demo cutline — TODO, define now so P1–P5 aim at it (review §5 P16: first three projects, one storm arc, POIs+salvage+one drop, 60–90 min)

---

## Milestone exit criteria (measurable, review §7)

- M0: suite green on every PR; golden transcript pinned in CI — DONE
- M1: ≥7/10 unguided playtesters reach water→oxygen stable within 45 min without help; other 3 fail at same step
- M2: playtesters can state current project's goal unprompted
- M3: ≥1 policy in use by session 2 of new player's first colony
- M4: for any observed failure, playtesters can answer "why failing" from dashboard alone
- M8 (demo): median session ≥45 min; ≥50% finish "Survive First Storm"; measurable wishlist conversion
- M9: ≥60% strangers return for second session

Numbers placeholders — set before playtests so can't be moved to match results.

---

## Risks & scope realism (review §8)

1. Solo-dev throughput vs 18 phases = 12–18 months. Compression via re-baseline helps; bigger lever is cutting: EA with chapters 1–3, 3 bottleneck types, 3–5 policies, demo-cutline-only scope for P1–P5.
2. Sim keeps growing anyway — enforce "every addition names decision it creates" in review.
3. Determinism tax — every phase adding player-facing randomness must draw from seeded RNG inside sim. Transcript/hash suites catch violations late.
4. Saves & migration debt — every phase adds fields (objectives, policies, unlocks, rover stats, names, event log). Budget migration per phase. Desktop save move multiplies — do before heaviest save phases (P2/P3/P4), not after.
5. One-colony emotional ceiling — fantasy ends at autonomy; after M6 retention engine is scenarios+seeds+reports (P10/P11). If playtests show stop at autonomous, invest there before P15 polish.

---

## What to keep verbatim (review §9)

- Core loop diagram and HUMAN→AUTONOMOUS progression — game identity, paste into store page and GDD
- Tutorial philosophy (situation → warning → player discovers fix)
- "Repeated questions are UX problems."
- TIER 1–4 prioritization and WHAT NOT TO DO section
- "Simulation complexity is NOT the goal. Interesting decisions ARE."

---

## Immediate next steps (from roadmap's own Immediate Roadmap, dependency-honest)

1. **First 30-Minute Experience** — make existing game understandable — DONE (awaiting unguided playtest, M1)
   - Forecast utility (`sim/forecast.ts`)
   - Strings externalization
   - Tutorial system (situation warnings)
2. **Engineering Projects** — explicit reasons to interact — DONE (ObjectiveSystem + data table + unlock registry + panel)
3. **Automation Progression** — manual→automated→autonomous central — DONE (autonomy stat + PolicySystem, P3)
4. **Operations Dashboard** — complex colonies understandable — DONE (extended history + event journal + dashboard, P4; M4 playtest open)
5. **Bottleneck/Advisor** — simulation data → useful decisions — DONE (pure analyzer, 3 types + advisor panel, P5)
6. **Exploration + POIs** — reason to leave starting colony — NEXT (P6 survey confidence + expeditions, P7 consequences)
7. **Campaign** — beginning/middle/end — after P6/P7
8. **Replayability** — scenarios + starting conditions — after campaign
9. **Vertical-Slice Demo** — prove fun before heavy polish — after P1–P5 + packaging
10. **Public Playtesting** — real player behavior — after demo
11. **Commercial Polish** — visuals/audio/UX/accessibility/game feel — after playtests
12. **Launch Prep** — store page, trailer, demo, wishlists, community — last

---

## Artifacts produced this session (Phase 4)

- `src/sim/state/HistoryState.ts` — extended `HistorySample`, `SolHistoryRow`, `SolAccumulator`, journal entry type + `journalWorthy` skip list + `pushJournal`
- `src/sim/systems/HistorySystem.ts` — wider sample, `tick(state, newSol)` + `rollSol`, `fleetUtilization`, `flowRatePerSol`, accumulator resets
- `src/sim/state/ColonyState.ts` — `solHistory` / `journal` / `_solAcc` fields, `DomainEventLog.sink` wiring
- `src/sim/domainEvents.ts` — the `sink` hook
- `src/sim/Simulation.ts` — `newSol` forwarded to HistorySystem; `solHistory` / `journal` accessors; type re-exports
- `src/sim/config.ts` — `SOL_HISTORY_ROWS = 240`, `EVENT_JOURNAL_MAX = 300`, save version 18
- `src/sim/persistence/SaveSchema.ts` — `history` block (`HistorySave`) v18
- `src/sim/persistence/historySave.ts` — the block's shared sanitiser
- `src/sim/persistence/migrations/v17.ts` — v17 → v18
- `src/sim/persistence/SaveMigrations.ts`, `ColonyPersistence.ts`, `SaveValidator.ts` — chain, snapshot/restore, warnings
- `src/sim/debug/StateHash.ts` — `solHistory` + `journal` into the `core` section
- `src/sim/host/projection.ts`, `mirror.ts`, `viewModels.ts` — `solHistory` in the read model; samples deep-copied
- `src/ui/DashboardPanel.ts` — the operations dashboard (pure model/markup + canvas graphs)
- `src/ui/HUD.ts` — 📊 topbar button, dashboard delegates, per-frame update
- `src/app/InputController.ts` — `O` hotkey + the Esc chain link
- `src/ui/strings.ts` — `dashboard.*` copy
- `src/style.css` — `#dashboard-overlay` styles
- `tests/sim/history-system.test.ts` (+9), `tests/sim/event-journal.test.ts` (12, new), `tests/ui/dashboard.test.ts` (14, new), `tests/full.test.ts` links
- `tests/sim/maintenance.test.ts`, `tests/sim/policies.test.ts` — version pins 18
- Pinned hashes re-recorded: canonical transcripts (`Transcript.ts` + test), golden colony, `tests/sim/large-colony-stress.test.ts`, `benchmarks/baseline.md`
- `docs/COMMERCIAL-PHASE-4.md` — the phase spec; `docs/SAVE-COMPATIBILITY.md` v18 row; `docs/SIMULATION-INVARIANTS.md` hash-section note; this file updated
- Browser smoke (playwright, sandbox): wizard → O opens dashboard → 6 rows in mock order → 4 vitals graphs paint from live history → checkbox adds a 5th → sols empty-state → Esc/buttons — all green, zero console errors

## Artifacts produced earlier (Phase 3)

- `src/sim/state/AutonomyState.ts`, `src/sim/systems/AutonomySystem.ts` — the stat (streak/coverage/resilience/rungs), `AUTONOMY_TUNING`, `autonomySnapshot`
- `src/sim/state/PolicyState.ts`, `src/sim/systems/PolicySystem.ts` — the four standing orders, `policySnapshot`, `POLICY_UNLOCK`
- `src/ui/ProjectsPanel.ts` — autonomy chip + Standing Orders card
- Save v16 (`migrations/v15.ts`, `autonomySave.ts`) + v17 (`migrations/v16.ts`, `policySave.ts`), validator warnings
- `tests/sim/autonomy.test.ts` (23), `tests/sim/policies.test.ts` (18)
- `docs/COMMERCIAL-PHASE-3.md` — the phase spec

## Artifacts produced earlier (Phase 2)

- `src/sim/unlocks.ts` — the unlock registry (ids, info, grant/has/list, pure)
- `src/sim/projects/types.ts` — declarative requirement records + project/project-view shapes
- `src/sim/projects/requirements.ts` — the one evaluator (current / target / met per kind)
- `src/sim/projects/catalog.ts` — the five projects, their prerequisites and rewards
- `src/sim/state/ObjectiveState.ts` — board state (active, completed) + empty board
- `src/sim/systems/ObjectiveSystem.ts` — offer / evaluate / complete / pay / project, plus the direct-order classification
- `src/ui/ProjectsPanel.ts` — the board panel (markup is a pure function, so it is testable without a DOM)
- `src/sim/persistence/migrations/v14.ts` — v14 → v15 (empty board, empty registry, marker = save's sol)
- Save schema v15, `ColonyPersistence` snapshot/restore, `SaveValidator` warnings, `StateHash` core section
- Host read model: `ObjectiveView` in `viewModels.ts`, `view.ts`, `projection.ts`, `mirror.ts`, `Simulation.objectives`
- `src/sim/domainEvents.ts` — `objective/offered`, `objective/completed`, `unlock/granted`
- `src/app/Game.ts` + `src/style.css` — panel wiring and layout (docks beside the vitals; mobile chip)
- `tests/sim/objectives.test.ts` (22 checks), `tests/ui/projects-panel.test.ts` (6 checks)
- `docs/COMMERCIAL-PHASE-2.md` — the phase spec; this file updated
- Pinned hashes re-recorded: canonical transcripts, golden colony, large-colony stress (`benchmarks/baseline.md`)
- Save version 15; `tests/sim/maintenance.test.ts` version pin updated

## Artifacts produced earlier (Phase 0 + Phase 1 full)

Phase 0:
- `tests/golden-colony/*` — golden colony transcript + hash + save + meta + README
- `scripts/generate-golden-colony.mjs` — generator + checker
- `tests/sim/golden-colony.test.ts` — 7 checks, linked in `full.test.ts`
- `benchmarks/baseline.md` — perf baseline
- `docs/SIMULATION-INVARIANTS.md` — invariant map
- `docs/SAVE-COMPATIBILITY.md` — save policy
- `.github/workflows/pages.yml` — CI now runs full suite + replay + golden check (Phase 0 gate)

Phase 1 infrastructure + tutorial (review §3.1, §4.6, §5 P1):
- `src/sim/forecast.ts` — pure forecast math (sols-to-empty, runway breach, warning tiers)
- `tests/sim/forecast.test.ts` — 8 checks
- `src/ui/strings.ts` — player-facing copy bundles (tutorial, warnings, projects, bottleneck, dashboard, autonomy, POI, report)
- `tests/ui/strings.test.ts` — 5 checks
- `src/sim/state/TutorialState.ts` — milestones, warnings, hints, funnel, stats, transient
- `src/sim/systems/TutorialSystem.ts` — milestone tracking, warnings via forecast ctx, cooldown, funnel, stats hooks
- `src/sim/persistence/ColonyPersistence.ts` — snapshot/restore tutorial with migration from old saves
- `src/sim/host/viewModels.ts`, `view.ts`, `projection.ts`, `mirror.ts`, `protocol.ts`, `applyCommand.ts` — view layer + host command
- `src/sim/Simulation.ts` — dismissTutorialHint + get tutorial()
- `src/ui/TutorialPanel.ts` — situation-driven hints, warnings, progress, dismiss
- `src/style.css` — #tutorial-panel styles
- `src/audio/AudioSystem.ts` — cue for tutorial/dismiss
- `src/sim/domainEvents.ts`, `src/sim/DevBackdoors.ts` — events + afterTimeJump clear
- `tests/sim/tutorial.test.ts` — 12 checks
- `tests/sim/host.test.ts` — SAMPLES includes tutorial/dismiss
- `docs/COMMERCIAL-PHASE-1.md` — full Phase 1 spec and remaining work (now marked DONE)
- This file — implementation tracker (updated)
- `package.json` — added `test:golden` and `test:golden:write` scripts
- Pinned hashes updated: `tests/golden-colony/golden-colony.meta.json` → rf1-024150dbf13fe8-03093564627b23, canonical transcripts → new hashes, large-colony-stress → rf1-0602d23cbf6d99-10335f00abe039

---

## Artifacts produced this session (Phase 5)

- `src/sim/bottlenecks/types.ts` — plain-JSON `BottleneckReport` / `BottleneckSnapshot` (no Map, no Infinity)
- `src/sim/bottlenecks/solutions.ts` — static advice tables as data (mock lines echoed)
- `src/sim/bottlenecks/analyzer.ts` — the pure analyzer: 3 kinds, measured factors, static solutions, deterministic ranking
- `src/sim/host/projection.ts` — payload field `bottlenecks` via `bottleneckSnapshot(sim.state)`
- `src/sim/host/viewModels.ts` — `BottleneckView` family; `src/sim/host/view.ts` — `SimFields.bottlenecks`; `src/sim/host/mirror.ts` — getter
- `src/sim/Simulation.ts` — `bottlenecks` parity getter
- `src/ui/AdvisorPanel.ts` — overlay card(s), pure model/render/badge, focus-only interaction
- `src/ui/HUD.ts` — ⚠ topbar button + severity-toned count badge, open/close plumbing, update loop wiring
- `src/app/InputController.ts` — `B` hotkey + Esc-chain slot
- `src/ui/strings.ts` — `bottleneck.*` panel chrome copy
- `src/style.css` — `.adv-*` card styles + `#advisor-btn` badge tones
- `tests/sim/bottlenecks.test.ts` (15 checks), `tests/ui/advisor.test.ts` (7 checks), `tests/full.test.ts` — link
- `docs/COMMERCIAL-PHASE-5.md` — full spec
- `wiki/Interface-and-Controls.md` — advisor row + section
- This file — implementation tracker (updated)
- Save version unchanged (18); all pinned hashes unchanged

---

## How to run Phase 0 gates locally

```bash
npm install
npm run typecheck
npm test                    # 100 suites / 1192 checks, ~10 min
npm run test:replay         # canonical 3 scenarios
node scripts/generate-golden-colony.mjs --check  # golden colony hash
npm run test:bench          # fleet scaling
npm run test:stress -- --day  # 1 sol stress, 11 sec
npm run build
```

CI runs same (except bench/stress) on every PR and main.
