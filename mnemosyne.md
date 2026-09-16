# Mnemosyne

Persistent notes for future coding sessions.

## In-play update check (TDD §23)

- `vite.config.ts` writes `dist/version.json` (`{ name, commit, builtAt }`) at
  build time — commit from `GITHUB_SHA` in CI, else local `git rev-parse HEAD`.
  The Pages workflow uploads `dist/` as-is, so the manifest is *by
  construction* the live build. Never remove it from the Pages upload path.
- `src/app/UpdateCheck.ts` polls that manifest every 5 min **while a colony
  runs** (started in `Game.launch`, production builds only, stopped on
  `returnToMenu`/mission end). Same-origin on purpose: the GitHub API
  (`BuildStatus.latestMainCommit`, main-menu badge) answers "where is main?",
  which can sit ahead of the live deploy (a failed smoke gate blocks the
  deploy while main moves), and rate-limits per IP.
- Flow on a newer commit: one-shot — freeze sim, `NEW BUILD AVAILABLE` banner,
  save via `Game.save(quiet, onDone)`, dispose host, `reload()` after 3 s.
  Save failure → "Reload anyway" button instead of a forced reload. Hidden
  tabs skip + re-arm on `visibilitychange`. QA knob: `?updateCheckMs=…` (≥1000).
- `scripts/update-check-smoke.mjs` drives the whole flow in headless Chromium
  (rewrites `dist/version.json` mid-run and restores it); run it after any
  change to the manifest/poller/reload path. `tests/app/update-check.test.ts`
  covers the poller unit-level (fake fetcher, no DOM).


- `scripts/setup-playwright.mjs` installs the Playwright browser-test dependencies. Use it when Playwright is needed instead of searching for another setup script.
- TypeScript is a local project dependency. Run `npm install` before expecting `tsc` or other package tools to be available.
- Add architecture notes, recurring pitfalls, useful commands, and unfinished work here as they are discovered.

## Design docs (realigned)

- `docs/design/GDD.md` and `docs/design/TDD.md` carry a living **§0 Implementation status** that maps every major system to **IN / PARTIAL / OUT** against the current tree (Prototype 4 + first P6 exploration slice). Prefer those tables over the original PDF wording when deciding what exists.
- Package is `0.3.0`; README correctly says Prototype 4. `SAVE_VERSION = 7`. Worker is the default transport (`WORKER_DEFAULT = true`).
- **Next-pillar fork is still open:** GDD wants P5 refining next; the project already shipped a P6 slice and TDD never gave refining its own tier. Pick Engineering (P5) vs finishing Exploration (T6) explicitly — the docs will not decide it for you.
- Deliberate locks encoded in sim + docs: bulk solids on rovers, fluids never; per-resource storage; dev *modifiers* never save, *fabrications* do; no field-fluid recovery in supply drops.

## Weather FX (dust devils)

- Devil behaviour lives in `src/render/particles/effects.ts` (`DustDevil`, `DevilManager`, `devilBand`, `MAX_DEVILS`).
  `FxContext` is the only interface between it and the world, and it now carries **`windRamp`** (m/s per sim second) —
  `WeatherFX.sync` derives it from the previous frame's reading, because the sim reports wind speed but never its
  derivative. Anything building an `FxContext` by hand (tests, tooling) must supply it.
- Devil counts are **rolled per intensity band and held**, not rolled per frame (`wantedFor` + `BAND_HOLD`). Rolling
  every frame would spawn and kill a devil on alternate frames as a storm hovers on a band boundary.
- `RAMP_MIN = 0.35 m/s²` was calibrated against the real sim, not guessed: 20 minutes of ambient weather across six
  seeds never trips it, a scheduled storm trips it as its front arrives. Re-check both directions before touching it.
- Budget: `MAX_DEVILS = 5`. Worst case measured at ~6155 of 9000 particles (5 devils fed to their growth cap plus a
  severe storm). `tests/render/particles.test.ts` pins that ceiling.
- **Adding a `rand()` draw to `DustDevil`'s constructor moves every seeded FX test** — the devil RNG is the FX RNG, and
  the size/spin/wander draws all come out of one stream. Expect to re-tune seeds when it changes.

## Dust field (the #2 / #7 rework)

- Ambient dust no longer blows into a fixed box: `WeatherFX.viewGeometry` derives `viewRadius`
  (half-diagonal of the viewed ground footprint) from rig radius, FOV, aspect and view angle, and
  `dustField(viewRadius)` in `particles/effects.ts` turns it into the emission envelope
  (`half`, `height`, `size` LOD, `alpha` haze, `swirl`, feather `r0`). `FxContext.viewRadius` is
  **required** — anything building an `FxContext` by hand (tests, tooling) must supply it.
- `half` is the emission box, the `wrapAmbient` radius *and* the rim feather's outer radius at
  once — that coincidence is what hides the box: `ParticlePool.setFalloff` fades ambient alpha to
  zero exactly at the wrap rim on a p=4 superellipse (stored in distance⁴ space so `writeRender`
  needs no roots). Never wrap at one radius and feather at another.
- `FIELD_MIN = 45` (close-up floor: up close you are inside the dust), `FIELD_MAX = 1000`
  (from-orbit ceiling: the world is 1280 m across, past that the field would hang over the void).
  Emission *rates* are deliberately view-independent — the box matches the view, so screen-space
  density is constant for free and the 9000-particle pool never grows.
- Storm grit is grit: sizes `(0.35–0.9, 0.9–1.8)·size`, strictly under the wind emitter's
  `(0.5–1.2, 1.2–2.1)·size`. The storm's wall-opacity comes from fog + sky haze, not from sprite
  coverage — do not "fix" thin-looking storms by re-inflating sprite sizes.
- Turbulence is now ONE coherent divergence-free roll (`CURL_K ≈ 157 m` cells, Taylor–Green via
  the sin(a±b) identity: 2 sines/particle, cheaper than the old 3-sine per-mote jitter) plus
  `CURL_SCAT` per-mote phase scatter. Coherence is the whole "fluid" read — neighbouring motes
  must turn together. `tests/render/particles.test.ts` pins coherence (cos ≈ 1 at 8 m, ≈ −1 half
  a roll away), path curvature and the downwind transport.
- Retuning traps: turbulence amplitude means *acceleration*; visible swing ≈ tb/ω² with
  ω ≈ wind·CURL_K + pattern drift. And `drag` silently eats wander over a particle's life.

## Rover proximity (issue #11)

- Hull clearance, not centre-to-centre: `nearestObstacleClearance` returns
  `centreDist − selfR − otherR`. A literal "5 ft from centre" would sit inside
  a 2.4–3.4 m rover. Constants live in `config.ts`
  (`ROVER_PROXIMITY_*`, `ROVER_COLONY_YARD_M`).
- Speed multiplies inside `moveRover` only — no re-path, no alert, no full stop.
  Crawl multipliers are never zero so nose-to-nose pairs keep inching.
- **Destination skip is load-bearing.** Without it, a builder crawling up to a
  site (or a rescuer closing on a stranded rover) never reaches arrival reach
  and the job hangs. Skip the current goal's target once inside that task's
  arrival ring. Covered by `tests/sim/proximity.test.ts`.
- Move power scales with `speedMul` so a crawl is a brake, not a battery tax.
  Condition wear is still per-tick of driving (the drivetrain is still turning).

## Learned the hard way

- **The two sim transports have different failure modes, and only the browser gates see both.** `LocalSimHost`'s view *is* the live sim, so anything that delays a view
  update is invisible to `npm test` and fatal on the worker. Concrete case: `workerRuntime` used to publish a view only on `advance`, so a command sent to a **paused**
  colony was applied and never shown. Found by `mobile-smoke` (which pauses before ordering) the day the worker became the default transport. If you touch
  `workerRuntime`'s message cases, run `node scripts/mobile-smoke.mjs` and `scripts/worker-smoke.mjs`, not just `npm test`.
- **`SMOKE_QUERY` must be explicit now that the worker is the default.** `SMOKE_QUERY='?worker=0'` for the in-process run; an empty query means "the default", which is
  the worker, so a CI pair of `?worker=1` + empty would test one transport twice. `worker-smoke` derives its expectation from the query for exactly this reason.
- **Attributing a smoke failure takes ~3 minutes and is worth it.** Export the base commit with `git archive <sha> | tar -x -C /tmp/base`, symlink `node_modules`, build,
  serve on another port, and point `BASE_URL` at it. That is how the paused-order bug was pinned on the worker flip rather than on the feature that landed next to it.
- **POI ids and entity ids are separate spaces.** Rovers, buildings and sites each allocate their own; anything keying a DOM node or a Map by id must namespace it
  (`hud/markers` uses `rover-12` / `poi-3`).
- Sites live on `World` (`world.pois`) but are *player-mutated* state (found, stripped, burial clock), so they cross the wire in the view payload and are snapshotted —
  do not try to re-derive them from the seed client-side the way the terrain is.
- Supply drops contain bulk resources and sometimes battery cells, never fluids. Exposed water or food would freeze, and the current rover logistics model has no
  field-fluid recovery path; do not bypass that boundary by teleporting fluid cargo into colony tanks.
- **Storm screenshots need patience, not time travel.** `dev/time` jumps re-anchor the clock but
  leave `weather.time` behind, so a conjured storm's envelope does not follow the jump — and the
  severe ramp is ~1.5 sim-hours anyway. The working recipe: `game.dev.enable()` +
  `game.dev.forceStorm('severe')` straight through the dev API (the panel's buttons need the PR #29
  master switch, and on a minified build the UI path is painful to debug), then run at 4× and
  `waitForFunction(stormIntensity > 0.75)` — a few real minutes. On a worker host, dev command
  acks are Promises: a synchronous `JSON.stringify(ack)` reads as `undefined`, which is not a failure.
  The same master switch gates `overlayState()`: anything publishing pins (including
  `scripts/worker-smoke.mjs`'s battery-pin check, which #29 left red on main until it called
  `g.dev.enable()`) must turn the mode on first.
- `src/audio/AudioSystem.ts` is presentation-only procedural Web Audio: it never writes sim state, starts on the first real input gesture to satisfy autoplay policy,
  and is deliberately updated at simulation speed 0 so paused colonies retain environmental ambience and brownout/storm reminders. Keep new `SimCommand` values
  represented in its exhaustive `COMMAND_CUES` map; `tests/audio/system.test.ts` pins that contract.

## Descent stage (the pod, given a body)

- `src/render/DescentStage.ts` draws the sim's landing pod (`POD_RADIUS` = 8 m at
  SPAWN) as a ~56 m propulsive-landing stage on three splayed legs. **Presentation
  only**: not in `getPickObjects()` (clicks fall through to terrain), never writes
  sim state, nothing in a save. The sim's exclusion/charge/shelter rules stay
  authoritative; the visual footprint (~10.9 m incl. feet) deliberately sits inside
  the sim's 8 m pod radius plus the 1.5 m rule margin so no *legal* building site
  can overlap a foot (`rules.ts`: centre ≥ def.radius + POD_RADIUS + 1.5).
- **Leg azimuths are load-bearing:** `[0, 120, 240]` degrees. `Simulation.ts` parks
  the starting rovers at (9, 0) and (−9, 4) — i.e. 90° and 294° — inside the pod
  radius, so a tripod at the wrong phase lands a foot on a rover on frame one.
  `tests/render/descent-stage.test.ts` pins the ≥3 m clearance; moving a leg or a
  rover spawn must re-check it.
- **The burn is two passes on one shell.** A char veil (NormalBlending, dark, alpha
  = soot) and a heat glow (AdditiveBlending). An additive pass can never darken,
  which is why the char cannot live in the glow pass — and additive blending in
  three multiplies source rgb **by source alpha** (SrcAlpha, One), so the glow's
  intensity must ride in `gl_FragColor.a` with the colour in rgb. An rgb-only
  payload with alpha 0 compiles, draws, and adds nothing: the quietest shader bug
  in this repo so far.
- `BURN` constants are the single source for both the GLSL (`BURN_MATH` templates
  them in) and the tested pure curve `burnProfile`, so the painted burn and the
  unit-tested one cannot drift. The glow also multiplies by `(1 - uDay)`: residual
  heat is a night feature, and at 86 % sun the same shader reads as a stage on
  fire.
- Metalness is kept ≈0.3 on the stage: the scene has **no environment map**, so a
  mirror-metal tank reflects nothing and renders near-black. If an env map ever
  lands, the stage is the first thing that can afford real metal.
- Shadow camera near plane went 50 → 30 (`Renderer.buildEnvironment`): a high sun
  puts the stage's top closer to the directional light than the old near plane,
  which clipped its shadow.

## Milestone 1 — deterministic state hash (StateHash)

- `src/sim/debug/StateHash.ts`: `hashSimulation(sim)` → `rf1-<14hex>-<14hex>`
  (two cyrb53 lanes over canonical-JSON — keys sorted, entity arrays sorted
  by id). **A 53-bit hash needs 14 hex digits** — padStart(13) was a real
  bug caught by the format test; keep the `{14}` in the regex.
- Hashes **live state, deliberately not `snapshot()`** — so a persistence bug
  can't hide behind the tool that polices it, and Phase 3's codec rework
  won't churn the hash. Consequence: a live sim and its just-restored twin
  do **not** hash equal — restore resumes rovers/buildings *at rest*
  (goal/nav/chargeSat/history reset by design). Compare restored-vs-restored,
  or compare after both advance. `tests/sim/state-hash.test.ts` pins this.
- Excluded on purpose (would churn without behavior change): `statusText`,
  `idleReason`, rover `label`, colonist `name`; also unobservable: `remainder`
  and the `dropRng` closure counter (a dropRng divergence surfaces one roll
  later as a real `nextDropSol`/drop diff, which *is* hashed).
- Sensitivity-test pattern: restore by **captured exact value**, never by
  inverse arithmetic — `x + 0.1; x - 0.1` leaves float residue and the
  back-to-baseline assert fails.
- The hash module is imported only by tests: it tree-shakes out of the app
  bundle (build size unchanged). If you ever wire it into dev tooling,
  remember it becomes bundle weight.

## Milestone 1 — remaining pieces (Profiler, Save validation, Transcripts)

- `src/sim/debug/Profiler.ts`: dev-only diagnostics with process-wide switch
  (`setProfilerEnabled`, default off, enabled in `tests/harness.ts`). Counters:
  ticks, pathfinds (`NavGrid.findPath`), commands (`applyCommand`), workerMessages
  (`WorkerSimHost.post` + `workerRuntime` send wrapper), viewGenerations + timing
  (`projectView`). `Simulation.step()` measures batch time via `performance.now()`.
  `snapshot(sim)` reports tick, simTime, realMs, entities/rovers/buildings/deposits/pois,
  activeTasks (non-idle command or pending), pathfinds, commands, workerMessages,
  viewGenerations, stepTimeMs/viewTimeMs and averages. `report(sim)` adds summary +
  table identical to roadmap's example. Observationally inert (same snapshot with
  profiler on/off). Tree-shakes out of bundle when not imported.
  `tests/sim/profiler.test.ts` (10 checks) pins counters, timing, reset, report format,
  inertness.

- `tests/sim/save-validation.test.ts` (26 checks): malformed-save suite covering
  Phase 3 requirements — empty save, missing version, unsupported version, non-object,
  invalid task shapes (coerced to idle), pending queue filtering, invalid building/
  rover/poi refs, negative storage flagged by invariants, fluid clamping, battery/cargo
  bounds, missing arrays defaulting, corrupt weather fallback, lightningMul fallback,
  invalid poi kind filtering, reservedBy coercion, plus v3→v8 historical migrations
  and round-trip determinism after migration. Uses `checkInvariants` for negative cases.

- `src/sim/debug/Transcript.ts`: transcript format `{ seed, difficulty?, worldHalf?,
  region?, worldOptions?, commands: [{ tick, command }], durationTicks? }` where tick
  is Simulation ticks (SIM_TICK = 1/20s). `replayTranscript()` sorts by tick,
  delivers tick-0 pre-tick, fixed-step loop, deterministic. `TranscriptBuilder`
  ergonomic helper, `validateTranscript()` shape errors, `canonicalTranscriptJson()`
  sorted-keys JSON for stable hashing. `tests/sim/transcript.test.ts` (12 checks):
  validation, canonical stability, same-transcript identical hash (via StateHash),
  different seed/commands diverge, building placement, mining haul, builder ergonomics,
  empty transcript, manual vs transcript replay (ticks = round(20*240*sols)), hash pinning
  `rf1-…` format. Intended use for refactor policing: pin hash before extraction, compare after.

- Milestone 1 is now **complete** (48 suites / 471 checks green). Next per roadmap §51
  is Phase 2 — ColonyState, then Phase 3 — Persistence as first major extraction.
  Recorded in roadmap §58 "Recorded (Milestone 1 complete)".

## Rover task handlers — check order is load-bearing (salvage ping-pong)

- **"Am I done/full?" checks must run before "am I there yet?" checks** in a
  rover task handler. `doSalvage` had the full-hold check *after* the distance
  check; a loaded rover trying to leave the site was turned straight back
  (goal `toSalvage`↔`toDepot` every tick — the status glitched between
  "Heading to the site" and "Hauling to storage"), or, inside the 8 m reach,
  the at-site branch clobbered goal/phase to `salvage` before `beginUnload`
  re-pathed — defeating `setTravel`'s keep-in-flight guard, so the rover
  re-pathed every tick and **froze on the reach ring without moving**.
  `doMine` already had the right order; match it in any new task handler.
- **`setTravel`'s keep-in-flight guard is only as good as the caller**: it
  keeps a path only while `goal` stays the same between ticks. Anything that
  flips goal/phase between travel issuances (task branches, status writes)
  makes every tick a fresh A* path — and with one-waypoint-per-tick
  advancement the rover spends its whole tick stepping onto the cell centre it
  already occupies. Symptom: `phase === 'moving'`, position frozen.
- Full-silo salvage parks at the depot (`routePaused`, like a stuck haul
  route) retrying `tryUnload` as consumption frees room; the out-and-back
  loop resumes on its own. Pinned by the "full hold hauls home" test in
  `tests/sim/pois.test.ts`.

## Refactor Phase 5 (WeatherSystem) — and the snapshot-aliasing trap

- `src/sim/systems/WeatherSystem.ts` owns the weather behavior that used to
  live in `Simulation.ts` (`tickWeather`, the lightning resolver, the restore
  wiring, the time-jump re-anchor). The `Weather` model in `sim/weather.ts` is
  **unchanged** — scheduler + lightning RNG streams stay inside it, now pinned
  by `tests/sim/weather-system.test.ts` instead of by convention.
- **`WeatherHostHooks` is the pattern for systems that trigger cross-domain
  effects**: `tripDamaged` / `disableRover` / `endMission` are implemented by
  Simulation against its existing private methods (no second source of
  truth). Phase 10 (RoverSystem) and Phase 15 (FailureSystem) replace the
  *implementor*, not the interface. Expect the same seam for the next
  extractions that can't be pure-state yet.
- **`Weather.snapshot()` returns live references** — its `active`/`scheduled`
  arrays *and* the storm-cell objects inside them. Consequences:
  - `JSON.stringify` (localStorage saves) and `postMessage` (worker) deep-clone
    and are safe.
  - **Direct in-process `simB.restore(simA.snapshot())` aliases the two
    weathers**: both ticks move the same cells (double speed), readings
    diverge, and a "restored colony replays the same weather" test fails in
    ways that look impossible (identical cells + identical simTime, different
    `windDirRad`). Diagnose by recomputing the reading from state by hand —
    the mismatch points at shared mutation, not at the math.
  - Tests must `structuredClone(save)` before restoring into a second sim.
    (`JSON.parse(JSON.stringify())` is *not* equivalent here: it turns
    `nextRollAt: Infinity` — suppressed rolls — into `null`, which
    `Weather.restore`'s `??` reads as "resume rolling".)
  - Fix belongs to a future phase that touches the model (make `snapshot()`
    return copies); Golden Rule 1 kept Phase 5 from changing it. Recorded in
    the roadmap's Phase 5 block.
- Extraction fidelity was proven with a **pre/post hash baseline**: a
  weather-heavy script (forced storms, dirtying panels, wind damage, rolled +
  exact bolts, mid-storm save/restore) hashed at six checkpoints with
  `StateHash` before the refactor and after — byte-identical. Cheap to redo;
  do it for every extraction phase.
- `SOL_SECONDS = 240` (the game sol is compressed) — storm "durMin 300–430"
  in `STORM_PROFILE` is game-*seconds* despite the name. A 1-sol `run()` is
  only 4800 ticks; weather suites are cheap.
- Gate on completion (2026-09-16): 50 suites / 497 checks green, build
  996.7 kB / sim.worker 221.7 kB unchanged, all four browser smokes green on
  both transports. Recorded in the roadmap's "Phase 5 — Recorded" block.

## Refactor Phase 6 (PowerSystem) — moved, not redesigned

- `src/sim/systems/PowerSystem.ts` owns the grid pipeline that was
  `Simulation.tickPower` (~110 lines, verbatim move): input (generation +
  demand) → `resolvePower` (pure, `sim/power.ts`, **untouched**) → output
  (state + per-building/per-rover apply). `PowerSystem.restore` owns the
  save clamp; `nearCharger`/`chargeRateKwAt` are statics the Simulation
  delegates to — one charger map, not two.
- **`PowerSystemContext` is the second instance of the host-hooks pattern**
  (`desiredThroughput` / `runProcess` / `processBlockReason`): production
  questions answered by Simulation's existing private methods. Phase 8
  (ProductionSystem) absorbs the implementor, not the contract. A useful
  property discovered while testing: `processBlockReason` is only consulted
  when satisfaction ≥ 0.99 — during a brownout "No power" wins and the
  domain is not asked why. That ordering is load-bearing for honest idle
  reasons; the seam test pins it.
- **`tickGarages` stays in Simulation on purpose** — it *consumes*
  `powerSat` (service/assembly rates) rather than resolving the grid; it
  belongs to a later owner. Noted at the call site and in the system header
  so the next extraction doesn't "helpfully" drag it in.
- **Allocation carve-out for the "no allocations in tick" rule**: the
  per-tick `PowerResult` on `state.power` is deliberate (the view projects
  it); demand array + desired-throughput map remain the only tick-local
  scratch. Recorded in the roadmap's Phase 6 block.
- Behavior preservation: same **pre/post hash baseline** recipe as Phase 5
  (eight checkpoints: setup/noon/night/brownout/severe-storm dust collapse/
  availability loss/save-restore) — byte-identical. The baseline script
  pattern: esbuild-bundle a `/tmp/*.ts` scenario against the repo, run
  before and after, `diff`.
- Direct-drive unit tests are the cheap way to test the system in
  isolation: `devSetTime` recomputes `clock.sun` immediately (no step
  needed), and `PowerSystem.tick(sim.state, stubCtx)` can be called without
  `sim.step` — set `state.dustTransmission` by hand (normally the weather
  tick mirrors it) and give rovers full batteries to keep them out of the
  demand list.
- Gate on completion (2026-09-16): 51 suites / 511 checks green
  (`tests/sim/power-system.test.ts` +13), build 997.2 kB (290 gz) /
  sim.worker 222.1 kB, all four browser smokes green on both transports.
  Recorded in the roadmap's "Phase 6 — Recorded" block.

## Refactor Phase 7 (LifeSupportSystem) — moved, not redesigned

- `src/sim/systems/LifeSupportSystem.ts` owns the survival pipeline that
  was `Simulation.tickLifeSupport` + `tickColonistMovement` +
  `orderColonist` + `shelters`/`nearestShelter` + the fluid/colonist
  restore block, moved verbatim. `sim/lifesupport.ts`
  (`applyColonistNeeds`, `makeColonist`) is **untouched** — the system is
  the named owner around the existing pure resolver.
- **`LifeSupportHostHooks` is the third instance of the host-hooks
  pattern** (`endMission` / `completeBuilding`): death is FailureSystem
  (Phase 15), assist-complete is ConstructionSystem (Phase 9). Simulation
  implements both against its existing private methods. The system does
  **not** write `gameOver` or flip a building `online` itself — the
  recorder tests pin that.
- **Power is an input the fluid draw ignores.** A brownout still
  consumes; the pod's scrubbers are a tier-0 *load* on the grid, not a
  gate on breathing. Pinned by the power-loss test. Do not "fix" this
  inside an extraction.
- **Colonist locomotion came along this pass** (`tickColonist`) because
  suit-critical abort, storm recall and assist-complete are survival
  overrides on the same order the player issued. Splitting motion back
  into Simulation would leave two writers of `colonist.order`.
- **EVA log minutes use the literal `24.66`**, not `SOL_HOURS` (24.6597).
  Golden Rule 1 kept that rounding.
- Alerts that *report* life-support state (low O₂, colonist health) stay
  in `evaluateAlerts` until Phase 16. The system only emits the one-off
  EVA / refusal / death log lines the old methods did.
- Behavior preservation: same **pre/post hash baseline** recipe as
  Phases 5–6 (nine checkpoints: sol 1, EVA out/back, no-O₂, production
  chain, storm EVA, live vs restored mid-EVA, suit-critical abort) —
  byte-identical. Live vs restored hashes still differ (restore resumes
  at rest) — that is the StateHash contract, not a regression.
- Gate on completion (2026-09-16): 52 suites / 526 checks green
  (`tests/sim/life-support-system.test.ts` +15), typecheck green, build
  `index.js` 997.8 kB (290 gz) / `sim.worker` 222.7 kB. Recorded in the
  roadmap's "Phase 7 — Recorded" block.

## Refactor Phase 8 (ProductionSystem) — moved, not redesigned

- `src/sim/systems/ProductionSystem.ts` owns the three answers PowerSystem
  asks about a process (`desiredThroughput` / `processBlockReason` /
  `runProcess`), moved verbatim from Simulation. `BuildingDef.process` in
  `sim/defs.ts` is **untouched** — processes were already declarative; this
  phase names the owner.
- **`PowerSystemContext` did not change.** Simulation only wires
  ProductionSystem into it. Power still speaks first on a brownout
  (`processBlockReason` is not consulted when satisfaction < 0.99) — that
  ordering stays load-bearing; the production suite pins the domain half.
- **`tickGarages` stays in Simulation** — service/assembly consume
  `powerSat` rather than converting mass. Do not drag it into
  ProductionSystem "to finish the phase".
- Ice's display name is `Water Ice` (`RESOURCES.ice.label`). Idle copy
  reads `Out of Water Ice`, not `Out of Ice`.
- Greenhouses crawl at 15% in the dark (`0.15 + 0.85 × light`) rather than
  stopping; `processBlockReason` still says `Waiting for daylight` below
  irradiance 0.02. Do not "fix" that inside an extraction.
- Direct-drive tests (`ProductionSystem.runProcess(state, b, rate, hours)`
  and `PowerSystem.tick(state, liveCtx)`) are the cheap way to assert
  plate-rate arithmetic. A full `sim.step` also runs life support, which
  drinks oxygen and will miss an exact O₂ delta.
- Behavior preservation: same **pre/post hash baseline** recipe as Phases
  5–7 (ten checkpoints: extract, chain, food, no-ice, tanks-full, brownout,
  upgrade, live vs restored, night-crop) — byte-identical.
- Gate on completion (2026-09-16): 53 suites / 538 checks green
  (`tests/sim/production-system.test.ts` +12), typecheck green, build
  `index.js` 997.8 kB (290 gz) / `sim.worker` 222.7 kB. Recorded in the
  roadmap's "Phase 8 — Recorded" block.

## Refactor Phase 1 (invariants) — the loud-state era

- `src/sim/debug/SimulationAssertions.ts` is the Phase 1 deliverable: pure
  `checkInvariants(sim) → InvariantViolation[]` + `assertInvariants` that
  throws `InvariantError`. **Codes are load-bearing** — tests pin them
  (`tests/sim/invariants.test.ts`). Add new checks with new stable codes,
  never renumber.
- The gate lives at the end of `Simulation.step()`, behind the process-wide
  `setInvariantChecks()` switch (default **off**). `tests/harness.ts` flips
  it on, so every suite asserts after every step; the game, worker and
  browser smokes never do. Full-suite cost was ~11 s.
- **Two documented exceptions** (module header + check comments): storage
  may exceed capacity (`demolish()` refunds in full on purpose — only
  *negative* storage is corruption), and rover battery may briefly exceed
  the pack (rescue jump-start pays its "give" uncapped; the check only
  trips above 3× capacity + 10 kWh). If jump-start ever caps at headroom,
  tighten `rover-battery` to `maxBatteryKWh`.
- **Test fixtures may not create impossible state** — that is what the gate
  is for. `sim/pois` used to park rovers at `battery = 999`; it now charges
  a full pack and tops up *between* steps (`runPowered` in pois.test.ts).
  The pattern for "energy is not this test's subject": mutate between
  `step()` calls, never leave an impossible value sitting at a check point.
- Deliberately NOT checked in Phase 1 (reachable legit states, verified by
  reading the code, not by guess): reservation ↔ task consistency
  (`releaseReservations` only looks at the active command, so queued mines
  can leave stale claims when stop/replaced) and one-rover-multiple-claims
  (shift-queued mine orders claim each seam). Both are real lifecycle quirks
  for a future phase to decide on — do not "fix" them inside an extraction
  without a behavior-change note.
- Gate on completion (2026-09-16): 44 suites / 413 checks green, build 989 kB
  unchanged, all four browser smokes green on both transports. Recorded in
  the roadmap's "Phase 1 — Recorded" block.

## Refactor Phase 0 (baseline) — and the jsdom canvas trap

- `ARCHITECTURAL-REFACTOR-ROADMAP.md` (repo root) is the governing plan since PR #38. Read
  §3 (Golden Rules), §48 (phase checklist) and §51 (execution order) before touching `sim/`.
  Phases run 0 → 30; **Phase 0 is recorded complete** in that file's "Recorded baseline"
  table (typecheck 6.0 s, build 7.0 s, `npm test` 43 suites / 393 checks in 107 s on 2 cores,
  all four browser smokes green, `index.js` 989 kB). **Phase 1 (invariants) is done** — see
  the section below. Remaining Milestone 1 (§58) items: deterministic state hash, perf
  instrumentation, save validation, command transcripts — *then* Persistence is the first
  extraction.
- **CI does not run `npm test`.** `.github/workflows/pages.yml` gates `npm run build` +
  `mobile-smoke` + `worker-smoke` (both transports) only. That is how main carried 12 red
  suites: `WorldMapOverlay`'s constructor threw on a null 2D context, and the jsdom fixture
  answered null for *every* canvas, so `HUD.buildChrome()` died and all `hud/*` went red
  while CI stayed green. If you fix a HUD bug and only CI is green, run `npm test` anyway.
- `tests/fixtures/hud.ts` now hands canvases a **recording stub 2D context** instead of
  `null`. Two consequences to remember:
  - every `ui/` paint path is now genuinely executed in the HUD suites (minimap, world map,
    power sparkline) — which is how it found `stopLoop`'s bare `cancelAnimationFrame`: legal
    in a browser, a `ReferenceError` wherever only `window` is defined. Pair rAF/cAF as
    `window.requestAnimationFrame` + `window.cancelAnimationFrame`, never bare globals.
  - `paints.byCanvas[id]` counts 2D calls **per canvas id** and is module-global, so it
    accumulates across suites in the linked serial run. Assert deltas against a reading you
    took a line earlier, never absolute counts.
- `setCanvasBackend('none')` is the knob for "the browser refused the context". `ui/` must
  degrade there — a canvas is presentation, and a lost canvas may not lose the colony's
  controls. `tests/hud/worldmap.test.ts` pins that contract; anything new that paints should
  hold it too (guard the paint, keep open/fit/close/pick working — they are pure geometry).
- The stub counts calls, it does not rasterise. A wrong `MapTransform` still passes every
  jsdom test, so *what the map looks like* is only checkable in the browser smokes.
- Cosmetic, not a bug: `HUD.ts`'s `#map-btn` markup carries `class="btn"` twice; the parser
  keeps the first, so the button renders correctly. Left alone — unrelated to this fix.
