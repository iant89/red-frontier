# Red Frontier — Technical Design Document

Source: Ian Thomas's shared Dropbox (`Red_Frontier_TDD.pdf`, v1.0), realigned to the
live codebase on branch `arena/01a091e4-red-frontier` (package `0.3.0`, README
**Prototype 4** + first exploration slice).

This document is both the **architecture target** and the **as-built notes**.
Where the build deliberately diverged from the original PDF, the divergence is
named and justified so a future change is a decision, not an accident.

Status tags match the GDD: **IN** / **PARTIAL** / **OUT**.

---

## 0 — Implementation status (living)

| TDD tier (§25) | Theme | Status |
|---|---|---|
| **T1** | Worker + fixed tick + camera + terrain | **IN** (worker default; frame-pumped, not a worker-side timer) |
| **T2** | Entities + resources + buildings + construction | **IN** (class/entity model, not a formal ECS folder) |
| **T3** | Power / water / oxygen + day/night | **IN** (power network; fluids as tank pools) |
| **T4** | Rovers + navigation + tasks | **IN** |
| **T5** | Weather + dust + damage | **IN** |
| **T6** | Procedural world + POIs + supply drops | **PARTIAL** |
| **T7** | Research + agriculture depth + colonists | **OUT** |
| **T8** | Optimization + save migrations + release UI | **PARTIAL** (migrations v3→v7 IN; budgets/LOD OUT) |

**Stack as built**

| Concern | Original recommendation | As built |
|---|---|---|
| Language | TypeScript client + sim | **TypeScript** throughout |
| Renderer | WebGPU primary, WebGL2 fallback | **three.js WebGL2** (WebGPU OUT) |
| Sim isolation | Dedicated Worker | **Module Worker default** + `LocalSimHost` fallback (`?worker=0`) |
| Saves | IndexedDB | **localStorage** named slots (`SaveStore`) |
| Backend | future Java authority | **OUT** (static Vite app) |
| Audio | Web Audio | **OUT** |
| Content data | data-driven blueprints | **IN** (`defs.ts` / `config.ts`) |

**Hard gates that exist today**

- `npm test` — 36 suites / 299 checks (unit, integration, determinism, load, HUD)
- `scripts/worker-smoke.mjs` — both transports on every PR
- `scripts/mobile-smoke.mjs` — headless Chromium play path
- Determinism: same seed + elapsed time → same state hash (frame-pacing invariant tested)

---

## 1. Purpose & Technical Goals

Translates GDD into an implementable architecture: simulation ownership, data
structures, update order, utility networks, AI/task scheduling, procedural
terrain, weather, persistence, rendering, input, testing, profiling, deployment.

Goals (unchanged, with current grade):

| Goal | Grade |
|---|---|
| Deterministic & testable simulation | **IN** |
| Smooth desktop/mobile | **PARTIAL** (playable; perf budgets not instrumented) |
| Scalable entity counts | **OUT** (no sim LOD yet; world is one window) |
| Save/load without renderer state | **IN** |
| Graceful degradation | **IN** (soft rover failure, storm recovery) |
| Clear sim / render / UI / persistence separation | **IN** (via `SimHost`) |

## 2. Architecture Overview

| Layer | Responsibility | Runtime | Status |
|---|---|---|---|
| UI | HUD, menus, build palette, alerts | Main thread DOM/CSS (`src/ui`) | **IN** |
| Input | desktop/mobile gesture normalization | Main thread (`src/app/Game.ts`) | **IN** (no separate `input/` package) |
| Renderer | camera, terrain, entities, effects, overlays | three.js WebGL2 (`src/render`) | **IN** |
| Simulation | world state, economy, AI, weather, utilities | Worker **or** main (`src/sim`) | **IN** |
| World | terrain, deposits, POIs | Inside sim; terrain re-derived from seed on mirror | **PARTIAL** (no chunk streamer) |
| Persistence | versioned snapshots | localStorage (`src/ui/SaveStore.ts`) | **IN** |
| Audio | music, ambience, alerts | — | **OUT** |
| Dev tools | runtime edits | `src/dev` → `dev/*` commands on the host | **IN** |

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
  app/               Game loop, input, camera rig, command dispatch
    CameraRig.ts
    Game.ts
  sim/               framework-agnostic simulation (no DOM, no three.js)
    config.ts        balance constants + the two time bases
    defs.ts          data-driven blueprints (resources, fluids, rovers, buildings)
    clock.ts         Mars sol clock + authoritative sun
    power.ts         pure power-grid resolver
    lifesupport.ts   fluid pools, colonist needs, health
    alerts.ts        condition bus + event log
    weather.ts       wind, dust, storm scheduler + envelopes
    pois.ts          site/drop content tables + salvage maths
    terrain.ts       local height / material from seed + landing
    marsGlobe.ts     compact geographic Mars for the landing picker
    navgrid.ts       walk/build grid, reachability flood
    rules.ts         siting + maintenance verdicts (shared by ghost + sim)
    World.ts         seeded terrain handle + deposits + scattered sites
    Simulation.ts    entities, tick order, construction, tasks, persistence
    difficulty.ts    Settler/Pioneer/Survivor + world sizes/options
    host/            the seam
      protocol.ts      every legal write, as plain serializable data
      view.ts          SimView — read model (Pick'd from Simulation)
      applyCommand.ts  dispatch table (sim-side, worker-reusable)
      overlays.ts      runtime edits as data (name + ids), never closures
      projection.ts    view payload a host answers with
      LocalSimHost.ts  in-process host
      mirror.ts        SimView from payloads + terrain from seed
      workerRuntime.ts sim side of the wire
      WorkerSimHost.ts posts ticks, mirrors state, optimistic acks
      createHost.ts    one factory, either transport
      messages.ts      wire message types
      SimHost.ts       interface
    sim.worker.ts    worker entry
  dev/               DevMode (runtime state) + DevPanel (DOM)
  render/            three.js renderer, weather FX, particles/
  ui/                HUD, menus, wizard, save store, globe picker
  lib/               deterministic RNG + simplex noise
  style.css          play HUD + menu theme
tests/               36 suites: sim/*, hud/*, render/*, ui/*
scripts/             test runner, Playwright smokes, screenshots
docs/design/         this GDD + TDD
```

**Original PDF folders not present (and why):**

| PDF path | Status | Notes |
|---|---|---|
| `sim/ecs/` | **not used** | Entities are typed objects on `Simulation` (rovers, buildings, colonist, POIs). Data-oriented enough for the current scale; a formal ECS is not required until entity counts demand it. |
| `sim/utilities/` | **OUT** | Only power is a network; fluids are tank pools on buildings. |
| `sim/ai/` | **folded into** `Simulation.ts` | Task queue, auto-dispatch, reservations live next to the entities they drive. |
| `sim/research/` | **OUT** | |
| `sim/save/` | **folded into** `Simulation.snapshot/restore` + migrations | |
| `input/` | **folded into** `app/Game.ts` | |
| `audio/` | **OUT** | |
| `shared/` | **OUT as a package** | Protocol types live under `sim/host/`; defs are imported directly. |

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
  weather on its own seeded stream, pure storm envelope, tick accumulator that
  telescopes (60 s in 3600 ragged frames ≡ 60 s in one call — tested).
- No wall-clock dependence inside the sim — **IN**.

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

Resource rule (nothing from nowhere except configured producers) — **IN**.

| Network | Status | Notes |
|---|---|---|
| **Power** | **IN** | `power.ts` pure resolver: generation → batteries → consumers by priority tiers 0–3; within a tier, uniform degradation (brownout reads as "Industry at 62%"). |
| **Water** | **PARTIAL** | Extractor process writes fluid `water` into shared tank capacity; habitat reclaim; no pipe graph. |
| **Atmosphere** | **PARTIAL** | `pressurized` flag + O₂ fluid; no volume/breach model. |
| **Heat** | **OUT** | |
| **Logistics** | **PARTIAL** | Haulers + deposit reservations + site material delivery without a parked rover (Materials Reserved). No general supply/demand graph. |

Priority tiers in use: 0 life support → 1 oxygen & water → 2 industry → 3 logistics (rover charge).

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

**Buildable set today:** habitat, solar, battery, rtg, warehouse, extractor,
oxygenator, greenhouse, workshop, garage. Missing vs GDD: refinery, laboratory,
repair bay, nuclear reactor.

## 8. Rover Architecture

| Rover | Status | Core systems in build |
|---|---|---|
| Scout | **OUT** | — |
| Utility | **IN** | build / repair / clean / general |
| Mining | **IN** | dig + hopper |
| Cargo | **IN** | large hopper (garage-assembled) |

Task states effectively: Idle → Navigate → Work/Load/Unload → Charge/Repair/Recover/Disabled. — **IN**
Reservations prevent two auto-haulers collapsing onto one poor seam; rich seams share. — **IN**
Priority: player orders > critical survival / storm shelter / rescue > charge floor > production logistics > exploration. — **IN**
Position lights (auto at night/low visibility, battery draw, stranded reserve strobe) — **IN**.

## 9. Pathfinding & Navigation

- `NavGrid`: fixed cell size (8 m), cliff/slope masks, reachability flood from the pad. — **IN**
- Movement integrates toward waypoints with turn rate; blocked destinations refused. — **IN**
- Hierarchical chunk A* / Jump Point Search / long-distance chunk routing — **OUT**
- Dynamic building obstacle updates — **PARTIAL** (placement uses clearance; nav grid is terrain-static)
- Deterministic tie-breaking / bounded acceleration — **PARTIAL** (deterministic integration; simple controller)

## 10. World Generation & Streaming

- Playable region: axis-aligned square `[-worldHalf, worldHalf]²`, 1 unit = 1 m.
  Default-scale half-extent 640 m; difficulty offers small/medium/large/planet sizes. — **IN**
- Landing: `marsGlobe.ts` picks a geographic site; local `terrain.ts` builds
  HiRISE-scale height + material from the seed. — **IN**
- Deposits + POIs scattered with exclusion radius around the pad. — **IN**
- Chunks 128 m, streaming, persist-only-mutated-chunks — **OUT**. Terrain is a
  pure function of seed on both sides of the worker mirror (heights never cross
  the wire). Player-mutated state (buildings, POI found/stripped/burial, stockpiles)
  is what snapshots carry.

## 11. Weather Simulation

- Regional field sampled across the claim; storm cells with ramp-hold-decay envelopes. — **IN**
- State: wind, dust density, solar transmission, visibility, storm kind/intensity. — **IN**
- Storm classes: devil, regional, severe, planetary (+ calm). Unlock sols + chances in `config.ts`. — **IN**
- Solar output = sun elevation × dust transmission × panel cleanliness (and health). — **IN**
- Wind damage from exposure × intensity; dust accumulates, cleaning restores. — **IN**
- Forecast with lead time; HUD surfaces it. Research-reduced uncertainty — **OUT**.
- Scheduler can be suspended from developer mode. — **IN**

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
  path → `gameOver`. — **IN**
- Job scoring multi-colonist system — **OUT**
- Skills / roles / medicine — **OUT**
- Architecture supports more colonists later (`Colonist` is already a type; spawning
  N of them is a content decision, not a rewrite), but nothing instantiates a second.

## 15. Save Format & Persistence

- Versioned snapshot envelope produced by `Simulation.snapshot()` — **IN**
- Current `SAVE_VERSION = 7`. Migration chain **v3 → v7** (additive):
  - v4 task queues, drivetrain, automation rules
  - v5 position lights
  - v6 difficulty + world options
  - v7 exploration (POIs + drop schedule)
- Refuse unknown future versions rather than guess. — **IN**
- Storage: **localStorage** named slots via `SaveStore` (not IndexedDB yet).
  Autosave ~45 s + manual (`Ctrl/Cmd+S`) + visibility-aware hooks as applicable.
- Save **sim state only**, never renderer/dev overlays. Building upgrade `level`
  is omitted on purpose; restore defaults it to 1.
- Cloud / import-export UI polish — **OUT** / light

## 16. Worker Protocol

Typed commands and acks — **IN** (`sim/host/protocol.ts`).

**Player commands (non-dev):**

```
rover/move | mine | unload | wait | construct | clean | repair | recover | salvage
rover/stop | repeatRoute | rule | chargeFloor | lights
building/place | toggle | demolish | maintain | assemble
```

**Developer commands:** `dev/time`, `dev/storm/*`, `dev/dust`, `dev/spawn/*`,
`dev/building/*`, `dev/rover/*`, `dev/colonist/*`.

- `SimAck{ok, entityId?, value?, error?}` returns from placements and other
  mutating calls so the ghost's verdict **is** the sim's verdict on both transports.
- Transferable typed arrays / SAB / OffscreenCanvas — **OUT** (start with structured
  clone + batcheded snapshots; add when measured).
- View payload spreads entities whole; `satisfaction` as entries (JSON-safe);
  terrain omitted (re-derived from seed).

## 17. Rendering Architecture

- **three.js WebGL2** — **IN**. WebGPU primary path — **OUT**.
- Terrain mesh from heightfield; entity meshes; day/night sky + fog; shadow sun;
  dust haze; particle system (wind, storm grit, dust devils, rover trails). — **IN**
- Overlays: `none` | `power` | `life` | `weather`. — **IN**
- LOD / mobile shadow budgets / texture atlases as a formal system — **PARTIAL** / light
- Style target unchanged: stylized modern Mars, clean silhouettes, readability over photorealism.

## 18. UI/UX Implementation

- DOM/CSS HUD + menus + wizard + inspectors — **IN**
- Canvas/WebGPU selection outlines etc. — **PARTIAL** (three.js picks + DOM chrome)
- Input map matches GDD/TDD: select, context (right / long-press), camera drag/pinch,
  multi-select light, hotkeys (`Space` pause, `V` overlay, `F` focus, `1–9` blueprints,
  `` ` `` dev panel, `Ctrl/Cmd+S` save). — **IN**
- Touch targets and pause-friendly flows — **IN** / ongoing
- Build ghost uses the same `evaluateSite` rules as the sim (mirror-side), final
  commit goes through `host.requestPlacement` for an authoritative ack.

## 19. Alerts & Event System

- Central bus with **conditions** (raised once / cleared once) distinct from
  **events** (append-only log). — **IN** (`alerts.ts`)
- Severities: critical / warning / info / opportunity. — **IN**
- Coalesce/dedup by condition key so a brownout is one row, not 200. — **IN**
- Examples live in code: brownouts, O₂/water/food low, storm approaching, supply
  drop detected, rover disabled/stranded, building damaged, site discovered, drop buried.

## 20. Performance Budgets

| Budget | Target | Status |
|---|---|---|
| Sim 20 Hz, <50 ms headroom | target | **unenforced** (no tick perf counters yet) |
| 60 FPS desktop / 30 mobile | target | playable; not CI-gated |
| Draw calls <1,000 | target | not instrumented |
| Save <1–2 s | target | localStorage snaps are small today |
| Sim LOD near/far/statistical | target | **OUT** |

Life-support and resource totals are never "simplified away". — **IN** by virtue of simming the whole claim.

## 21. Testing Strategy

Matches the PDF categories and is **IN**:

| Category | Suites (representative) |
|---|---|
| Unit | `sim/power`, `sim/clock`, `sim/alerts`, `sim/weather`, `sim/host` |
| Integration | `sim/life-support`, `sim/colony`, `sim/build`, `sim/grid`, `sim/storms`, `sim/rovers`, `sim/fleet`, `sim/garage`, `sim/lights`, `sim/pois`, `sim/persistence` |
| Determinism | `sim/determinism`, weather/pois persistence hashes |
| Load | `sim/soak` (20 sols) |
| HUD | `hud/*` under jsdom |
| Browser matrix / smokes | `worker-smoke` (both transports), `mobile-smoke` |

Runner: `scripts/run-tests.mjs` — parallel workers, `--affected` via `@covers`,
`--group`, watch mode. `tests/full.test.ts` is the linked serial entry.
Layout guard: every on-disk suite is linked; every suite declares `@covers`.

## 22. Debugging & Developer Tools

Dev overlay perf counters / worker queue / deterministic hash HUD — **OUT**.

**Implemented: the Developer mode panel** (`src/dev/`, toggled with backquote or
the 🛠 topbar button in play). Design rules it shipped with:

- *Runtime-only overlay.* `DevMode` holds modifier state (enabled flag,
  keep-battery-full pin set, armed click-to-place spec) *outside* the sim and
  applies it via host **overlays** + `dev/*` commands. Building upgrade marks live
  on a `level` field that `snapshot()` deliberately never writes and `restore()`
  defaults back to 1 — so nothing the panel does can reach the save file
  (explicitly tested, including a live read of the stored localStorage blob).
- *Fabrication goes through the real sim.* Explicit
  `dev/spawn/{rover,building,deposit}`, `dev/building/complete`, `dev/time`, etc.
  Building spawns use ordinary `canPlace` siting rules and the same refusal
  strings as the build palette. Fabrications become first-class sim objects
  (they charge, work, break, and *are* saved once created); only the dev
  modifiers are not.
- *No sim-side clock forks.* Editing the calendar re-anchors the authoritative
  sol clock
  (`simTime = (sol + frac − START_SOL_FRAC) · SOL_SECONDS`)
  and rebases history sampling so the jump records one marker instead of a wall
  of regressed points.
- *Input discipline.* Hotkeys are swallowed while any form control has focus
  (the panel's own number boxes included), and the click-to-place arm grammar is
  the build palette's: Shift clicks keep placing, Esc disarms first.
- *Host-shaped.* Since the host extraction, every edit is a command on the
  colony's host — the same path a player's move order takes — so the worker and
  in-process transports behave identically.

Still open per the original spec: tick/frame perf counters, worker queue
inspection, deterministic state hash readout, teleport/reveal commands.

## 23. Browser Deployment

- Static Vite SPA, GitHub Pages workflow present. — **IN**
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
| T4 rovers + nav + tasks | rovers mine, haul, charge, recover | **IN** |
| T5 weather + dust + damage | storm cascades and recovers | **IN** |
| T6 procedural world + POIs + drops | explore & recover remote objectives | **PARTIAL** (see open list) |
| T7 research + agriculture + colonists | progression creates meaningful automation | **OUT** |
| T8 optimization + migrations + release UI | devices meet budgets; saves survive upgrades | **PARTIAL** (migrations IN) |

**Open work, ordered the way the code comments and README currently argue:**

1. **Live with the worker default, then delete the in-process fallback** outside
   tests. Gates are already dual-transport. Optional later: true 20 Hz worker
   timer + render interpolation *if* frame-pumped advance measures as a bottleneck;
   transferables / OffscreenCanvas behind their own guards.
2. **GDD P5 / industrial layer** — Refinery + recipes, component manufacturing,
   possibly a second utility network. Builds on logistics reservations + staged
   construction already in.
3. **Finish T6** — survey confidence, expedition planning, narrative logs,
   repairable wrecks into the garage line, ice-cave/lava-tube rules beyond flat salvage.
4. **T7** — research DAG, agriculture depth, multi-colonist.
5. **TDD §22 remainder** — perf counters, hash readout, teleport/reveal.
6. **Persistence upgrade** — IndexedDB (original target) if slot size or quota
   becomes a real limit; service worker offline.

**Ordering conflict with GDD §16:** GDD wants refining (P5) before finishing
exploration (P6); TDD never gave refining its own tier and the project already
shipped a P6 slice. Pick the next pillar explicitly when scheduling.

## 26. Prototype Acceptance Test

A fresh world can (and the test suite / smokes assert the bulk of this):

| Criterion | Status |
|---|---|
| Generate terrain from a seed | **IN** |
| Spawn player + two rovers | **IN** |
| Mine regolith / iron / water ice (also silicon, aluminum) | **IN** |
| Construct habitat, solar, battery, water extractor, oxygen generator, greenhouse, warehouse, workshop, garage | **IN** (+ RTG Array) |
| Connect utilities | **PARTIAL** (power grid; no pipe networks) |
| Run day/night | **IN** |
| Dust storm reduces solar and damages exposed equipment | **IN** |
| Dispatch rovers automatically | **IN** |
| Save, reload, identical state hash | **IN** |
| Discover POIs, salvage, recover a supply drop before burial | **IN** |

Most important criterion, unchanged: simulation remains understandable,
deterministic, recoverable, and performant under pressure from Mars — not visual
fidelity first.

## 27. Engineering Principles

1. Simulation is authoritative; rendering/UI observe it. — **IN** (`SimHost`/`SimView`)
2. Data drives content (buildings/resources/recipes/research/weather params outside core logic). — **IN** for what exists; research still absent
3. Determinism matters (fixed steps, stable ordering, seeded randomness). — **IN**
4. Fail gracefully (recoverable cascading failures over opaque instant loss). — **IN**
5. Optimize from profiling; start simple, measure, then optimize. — **PARTIAL** (no perf HUD yet)
6. Design for mobile from day one (touch, GPU limits, suspension, readability). — **IN** / ongoing

---

## Appendix A — Protocol surface (quick ref)

See `src/sim/host/protocol.ts` for the schema-of-record. Any new player intent
adds a variant there, a decoder field table, an `applyCommand` branch, and a
host test — never a direct `sim.foo()` call from UI.

## Appendix B — What "done" means for the next two slices

**P5 / industrial (Engineering pillar)** is done when:

- At least one refined material (e.g. steel) is produced from ore through a
  building process and is required by a downstream blueprint.
- A component or two (e.g. motor, circuit board) exists as craftable inventory.
- Construction costs can reference refined outputs without breaking v7 saves
  (v8 migration).

**T6 remainder (Exploration pillar)** is done when:

- Site contents are ranges until surveyed; survey is a task or scout action.
- At least one wreck can be recovered into a working rover via the garage line.
- A drop or POI expedition is plan-able (range/battery estimate before dispatch).
- One narrative content hook (log entry / radio) fires on a discovery milestone.
