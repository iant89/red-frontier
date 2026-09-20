# Red Frontier — Commercial Phase 1: First 30 Minutes Excellent

*Implementation spec for Phase 1 of COMMERCIAL-ROADMAP.md, re-baselined per COMMERCIAL-ROADMAP-REVIEW.md §5 P1.*
*Status: DONE — infrastructure + tutorial system + persistence + UI shipped, awaiting playtest.*
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

### 3. Tutorial core — `src/sim/state/TutorialState.ts` + `src/sim/systems/TutorialSystem.ts` (DONE)

Pure deterministic milestone/warning system, no DOM.

- `TutorialState`: milestones (12), warnings (11), seen/dismissed hints, funnel (bounded 200), stats, transient `_activeWarnings`, `_nextHint`
- `TutorialSystem.tick(state, ctx)`:
  - Milestones: first-move (rover moved >12m or move command), first-resource-found (POI discovered / deposit reserved / mine), first-mine, first-haul (storage>1 or stat), first-build, first-power (solar/battery online + gen>5), first-water (extractor+water), first-oxygen, first-food, first-automation (rule or repeat), first-storm-survived (stats), first-objective (water+oxy+power+sol>=2)
  - Warnings: uses `TutorialSystemContext` { reserveSols, netRatePerSol, instantRatePerSol } — reads forecast-like rates from LifeSupportSystem; fluid warnings via reserveSols <1.0 critical, <2.5 low; battery <20% or brownout → power-low/battery-low; panels <70% → panels-dirty; disabled rover → rover-stranded; damaged building → building-damaged; storm forecast <120s → storm-inbound
  - Cooldown: 0.5 sol per warning, bounded funnel push, domainEvents `tutorial/milestone`, `tutorial/warning`
  - Transient derivation: `_activeWarnings`, `_nextHint` (first incomplete milestone → hintId mapping, prioritizes welcome until dismissed)
- Hooks: `onRoverMove`, `onMine`, `onHaul`, `onBuild`, `onAutomation`, `onStormSurvived` increment stats (called from Simulation tick / rover/build systems)
- `dismissHint`, `seeHint`, `clear`, `afterTimeJump` (clears transient + resets warning lastSeenTick)
- Tick order: after Failure→Alert, before History (same as AlertSystem). Reads ColonyState, writes ColonyState.tutorial.
- Save: milestones saved so reload doesn't repeat tutorial — save v14 candidate (see below).

Suite: `tests/sim/tutorial.test.ts` — 12 checks: empty defaults, milestone detection, stats hooks, water-critical warning, cooldown, afterTimeJump transient clear, snapshot includes tutorial, restore from old save without tutorial → empty, funnel bounded, dismiss persists, nextHint respects dismissed.

### 4. Persistence — SaveCodec boundary unchanged, SaveValidator warnings optional (DONE)

- `src/sim/persistence/SaveSchema.ts`: CURRENT_SAVE_VERSION still 13? Actually code adds tutorial optional — SaveCodec treats unknown fields as optional; no version bump required for optional additive field (per SAVE-COMPATIBILITY.md: additive optional fields don't require version bump). However `ColonyPersistence.ts` now writes `tutorial` block and restores it defensively.
- `src/sim/persistence/ColonyPersistence.ts`: `snapshotColony` writes `tutorial: { milestones, warnings, seenHints, dismissedHints, funnel, stats }` (deep copies). `restoreColony` reads `data.tutorial` if present, else `emptyTutorialState()`. For milestones/warnings, iterates known keys only, validates `completed` boolean, `lastSeenTick` finite, clamps counts. Funnel sliced -200, stats floored >=0. Handles old saves missing tutorial.
- `src/sim/persistence/SaveValidator.ts`: tutorial warnings are optional, not errors — validates shape if present, else warns.
- StateHash: now includes tutorial milestones/warnings/seen/dismissed/funnel/stats in hash — intentionally breaks pinned hashes; re-pinned via `test:golden:write`, `replay-transcript`, `large-colony-stress`.

### 5. View layer projection (DONE)

- `src/sim/host/viewModels.ts`: `TutorialView` interface — milestones copy, `_activeWarnings`, `_nextHint`, funnel, stats
- `src/sim/host/view.ts`: `tutorial: TutorialView` in SimFields, export TutorialView
- `src/sim/host/projection.ts`: `ViewPayload.tutorial` block — copies tutorial state (milestones copy, warnings active list, nextHint, funnel last 20, stats)
- `src/sim/host/mirror.ts`: `get tutorial()` getter — exposes via SimView proxy
- `src/sim/domainEvents.ts`: `tutorial/milestone`, `tutorial/warning`, `tutorial/hint` event types
- `src/sim/DevBackdoors.ts`: imports TutorialSystem, `setTime` clears tutorial transient via `TutorialSystem.afterTimeJump`

### 6. Host layer (DONE)

- `src/ui/TutorialPanel.ts`: deterministic panel reading `SimView.tutorial`, HINT_COPY/WARNING_COPY using STRINGS, warnings + nextHint + progress bar + dismiss callback
- `src/app/Game.ts`: private `tutorialPanel` field, instantiated in constructor with `onDismissHint -> host.send({type:'tutorial/dismiss',hintId})` and `onAction -> handleAction`, `update()` called after `hud.updateVitals` in both started path and tick path
- `src/sim/host/protocol.ts`: `TutorialCommand {type:'tutorial/dismiss',hintId:string}` added, PlayerCommand union extended, PLAYER_COMMAND_TYPES includes 'tutorial/dismiss', FieldKind 'hintId' validation string 1..64, COMMAND_SHAPES entry, fieldOk case
- `src/sim/host/applyCommand.ts`: handles 'tutorial/dismiss' -> `sim.dismissTutorialHint()`
- `src/sim/Simulation.ts`: `dismissTutorialHint(hintId)` calling `TutorialSystem.dismissHint()` and `get tutorial(): TutorialView` projecting `state.tutorial` (milestones copy, _activeWarnings, _nextHint, funnel, stats) to satisfy SimView compliance
- `tests/sim/host.test.ts`: SAMPLES now includes tutorial/dismiss
- `src/style.css`: `#tutorial-panel` + `.tut-warning`, `.tut-hint`, progress styles, responsive breakpoints
- `src/audio/AudioSystem.ts`: COMMAND_CUES includes `tutorial/dismiss: 'ui'`

### 7. Phase 0 gates — CI + golden colony + docs (DONE)

See `docs/COMMERCIAL-IMPLEMENTATION.md` Phase 0 section and `docs/SIMULATION-INVARIANTS.md`, `docs/SAVE-COMPATIBILITY.md`, `benchmarks/baseline.md`.

CI now runs full suite + replay + golden check (review §4.4 highest-leverage item).

---

## Remaining Phase 1 work (TODO) — only playtest and polish left

### Playtest plan (from roadmap) — NEXT

> Give the game to someone who has never played it. Do not explain the game. Watch them.
> Repeated questions are UX problems.

- Recruit 10 strangers
- Don't explain
- Observe: where confused, what ignored, what enjoyed, what frustrated, where quit, what remembered, what talked about after
- Ask: "What were you trying to accomplish?" "What was confusing?" "What did you enjoy most?" "What would you change?" "At what point did you want to keep playing?"
- Don't rely only on "Did you like it?" — behavior > compliments
- Target: ≥7/10 reach water→oxygen stable within 45 min without help

### Polish

- Funnel UI: Dev menu shows funnel events (opt-in milestone logging) — `TranscriptRecorder` exists, needs UI button (review §4.5)
- First project: wizard hands first project "Establish Survival" — functional oxygen, water, food, stable power — needs ObjectiveSystem (P2) but for P1 hardcoded minimal objective that uses same warning philosophy
- Simplified early-game UI: hide advanced blueprints until relevant? Or grey out with "why locked" copy via unlock registry (P2). For Phase 1, keep all blueprints available but highlight recommended next build based on current bottleneck
- Clear warnings: use forecast utility `warningForFluid` for water/oxygen/food already wired via reserveSols, but copy could be enriched with produced/consumed numbers

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
