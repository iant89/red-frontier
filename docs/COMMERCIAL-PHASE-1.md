# Red Frontier — Commercial Phase 1: First 30 Minutes Excellent

*Implementation spec for Phase 1 of COMMERCIAL-ROADMAP.md, re-baselined per COMMERCIAL-ROADMAP-REVIEW.md §5 P1.*
*Status: IN PROGRESS — infrastructure done, UX work next.*
*Branch: `arena/01a0c041-red-frontier`*

---

## Goal

Make the game immediately understandable to someone who has never played it.

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

---

## What already exists (foundation)

- Descent intro + mission wizard (difficulty, world size, world options, landing site globe) — decent first 5 min
- No tutorial/hint/objective code — genuine gap (review §2)
- Vitals panel (power, water, oxygen, food) but no forecast
- Alerts (critical/warning/info/opportunity) but copy scattered in HUD.ts
- Rover automation rules exist (autoHaul, autoService, stormShelter, autoRescue, chargeFloor)
- HistorySystem samples power + fluid vitals, but not ore/steel/components

Vulnerable zone: minutes 5–30, between "pod landed" and "water → oxygen chain understood"

---

## Infrastructure shipped this session (review §3.1, §4.6, §4.7)

### 1. Forecast utility — `src/sim/forecast.ts` (DONE)

Pure, deterministic, no DOM/three/RNG. One function set that P1, P4, P5 all consume.

- `forecastFluid(state, fluid)` — reads flow windows, returns sols-to-empty, netPerSol, isDepleting, runwayBreach (<1.0 sol), warningTier (ok/watch/warning/critical)
- `forecastFluidWithRates(amount, capacity, fluid, producedPerSol, consumedPerSol)` — overload for tests and consumers with precomputed rates
- `forecastColony(state)` — full colony forecast, worstFluid, hasRunwayBreach, summary
- `formatSolsToEmpty(sols)` — "1.8 sols" or "∞"
- `warningForFluid(forecast)` — player-facing copy: "Your water reserve will run dry in 1.8 sols." — roadmap exemplar

Why this matters: tutorial exemplar "Your water reserve will run dry in 1.8 sols" is a forecast — production/consumption projection. That math was listed under Phase 5 but needed in Phase 1. Now built once, three phases early.

Suite: `tests/sim/forecast.test.ts` — 8 checks: not depleting → Infinity, sols-to-empty math, warning tiers, runway breach, format, warning copy matches exemplar, net math, determinism.

### 2. String externalization — `src/ui/strings.ts` (DONE)

Centralized player-facing copy so localization later is rewrite of this file, not hunt through HUD.ts literals.

- Keys: `tutorial.*`, `warning.*`, `project.*`, `bottleneck.*`, `dashboard.*`, `autonomy.*`, `poi.*`, `report.*`, `alert.*`, `building.*`, `rover.*`
- Function values for formatted numbers: `warning.waterEmpty(sols) => "Your water reserve will run dry in ${sols}."`
- Helpers: `formatKg`, `formatKm`, `formatPct`, `formatSols`
- Convention documented in file header
- Suite: `tests/ui/strings.test.ts` — 5 checks: keys present, function format, getString, helpers, tutorial philosophy (no click-here)

New player-facing copy must go through this file.

### 3. Phase 0 gates — CI + golden colony + docs (DONE)

See `docs/COMMERCIAL-IMPLEMENTATION.md` Phase 0 section and `docs/SIMULATION-INVARIANTS.md`, `docs/SAVE-COMPATIBILITY.md`, `benchmarks/baseline.md`.

CI now runs full suite + replay + golden check (review §4.4 highest-leverage item).

---

## Remaining Phase 1 work (TODO)

### Tutorial system

Create:

- `src/sim/systems/TutorialSystem.ts` — tracks first-time milestones, emits warnings
  - Milestones: first-move, first-mine, first-haul, first-build, first-power, first-water-chain, first-oxygen, first-food, first-automation, first-storm-survived, first-project
  - Reads forecast utility for "will run dry in X sols" warnings
  - Emits domain events or writes to `ColonyState.tutorial` (to be added)
  - Deterministic, saved? Milestones should be saved so tutorial doesn't repeat after load — save v14 candidate

- `src/ui/TutorialPanel.ts` — situation-driven hints, not modal click-chain
  - Shows warning copy from `strings.ts`
  - "Why this matters" explanations
  - Recommended actions (static suggestions, not auto-solve)
  - Dismissible, but reappears if situation worsens

Philosophy (from roadmap, keep verbatim):

> Do NOT make the tutorial:
>     Click here.
>     Click here.
>     Click here.
>
> Instead:
>     "Your water reserve will run dry in 1.8 sols."
>
> Then let the player discover how to solve it.

### First-time hints & recommended actions

- Contextual: when water < 2.5 sols, show water warning + "Why: water is bridge into life support"
- When power < 30% battery, show power warning
- When rover idle with no task, suggest auto-haul rule
- When storm inbound, suggest shelter + charge

### Clear warnings

- Use forecast utility: `warningForFluid` for water/oxygen/food
- Use power forecast: battery reserve <30%
- Use storm forecast: existing forecast lead time (60s baseline, 2.25× with radar)

### Simplified early-game UI

- Hide advanced blueprints until relevant? Or grey out with "why locked" copy via unlock registry (P2)
- For Phase 1, keep all blueprints available but highlight recommended next build based on current bottleneck

### Guided first engineering project

- Wizard hands first project: "Establish Survival" — functional oxygen, water, food, stable power
- Needs ObjectiveSystem (P2) but for P1 can be a simple hardcoded first objective that uses same warning philosophy

### Funnel instrumentation (review §5 P1)

- Opt-in anonymized milestone events: `first-power`, `first-water-chain`, `first-storm-survived`
- Dev menu first, playtest builds later
- Export session transcript button (review §4.5) — deterministic replay from seed+commands, few hundred bytes

### Playtest plan (from roadmap)

> Give the game to someone who has never played it. Do not explain the game. Watch them.
> Repeated questions are UX problems.

- Recruit 10 strangers
- Don't explain
- Observe: where confused, what ignored, what enjoyed, what frustrated, where quit, what remembered, what talked about after
- Ask: "What were you trying to accomplish?" "What was confusing?" "What did you enjoy most?" "What would you change?" "At what point did you want to keep playing?"
- Don't rely only on "Did you like it?" — behavior > compliments
- Target: ≥7/10 reach water→oxygen stable within 45 min without help

---

## Suggested file layout

```
src/sim/forecast.ts                  DONE — pure forecast math
src/ui/strings.ts                    DONE — copy bundles
src/sim/systems/TutorialSystem.ts    TODO — milestone tracking, warnings
src/sim/state/TutorialState.ts       TODO — first-time flags, saved
src/ui/TutorialPanel.ts              TODO — situation-driven hints
src/ui/FirstSessionFunnel.ts         TODO — milestone logging (opt-in)
tests/sim/forecast.test.ts           DONE
tests/ui/strings.test.ts             DONE
tests/sim/tutorial.test.ts           TODO
tests/hud/tutorial.test.ts           TODO
```

---

## Definition of done (from review §7)

- M1: ≥7 of 10 unguided playtesters reach "water → oxygen chain stable" within 45 min without external help; other 3 all fail at same step (then fix that step)

---

## Dependencies

- Forecast utility → needed by P1 warnings, P4 dashboard, P5 bottleneck — DONE
- Strings externalization → needed by P1 tutorial, P2 projects, P7 POIs — DONE
- TutorialSystem → needs ColonyState.tutorial field + save migration v13→v14
- First project → needs ObjectiveSystem (P2) or hardcoded for P1
- Funnel → needs transcript export (review §4.5) — `TranscriptRecorder` exists, needs UI button

---

## Open decisions

1. Should tutorial milestones be saved? Yes — otherwise reload repeats tutorial. Add to save schema v14.
2. Should first project be hardcoded or wait for ObjectiveSystem? Recommend hardcoded minimal for P1 to unblock playtests, then migrate to data-driven in P2.
3. Mobile: keep mobile playable but not release-gating for P1? Per review §4.3, declare desktop-first to avoid doubling UI cost. Recommend: desktop-first for P1, mobile smoke stays nightly not PR-gating? Currently PR-gating, but okay.
4. Where does forecast read rates from? Currently `forecastFluid` tries `state.flowWindows` / `history.flowWindows` / `pools.flows`. Should be wired to `HistorySystem`'s flow windows explicitly — next pass.

---

## How to run

```bash
npm test -- forecast strings  # infrastructure
npm run dev                   # manual playtest
# Then give to stranger, watch
```
