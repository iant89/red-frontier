# Red Frontier — Commercial Implementation Tracker

*Tracks progress against `COMMERCIAL-ROADMAP.md` (verbatim) and `COMMERCIAL-ROADMAP-REVIEW.md` (re-baseline).*
*This file is the living tracker; the two roadmap docs are the preserved source.*

Last updated: 2026-09-20
Branch: `arena/01a0c041-red-frontier`
Save version: 13
Test suite: 91 suites / 1035 checks (after Phase 1 infra: forecast + strings)

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

## Phase 1 — Make the First 30 Minutes Excellent (IN PROGRESS, infrastructure DONE)

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
- (c) **First-session funnel instrumentation** — opt-in anonymized milestone events `first-power`, `first-water-chain`, `first-storm-survived` etc. so "where do new players quit" is data, not vibes. — TODO
- (d) Focus on minutes 5–30 (between pod landed and water→oxygen chain understood). Descent intro + mission wizard already decent first 5 min.

### Tasks (from original + review)

- [x] Forecast utility (`src/sim/forecast.ts`) — pure, deterministic, uses `emptyFlows` / `HistoryState` flow windows — DONE
- [x] Strings externalization (`src/ui/strings.ts`) — DONE
- [ ] Contextual tutorials (situation → warning → player discovers fix, NOT click-here chain) — NEXT, see `docs/COMMERCIAL-PHASE-1.md`
- [ ] First-time hints
- [ ] Recommended actions
- [ ] Clear warnings — exemplar: "Your water reserve will run dry in 1.8 sols." (needs forecast utility) — infra DONE, UI TODO
- [ ] "Why this matters" explanations — copy DONE in strings, UI TODO
- [ ] Simplified early-game UI
- [ ] Guided first engineering project (hands first objective from wizard)
- [ ] Funnel milestone events (dev menu first, playtest builds later)
- [ ] Playtest: give to someone who never played, don't explain, watch. Repeated questions = UX problems.

### Suggested structure

```
/src/sim/forecast.ts           DONE — pure forecast math (sols-to-empty, runway breach)
/src/ui/strings.ts             DONE — player-facing copy bundles
/src/sim/systems/TutorialSystem.ts — TODO, tracks first-time milestones, emits warnings
/src/ui/TutorialPanel.ts       TODO, situation-driven hints, not modal click-chain
/tests/sim/forecast.test.ts    DONE
/tests/ui/strings.test.ts      DONE
/tests/hud/tutorial.test.ts    TODO
```

### Definition of done

- ≥7 of 10 unguided playtesters reach "water → oxygen chain stable" within 45 min without external help; other 3 all fail at same step (then fix that step) — review §7 M1.

See `docs/COMMERCIAL-PHASE-1.md` for full spec and remaining work.

---

## Phase 2 — Engineering Projects (after P1)

**Goal:** Give player meaningful objectives beyond "build whatever you want."

Original examples: ESTABLISH SURVIVAL, SURVIVE FIRST STORM, INDUSTRIALIZE, REMOTE OPERATIONS, AUTONOMOUS COLONY (10 sols no manual intervention).

Re-baselined notes (review §5 P2):

- `ObjectiveSystem` in `sim/systems/`, ticked after alerts, writing to `ColonyState.objectives`
- Project definitions in data table (`sim/projects/`), never in code (§3.4) — campaign (P9) then becomes content authoring
- Progress predicates read only deterministic sim state
- Rewards route through unlock registry (§3.3) — decide what "Advanced automation" concretely unlocks (likely colony-level policies, P3)
- First projects completable with today's building set (protects demo cutline)
- UI: projects panel + situation-driven pips on HUD; wizard hands first project

Hidden dependency: needs unlock registry (shared primitive with P7/P9). Design unlock registry once — sim-side deterministic saved set of `unlockId`s that blueprint availability, project rewards, POI contents, chapter progression all read from.

---

## Phase 3 — Make Automation the Progression System

**Goal:** Progression about moving from manual → autonomous.

MANUAL → ASSISTED → AUTOMATED → REDUNDANT → AUTONOMOUS
Player: OPERATOR → ENGINEER → COLONY ARCHITECT

Re-baselined notes:

- Missing piece is PolicySystem: player-authored standing orders ("keep iron >500kg") that sim satisfies by issuing same commands player would
- Two hard requirements: policies act through command path so transcripts/determinism survive; policy-issued actions marked so autonomy stat stays honest (§4.1 AUTONOMY.md)
- Ship 3–5 policies, not scripting language
- OPERATOR/ENGINEER/ARCHITECT label tied to how much work is policy-driven
- Needs AUTONOMY stat defined — DONE in `docs/design/AUTONOMY.md` (three faces: streak, coverage, resilience, command classification, breaker rules, rung gates, save v14 schema, test plan)

---

## Phase 4 — Build the Colony Operations Dashboard

**Goal:** Let players understand what increasingly complex colony is doing.

Mock: POWER 84% STABLE, WATER 71% WARNING, etc., AUTONOMY 6.8 sols, NEXT BOTTLENECK

Re-baselined notes:

- Foundation exists: HistorySystem samples power + fluid vitals; DomainEventLog streams 19 event types; HUD vitals panel
- Missing: ore/steel/components series, rover utilization, dashboard UI, retention/downsampling
- Extend HistorySystem: add ore/steel/components series, rover utilization (fraction fleet with task), production/consumption per resource (flow accumulators exist), sol-bucketed downsampling so 200-sol colony doesn't hold 300k samples
- Dashboard reads mirror, must not touch sim state (host seam enforces, keep dashboard pure view)
- Do NOT put "NEXT BOTTLENECK" in dashboard — that's P5 advisory panel, keeps description/advice separate
- Prereq: persisted event log (shared with P11/P12) — DomainEventLog streams in-memory today but isn't saved. Build bounded persisted sol-stamped event ring once (P4 infra) and P11/P12 become aggregations.

---

## Phase 5 — Build the Bottleneck System

**Goal:** Turn raw simulation info into useful engineering decisions.

Mock: WATER BOTTLENECK panel with production/consumption, projected shortage, contributing factors, possible solutions (static suggestions, NOT auto-solve).

Re-baselined: one pure analyzer module in sim/ (testable without UI): inputs = history + current state; outputs = ranked bottlenecks with contributing factors and static solution suggestions per bottleneck type. Scope: 3 types at first (water, power, oxygen), not general solver.

Secretly needed by P1 — forecast utility is P1 infra (§3.1).

---

## Phases 6–18 — Summary with ordering fixes (review §6)

```
P0'  Codify freeze (CI suite gate, golden transcript, invariant doc)  [DONE]
P1'  First 30 min + Forecast utility + strings externalization        [NEXT]
P2'  ObjectiveSystem (data-driven) + Unlock registry                  ← shared primitive
P3'  PolicySystem (colony standing orders) + AUTONOMY stat
P4'  Event log persistence + Dashboard + extended history
P5'  Bottleneck analyzer (3 types)
P13' Single-points-of-failure surfacing (one dashboard row — ride along with P5)
P6'  Survey confidence + expedition planning
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

1. **First 30-Minute Experience** — make existing game understandable — NEXT
   - Forecast utility (`sim/forecast.ts`)
   - Strings externalization
   - Tutorial system (situation warnings)
2. **Engineering Projects** — explicit reasons to interact — after P1
3. **Automation Progression** — manual→automated→autonomous central — after P2
4. **Operations Dashboard** — complex colonies understandable — after P3
5. **Bottleneck/Advisor** — simulation data → useful decisions — after P4
6. **Exploration + POIs** — reason to leave starting colony — after P5
7. **Campaign** — beginning/middle/end — after P6/P7
8. **Replayability** — scenarios + starting conditions — after campaign
9. **Vertical-Slice Demo** — prove fun before heavy polish — after P1–P5 + packaging
10. **Public Playtesting** — real player behavior — after demo
11. **Commercial Polish** — visuals/audio/UX/accessibility/game feel — after playtests
12. **Launch Prep** — store page, trailer, demo, wishlists, community — last

---

## Artifacts produced this session (Phase 0 + Phase 1 infra)

Phase 0:
- `tests/golden-colony/*` — golden colony transcript + hash + save + meta + README
- `scripts/generate-golden-colony.mjs` — generator + checker
- `tests/sim/golden-colony.test.ts` — 7 checks, linked in `full.test.ts`
- `benchmarks/baseline.md` — perf baseline
- `docs/SIMULATION-INVARIANTS.md` — invariant map
- `docs/SAVE-COMPATIBILITY.md` — save policy
- `.github/workflows/pages.yml` — CI now runs full suite + replay + golden check (Phase 0 gate)

Phase 1 infrastructure (review §3.1, §4.6):
- `src/sim/forecast.ts` — pure forecast math (sols-to-empty, runway breach, warning tiers)
- `tests/sim/forecast.test.ts` — 8 checks
- `src/ui/strings.ts` — player-facing copy bundles (tutorial, warnings, projects, bottleneck, dashboard, autonomy, POI, report)
- `tests/ui/strings.test.ts` — 5 checks
- `docs/COMMERCIAL-PHASE-1.md` — full Phase 1 spec and remaining work
- This file — implementation tracker (updated)
- `package.json` — added `test:golden` and `test:golden:write` scripts

---

## How to run Phase 0 gates locally

```bash
npm install
npm run typecheck
npm test                    # 89 suites / 1027 checks, ~4.5 min
npm run test:replay         # canonical 3 scenarios
node scripts/generate-golden-colony.mjs --check  # golden colony hash
npm run test:bench          # fleet scaling
npm run test:stress -- --day  # 1 sol stress, 11 sec
npm run build
```

CI runs same (except bench/stress) on every PR and main.
