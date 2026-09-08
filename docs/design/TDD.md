# Red Frontier — Technical Design Document (reference)

Source: Ian Thomas's shared Dropbox (`Red_Frontier_TDD.pdf`, v1.0). Captured as working reference.

## 1. Purpose & Technical Goals

Translates GDD into an implementable architecture: simulation ownership, data structures, update order, utility networks, AI/task scheduling, procedural terrain, weather, persistence, rendering, input, testing, profiling, deployment.

Goals: deterministic & testable simulation; smooth desktop/mobile; scalable entity counts; save/load without renderer state; graceful degradation; clear separation of simulation / rendering / UI / persistence.

**Recommended stack:** TypeScript (client + simulation), WebGPU primary renderer + WebGL2 fallback, Web Workers for simulation isolation, IndexedDB local saves, future Java authoritative server (out of scope for single-player). Java viable for backend but TypeScript best fit for browser (shares types with UI/Web APIs).

## 2. Architecture Overview

| Layer | Responsibility | Runtime |
|---|---|---|
| UI | HUD, menus, build palette, alerts, accessibility | Main thread DOM/CSS |
| Input | desktop/mobile gesture normalization | Main thread |
| Renderer | camera, terrain, entities, effects, overlays | WebGPU / WebGL2 |
| Simulation | world state, economy, AI, weather, utilities | Dedicated Worker |
| World | chunk generation, streaming, POIs, deposits | Worker + cached data |
| Persistence | versioned snapshots, migrations, import/export | IndexedDB + optional cloud |
| Audio | music, ambience, alerts, machinery | Web Audio |

Renderer never owns authoritative state — consumes snapshots/interpolated data. UI sends commands, receives state/events.
Main-thread rule: never run pathfinding, large logistics, weather grids, mass entity updates synchronously on UI thread. Worker rule: no DOM; platform-neutral APIs.

## 3. Project / Module Layout

```
src/
  app/        bootstrap, config, lifecycle
  sim/        fixed-step simulation
  sim/ecs/    entities, components, systems
  sim/world/  chunks, terrain, deposits, POIs
  sim/utilities/ power, water, oxygen, heat, logistics
  sim/ai/     rover tasks, colonist jobs, pathfinding
  sim/weather/ atmosphere, storms, degradation
  sim/research/ tech tree, unlocks
  sim/save/   serialization, migrations
  render/     WebGPU + WebGL2 fallback
  ui/         HUD, panels, build tools, alerts
  input/      pointer, touch, keyboard, camera gestures
  audio/      sound event routing
  shared/     schemas, IDs, math, protocol messages
  tests/      unit, integration, determinism, performance
```

Prefer pure functions for formulas/state transitions; side effects at system boundaries; stable numeric IDs in serialized state (not object refs).

## 4. Simulation Clock & Determinism

- Fixed step 50 ms = 20 Hz. Render interpolates between sim snapshots.
- Speed modes multiply sim steps per rendered frame: Paused 0, 1× = 20 Hz, 2× = 40 Hz, 4× = 80 Hz.
- Tick order: (1) clock/day-night, (2) weather, (3) resource production/consumption, (4) utility networks, (5) maintenance/degradation, (6) jobs/tasks, (7) movement/pathfinding, (8) construction/repair, (9) research/population, (10) victory/failure checks, (11) event emission, (12) snapshot publication.
- Determinism: fixed seed, integer tick counter, stable entity iteration order, per-subsystem deterministic RNG streams, no wall-clock dependence.

## 5. ECS & Core Data Model

Components: Transform(x,y,z,rotation,chunkId), Health(current,max,failureState), Inventory(slots,mass,capacity), PowerConsumer(idleW,activeW,priority,enabled), PowerProducer(maxW,outputCurve), Storage(resourceType,amount,capacity), TaskController(queue,currentTask,state), Maintenance(wear,serviceInterval,partsCost), NetworkNode(power/water/atmo/data/logistics IDs), ResearchNode(unlocked,progress), Colonist(skills,needs,health,role).

Entities built from data-driven blueprints: footprint, costs, utility ports, power behavior, production recipes, maintenance profile, construction stages, visual asset IDs.

## 6. Resource Accounting & Utility Networks

Resource rule: nothing appears from nowhere except configured production nodes; record inputs/outputs/efficiency/waste/storage destinations.
Power: producers → batteries → consumers; generation/battery charge-discharge/consumer priority tiers 0–3/brownout.
Water: extraction → purification → storage → habitat/greenhouse → wastewater → reclamation; potable/process/wastewater pools separate.
Atmosphere: sealed volume = pressure, O2, CO2, temperature, humidity, leakage rate, scrubber capacity; breaches propagate.
Heat: buildings generate waste heat; radiators remove heat by ambient temp + condition; overheating → efficiency loss / component damage.
Logistics: storage nodes expose supply/demand; haulers reserve cargo, travel, load/unload, release reservations; reservation timeouts avoid deadlocks.

## 7. Buildings & Construction

Staged state machine: Planned → Materials Reserved → Foundation → Assembly → Commissioning → Online. Damage → Degraded/Offline. Materials consumed only when the stage completes.
Blueprint contains: ID, footprint, build cost/time, allowed terrain, utility ports, power draw/production, storage, recipe/process definitions, maintenance parts, failure modes, research prerequisite.
Placement validation: terrain slope, overlap, utility reach, clearance, foundation, special constraints (underground access, greenhouse orientation).

## 8. Rover Architecture

| Rover | Role | Core systems |
|---|---|---|
| Scout | explore/survey | camera/sensors, mapping, light cargo |
| Utility | build/repair/clean | tool arm, repair kit, cleaning kit |
| Mining | extract | drill, hopper, sample scanner |
| Cargo | haul | large storage, tow interface |

Task states: Idle, AcquireTask, Navigate, Work, Load, Unload, Return, Charge, Repair, Disabled. Reservations prevent two rovers consuming same target.
Priority: critical survival > storm shelter > repair life-support > charging > production logistics > exploration. Battery + storm thresholds interrupt any non-critical task.

## 9. Pathfinding & Navigation

Hierarchical grid nav: chunk coarse walkable grid + fine cells near active entities. A* / Jump Point Search on static terrain + dynamic obstacle costs. Buildings update obstacle occupancy.
Long-distance: chunk-level A* → local refinement. Repath on blocked route/terrain change/timeout. Cache by start/end chunk; invalidate regions only.
Deterministic: fixed tick integration, bounded acceleration, deterministic tie-breaking.

## 10. World Generation & Streaming

Chunks recommended 128 m × 128 m. Each chunk stores terrain height, slope, material tags, resource deposits, POIs, navigation data, decoration seed.
Pipeline: seed → macro biome noise → height/slope → erosion modifiers → material layers → deposits → POIs → nav grid → decoration seed.
Persist only player-mutated chunk state; regenerate decoration deterministically. Streaming adaptive; larger lightweight sim radius than high-detail render radius.

## 11. Weather Simulation

Low-res regional weather field sampled by chunks. State: wind speed/direction, dust density, temperature, solar irradiance, visibility, storm intensity. Update at 1–5 min sim intervals, interpolate between. Deterministic seeded perturbations + pressure/temp gradients (not per-particle).
Solar output = baseIrradiance × sunAngle × dustTransmission × panelCleanliness. Wind damage = accumulated exposure above threshold. Dust accumulates with wind+dust density, decreases with cleaning.
Storm classes: dust devil (local), regional (multi-chunk), severe (large region), planetary (rare campaign-level). Forecast noisy; sensors/research reduce uncertainty.

## 12. Day/Night & Solar Cycle

Mars sol clock. Sun elevation from latitude, seasonal angle, sol fraction. Renderer uses same authoritative sun as simulation (single source). Solar depends on sun elevation, orientation, dust transmission, panel health, temperature; night disables solar except battery/storage/other.

## 13. Research & Progression

Research nodes data-driven DAG; each defines prerequisites, cost, time, unlocks, modifiers. Produced by labs + discoveries.
Tiers: 1 Survival (habitat, water extraction, basic solar, greenhouse); 2 Industrialization (refinery, steel, glass, improved storage); 3 Automation (rover scheduling, logistics, advanced sensors); 4 Advanced Colony (nuclear, underground, advanced agriculture); 5 Independence (closed-loop, advanced mfg); 6 Endgame (terraforming/science megaprojects).

## 14. Colonists & Life Support

Colonists optional in earliest prototype but architecture must support. Needs/skills/health/role/job. Job scoring = priority, distance, skill, fatigue, survival urgency. Critical life-support checks precede lower-priority work; unsafe states → alerts + emergency jobs.

## 15. Save Format & Persistence

Versioned JSON snapshot envelope: {version, worldSeed, tick, calendar, playerState, entities, chunks, research, weatherState, eventLog, rngState}. Compress for IndexedDB. Save at checkpoints, pause/background transitions, milestones, configurable autosave. Never every frame. Atomic slot writes: temp snapshot → checksum → commit metadata. Migrations convert old versions; validate bounds/enums on import.

## 16. Worker Protocol

Typed command/event messages. Commands = player intent: BuildPlace{blueprintId,position,rotation}, SetRoverTask{entityId,task}, MoveCameraTarget{x,z}, SetSpeed{multiplier}, ResearchStart{nodeId}. Events = sim facts: EntityChanged, AlertRaised{severity,type,entityId}, ChunkReady{chunkId,data}, ConstructionProgress{entityId,stage,progress}, SaveCompleted{slotId,checksum}. Use transferable typed arrays/SAB only when justified; start with message passing + batched snapshots.

## 17. Rendering Architecture

WebGPU primary. Terrain chunk meshes; instanced vegetation/rocks; batched building/rover meshes; texture atlases/material IDs to cut draw calls. Passes: shadow/depth → opaque terrain/buildings → transparent effects → atmosphere/dust → UI overlays. LOD by distance/screen size; limit dynamic shadows on mobile. Style: stylized modern Mars, clean silhouettes, moderately low-poly, PBR, strong readability.

## 18. UI/UX Implementation

DOM/CSS for menus + info-heavy panels; lightweight canvas/WebGPU overlay for selection outlines, range indicators, construction previews, world markers.
Input map: Select=left click/tap; Context=right click / tap terrain-action; Camera=middle drag+wheel / two-finger pan-pinch-rotate; Multi-select=drag box; Command menu=hotkeys/long-press. Touch targets ≥44 CSS px; every critical alert has icon+text; pause-friendly; bigger destructive-action confirmations on mobile.

## 19. Alerts & Event System

Centralized event bus, typed event IDs; alerts derived from events, dedup/coalesce. Severity: Critical/Warning/Info/Opportunity. Examples: PowerGridBrownout, OxygenLow, WaterReserveLow, StormApproaching, SupplyDropDetected, RoverDisabled, SolarOutputReduced, BuildingDamaged, ResearchComplete, ColonyMilestone. Events serializable when they affect state.

## 20. Performance Budgets

Simulation: 20 Hz tick, <50 ms worst-case headroom. Frame rate 60 FPS desktop / 30 mobile. Draw calls <1,000 typical, batch static. Memory adaptive (unload distant render assets first). Save <1–2 s user-visible. Sim LOD: full near active; simplified distant; statistical for safe systems. Never simplify life-support/resource accounting in a way that changes player-visible totals without explicit rules.

## 21. Testing Strategy

Unit: formulas, recipes, utility allocation, weather damage, pathfinding heuristics, save migration.
Integration: build→power→production→storage; storm→solar loss→battery discharge→brownout; rover mine→load→haul→unload; greenhouse→water→food.
Determinism: same seed+commands → identical authoritative state hashes.
Load: thousands of entities, large utility graphs, many rovers, long sims.
Browser matrix: Chromium/Safari/Firefox; desktop + iOS/iPadOS + Android; WebGPU + WebGL2 fallback.

## 22. Debugging & Developer Tools

Dev overlay (disabled in release): tick time, render time, entity count, active chunks, worker queue size, memory, utility-network status, weather values, selected entity components, deterministic state hash.
Cheat commands (explicit, excluded from save-compat tests): spawn resource, damage building, trigger storm, teleport rover, reveal chunk, advance sol, set research, refill storage, force brownout, export state.

## 23. Browser Deployment

Static web app, hashed assets. Service Worker caching → offline after first load. IndexedDB saves. WebGPU detection at startup → WebGL2 fallback → compatibility screen if neither. Save on visibility changes/before suspension. Optional future Java backend for account/cloud saves, telemetry, content manifests, multiplayer authority (browser remains capable of full single-player sim).

## 24. Security & Data Validation

Treat imported/cloud saves and future multiplayer packets as untrusted. Validate lengths, numeric ranges, IDs, enum values, chunk coords, referenced entities. Never execute code from save data. Signed/integrity-checked content manifests in future online deployments.

## 25. Implementation Roadmap

- T1 Worker + fixed tick + camera + terrain chunk. Exit: stable 20 Hz sim, smooth camera.
- T2 ECS + resources + buildings + construction. Exit: build and account for materials deterministically.
- T3 Power/water/oxygen + day/night. Exit: life-support loop survives normal day/night.
- T4 Rovers + navigation + tasks. Exit: two rovers mine, haul, charge, recover.
- T5 Weather + dust + damage. Exit: storm creates cascading but recoverable failure.
- T6 Procedural world + POIs + supply drops. Exit: explore and recover remote objectives.
- T7 Research + agriculture + colonists. Exit: progression creates meaningful automation.
- T8 Optimization + save migrations + release UI. Exit: target devices meet budgets, saves survive upgrades.

## 26. Prototype Acceptance Test

A fresh world can: generate terrain from a seed; spawn player + two rovers; mine regolith/iron/water; construct habitat, solar, battery, water extractor, oxygen generator, greenhouse, warehouse, workshop, garage; connect utilities; run day/night; experience a dust storm that reduces solar and damages exposed equipment; dispatch rovers automatically; save, reload, produce identical state hash.
Most important criterion: simulation remains understandable, deterministic, recoverable, performant under pressure from Mars (not visual fidelity).

## 27. Engineering Principles

1. Simulation is authoritative; rendering/UI observe it.
2. Data drives content (buildings/resources/recipes/research/weather params outside core logic).
3. Determinism matters (fixed steps, stable ordering, seeded randomness).
4. Fail gracefully (recoverable cascading failures over opaque instant loss).
5. Optimize from profiling; start simple, measure, then optimize.
6. Design for mobile from day one (touch, GPU limits, suspension, readability).
