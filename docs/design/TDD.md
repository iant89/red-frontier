# Red Frontier — Technical Design Document

Source: Ian Thomas's shared Dropbox (`Red_Frontier_TDD.pdf`, v1.0), realigned to the
live codebase on branch `arena/01a0bc5e-red-frontier` (package `0.3.0`, README
**Prototype 4** + first exploration slice + first engineering slice).

**Last realignment: 2026-09-20**, against `SAVE_VERSION = 8`, **76 suites / 866
checks** green in 3½ minutes, and refactor-roadmap **Phases 0–30 complete**. The
biggest corrections in that pass: audio is no longer OUT (§3, §17), the weather
model is spatial and carries lightning (§11), performance budgets are enforced by
a regression suite rather than merely stated (§20), and the module tree below is
the as-built one — app controllers, `sim/debug/`, the network adapter and all.

**Since then both shipped P5 slices landed** (§6, §7, §15, Appendix B): refining
(`SAVE_VERSION = 9`, a twelfth blueprint, the first `solidOut` process) and
manufacturing (`SAVE_VERSION = 10`, the Workshop's two selectable lines, the
counted component rack, rovers priced in parts). Those slices brought **79 suites /
913 checks**, and both canonical hash sets moved twice: the bulk ledger grew a key
and a conversion began conserving mass, then the rack, the selected line and the
bench joined the hashed building state.

**P5 slice 3 — rover maintenance** now adds the thirteenth blueprint, the Repair
Bay, installed motor/board wear, and timed replacements using Workshop spares.
Current schema: **v11**. New owner: `MaintenanceSystem`. The suite is **81 suites /
939 checks**; canonical hashes now include installed health and maintenance jobs.

This document is both the **architecture target** and the **as-built notes**.
Where the build deliberately diverged from the original PDF, the divergence is
named and justified so a future change is a decision, not an accident.

Status tags match the GDD: **IN** / **PARTIAL** / **OUT**.

---

## 0 — Implementation status (living)

**Engineering update (2026-09-20):** right-click/long-press Engineering screen,
paused rotating model, icon costs, three-tier rover and role-specific building
upgrades, timed Garage/on-site installations, three new Workshop components and
saved free palette finishes are **IN**. Authoritative player refits use `upgrades`
and `upgradeJob`, never the developer-only `level`. Save v13 defaults old colonies
to stock hardware. See README’s Engineering section and the corresponding
architectural roadmap record for costs, lifecycle, limits and ownership.


**P5 slice 4 update (2026-09-20):** commissioned water networks, pipe manufacture,
pump/tank blueprints and local fluid access are IN. Current save v12; **84 suites /
959 checks** green. See §6 and the water acceptance section for limits and gates.

| TDD tier (§25) | Theme | Status |
|---|---|---|
| **T1** | Worker + fixed tick + camera + terrain | **IN** (worker default; frame-pumped, not a worker-side timer) |
| **T2** | Entities + resources + buildings + construction | **IN** (class/entity model over `ColonyState`, not a formal ECS folder; the bulk ledger now carries two origins — mined and refined) |
| **T3** | Power / water / oxygen + day/night | **IN** (power network; fluids as tank pools) |
| **T4** | Rovers + navigation + tasks | **IN** (now with hull-clearance proximity crawling) |
| **T5** | Weather + dust + damage | **IN** (spatial field, lightning, radar; storm cells travel) |
| **T6** | Procedural world + POIs + supply drops | **PARTIAL** |
| **T7** | Research + agriculture depth + colonists | **OUT** |
| **T8** | Optimization + save migrations + release UI | **PARTIAL** (migrations v3→v13 IN; fleet benchmarks + perf-regression + stress suites IN; sim LOD and on-device frame gates OUT) |

**Stack as built**

| Concern | Original recommendation | As built |
|---|---|---|
| Language | TypeScript client + sim | **TypeScript** throughout |
| Renderer | WebGPU primary, WebGL2 fallback | **three.js WebGL2** (WebGPU OUT) |
| Sim isolation | Dedicated Worker | **Module Worker default** + `LocalSimHost` fallback (`?worker=0`) |
| Remote transport | future network play | **Adapter IN, no server** — `host/NetworkPort.ts` encodes the same `HostRequest`/`HostReply` over any string duplex (Phase 30); nothing ships it |
| Saves | IndexedDB | **localStorage** named slots (`SaveStore`), schema v12 |
| Backend | future Java authority | **OUT** (static Vite app) |
| Audio | Web Audio | **IN** — procedural Web Audio, synthesised in-browser, zero fetched assets (`src/audio/`) |
| Content data | data-driven blueprints | **IN** (`defs.ts` / `config.ts`) |
| Art assets | — | **Pipeline IN, art OUT** — `render/ModelRegistry` + `assetCatalog` resolve GLBs from `public/models/`, procedural meshes are the fallback |

**Hard gates that exist today**

- `npm test` — **79 suites / 913 checks** (unit, integration, determinism, load, HUD, render, audio, app) in isolated parallel workers, ~3½ min; `npm run test:serial` is the linked one-process run
- `npm run typecheck` + `npm run build` — `tsc` runs as part of the build, so CI type-checks on every PR
- `scripts/worker-smoke.mjs` — both transports on every PR (`.github/workflows/pages.yml`)
- `scripts/mobile-smoke.mjs` — headless Chromium play path, on every PR
- `scripts/update-check-smoke.mjs` — in-play save-and-reload update flow (run locally)
- `scripts/pause-smoke.mjs` — pause-menu save hand-off ordering (run locally)
- `npm run test:bench` / `npm run test:stress` / `npm run test:replay` — fleet scaling benchmark, 100-rover/250-building stress, canonical transcript replay (local + before release)
- `scripts/screenshots.mjs` — the `screenshots` workflow refreshes `screenshots/` on a build
- Determinism: same seed + elapsed time → same state hash (frame-pacing invariant tested), and the same transcript replayed lands on the same hash
- **Not a gate:** `npm test` does not run in CI — the Pages workflow builds and smokes only. The suite is the local/PR-review contract.

---

## 1. Purpose & Technical Goals

Translates GDD into an implementable architecture: simulation ownership, data
structures, update order, utility networks, AI/task scheduling, procedural
terrain, weather, persistence, rendering, input, testing, profiling, deployment.

Goals (unchanged, with current grade):

| Goal | Grade |
|---|---|
| Deterministic & testable simulation | **IN** (seeded streams incl. a separate lightning stream; transcripts + state hash) |
| Smooth desktop/mobile | **PARTIAL** (playable; sim-side budgets are enforced headless, no on-device frame gate) |
| Scalable entity counts | **PARTIAL** (measured to 250 rovers and stressed at 100 rovers + 250 buildings; no sim LOD, world is one window) |
| Save/load without renderer state | **IN** (schema v8, validator, v3→v8 migrations) |
| Graceful degradation | **IN** (soft rover failure, storm and lightning recovery, procedural-mesh fallback for missing GLBs) |
| Clear sim / render / UI / persistence separation | **IN** (via `SimHost`; refactor Phases 0–30 complete) |

## 2. Architecture Overview

| Layer | Responsibility | Runtime | Status |
|---|---|---|---|
| UI | HUD, minimap/world map, menus, build palette, alerts | Main thread DOM/CSS + 2D canvas (`src/ui`) | **IN** |
| Input | desktop/mobile gesture normalization | Main thread (`src/app/gestures.ts` + `InputController`) | **IN** (no separate `input/` package) |
| Renderer | camera, terrain, entities, effects, overlays | three.js WebGL2 (`src/render`) | **IN** |
| Simulation | world state, economy, AI, weather, utilities | Worker **or** main (`src/sim`) | **IN** |
| World | terrain, deposits, POIs | Inside sim; terrain re-derived from seed on mirror | **PARTIAL** (no chunk streamer) |
| Persistence | versioned snapshots | `src/sim/persistence/` codec + localStorage slots (`src/ui/SaveStore.ts`) | **IN** |
| Audio | ambience, machinery, cues | Web Audio, procedural (`src/audio/AudioSystem.ts`) | **IN** (no assets, no music, no user volume control) |
| Dev tools | runtime edits | `src/dev` → `dev/*` commands on the host | **IN** |
| Debug harness | invariants, hash, profiler, transcripts, benchmarks | `src/sim/debug/` (dev-only, tree-shaken out of the bundle) | **IN** (no in-game perf HUD) |

**Authoritative boundary (the seam that actually shipped):**

- Nothing outside the host mutates the colony. `app/`, `ui/`, `render/`, `dev/`
  hold a `SimHost`, read a `SimView`, and write only `SimCommand`s (TDD §16).
- `LocalSimHost` — in-process; view *is* the live sim (narrowed).
- `WorkerSimHost` — module worker owns `Simulation`; main thread renders a
  `ColonyMirror` fed by view payloads + terrain derived from the reported seed.
- `createHost.ts`: **worker is the default** (`WORKER_DEFAULT = true`);
  `?worker=0` forces in-process; unsupported environments fall back with a reason.
- A command batch **publishes a fresh view** even when paused (worker used to
  publish only on `advance` — fixed; pinned by `sim/worker` + mobile smoke).
- The client pumps `advance{dt}` per delivered frame. There is **no** `setInterval`
  on the worker: a timer in a hidden tab would throttle and the colony would race
  ahead unseen.

Renderer never owns authoritative state. UI sends commands, receives state/events.

## 3. Project / Module Layout

**As-built tree** (supersedes the original PDF folder list where they differ):

```
src/
  main.ts            entry, boot splash, host factory
  app/               composition root: Game wires the controllers, never implements them
    Game.ts              the colony's owner: boot, launch, save/load hand-off, settings
    GameLoop.ts          rAF timing, host.step(), render scheduling (Phase 19)
    InputController.ts   keyboard / pointer / touch → gestures and commands
    SelectionController.ts selecting rover/building/colonist/POI + its visualization
    BuildController.ts   build mode, ghost positioning, placement request (never the verdict)
    SaveController.ts    save/load UI hand-off, autosave, onDone-ordered teardown
    MenuController.ts    pause menu, settings contract, expedition stats
    UpdateController.ts  in-play update card wiring
    UpdateCheck.ts       the version.json poller
    CameraRig.ts         orbit / pan / zoom rig
    gestures.ts          desktop + touch gesture normalization (unit-tested, no DOM)
  audio/             procedural Web Audio soundscape — presentation only (see §17)
    AudioSystem.ts       scenes, mix, cues; never writes sim state
  sim/               framework-agnostic simulation (no DOM, no three.js)
    config.ts        balance constants + the two time bases
    defs.ts          data-driven blueprints (resources, fluids, rovers, buildings)
    difficulty.ts    Settler/Pioneer/Survivor + world sizes + world options
    clock.ts         Mars sol clock + authoritative sun
    power.ts         pure power-grid resolver
    lifesupport.ts   fluid pools, colonist needs, health
    alerts.ts        condition bus + event log
    domainEvents.ts  per-tick structured events (Phase 21) — not a pub/sub bus
    weather.ts       wind, dust, storm scheduler + envelopes, spatial sampling, lightning RNG
    pois.ts          site/drop content tables + salvage maths
    terrain.ts       local height / material from seed + landing (MOLA-relief prior)
    marsGlobe.ts     compact geographic Mars: biomes, elevation, landable regions
    marsDem.ts       the compact MOLA-derived elevation table marsGlobe samples
    navgrid.ts       walk/build grid, reachability flood, zero-alloc A* (Phase 23)
    rules.ts         siting + maintenance verdicts (shared by ghost + sim)
    World.ts         seeded terrain handle + deposits + scattered sites
    Simulation.ts    thin orchestrator (Phase 18): state, hooks, tick order, lifecycle API
    DevBackdoors.ts  the dev-only edit surface, kept out of player commands (Phase 22)
    state/           ColonyState + entity/record shapes (data, no behavior)
      ColonyState.ts     the one authoritative state object
      RoverState.ts BuildingState.ts WeatherState.ts PowerState.ts
      ResourceState.ts HistoryState.ts EntityStore.ts
    systems/         extracted tick responsibilities, each a static API over state
      ClockSystem.ts       sol clock + authoritative sun
      WeatherSystem.ts     weather progression + its effects on the colony (dust, wind,
                           lightning) + the powered-radar capability
      PowerSystem.ts       grid tiers, satisfaction, brownout shedding
      ProductionSystem.ts  process want / idle reason / mass moved / units racked,
                           and which line a building is running (`setRecipe`)
      LifeSupportSystem.ts fluid draw, colonist needs, EVA orders
      ConstructionSystem.ts siting, site materials, crews, progress, completion
      RoverSystem.ts       fleet commands, task lifecycle, movement (incl. the proximity
                           crawl), task bodies
      FleetAutomationSystem.ts  the job model + autonomous dispatch (maintenance,
                           rescue, supply runs); see its header for the
                           evaluate → filter → order → reserve → assign pipeline
      LogisticsSystem.ts   the storage ledger, cargo transfers, site material,
                           deposit reservations — the one owner of *bulk* (kg)
                           accounting (Phase 13)
      ComponentSystem.ts   the manufactured-unit ledger (P5 slice 2): rack space,
                           whole-unit store/take, affordability and the shortfall
                           sentence — counted, not weighed, so deliberately not
                           folded into LogisticsSystem
      MaintenanceSystem.ts  installed rover part wear + Repair Bay replacement jobs
      ExplorationSystem.ts discovery, supply drops, burial, site-side salvage
                           rewards — what the player has found (Phase 14);
                           World still owns scatter
      GarageSystem.ts      fast charge, drivetrain service, the assembly line
      FailureSystem.ts     failure outcomes + checks (tripDamaged, endMission,
                           brownout / O₂ / stranded / damaged / …) as domain
                           events only — AlertSystem owns notification
      AlertSystem.ts       failure domain events → state.alerts mapping
                           (keys, severity, dedupe, expiration, history);
                           HUD ack stays presentation-side (Phase 16)
      HistorySystem.ts     vitals time-series sampling + the flow-window roll (Phase 17)
    persistence/     versioned saves: schema (v12), codec, validator, migration steps v1…v11
    debug/           dev-only diagnostics; imported by tests, tree-shaken from the bundle
      SimulationAssertions.ts  invariant checks (Phase 1)
      StateHash.ts             deterministic state hash (Phase 27)
      Transcript.ts            canonical command transcripts + replay (Phase 26)
      Profiler.ts              tick/pathfind/command/message counters + timings
      Benchmark.ts             fleet scaling benchmark (Phase 28)
      LargeColonyScenario.ts   100 rovers + 250 buildings under stress (Phase 29)
    host/            the seam
      protocol.ts      every legal write, as plain serializable data
      view.ts          SimView — immutable read model (Phase 20)
      viewModels.ts    the view's nested shapes (weather, power, …)
      applyCommand.ts  dispatch table (sim-side, worker-reusable)
      overlays.ts      runtime edits as data (name + ids), never closures
      projection.ts    view payload a host answers with
      LocalSimHost.ts  in-process host
      mirror.ts        SimView from payloads + terrain from seed
      workerRuntime.ts sim side of the wire
      WorkerSimHost.ts posts ticks, mirrors state, optimistic acks
      NetworkPort.ts   the same requests/replies over a string duplex (Phase 30)
      createHost.ts    one factory, either transport
      messages.ts      wire message types
      SimHost.ts       interface
      index.ts         the public surface app/ui/render/dev import
    sim.worker.ts    worker entry
  dev/               DevMode (runtime state) + DevPanel (DOM)
  render/            three.js renderer, weather FX, particles/
    Renderer.ts          scene, terrain, entities, overlays, selection ring, lightning flash
    marsTerrain.ts       PBR atlas split + macro albedo + the no-asset fallback material
    WeatherFX.ts         the FX director; derives viewRadius + windRamp for the emitters
    particles/           ParticlePool (9 000), ParticlePoints, effects (wind, storm,
                         DustDevil + DevilManager, rover trails)
    DescentStage.ts      the landing pod's body (presentation only)
    WeatherStation.ts    the radar station's body (presentation only)
    ModelRegistry.ts     GLB registry: resolveUrl / register / load / getClone / preload
    GlbLoader.ts         GLTFLoader wrapper, injectable for tests
    assetCatalog.ts      logical asset id → URL
  ui/                HUD, menus, wizard, maps, save store
    HUD.ts               vitals, alerts, inspectors, build bar, log, minimap panel
    WorldMap.ts          minimap + world-map overlay renderer (2D canvas, reads SimView)
    MainMenu.ts LoadingScreen.ts LoadGameScreen.ts NewGameWizard.ts PauseMenu.ts
    GlobePicker.ts       the spinnable landing-site globe
    landingRegions.ts    region metadata + biome colours
    Settings.ts          persisted player settings
    SaveStore.ts         named localStorage slots
    BuildStatus.ts       build identity + the GitHub "is main ahead?" badge
    Changelog.ts         the hand-curated build timeline the badge opens
  lib/               deterministic RNG + simplex noise
  style.css          play HUD + menu theme
tests/               79 suites (+ full.test.ts, the linked serial entry): sim/*, hud/*,
                     render/*, ui/*, app/*, audio/*
scripts/             test runner, Playwright smokes (worker, mobile, update-check, pause),
                     benchmark, stress, transcript replay, behavior baseline, screenshots
docs/design/         this GDD + TDD + ROVER-STATE.md (rover state model)
public/              textures/pbr/*.jpg (terrain atlas), ui/*.jpg (menu art),
                     models/_fixtures/placeholder.glb (the only shipped model)
```

**Original PDF folders not present (and why):**

| PDF path | Status | Notes |
|---|---|---|
| `sim/ecs/` | **not used** | Entities are typed objects on `Simulation` (rovers, buildings, colonist, POIs). Data-oriented enough for the current scale; a formal ECS is not required until entity counts demand it. |
| `sim/utilities/` | **OUT** | Only power is a network; fluids are tank pools on buildings. |
| `sim/ai/` | **`sim/systems/`** | Rover commands, task lifecycle and reservations moved to `RoverSystem` (Phase 10); its execution state (`goal`/`phase`) is runtime-only, machine-checked and documented in `docs/design/ROVER-STATE.md` (Phase 11); the *scheduler* — maintenance, rescue, supply-run auto-dispatch, behind an explicit job model (evaluators → filter → order → reserve → assign) — moved to `FleetAutomationSystem` (Phase 12); resource accounting — the storage ledger, cargo, depot transfers, site delivery and deposit reservations — moved to `LogisticsSystem` (Phase 13), with `Simulation`'s public storage surface kept as a delegate, while site crew choice stays in `ConstructionSystem`. Per-rover charging and storm recall remain in `RoverSystem`'s tick by design — the fleet-side of both lives in `FleetAutomationSystem` (dispatch pools and the storm filter). Exploration — POI discovery, supply-drop schedule/burial, and site-side salvage rewards — moved to `ExplorationSystem` (Phase 14); `World` still owns scatter, and the salvage *task* body stays in `RoverSystem`. Failures — equipment / rover / building / environmental / resource failure checks, `tripDamaged`, `endMission`, and the domain-event surface — moved to `FailureSystem` (Phase 15); failure→alert notification mapping moved to `AlertSystem` (Phase 16), with remaining direct `state.alerts` writers in other domain systems unchanged that phase; vitals history sampling (`recordHistory` / flow-window roll) moved to `HistorySystem` (Phase 17), with discrete event narratives still on AlertBus and replay/analytics deferred; Phase 18 slimmed `Simulation.ts` into a thin orchestrator (GarageSystem, ColonyPersistence, DevBackdoors, HistorySystem rate arithmetic) without changing tick order. |
| `sim/research/` | **OUT** | |
| `sim/save/` | **extracted to** `sim/persistence/` | Schema (v8), codec, validator and the migration steps v1…v7; `Simulation.snapshot/restore` are thin delegates over `ColonyPersistence`. |
| `input/` | **folded into** `app/` | `gestures.ts` (pure, unit-tested) + `InputController` (Phase 19). Still no package of its own. |
| `audio/` | **present** | `src/audio/AudioSystem.ts` — procedural Web Audio, presentation-only (§17). No asset files, no music, no user volume control yet. |
| `sim/world/` | **flat files** | `World.ts`, `terrain.ts`, `marsGlobe.ts`, `marsDem.ts`, `navgrid.ts` sit directly under `sim/`; the roadmap's `world/` folder was never worth the churn. |
| `sim/model/` | **`sim/state/`** | Entity shapes live in `state/` (data + the pure helpers that belong to them, e.g. `roverStatusText`, `lightningVulnerability`), not a `model/` folder. |
| `sim/debug/` extras | **beyond the roadmap** | The roadmap asked for `SimulationAssertions` + `StateHash`; the tree also carries `Profiler`, `Transcript`, `Benchmark` and `LargeColonyScenario` (§20–§21). |
| `shared/` | **OUT as a package** | Protocol types live under `sim/host/`; defs are imported directly. |

**Refactor status: the 30-phase roadmap is complete.** `ARCHITECTURAL-REFACTOR-ROADMAP.md`
records Phases 0–30 as done (baseline diagnostics → invariants → `ColonyState` →
persistence → the eleven systems → `Simulation` as a thin orchestrator → `Game`
as a composition root → immutable `SimView` → domain events → command architecture
→ navigation → worker/view performance → property, replay, hashing, regression and
stress testing → the optional network boundary). Each phase's record names the
tests that gate it; `mnemosyne.md` carries the working notes. **Prefer the target
architecture when adding code** — new tick behavior is a system, new state is a
`ColonyState` field, new player intent is a protocol command.

Prefer pure functions for formulas/state transitions; side effects at system
boundaries; stable numeric IDs in serialized state — **IN**.

## 4. Simulation Clock & Determinism

- Fixed step **50 ms = 20 Hz** (`SIM_TICK`). — **IN**
- Speed modes: Paused / 1× / 2× / 4× multiply sim steps per frame. — **IN**
- Render interpolation between snapshots — **OUT** (render reads the latest view)
- Two time bases (important, as-built):
  - **Material flows** (mining kg/s, build seconds) authored in *game seconds*.
  - **Energy & life support** (kW, kWh, kg/sol) authored in *Mars time*, bridged by
    `HOURS_PER_SEC` / `SOLS_PER_SEC`. A sol is **240 game seconds** at 1×
    (≈4 real minutes), while `SOL_HOURS = 24.6597` keeps the engineering numbers honest.
- Tick order (as-built, mirrors the PDF intent):

  1. clock / day-night  
  2. weather  
  3. power network  
  4. production (building processes)  
  5. life support & colonist  
  6–8. jobs / tasks / movement / construction / site logistics  
  9. failure checks → alerts → history  

- Determinism kit — **IN**: fixed seed, integer tick counter, stable iteration,
  weather on its own seeded stream (and **lightning on a third stream**, so a
  strike never perturbs a weather roll), pure storm envelope, tick accumulator that
  telescopes (60 s in 3600 ragged frames ≡ 60 s in one call — tested).
- Determinism *tooling* — **IN**: `debug/StateHash.ts` compresses live state to
  `rf1-<14hex>-<14hex>` over canonical JSON (sorted keys, entity arrays sorted by
  id), and `debug/Transcript.ts` records a colony as seed + difficulty + world
  options + a timed command list that `npm run test:replay` re-runs against pinned
  hashes. Note the hash covers *live* state, not `snapshot()`, on purpose — so a
  live sim and its just-restored twin do **not** hash equal (restore resumes
  entities at rest); compare restored-vs-restored, or after both advance.
- No wall-clock dependence inside the sim — **IN**. Presentation-side randomness
  (particles, devils) is injectable and separate, and FX animate on sim time.

## 5. ECS & Core Data Model

**As-built:** not a classic ECS. `Simulation` owns arrays/records of:

- `Rover` — kind, pose, battery, cargo, task queue, automation rules, condition, lights…
- `Building` — kind, pose, progress, health, cleanliness, enabled, power ports, process…
- `Colonist` — pose, health, suit O₂, order, dead flag
- `Poi` — kind, pose, found/stripped/burial, cargo residual, manifest
- Plus pod stockpiles, fluid tanks, power state, weather, clock, alerts, history

Components from the PDF mapped onto fields rather than component stores:

| PDF component | As-built |
|---|---|
| Transform | `x,z,rot` on entities (y from terrain) |
| Health | building `health` / colonist `health` |
| Inventory | rover cargo + per-resource base stockpiles |
| PowerConsumer / Producer | derived each tick from `BUILDINGS` defs + state |
| Storage | per-resource capacities (deliberately **not** one shared pool) |
| TaskController | rover `command` + `queue` |
| Maintenance | building health/dirt; rover `condition` |
| NetworkNode | power only (implicit via global resolver) |
| ResearchNode | **OUT** |
| Colonist | `lifesupport.Colonist` |

Blueprints are data-driven in `defs.ts` — **IN**.

## 6. Resource Accounting & Utility Networks

Resource rule (nothing from nowhere except configured producers) — **IN**, and since
P5 it is enforced through a conversion: a process may only produce what its inputs
actually handed over in that tick (`runProcess` scales outputs by the fraction of
each input it obtained), so two lines on one silo split the mass instead of both
running flat out. The same rule covers manufactured units, with one difference in
kind: `componentOut` accumulates a *fraction* on the building's bench
(`Building.craft`) and only hands whole units to the rack, because a component is
counted rather than weighed.

| Network | Status | Notes |
|---|---|---|
| **Power** | **IN** | `power.ts` pure resolver: generation → batteries → consumers by priority tiers 0–3; within a tier, uniform degradation (brownout reads as "Industry at 62%"). |
| **Water** | **IN** (first network slice) | Explicit commissioning transitions shared bootstrap plumbing to local tanks and a paid pipe graph. Powered pumps balance fill ratios within connected components; pressure/leaks/oxygen networks OUT. |
| **Atmosphere** | **PARTIAL** | `pressurized` flag + O₂ fluid; no volume/breach model. |
| **Heat** | **OUT** | |
| **Logistics** | **PARTIAL** | Haulers + deposit reservations + site material delivery without a parked rover (Materials Reserved). No general supply/demand graph. One ledger for *all* bulk solids — mined and refined alike. |
| **Refining** | **IN** (one link) | `ProcessDef.solidOut` (P5 slice 1): the Refinery takes `iron` from the ledger and stores `steel` into it, gated by ore supply, silo headroom and tier-2 power. Refined resources are `ResourceId`s with `origin: 'refined'` — no seam, no scatter, no mining, no dev-surveyed deposit. |
| **Maintenance** | **IN** (rover parts) | `MaintenanceSystem.tickBays` follows the powered garage tick; `tickWear` follows rover movement/colonist work. Existing tick order is otherwise unchanged. Installed health and unpaid bay jobs are saved/hashed; ComponentSystem owns the one-unit debit. |
| **Manufacturing** | **IN** (one link, three lines) | `ProcessDef.componentOut` (P5 slice 2): the Workshop racks `motor` / `circuitBoard` / `pipe` units on an integer ledger with rack-slot capacity, gated by input stock, rack room and tier-2 power. Which line runs is `Building.recipe` resolved by `defs.activeProcess` — one reader for sim, renderer and HUD. Pipes are spent by water links; valves and the wider utility parts catalogue remain **OUT**. |

Priority tiers in use: 0 life support → 1 oxygen & water → 2 industry → 3 logistics (rover charge).

### Water network implementation — P5 slice 4

- **State:** `state/WaterState.ts` owns `active`, canonical paid `{a,b,pipes}` links
  and per-port tanks. Pod ID is 0. `pools.amounts.water` is a derived aggregate
  after commissioning, never an alternative source of fluid. Flow readings are
  transient (not saved/hashed). `reconcileWater` clamps local damage/capacity loss
  and removes demolished links on capacity changes, before another tick can run.
- **Topology/transport:** `utilities/WaterNetwork.ts` provides sorted components
  and adjacency; `WaterSystem` owns validated connect/disconnect/commission
  commands, local access and proportional-deficit redistribution. Each powered
  pump grants 6 kg/h × satisfaction across its component. Transfers conserve mass;
  deterministic BFS paths accumulate signed per-edge kg/h. No pressure or per-edge
  throughput model. Disabled/damaged pumps contribute nothing; damaged ports do
  not conduct. Disabled consumers can still serve as passive junctions/storage.
- **Tick:** WaterSystem runs after PowerSystem (which resolves power and runs
  processes) and before LifeSupportSystem. Production reads/writes local buffers
  for water only; water delivered this tick feeds production on the next tick.
  Life support's narrow water adapter uses shelter-local drinking/reclamation,
  or the pod for EVA provisions. Oxygen and food retain their shared pools.
- **Boundary:** `water/connect`, `water/disconnect`, `water/commission` are intent
  commands with validated nonnegative IDs and refusal acknowledgements. Owned
  `waterNetwork` views carry nodes, links, flow and commissioning refusal text.
  WaterPanel keeps controls stable; WaterNetworkOverlay caches terrain-following
  geometry and reads actual flow, without sim writes.
- **Persistence:** v11→v12 starts old colonies uncommissioned. WaterPersistence
  sanitizes links, duplicate/reversed endpoints, lengths/costs and tank contents;
  snapshots own nested arrays/bags. Hashing includes topology/tanks/activation,
  excludes display flow. Invariants validate references, capacities and totals.
  Installed rover health uses `RoverPartId`, not the wider component catalogue.
- **Intentional limits:** instant straight-line paid pipe installation, no
  trench obstacles, no pressure/leaks/valves, no oxygen graph. Aggregate reserve
  histories/alerts are colony totals, not guarantees of supply at each port;
  local failures are exposed in the water inspector and overlay. EVA provisioning
  remains pod-debited rather than a portable water inventory. Track these against
  roadmap Phases 7/9/15/27, not as hidden Simulation/Game responsibilities.

## 7. Buildings & Construction

Staged flow as-built (simplified vs PDF names, same idea):

1. **Place** (siting via `evaluateSite` / `canPlace`) → entity with `progress = 0`
2. **Materials Reserved / delivered** — `tickSiteLogistics` pulls from stockpiles without a rover parked (`needsMaterials`)
3. **Assembly** — builder rover (or colonist) advances `progress` while powered/allowed
4. **Online** — `progress >= 1`, process/power ports active

Damage → degraded/offline via `health` + `damaged` flag; dirt on exposed panels via `cleanliness`. Cancel refunds delivered materials. — **IN**

PDF stage names (Planned → … → Commissioning) are not separate enums; behaviour is covered by the flags above.

Placement validation: slope, overlap/clearance, reachability, deposit exclusion — **IN**.
Special constraints (underground, greenhouse orientation) — **OUT**.

**Buildable set today (13):** habitat, solar, battery, rtg, weatherStation,
warehouse, extractor, oxygenator, greenhouse, workshop, garage, refinery, repairBay (by
`BUILDING_ORDER`; hotkeys 1–9 cover the first nine, the rest are palette-only).
Missing vs GDD: laboratory, nuclear reactor.

Construction costs are `ResourceAmounts`, so they may name refined material: the
Rover Garage costs 30 kg `steel` and the Weather Radar Station 25 kg, both smelted
by the Refinery — which is itself priced in raw ore only, so the chain is always
openable. The survival chain (habitat, solar, battery, extractor, oxygenator,
greenhouse) costs no steel by design.

## 8. Rover Architecture

| Rover | Status | Core systems in build |
|---|---|---|
| Scout | **OUT** | — |
| Utility | **IN** | build / repair / clean / general |
| Mining | **IN** | dig + hopper |
| Cargo | **IN** | large hopper (garage-assembled) |

Task states effectively: Idle → Navigate → Work/Load/Unload → Charge/Repair/Recover/Disabled. — **IN**
Movement speed is derived per tick (`cruiseSpeed × proximitySpeedMul`) — a hull-clearance
crawl near obstacles, never stored, never a `goal`/`phase` change (see §9 and
`ROVER-STATE.md` §3). — **IN**
Reservations prevent two auto-haulers collapsing onto one poor seam; rich seams share. — **IN**
Priority: player orders > critical survival / storm shelter / rescue > charge floor > production logistics > exploration. — **IN**
Position lights (auto at night/low visibility, battery draw, stranded reserve strobe) — **IN**.

## 9. Pathfinding & Navigation

- `NavGrid`: fixed cell size (8 m), cliff/slope masks, reachability flood from the pad, sized to the colony's own `world.half`. — **IN**
- Search cost (Phase 23): a reusable workspace with generation stamping and an indexed binary min-heap — no per-search typed-array allocation, O(log N) open-set operations instead of O(N) scans. — **IN**
- Movement integrates toward waypoints with turn rate; blocked destinations refused. — **IN**
- **Proximity crawl (issue #11) — IN:** `moveRover` multiplies cruise speed by `proximitySpeedMul`, a pure function of hull clearance to nearby rovers/buildings/pod/discovered sites (1.5 m → 28 %, 3.0 m inside the colony yard → 15 %, never 0). It does **not** re-path, raise an alert, or stop the rover, and the current goal's destination is exempt inside arrival reach so a builder can still finish its job. Move power scales with the multiplier; drivetrain wear does not (the wheels are still turning).
- Hierarchical chunk A* / Jump Point Search / long-distance chunk routing — **OUT**
- Dynamic building obstacle updates — **PARTIAL** (placement uses clearance; the crawl reads buildings each tick, but the nav grid itself is terrain-static)
- Collision response / pushing — **OUT** (a crawl is the whole model; two rovers never exchange momentum)
- Deterministic tie-breaking / bounded acceleration — **PARTIAL** (deterministic integration; simple controller, immediate speed changes)

## 10. World Generation & Streaming

- Playable region: axis-aligned square `[-worldHalf, worldHalf]²`, 1 unit = 1 m.
  Four sizes from the mission wizard — 420 / 640 / 960 / 1 280 m half-extent
  (840 m, 1.28 km, 1.92 km, 2.56 km claims); `WORLD_HALF = 640` is the default and
  the constant the balance numbers were tuned against. — **IN**
- **Everything that reads the world reads `world.half`, not the constant.** The
  terrain mesh used to be built at `WORLD_HALF * 2` regardless, which left the
  largest map driving off the edge of the geometry into void (issue #17). Mesh size
  now follows the colony and segment count scales with it
  (`TERRAIN_SEGS × world.half / WORLD_HALF`); nav grid and camera bounds already did. — **IN**
- Landing: `marsGlobe.ts` picks a geographic site — either from a seed or inside one
  of 18 named landable regions the globe picker offers; `marsDem.ts` carries the
  compact MOLA-derived elevation table it samples. Local `terrain.ts` then builds
  the window: a compressed MOLA relief prior (a seeded 3–7 km stretch of the real
  areoid steers regional tilt), seeded broad landforms where the coarse DEM cannot
  resolve local relief, then HiRISE-scale local geology (mixed-age craters, grit,
  rim rocks) and material. — **IN**
- The picker's globe texture is **generated**, not shipped: the same elevation model
  painted once into an equirectangular canvas. — **IN**
- Deposits + POIs scattered with exclusion radius around the pad; the near-ring
  fraction is a world option (8 / 20 / 34 %). — **IN**
- Chunks 128 m, streaming, persist-only-mutated-chunks — **OUT**. Terrain is a
  pure function of seed on both sides of the worker mirror (heights never cross
  the wire). Player-mutated state (buildings, POI found/stripped/burial, stockpiles)
  is what snapshots carry.

## 11. Weather Simulation

- **Storms are places.** Each storm is a `StormCell`: a circular system with a
  kilometre-scale footprint (devil 4–9 km radius, regional 90–210, severe 150–300,
  planetary 850–1 400) that moves
  along a heading at `speedKmS`, on a ramp-hold-decay envelope that is a pure
  function of elapsed storm time. The colony reads whatever footprint covers it. — **IN**
- Scheduler: rolls every `WEATHER_ROLL_INTERVAL_S = 84` game seconds after
  `WEATHER_CALM_SOLS = 2.2` calm sols, with a 96 s post-storm cooldown; per-class
  chances and unlock sols in `config.ts` (devil 10 % from sol 3, regional 4.5 %
  from 4, severe 1.2 % from 7, planetary 0.6 % from 12 and growing). — **IN**
- State: wind, dust density, solar transmission, visibility, storm kind/intensity. — **IN**
- **Spatial sampling — IN.** `localIntensity(x, z)` / `localDust(x, z)` combine the
  cell's footprint falloff at that position with a fine seeded noise term, and every
  decision has an `…At(x, z)` twin: `shelterRoversAt` (≥0.55, not a devil),
  `blocksEVAAt` (≥0.4), `workMultiplierAt` (0.6× above 0.4), `damageRateAt`. The
  colony-wide getters remain for the HUD and the solar model. Consequence: weather
  effects are per entity, so a rover across the yard can be working while the pad
  shelters. `WeatherSystem` writes dust onto panels and applies wind damage from
  each entity's own reading.
- Solar output = sun elevation × dust transmission × panel cleanliness (and health). — **IN**
- Wind damage from exposure × intensity; dust accumulates, cleaning restores. — **IN**
- **Lightning — IN** (`LIGHTNING_*` in `config.ts`). Hazard in strikes per game
  second = `LIGHTNING_BASE_RATE (0.06) × dust^1.6 × stormFactor × lightningMul`,
  hard-gated on dust ≥ 0.15 **and** local intensity ≥ 0.15, so calm clear air never
  strikes. Storm factors: devil 0.5, regional 1, severe 1.7, planetary 2.3.
  Difficulty multiplies it (Settler 0.6 / Pioneer 1 / Survivor 1.5). Each tick rolls
  `p = 1 − exp(−hazard · dt)` against the **dedicated lightning RNG stream**
  (`weather.lightningRoll`, saved and restored with the colony). Resolution:
  25 % of strikes aim at a weighted anchor — online buildings weighted by
  `exposure × lightningVulnerability` (solar 1.9, battery/oxygenator 1.5, workshop
  1.3, everything else 1), rovers weight 1, a colonist outside weight 0.8 — jittered
  ±9 m; otherwise the bolt lands anywhere in the claim. Damage falls off with
  distance inside a 24 m radius: `16 × exposure × vulnerability × falloff × damageMul`
  health to structures (crossing `DAMAGED_HEALTH = 25` trips them offline via
  `FailureSystem`), 18 % drivetrain condition to rovers, and inside a 10 m core a
  rover also loses 35 % of its pack — which strands it if that empties it. A
  colonist on EVA takes 30 health and can die, ending the mission. The strike is
  recorded as `weather.lastStrike {x, z, t}`, which the renderer turns into a
  double-flash point light, the log/alerts into a ⚡ line (critical if a structure
  went down or the colonist took it, warning if machines were singed), and the audio
  mix into a thunder cue. `dev/lightning/strike` resolves one with `aim='exact'` —
  dead on the most exposed thing standing, no jitter, no RNG — for tests and the panel.
- **Radar — IN.** A powered Weather Radar Station (`weatherRadarRangeKm = 520`,
  `advancedForecast`) is read each tick by `WeatherSystem`, which calls
  `weather.setRadar(rangeKm, advanced)`: forecast lead multiplies by **2.25×** and
  `radarMap()` returns `WeatherRadarCell[]` (kind, label, `xKm`/`zKm` centre,
  `radiusKm`, `heading`, `speedKmS`, `remainingS`, `intensity`, `active`) for the
  world map's predicted tracks. Without it the HUD falls back
  to `current()` + `threat()`. Radar is infrastructure, not a free flag: it costs
  10 kW and browns out with everything else in tier 2.
- Forecast with lead time (60 game seconds baseline); HUD surfaces it. Research-reduced
  uncertainty — **OUT**.
- Scheduler can be suspended from developer mode (`dev/storm/scheduler`), storms can
  be forced or cleared, dust set directly, and a bolt called down on demand. — **IN**
- **Dust devils are split across the seam, deliberately.** The sim owns `devil` as a
  storm *class* (its envelope, damage and dust); the visible wandering vortices are
  presentation — `render/particles/effects.ts` (`DustDevil`, `DevilManager`,
  `devilBand`, `MAX_DEVILS = 5`) rolls counts per class and intensity band, holds
  the roll for 2 s so a storm on a band boundary does not strobe, gives each devil
  its own size/spin/wander draws, and resolves contacts (cancel, dance, consume-and-grow,
  twin co-orbit → split). A wind ramp above `RAMP_MIN = 0.35 m/s²` — derived in
  `WeatherFX.sync` because the sim reports wind but never its derivative — spins one
  up out of clear air. All of it runs on an injectable RNG on sim time, so a pause
  freezes the sky. — **IN** (see `mnemosyne.md` → "Weather FX")
- Fluid dynamics per grain / pressure / radiation / SPE — **OUT** (scheduled, not simulated, per the original spec).

## 12. Day/Night & Solar Cycle

Mars sol clock + single authoritative `SunState` shared by power, greenhouse,
sky colour, shadows, and panel tilt. — **IN** (`clock.ts`). Mission starts mid-morning
(`START_SOL_FRAC = 0.34`). Night kills solar; batteries + RTG carry the base.

## 13. Research & Progression

Entire subsystem — **OUT**. No DAG, no lab producer, no unlock gates. When added,
the GDD tier list (Survival → … → Endgame) remains the content target; wire it as
data next to `defs.ts`, not as conditionals in tick code.

## 14. Colonists & Life Support

- One colonist, needs (O₂ / water / food per sol), health, EVA suit reserve, fatal
  path → `gameOver`. — **IN**. Two ways to die today: the life-support cascade, and a
  lightning strike on EVA (30 health inside a 24 m bolt radius, §11).
- Job scoring multi-colonist system — **OUT**
- Skills / roles / medicine — **OUT**
- Architecture supports more colonists later (`Colonist` is already a type; spawning
  N of them is a content decision, not a rewrite), but nothing instantiates a second.

## 15. Save Format & Persistence

- Versioned snapshot envelope produced by `Simulation.snapshot()` — **IN**, with the
  field-by-field body in `persistence/ColonyPersistence.ts` (Phase 18) and
  `Simulation` keeping only the thin delegate.
- **The untrusted boundary is `persistence/SaveCodec.ts`**: `decodeSave(unknown)`
  asserts an object (`"empty save"` otherwise), extracts and range-checks the version
  (`"unsupported save version X"` outside **3…10**), runs the migration chain, and
  returns a typed `SaveState`. Gameplay code depends on `SaveState`, never on raw
  JSON; `SaveValidator` uses `unknown` at the edge, never `any`.
- Current `SAVE_VERSION = 13`. Migration chain **v3 → v13** (additive):
  - v4 task queues, drivetrain condition, automation rules
  - v5 position lights
  - v6 difficulty + world options
  - v7 exploration (POIs + drop schedule)
  - v8 weather lightning state (the seeded strike RNG + the difficulty multiplier) —
    both optional on restore with seed/difficulty-derived defaults, so the step only
    bumps the version: an older save keeps its sky and simply gains the new hazard
  - v9 refined material (P5): `storage` gains `steel`. Additive like every step
    before it — restore spreads `{ ...emptyAmounts(), ...saved }`, so a v8 colony
    simply has an empty steel silo, and the Refinery needs no new building field
    because `BuildingSave.kind` is validated against the live blueprint table.
    Restore also *drops* any deposit row naming a refined resource: seams are
    mined material by definition, so such a row can only be hand-edited
  - v10 manufacturing (P5 slice 2): the colony gains `components` (an integer rack)
    and every building gains `recipe` (which line it runs) and `craft` (the
    fraction of a unit still on the bench). Additive again — a v9 colony arrives
    with an empty rack, every building on its first line and every bench empty —
    and restore *sanitises* rather than trusts: components floor to whole
    non-negative units, bench fractions clamp to 0…1, a non-integer or negative
    recipe index resets to 0
  - v11 maintenance: rover `parts` stores installed motor/board health, building
    `maintenance` stores `{ roverId, component, progress }` or null. Missing parts
    default to 100%; valid numeric health clamps to 0…100. Jobs with an invalid
    rover/component, non-finite progress, or a non-bay owner are dropped; valid
    progress clamps to 0…1. Jobs have not prepaid a spare, so no refunds are owed.
  - v12 water utilities: explicit local commissioning, paid pipe topology and
    per-port tanks; older colonies retain the shared water pool until commissioned.
  - v13 engineering: supported permanent tiers, funded timed job and palette paint
    per rover/building; three new component keys and bench fractions default to zero.
    Restore sanitises allowed tiers, next-tier jobs and unique Garage reservations.
- Refuse unknown future versions rather than guess; refuse anything older than v3
  (no migration path kept). — **IN**
- Storage: **localStorage** named slots via `SaveStore` (not IndexedDB yet), one slot
  per expedition, migrated once from the legacy single-slot key.
- Autosave interval is a **player setting** (`AUTOSAVE_INTERVAL_S = 45` default;
  off / 30 / 45 / 60 / 120 s), plus manual `Ctrl/Cmd+S`, save-on-tab-hide, and the
  menu/update hand-offs. `saveContext: 'auto' | 'manual' | 'menu' | 'update'`
  decides how a failure is reported — a hidden-tab autosave failure is a console
  line and a toast, never a modal prompt.
- **Ordering is the fix, not retries:** teardown runs only from the save's `onDone`
  callback, after the write has settled either way. Saving and disposing the host on
  consecutive lines is what used to reject an in-flight worker snapshot as "the
  colony has shut down".
- Save **sim state only**, never renderer/dev overlays. Building upgrade `level`
  is developer-only and omitted on purpose; restore defaults it to 1. Player
  `upgrades`, `upgradeJob` and `paint` are independent, persistent v13 fields. Rover `goal`/`phase` execution
  state is likewise not saved — `RoverSystem.rehydrate` rebuilds it (see
  `ROVER-STATE.md`).
- Snapshot header writes `CURRENT_SAVE_VERSION` rather than a literal, so a version
  bump cannot leave `snapshot()` stamping a stale schema.
- Gated by `sim/persistence`, `sim/save-validation`, `sim/refining` and
  `sim/components` (checks against hostile payloads: wrong types, missing arrays,
  out-of-range numbers, future versions, a v8 save arriving on v9, a v9 save
  arriving on v10, and a hand-edited rack).
- Cloud / import-export UI polish — **OUT** / light

## 16. Worker Protocol

Typed commands and acks — **IN** (`sim/host/protocol.ts`).

**Player commands (non-dev):**

```
rover/move | mine | unload | wait | construct | clean | repair | recover | salvage
rover/stop | repeatRoute | rule | chargeFloor | lights
building/place | toggle | demolish | maintain | assemble | recipe
colonist/order
```

**Developer commands:** `dev/time`, `dev/storm/force|clear|scheduler`, `dev/dust`,
`dev/lightning/strike`, `dev/spawn/rover|building|deposit`,
`dev/building/complete|level|health|damaged|cleanliness`,
`dev/rover/battery|cargo|cargoClear|condition`, `dev/colonist/health|suit`.

- **Player intent and dev backdoors are separate surfaces** (Phase 22): the dev
  edits live in `sim/DevBackdoors.ts` and are only reachable through a `dev/*`
  command, so a UI bug cannot accidentally fabricate a rover through a player path.
- `SimAck{ok, entityId?, value?, error?}` returns from placements and other
  mutating calls so the ghost's verdict **is** the sim's verdict on both transports.
- `SimView` is an **immutable read model** (Phase 20): `readonly` all the way down,
  built by `host/viewModels.ts` shapes, so no consumer can mutate the colony through
  a view field even by accident.
- **Domain events** (Phase 21) ride alongside the view: systems push plain
  serializable events (`rover/disabled`, `building/placed`, …) into a per-tick
  collector the host drains after a step. It is not a pub/sub bus and does not
  replace `alerts.ts`, which remains the HUD toast/log channel.
- **Transport is an adapter, not a rewrite** (Phase 30): `host/NetworkPort.ts`
  encodes the same `HostRequest`/`HostReply` objects as JSON strings over any duplex
  channel (WebSocket, DataChannel, socket). Nothing ships a server; the point is that
  sim and host stay oblivious to which side of a process boundary they are on.
- Transferable typed arrays / SAB / OffscreenCanvas — **OUT** (start with structured
  clone + batched snapshots; add when measured — §20 now measures it).
- View payload spreads entities whole; `satisfaction` as entries (JSON-safe);
  terrain omitted (re-derived from seed); weather carries the spatial field's
  inputs plus `lastStrike`, never per-entity readings.

## 17. Rendering Architecture

- **three.js WebGL2** — **IN**. WebGPU primary path — **OUT**.
- Terrain mesh from heightfield, sized to `world.half` with segment count scaled to
  match; entity meshes; day/night sky + fog keyframes; shadow sun (near plane 30);
  dust haze. — **IN**
- **Terrain material — IN:** `marsTerrain.ts` splits a 2×2 PBR atlas
  (albedo / normal / roughness / metallic / AO / height, `public/textures/pbr/`) and
  composes a world-spanning **macro albedo** so colour is sampled once across the
  claim while the fine maps keep tiling — a landscape, not a wallpaper. When the
  sheets are absent it generates a neutral fallback material, so rendering never
  depends on an asset download.
- **GLB pipeline — plumbing IN, art OUT:** `assetCatalog` derives logical ids from
  the blueprint kinds, `GlbLoader` wraps `GLTFLoader` (injectable for tests),
  `ModelRegistry` does `resolveUrl` / `register` / `load` / `getClone` / `preload`
  (a URL change invalidates; failed loads retry on an explicit load). Mesh factories
  ask the registry first and fall back to the procedural mesh on any miss — with the
  models tree empty, visuals are identical to pre-pipeline. GLB meshes get the same
  shadow flags and building pick metadata. Rover night lights expect named nodes
  (`marker`, `lampL/R`, `headlight`, `strobe`); solar tracking expects
  `solarTrack` / `sensorEye`.
- **Particles — IN:** one 9 000-mote pool (`ParticlePool` + `ParticlePoints`),
  emitters for wind-blown dust, storm grit, dust devils and rover trails, directed by
  `WeatherFX`. The emission field is **camera-scaled** (`dustField(viewRadius)`,
  clamped 45–1 000 m) and feathered at exactly the wrap radius on a p=4 superellipse,
  which is what hides the box when you zoom out (issues #2/#7). Turbulence is one
  coherent divergence-free curl roll (≈157 m cells, Taylor–Green) plus per-mote phase
  scatter; storm grit is deliberately finer than ambient dust. Emission *rates* are
  view-independent, so screen-space density is constant and the pool never grows.
  Every emitter takes an injectable `Rand` and runs on **sim time** — a pause freezes
  the sky. `tests/render/particles.test.ts` (57 checks) pins the ceiling, the
  coherence and the feather.
- **Lightning flash — IN:** `lightningFlashEnvelope(age)` drives a point light at the
  strike's world position from `view.weather.lightning`; two quick hits then a rest,
  on sim time.
- **Props — IN, presentation only:** `DescentStage` (the pod's ~56 m body on three
  splayed legs at load-bearing azimuths, with a two-pass reentry burn — a char veil
  under an additive heat glow that multiplies by night) and `WeatherStation` (azimuth
  dish, nodding feed, spinning anemometer cups, wind vane, status LEDs, all pure
  functions of sim time). Neither is pickable, neither writes sim state, neither
  appears in a save; the sim's own pod radius and siting rules stay authoritative.
- **Selection — IN:** a true-circle ring re-seated on the terrain plus a soft additive
  halo, both pulsing on sim time (`selectionPulseOpacity`, issues #9/#10).
- **Lights — IN:** rover light rigs are driven from the sim (headlamps + beam when
  lit), with a double-flash strobe envelope on a 1.6 s cycle — white on the move,
  amber emergency flash when disabled — and damaged structures get a pulsing damage
  ring. All of it is sim-time, so a pause freezes the scene.
- **2D canvas chrome — IN:** the minimap and the world-map overlay are painted from
  `SimView` in `ui/WorldMap.ts` (no three.js), with storm cells at true scale
  (`STORM_KM_TO_M = 1000`) and predicted tracks; the HUD radar scope stays a separate
  km-scale PPI.
- Overlays: `none` | `power` | `life` | `weather`. — **IN**
- Player-facing render settings — **IN**: resolution cap (ultra ≤2× / high ≤1.5× /
  performance 1× pixel ratio), shadow maps on/off, weather FX on/off (costing one
  boolean when off, not 9 000 dead particles).
- LOD / mobile shadow budgets as a formal system — **PARTIAL** / light (size-based
  particle LOD exists; no mesh LOD tiers)
- Skybox / star field / environment map — **OUT** (issue #16; the absence of an env
  map is why metalness is kept ≈0.3 on the descent stage)
- Style target unchanged: stylized modern Mars, clean silhouettes, readability over photorealism.

**Audio is presentation too** (`src/audio/AudioSystem.ts`) and follows the same
rules: it reads `SimView` and never writes it, so a save/replay stays deterministic
with the sound on.

- Nothing is fetched — the menu drone, world ambience, filtered wind/storm hiss,
  machinery bed and short cues are all synthesised on a Web Audio graph, so an
  offline build has a soundscape and there is no boot-time race.
- `audioMix(input)` is a pure function of scene, paused flag, wind, dust, storm
  intensity, active rovers and online buildings — the part worth unit-testing, and
  the part `tests/audio/system.test.ts` pins.
- **Pause contract:** machinery is time-bound and fades at speed 0; world ambience,
  wind, storm and the brownout reminder stay audible, so inspecting a frozen colony
  is never silent.
- The graph unlocks on the first real pointer/key gesture (autoplay policy) and stays
  up across menus, loading surfaces and paused frames.
- `cueForCommand(type)` maps **every** `SimCommand` to a confirmation cue
  exhaustively — a new protocol command without a cue is a compile error, and a
  rejected command plays `reject()` instead.
- Still **OUT**: music, interior/exterior acoustics, and any user-facing mute or
  volume control (a real gap — the settings tabs have no audio row).

## 18. UI/UX Implementation

- DOM/CSS HUD + menus + wizard + inspectors — **IN** (`ui/HUD.ts` owns vitals,
  alerts, inspector, build bar, colony log, minimap panel; the menus are separate
  components: `MainMenu`, `NewGameWizard`, `LoadGameScreen`, `LoadingScreen`,
  `PauseMenu`, `GlobePicker`, `Changelog`).
- Canvas/WebGPU selection outlines etc. — **PARTIAL** (three.js picks + a pulsing
  ring in 3D; the maps are 2D canvas)
- **Minimap + world map — IN** (`ui/WorldMap.ts`, issue #18): the minimap panel
  paints the whole claim each frame from the view (rovers, buildings, POIs,
  deposits, colonist, storm cells at true scale, claim bounds) and is draggable and
  collapsible; clicking it opens the overlay — zoom in/out buttons, wheel/pinch zoom,
  drag pan, fit-to-world, reset, legend, click-a-marker-to-select, Esc to close. Its
  transform is independent of `CameraRig`, so closing it never moves the game camera,
  and the paint key includes `stormOverlayKey` so a travelling front animates.
- **Panel window management — IN** (issues #12/#13): one delegated pointer pipeline
  gives every panel move + resize grips, edge snapping, and a double-tap to send it
  home; title bars no longer scroll their own content. Phones start with the side
  panels folded (a stored preference wins).
- Input map: select, context (right click / long-press), camera drag/pinch,
  Shift+order to queue, multi-select light, and hotkeys — `Space` pause/resume,
  `V` cycle overlay, `F` focus selection, `H` alert history, `M` world map,
  `.` cycle idle rovers, `1–9` blueprints in palette order, `` ` `` dev panel,
  `Ctrl/Cmd+S` save, `Esc` contextual (world map → alert history → build info →
  armed spawn → pending blueprint → selection). — **IN**
- **Keyboard ownership is explicit:** while the pause menu or the update card is
  open, only `Esc` is honoured (and `Esc` is ignored while the card's save is in
  flight); hotkeys are swallowed whenever an `INPUT`/`SELECT`/`TEXTAREA` has focus,
  which is what makes the dev panel's number boxes and the wizard's seed field safe.
- Touch targets and pause-friendly flows — **IN** / ongoing (issue #1's one-finger
  pan is in `app/gestures.ts`, still awaiting a device check)
- Build ghost uses the same `evaluateSite` rules as the sim (mirror-side), final
  commit goes through `host.requestPlacement` for an authoritative ack.
- Every UI action also has an audible identity (§17): `hud` and `app` call
  `audio.command(...)` / `audio.select()` / `audio.reject()` rather than owning
  sound themselves.

## 19. Alerts & Event System

- Central bus with **conditions** (raised once / cleared once) distinct from
  **events** (append-only log). — **IN** (`alerts.ts`)
- Severities: critical / warning / info / opportunity. — **IN**
- Coalesce/dedup by condition key so a brownout is one row, not 200. — **IN**
- Examples live in code: brownouts, O₂/water/food low, storm approaching, supply
  drop detected, rover disabled/stranded, building damaged, site discovered, drop
  buried, and **lightning strikes** (critical when a structure went down or the
  colonist took the hit, warning when machines were merely singed).
- **Ownership is split three ways** since the refactor: domain systems emit
  *domain events* (`domainEvents.ts`, Phase 21) → `FailureSystem` decides outcomes →
  `AlertSystem` maps them to `state.alerts` (keys, severity, dedupe, expiry,
  history, Phase 16). Weather writes its own log lines directly for strikes and
  storm arrival/passing. The HUD's acknowledgement stays presentation-side.
- Alert history is a first-class surface (`H`), and "pause on a new critical alert"
  is a persisted player setting.

## 20. Performance Budgets

The sim-side half of this table is no longer aspirational: it is asserted by
`tests/sim/performance-regression.test.ts` (Phase 28) on every `npm test` run.

| Budget | Target | Status |
|---|---|---|
| Sim tick at 20 Hz (50 ms) | headroom at fleet scale | **ENFORCED** — avg tick <5 / <8 / <12 / <20 ms at 10 / 25 / 50 / 100 rovers, peak <45 ms at 100 |
| View projection | cheap enough to publish per frame | **ENFORCED** — view gen <8 / <8 / <10 ms at 10 / 25 / 50 rovers |
| Worker transport (clone + mirror apply) | inside a 16.6 ms frame | **ENFORCED** — <15 ms at 100 rovers; `sim/worker-performance` also asserts the Phase 24 counters exist (view time, structured-clone time, main-thread apply, message bytes) |
| View payload size | bounded growth | **ENFORCED** — <35 / <55 / <90 / <160 KB at 10 / 25 / 50 / 100 rovers |
| Pathfinding | no O(N²) under fleet load | **ENFORCED** — avg query <3 ms at 50 rovers |
| Determinism under load | benchmark runs are reproducible | **ENFORCED** — bit-for-bit identical hashes |
| Large-colony stability | 100 rovers + ≥250 buildings through a storm | **ENFORCED** — `sim/large-colony-stress` (Phase 29): invariants hold, rover queues stay ≤5 pending, 4 800 ticks land on a **pinned state hash** |
| Particle budget | bounded pool | **ENFORCED** — 9 000 motes, worst measured case ~6 155 (5 devils at their growth cap + a severe storm); `render/particles` pins the ceiling |
| 60 FPS desktop / 30 mobile | target | playable; **not CI-gated** (the smokes assert behaviour in headless Chromium, not frame rate) |
| Draw calls <1,000 | target | **not instrumented** |
| Save <1–2 s | target | localStorage snaps are small; **not instrumented** |
| Sim LOD near/far/statistical | target | **OUT** — unnecessary so far: 250 rovers cost ~4.7 ms average tick, <10 % of the budget |

**Measured baseline** (`npm run test:bench`, `debug/Benchmark.ts`):

| Fleet | Avg tick | Peak tick | Pathfind | View gen | Clone+apply | Payload |
|---|---|---|---|---|---|---|
| 10 rovers | 0.50 ms | 6.81 ms | 0.15 ms | 0.94 ms | 0.50 ms | 18.9 KB |
| 25 rovers | 0.58 ms | 5.10 ms | 0.23 ms | 0.18 ms | 0.33 ms | 29.2 KB |
| 50 rovers | 1.10 ms | 7.49 ms | 0.02 ms | 0.44 ms | 0.63 ms | 46.4 KB |
| 100 rovers | 1.40 ms | 3.96 ms | 0.02 ms | 0.20 ms | 0.86 ms | 81.1 KB |
| 250 rovers | 4.73 ms | 11.53 ms | 0.02 ms | 0.31 ms | 1.92 ms | 184.8 KB |

Instrumentation (`debug/Profiler.ts`) is a process-wide switch, **default off**,
enabled by `tests/harness.ts`; it counts ticks, pathfinds, commands, worker
messages and view generations and times `Simulation.step` batches. It tree-shakes
out of the app bundle, and there is still **no in-game perf HUD** (§22).

Life-support and resource totals are never "simplified away". — **IN** by virtue of simming the whole claim.

## 21. Testing Strategy

Matches the PDF categories and is **IN**: **79 suites / 913 checks**, green in
~3½ minutes in parallel workers (39 unit, 23 integration, 15 HUD, 1 determinism,
1 load, plus `tests/full.test.ts` as the linked serial entry).

| Category | Suites (representative) |
|---|---|
| Unit — formulas | `sim/power`, `sim/clock`, `sim/alerts`, `sim/weather`, `sim/storms`, `sim/world`, `sim/setup`, `sim/state-hash`, `sim/profiler` |
| Unit — per system (one suite per extraction) | `sim/clock-system`, `weather-system`, `power-system`, `production-system`, `life-support-system`, `construction-system`, `rover-system`, `logistics-system`, `exploration-system`, `failure-system`, `alert-system`, `history-system`, `simulation-orchestrator` |
| Unit — the seam | `sim/host`, `sim/worker`, `sim/worker-performance`, `sim/domain-events`, `sim/devtools` |
| Integration | `sim/colony`, `sim/build`, `sim/grid`, `sim/life-support`, `sim/rovers`, `sim/rover-state`, `sim/fleet`, `sim/fleet-automation`, `sim/garage`, `sim/lights`, `sim/pois`, `sim/persistence`, `sim/save-validation`, `sim/proximity`, `sim/navigation`, `sim/invariants`, `sim/network-boundary`, `sim/refining`, `sim/components` |
| Property-based (Phase 25) | `sim/property-testing` — invariant fuzzing over random command sequences |
| Determinism | `sim/determinism` (frame-pacing telescoping), `sim/transcript` (canonical replay, Phase 26), weather/POI persistence hashes |
| Performance | `sim/performance-regression` (Phase 28 thresholds), `sim/large-colony-stress` (Phase 29, pinned hash) |
| Load | `sim/soak` (20 sols) |
| HUD | `hud/*` under jsdom — chrome, panels, controls, inspectors, fleet, garage, workshop, weather, alerts, markers, dossier, devpanel, pause-menu, mobile, worldmap |
| Render (GPU-free) | `render/particles`, `render/descent-stage`, `render/weather-station`, `render/glb-assets`, `render/selection`, `render/solar` |
| Audio | `audio/system` — the pure mix + the exhaustive command→cue contract |
| App / UI | `app/game-controllers`, `app/pause-save`, `app/update-check`, `ui/gestures`, `ui/build-status` |
| Browser smokes (Playwright, headless Chromium) | `worker-smoke` (both transports, CI), `mobile-smoke` (CI), `update-check-smoke`, `pause-smoke`, `maintenance-smoke` (both transports), `screenshots` |

Runner: `scripts/run-tests.mjs` — esbuild-bundled suites in parallel workers,
`--affected` via `@covers`, `--group`, `--case`, watch mode, slowest-first
scheduling. `npm run test:list` prints every suite with its check count and the
sources it pins.
Layout guard: every on-disk suite is linked in `full.test.ts`; every suite declares
`@covers` (`npm run test:check`, also run by `npm test`).
Other harnesses: `npm run test:bench` (fleet scaling), `npm run test:stress`
(large colony), `npm run test:replay` (canonical transcripts),
`scripts/behavior-baseline.ts` (byte-identical behavior across a refactor).

**jsdom gotchas worth repeating** (they have bitten twice): a standalone suite that
constructs `new Game()` must `process.exit` itself at the end — the frame loop's
chained rAF keeps Node alive — and `globalThis.fetch` must be stubbed to reject, or
the main menu's GitHub badge fetch hangs the runner in a blackholed sandbox. The HUD
fixture installs a *recording* 2D canvas stub, because a `getContext` returning null
silently deletes every paint path in `ui/` from all HUD suites (`hud/worldmap` pins
the stub itself).

## 22. Debugging & Developer Tools

Dev overlay perf counters / worker queue / deterministic hash HUD — **OUT as UI**.
The *machinery* for two of them now exists as modules (`debug/Profiler.ts`,
`debug/StateHash.ts`), imported by tests and tree-shaken from the bundle; neither is
surfaced in the panel yet.

**Implemented: the Developer mode panel** (`src/dev/`, toggled with backquote or
the 🛠 topbar button in play). Design rules it shipped with:

- *Master switch ≠ visibility.* `DevMode.enabled` is the mode; opening the panel is
  presentation. Closing the panel leaves the mode (and its pins) exactly as they
  were, and `overlayState()` publishes nothing at all unless the mode is on — which
  is also why any script that exercises pins (`scripts/worker-smoke.mjs`'s battery
  check) has to call `dev.enable()` first.
- *Runtime-only overlay.* `DevMode` holds modifier state (enabled flag,
  keep-battery-full pin set, armed click-to-place spec) *outside* the sim and
  applies it via host **overlays** + `dev/*` commands. Building upgrade marks live
  on a `level` field that `snapshot()` deliberately never writes and `restore()`
  defaults back to 1 — so nothing the panel does can reach the save file
  (explicitly tested, including a live read of the stored localStorage blob). The
  panel carries an `UNSAVED` badge to say so.
- *Fabrication goes through the real sim.* Explicit
  `dev/spawn/{rover,building,deposit}`, `dev/building/complete`, `dev/time`,
  `dev/lightning/strike`, etc. Building spawns use ordinary `canPlace` siting rules
  and the same refusal strings as the build palette. Fabrications become first-class
  sim objects (they charge, work, break, and *are* saved once created); only the dev
  modifiers are not. Since Phase 22 these live behind `sim/DevBackdoors.ts`, separate
  from the player-command surface.
- *Weather is hand-flyable:* force or clear any storm class, switch the scheduler
  off, set airborne dust directly, and drop a bolt on the most exposed thing
  standing (`aim='exact'`, no jitter, no RNG — reproducible by design).
- *No sim-side clock forks.* Editing the calendar re-anchors the authoritative
  sol clock
  (`simTime = (sol + frac − START_SOL_FRAC) · SOL_SECONDS`)
  and rebases history sampling so the jump records one marker instead of a wall
  of regressed points. Note that a `dev/time` jump leaves `weather.time` behind, so
  a conjured storm's envelope does not follow the calendar — for screenshots, force
  the storm and run at 4× rather than time-travelling.
- *Input discipline.* Hotkeys are swallowed while any form control has focus
  (the panel's own number boxes included), and the click-to-place arm grammar is
  the build palette's: Shift clicks keep placing, Esc disarms first.
- *Host-shaped.* Since the host extraction, every edit is a command on the
  colony's host — the same path a player's move order takes — so the worker and
  in-process transports behave identically (and every command gets its audio cue).

Still open per the original spec: an on-screen tick/frame perf readout, worker queue
inspection, a state-hash readout, and teleport/reveal commands.

## 23. Browser Deployment

- Static Vite SPA, GitHub Pages workflow present. — **IN**
- **CI gates** (`.github/workflows/pages.yml`, on pushes to main and on PRs):
  `npm ci` → install headless Chromium → `npm run build` (which runs `tsc` first, so
  every PR type-checks) → serve that exact `dist/` → `mobile-smoke` →
  `worker-smoke` **twice**, once per transport (the in-process run passes
  `SMOKE_QUERY='?worker=0'` explicitly, because an empty query would exercise the
  worker twice and quietly drop the gate) → deploy, on main only. Failures upload
  evidence, comment on the PR, and open an issue when main breaks. A separate
  `screenshots` workflow rebuilds and commits `screenshots/`.
  **`npm test` is not part of CI** — the 76-suite run is the local / review contract.
- Build identity: every build stamps its commit into the bundle (`__RF_BUILD_COMMIT__`)
  and ships `version.json` (`{ commit, builtAt, notes }`) in `dist/` (Vite plugin in
  `vite.config.ts`); `notes` is the recent non-merge commit subjects — the changelog
  the in-play card reads. CI uses `GITHUB_SHA`, local builds use `git rev-parse HEAD`.
  The Pages checkout is full-depth (`fetch-depth: 0`) because main's HEAD is a merge
  commit the changelog must expand. — **IN**
- In-play update check (`src/app/UpdateCheck.ts`): while a colony runs, the app
  polls its own `version.json` every ~5 min (same origin, `no-store` + a fresh
  cache-buster query so no CDN copy can answer stale). Newer commit found →
  one-shot hand-off to `Game.onNewBuild`: freeze the sim and raise the **update
  card** (frost + centered card, not a toast). The card lists what is new (the
  manifest's `notes`), names both builds, and tells the player that continuing
  means *they* save and *they* reload. **Nothing happens automatically — no
  auto-save, no auto-reload** (a player requirement): "Save colony" runs the
  normal save under the progress frost, and only a successful save reveals
  "Reload now"; that click alone tears the colony down and reloads the page.
  "Later" / Esc dismisses the card and restores the pre-notice speed; a manual
  page reload re-arms the check. A failed save in this context is reported on
  the card (retry / keep playing), never as a stacked save-failed prompt.
  Hidden tabs skip the check and re-arm on return; the check starts at colony
  launch and stops on menu hand-off or mission end; dev mode is out (HMR covers
  it, the dev server ships no manifest). QA knob: `?updateCheckMs=…` (≥ 1000 ms). — **IN**
- Why the manifest and not the GitHub API: the Pages workflow deploys this
  exact `dist/` tree, so the manifest is by construction the build that is
  *live* — main can sit ahead of a deploy (a failed smoke gate blocks
  publishing while main keeps moving), and unauthenticated API calls
  rate-limit per IP, which a per-player 5-minute poll would burn through. The
  main-menu badge (`BuildStatus.latestMainCommit`) keeps the GitHub API: it
  answers a different question ("is main ahead of the build I just loaded?"). — **decision**
- Update-check gate: `scripts/update-check-smoke.mjs` drives the whole
  save-and-reload flow in headless Chromium against a served build. — **IN** (run manually / locally)
- Service Worker offline cache — **OUT**
- WebGPU detection path — **OUT** (WebGL2 required; splash says so)
- Save on visibility / before suspension — **PARTIAL**
- Optional future Java backend — still out of scope

## 24. Security & Data Validation

- `SimCommand` decode validates types/enums/ranges before `applyCommand`. — **IN**
- Save restore validates version + migrates; unknown versions refused. — **IN**
- Never execute code from save data. — **IN**
- Cloud/multiplayer packet threat model — **OUT** (no cloud yet)

## 25. Implementation Roadmap

| Tier | Exit criterion | Status |
|---|---|---|
| T1 Worker + fixed tick + camera + terrain | stable 20 Hz, smooth camera | **IN** (frame-pumped worker; see §2) |
| T2 entities + resources + buildings + construction | build & account materials deterministically | **IN** |
| T3 power/water/oxygen + day/night | life-support loop survives a day/night | **IN** |
| T4 rovers + nav + tasks | rovers mine, haul, charge, recover | **IN** (plus proximity crawling) |
| T5 weather + dust + damage | storm cascades and recovers | **IN** (spatial field, lightning, radar) |
| T6 procedural world + POIs + drops | explore & recover remote objectives | **PARTIAL** (see open list) |
| T7 research + agriculture + colonists | progression creates meaningful automation | **OUT** |
| T8 optimization + migrations + release UI | devices meet budgets; saves survive upgrades | **PARTIAL** — migrations v3→v13 IN, sim budgets measured and enforced IN, on-device frame budgets and sim LOD OUT |

**The architecture work is finished.** All 30 phases of
`ARCHITECTURAL-REFACTOR-ROADMAP.md` are recorded complete (Phase 30, the optional
network boundary, landed 2026-09-20). What remains is *content and product*, not
structure — which is why the open list below is about pillars, not refactors.

**Open work, ordered the way the code comments and README currently argue:**

1. ~~**Pick the next pillar**~~ — **decided: Engineering (P5)**. Four slices
   are IN: refining (steel), manufacturing (components, recipes, part-priced
   rovers), rover maintenance (installed part wear + Repair Bay), and water networks. What is left of the pillar is the depth work in
   item 3.
2. **Live with the worker default, then delete the in-process fallback** outside
   tests. Gates are already dual-transport. Optional later: true 20 Hz worker
   timer + render interpolation *if* frame-pumped advance measures as a bottleneck
   (it does not today — §20); transferables / OffscreenCanvas behind their own guards.
3. **GDD P5 / industrial layer** — *four slices shipped*: slice 1 gave
   the colony `steel` (a refined `ResourceId` on the one bulk ledger,
   `ProcessDef.solidOut`, heavy blueprints priced in steel, save v9); slice 2 gave
   it machines (`ComponentId` on a counted ledger with rack slots,
   `ProcessDef.componentOut`, `RECIPES` + `Building.recipe` replacing the
   one-process-per-building model, rover assembly priced in motors and boards, save
   v10). Slice 3 adds installed-part wear and timed Repair Bay replacements (v11).
   Slice 4 adds water pipes, pumps, tanks and safe commissioning (v12).
   *Still open*: a second refined material (glass), a wider parts catalogue
   (valves and further utility parts), further utility networks, and
   building-specific component wear.
4. **Finish T6** — survey confidence, expedition planning, narrative logs,
   repairable wrecks into the garage line (which now has a price list to charge
   against: a recovered rover is motors and boards as well as metal),
   ice-cave/lava-tube rules beyond flat salvage, and POI-specific markers
   (issue #19).
5. **Presentation gaps the backlog already names** — a skybox/star field (#16),
   changelog data generated from Git instead of the hand-curated table (#15), and a
   device check on the mobile one-finger pan (#1).
6. **Audio settings** — a mute/volume row in the settings tab. The soundscape is
   the one shipped feature a player cannot turn off.
7. **TDD §22 remainder** — surface the profiler and the state hash in the dev panel,
   plus teleport/reveal.
8. **T7** — research DAG, agriculture depth, multi-colonist.
9. **Persistence upgrade** — IndexedDB (original target) if slot size or quota
   becomes a real limit; service worker offline.

**Ordering conflict with GDD §16 (resolved in code, still unresolved on paper):**
GDD wants refining (P5) before finishing exploration (P6); TDD never gave refining
its own tier, and the project shipped a P6 slice first and then a P5 slice. The
scheduling call was made in the build — Engineering went next — but TDD §25 still
has no tier for the industrial layer, so P5 progress is tracked in GDD §0/§16 and
in Appendix B rather than in a T-row of its own.

## 26. Prototype Acceptance Test

A fresh world can (and the test suite / smokes assert the bulk of this):

| Criterion | Status |
|---|---|
| Generate terrain from a seed | **IN** |
| Spawn player + two rovers | **IN** |
| Mine regolith / iron / water ice (also silicon, aluminum) | **IN** |
| Construct habitat, solar, battery, water extractor, oxygen generator, greenhouse, warehouse, workshop, garage | **IN** (+ RTG Array, Weather Radar Station, Refinery) |
| Smelt ore into a refined material and build heavy structures from it | **IN** (P5 slice 1: iron ore → steel → garage / radar station) |
| Machine components out of refined stock and build a rover from them | **IN** (P5 slice 2: steel + silica → motors / boards on a chosen Workshop line → garage assembly) |
| Connect utilities | **PARTIAL** (power grid; no pipe networks) |
| Run day/night | **IN** |
| Dust storm reduces solar and damages exposed equipment | **IN** |
| Storm weather varies across the claim and can strike lightning | **IN** |
| Dispatch rovers automatically | **IN** |
| Save, reload, identical state hash | **IN** (and load a v3–v8 save into the v9 schema) |
| Discover POIs, salvage, recover a supply drop before burial | **IN** |
| Play with sound, on a worker, on a phone-sized screen | **IN** (smoke-gated; audio is synthesized, so no assets to fetch) |

Most important criterion, unchanged: simulation remains understandable,
deterministic, recoverable, and performant under pressure from Mars — not visual
fidelity first.

## 27. Engineering Principles

1. Simulation is authoritative; rendering/UI observe it. — **IN** (`SimHost`/`SimView`)
2. Data drives content (buildings/resources/recipes/research/weather params outside core logic). — **IN** for what exists; research still absent
3. Determinism matters (fixed steps, stable ordering, seeded randomness). — **IN**
4. Fail gracefully (recoverable cascading failures over opaque instant loss). — **IN**
5. Optimize from profiling; start simple, measure, then optimize. — **IN** as a practice (profiler counters, fleet benchmarks, an enforced regression suite, a stress scenario with a pinned hash, replayed transcripts); **PARTIAL** as a player-facing tool (no perf HUD yet)
6. Design for mobile from day one (touch, GPU limits, suspension, readability). — **IN** / ongoing

---

## Appendix A — Protocol surface (quick ref)

See `src/sim/host/protocol.ts` for the schema-of-record. Any new player intent
adds a variant there, a decoder field table, an `applyCommand` branch, a cue in
`audio/AudioSystem.ts`'s exhaustive `COMMAND_CUES` map, and a host test — never a
direct `sim.foo()` call from UI. Dev-only edits go through `sim/DevBackdoors.ts`
and a `dev/*` command instead, so the player surface stays small (Phase 22).

New *content* is cheaper than new *intent*: a blueprint or a bulk resource needs no
protocol change at all, because `fieldOk` validates `buildingKind` against
`BUILDINGS` and `resourceId` against `RESOURCES` — the Refinery and `steel` arrived
with the decoder untouched. The one exception is a field whose legal values are a
*subset* of a table: `dev/spawn/deposit` uses `mineableResourceId`, because a seam
of refined material is not a thing that can exist.

## Appendix B — What "done" means for the open slices

**P5 / industrial foundation** acceptance (not the entire GDD P5 milestone):

- **DONE** — At least one refined material (e.g. steel) is produced from ore through
  a building process and is required by a downstream blueprint. *As built:* the
  Refinery (`solidOut` 2.6 kg iron ore → 1.6 kg steel per Mars hour, 35 kW, tier 2)
  makes `steel`, which the Rover Garage (30 kg) and Weather Radar Station (25 kg)
  require. Gated by `tests/sim/refining.test.ts` (19 checks) plus the process and
  logistics suites.
- **DONE** — A component or two (e.g. motor, circuit board) exists as craftable
  inventory. *As built:* `ComponentId` = `motor` | `circuitBoard` on their own
  integer ledger (`ComponentSystem`) with rack-slot capacity instead of kg, made by
  the Workshop on one of two player-selected lines (`RECIPES` *replaces* the
  blueprint's fixed process — a kind never has both, and a test pins that), the
  unfinished fraction held on `Building.craft`, and the whole chain closed by rover
  assembly prices in parts (Utility 2 motors + 1 board, Mining 4 + 1, Cargo 6 + 2).
  `SAVE_VERSION = 10` (additive: a v9 colony arrives with an empty rack, every
  building on its first line). Gated by `tests/sim/components.test.ts` (21 checks)
  plus the garage, host, production and persistence suites.
- **DONE** — Construction costs can reference refined outputs without breaking v8
  saves (a v9 migration step, additive like every one before it). *As built:*
  `migrations/v8.ts` in the chain, a v8 colony restores with `steel: 0`, and a save
  claiming a steel seam loses that row. Slice 2 followed the same shape one version
  later: `migrations/v9.ts` adds the rack, the line and the bench, and nothing else.

**P5 / rover maintenance slice** acceptance:

- **DONE** — motor and board health are authoritative, independent of routine
  drivetrain condition, worn by activity/exposure and reflected in work rate.
- **DONE** — Repair Bays do timed, powered replacements, spending exactly one
  matching Workshop spare per completion. No power or inventory means no repair.
- **DONE** — player orders/charging override service; cancelled work is unpaid;
  two bays cannot double-spend or repair the same rover concurrently.
- **DONE** — v11 jobs/health survive save/load, old colonies get healthy parts,
  and owned nested copies cross the local/worker view boundary.
- **DONE** — HUD health/progress/costs and alerts are visible; bootstrap recovery
  remains possible at half work rate, and building structural repair stays free.
- **OUT of this slice** — building-specific replaceable components, repair-bay
  dispatch/appointments, salvage of worn parts, and the wider utility catalogue.

**T6 remainder (Exploration pillar)** is done when:

- Site contents are ranges until surveyed; survey is a task or scout action.
- At least one wreck can be recovered into a working rover via the garage line.
- A drop or POI expedition is plan-able (range/battery estimate before dispatch).
- One narrative content hook (log entry / radio) fires on a discovery milestone.

### P5 water network acceptance

- **DONE:** manufacturing pipes, paid validated links, connected/powered explicit
  commissioning without reserve loss, isolated consumers, power-scaled mass
  conservation, local production/drinking/recycling and safe v12 saves.
- **DONE:** immutable host projection, command decoding, deterministic continuation,
  tank/link invariants, stable controls and a dedicated water overlay.
- Gates: `sim/water` (15), `hud/water` (4), `render/water-overlay` (1),
  `scripts/water-smoke.mjs` on both transports, plus the full regression suite.
