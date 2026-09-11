# Red Frontier — Game Design Document

Source: Ian Thomas's shared Dropbox (`Red_Frontier_GDD.pdf`, v1.0), realigned to the
live codebase on branch `arena/01a091e4-red-frontier` (package `0.3.0`, README
**Prototype 4** + first exploration slice).

**Tagline:** Mars • 2066 | Real-Time Strategy • Survival • Automation • Exploration
**Design premise:** *One human. A handful of machines. An entire planet that does not want you there.*

---

## 0 — Implementation status (living)

This document is still the **design target**. Section 0 is the honest map of what
the browser build actually does today versus what the later vertical slices still
owe. Status vocabulary:

| Tag | Meaning |
|---|---|
| **IN** | Shipped and gated by tests / playable in the build |
| **PARTIAL** | Present in a reduced form; design depth still open |
| **OUT** | Not in `src/` yet — still a design commitment |

**Where the build sits on the §16 roadmap:** **P1–P4 are IN**, plus the first slice
of **P6** (POIs, SALVAGE, supply drops). **P5** (refining / manufacturing / multi-
utility networks) and **P7–P8** are OUT. TDD §25 **T1–T5** are IN; **T6** is PARTIAL.

| Pillar / system | Status | Notes |
|---|---|---|
| Terrain + orbit camera + day/night | **IN** | Seeded local window on a Mars globe landing site |
| One human colonist + EVA suit O₂ | **IN** | Single crew; skills / multi-colonist OUT |
| Rovers (mining, utility, cargo) | **IN** | Scout kind still OUT |
| Mining, inventory, staged construction | **IN** | Materials Reserved + assembly; full stage names simplified |
| Power grid (solar / battery / RTG / priorities) | **IN** | Pure resolver, tier shedding 0–3 |
| Water → oxygen → food life support | **IN** | Fluids in building tanks; no field-fluid logistics |
| Weather, dust, storms, degradation | **IN** | Devil / regional / severe / planetary + forecast |
| Rover task queue, haul routes, automation rules | **IN** | Garage charge / service / assemble |
| POIs, SALVAGE, Earth supply drops | **PARTIAL** | Discover + strip + bury clock; no survey confidence / narrative logs |
| Refining, manufacturing, component recipes | **OUT** | Ore is stockpiled; no Refinery / smelting chain |
| Water / atmosphere / heat / data / logistics nets | **OUT** | Power is the only utility network |
| Research tech tree | **OUT** | No `research` symbol in `src/` |
| Multi-colonist skills / medicine | **OUT** | Architecture hooks only (one `Colonist`) |
| Nuclear / underground / closed-loop endgame | **OUT** | RTG Array is a small baseload stand-in, not a reactor |
| Desktop + mobile UI, alerts, save/load | **IN** | localStorage slots; autosave |
| Developer mode panel | **IN** | Runtime-only overlays; fabrications save |

**MVP feature set (§16) — scorecard**

| MVP item | Status |
|---|---|
| Procedural local Mars terrain, day/night, basic weather | **IN** |
| One human | **IN** |
| Two rovers (start); three kinds buildable | **IN** (no Scout) |
| Resources: iron, regolith, water (ice), silicon, aluminum | **IN** |
| Buildings: habitat, solar, battery, water extractor, oxygen generator, greenhouse, storage, workshop | **IN** (+ garage, RTG Array beyond MVP) |
| Sim: mining, construction, electricity, water, oxygen, food | **IN** |
| Environment: dust accumulation, dust storm, wind damage | **IN** |
| UI: responsive desktop + mobile | **IN** |
| Persistence: local save/load | **IN** (localStorage, versioned v3→v7) |

**Deliberate design locks already enforced in code** (do not "fix" without a design change):

- Bulk solids ride rovers; **fluids never do**. Supply drops contain no water/food cargo.
- Storage is **per-resource**, not one shared pool.
- Soft failure: rovers strand and get jump-started; most disasters are recoverable.
- Developer-mode *modifiers* never enter the save; *fabricated objects* do.

---

## 01 — Executive Summary & Design Pillars

- Genre: RTS / survival / automation / exploration
- Platform: modern desktop + mobile web browsers
- Setting: Mars, 2066
- Perspective: 3D isometric / freely rotatable 3/4 camera — **IN** (orbit rig)
- Single-player at launch — **IN** (multiplayer still out of scope)
- Player = humanity's first long-duration Mars colonist, with autonomous rovers and constrained inventory.
- Central fantasy: engineering — take a fragile outpost and turn it into a resilient, self-sustaining civilization (not empire building).
- Pillars: **Survival**, **Engineering**, **Automation**, **Exploration**.
- Core loop: Explore → Survey → Extract → Process → Build → Maintain → Automate → Expand → Explore farther.
  - **IN today:** Explore (partial) → Extract → Build → Maintain → Automate.
  - **OUT today:** Survey confidence, Process/refine, Expand beyond one human / one claim window.

## 02 — Core Gameplay & Simulation Systems

- Interacting systems; failure propagates (emergent stories). — **PARTIAL** (power ↔ weather ↔ life support ↔ rover work; full industrial cascade waits on P5)
- Dependency chain: Weather → Solar/Terrain/Damage → Power/Mining/Maintenance → Life Support/Industry → Food/Population → Labor → Automation → Expansion.
- Time: Martian sols (≈24h 39m 35s). Pause, 1×, 2×, 4× speed. Fixed timestep independent of rendering. — **IN** (`SIM_TICK` 20 Hz; sol = 240 game seconds at 1×)
- Survival systems:
  - Electricity (network w/ gen/storage/loads/priorities/failures) — **IN**
  - Water (extract/store/…/recycle) — **PARTIAL** (extract → tank → consume/recycle in habitat; no multi-node water pipe network)
  - Oxygen — **PARTIAL** (tank resource + pressurized flag; no per-volume atmosphere sim / breach propagation)
  - Food (controlled agriculture) — **PARTIAL** (single greenhouse process; no crop varieties)
  - Temperature, radiation — **OUT**
  - Maintenance / component wear — **PARTIAL** (building health + cleanliness + rover drivetrain; no part-level inventory)

Cascading failure example (dust storm → solar drops → batteries drain → …) — **IN** for the power and exposure path; irrigation stoppage follows if the extractor browns out.

## 03 — Resources & Industrial Economy

**Bulk resources (rover cargo) — IN**

| Id | Role |
|---|---|
| Regolith | construction / shielding |
| Iron ore | structures / machinery (smelting still OUT) |
| Aluminum ore | frames / trusses (smelting still OUT) |
| Silica | glass / silicon feedstock (refining still OUT) |
| Water ice | bridge into the fluid economy via Water Extractor |

GDD-original extras (Magnesium, Sulfur, carbon-bearing, rare minerals) — **OUT**.

**Fluids (building tanks only) — IN:** water, oxygen, food.

**Refined materials & industrial components** (steel, glass, pipes, boards, …) — **OUT**.
Ore the rovers haul is stockpiled and spent as construction cost directly. The
replication chain *Iron deposit → mine → crush → smelt → steel → components →
build* has no middle yet — that is **P5**.

## 04 — Buildings & Infrastructure

Buildings are functional machines: construction cost, power interfaces, operating
loads, wear, failure modes, maintenance. — **PARTIAL** (power + process + exposure + health/dirt; no multi-utility ports)

| Building | Power (draw / gen) | Status | Function in build |
|---|---|---|---|
| Emergency / Habitat | 5 kW draw | **IN** | pressurized shelter, 55% water reclaim, fluid tanks |
| Solar Array | 0 / 28 kW peak | **IN** | sun-tracking generation |
| Battery Bank | 0.2 kW idle / 200 kWh | **IN** | energy storage |
| Water Extractor | 18 kW | **IN** | ice → water |
| Oxygen Generator | 12 kW | **IN** | water → O₂ |
| Greenhouse | 8 kW | **IN** | water + light → food |
| Warehouse | 1 kW | **IN** | +600 kg per bulk resource |
| Workshop | 5 kW | **IN** | repair / nearby build speed (light role) |
| Rover Garage | 3 kW | **IN** (beyond original table) | 2× charge, drivetrain service, assemble rovers |
| RTG Array | 0 / 5 kW baseload | **IN** (stand-in) | storm-proof trickle power |
| Refinery | 35 kW | **OUT** | material processing |
| Laboratory | 10 kW | **OUT** | research |
| Repair Bay | 8 kW | **OUT** | advanced maintenance |
| Nuclear Reactor | variable | **OUT** | base-load power |

Landing pod (not a blueprint): 14 kW RTG, 90 kWh battery, starter warehouse + life support — **IN**.

Utility networks: Power **IN**; Water / Atmosphere / Waste / Data / Logistics pipe networks **OUT**.
Infrastructure overlays toggleable — **PARTIAL** (`none` / `power` / `life` / `weather`).

## 05 — Rovers & Automation

| Rover | Cargo | Battery | Status | Role in build |
|---|---|---|---|---|
| Scout | 100 kg | 20 kWh | **OUT** | exploration / mapping |
| Utility | 500 kg | 40 kWh | **IN** | general work / build |
| Mining | 1,500 kg | 80 kWh | **IN** | drilling / extraction |
| Cargo | 3,000 kg | 120 kWh | **IN** | long-haul logistics |

Task system — **IN** (first-class, queueable, some repeatable):

| Task | Status |
|---|---|
| MOVE, MINE, UNLOAD, WAIT | **IN** |
| BUILD (construct), REPAIR, CLEAN | **IN** |
| RECOVER (jump-start stranded) | **IN** |
| SALVAGE | **IN** |
| CHARGE | **IN** (implicit park-at-charger / garage behaviour + charge-floor rule) |
| HAUL | **IN** as repeating mine route + auto-haul rule |
| SCOUT | **OUT** |
| RETURN | **PARTIAL** (charge-floor / storm-shelter recalls) |

Automation rules (player-authored per rover) — **IN:** auto-haul, auto maintenance (repair/clean), storm sheltering, auto-rescue, charge floor 10–60%. Deposit reservations spread the fleet. Explicit player orders always win.

Rover failure: drivetrain wear (soft slowdown), battery-flat strand + yellow strobe, jump-start recovery — **IN**. Wheel/motor/sensor part failures as distinct systems — **OUT**.

## 06 — Mars World Generation & Exploration

Large local region around landing site — **IN** as a seeded playable square
(`worldHalf` from difficulty sizes; default-scale ~640 m half-extent), not a
whole-planet streamer. Landing site is picked on a compact Mars globe
(biomes, MOLA-scale elevation) before the local window is generated.

| Terrain idea | Status |
|---|---|
| Flat / rocky plains, craters, canyons, dunes-ish local geology | **PARTIAL** via globe biome + local height/slope/material |
| Ice field / lava tube as special rules | **PARTIAL** (ice-cave POI is salvage + water-ish scrap, not a ruleset) |
| Chunk streaming | **OUT** (fixed window; terrain is a pure function of seed) |

Procedural deposits (size/concentration) — **IN**. Survey confidence — **OUT** (amounts are exact once found).

POIs — **PARTIAL**:

| Kind | In build | Behaviour today |
|---|---|---|
| Wrecked rover | yes | salvage scrap (not repairable back into fleet) |
| Abandoned mission | yes | salvage |
| Meteorite | yes | salvage (iron-heavy) |
| Ice cave | yes | salvage |
| Science cache | yes | salvage |
| Settlement site | yes | marker only — nothing to haul |
| Supply drop | yes | scheduled Earth cargo, 3-sol burial clock (×3 in storm) |

Philosophy holds: map begins mostly unknown; sites appear within ~55 m discovery radius; nothing inside ~150 m of the pad.

## 07 — Weather, Climate & Environmental Hazards

| Event | Status |
|---|---|
| Dust devil | **IN** |
| Regional storm | **IN** |
| Severe storm | **IN** |
| Planetary dust event | **IN** |

Weather variables in sim: wind, dust density, solar irradiance (via dust transmission + sun), visibility, storm intensity — **IN**. Atmospheric pressure / radiation / SPE as gameplay — **OUT**.

Forecasting with lead time — **IN** (noisy schedule + HUD forecast). Sensors/research reducing uncertainty — **OUT**.

Storm prep levers that work today: charge batteries, shelter rovers (auto rule), clean arrays, power priorities. — **IN**

## 08 — Agriculture, Life Support & Population

- Atmosphere: pressurized flag on habitat/greenhouse/pod; colonist must be indoors to live long-term. Full volume gas mix / breach cascade — **OUT**.
- Water loop: ice haul → extractor → tanks → habitation/agriculture → habitat reclaim (~55%). Multi-stage purification / wastewater pools — **OUT**.
- Food loop: greenhouse process (water + light → food); colonist consumes per sol. Crop varieties / nutrients — **OUT**.
- Population: **exactly one human**. Further colonists — **OUT**.
- Skills ladder — **OUT**.
- Suit O₂ on EVA with fatal-path refusal — **IN**.

## 09 — Research & Progression

Entire section — **OUT**. No laboratories, no tech DAG, no unlock gates beyond "can you afford and power it". Progression today is *spatial and logistical*: more power, more storage, more rovers, farther POIs.

When P7 lands, tiers 1–6 in the original GDD remain the target arc:
Survival → Industrialization → Automation → Advanced colony → Independence → Endgame.

## 10 — Supply Drops, Earth & Narrative

- Cargo missions with uncertain landing, transponder, burial pressure — **IN**
  (first drop 2–4 sols, then every 5–9; 30–85% of the way to the claim edge; 3-sol burial clock, storm-accelerated).
- Cargo types in build: battery cells, replacement parts, specialised machinery, scientific equipment (bulk + cells). No fluids.
- Earth comms delay / request board — **OUT**.
- Narrative layer (logs, radio, milestone stories) — **OUT** (alerts + event log only).

## 11 — UI/UX & Accessibility

- Desktop: left select, right context, drag pan/rotate, wheel zoom, hotkeys — **IN**
- Mobile: tap select, long-press context, pinch zoom, two-finger pan — **IN**
- Alerts: Critical / Warning / Information / Opportunity — **IN** (condition bus ≠ event log)
- Accessibility (scalable text, high-contrast, reduced motion, 44px targets) — **PARTIAL** (pause-friendly, touch targets, icon+text alerts; full a11y pass still open)
- Mission wizard (difficulty, world size, landing site on globe) — **IN**
- Main menu / load game / build palette / inspectors / fleet / garage UI — **IN**

## 12 — Visual, Audio & Presentation

- Visual: stylized Mars, three.js WebGL2 renderer, day/night sky, dust haze, particles (wind, grit, devils, rover trails), sun-tracking panels — **IN**
- WebGPU primary path — **OUT** (TDD still lists it as future)
- Camera: rotatable 3/4, zoom, follow selection — **IN**; bookmarks — **OUT**
- Audio (sparse exterior / machine interior / restrained music) — **OUT** (no `audio/` module)

## 13 — Victory, Failure & Difficulty

- Primary victory / multi-path victories — **OUT** (no victory checker)
- Failure: final human dies — **IN** (`gameOver`). Other hard-loss conditions (no habitat, permanent water loss, …) — **PARTIAL** / mostly soft via the life-support cascade.
- Soft failure philosophy — **IN**
- Difficulty — **IN** as presets (**Settler / Pioneer / Survivor**) plus advanced world options (storm/supply multipliers, world size). Independently configurable axes match the GDD intent.

## 14 — Browser Technical Architecture

See **TDD** for the living technical picture. Short version vs original GDD §14:

| Layer | Original target | Current |
|---|---|---|
| UI | DOM/CSS | **IN** (`src/ui`) |
| Renderer | WebGPU + WebGL2 fallback | **WebGL2 via three.js** (no WebGPU yet) |
| Simulation | Worker | **Worker default** + in-process fallback (`?worker=0`) |
| World | streaming chunks | **Fixed seeded window** + globe landing |
| Persistence | IndexedDB | **localStorage** versioned snapshots |
| Audio | Web Audio | **OUT** |

## 15 — Performance, Persistence & Scalability

- World streaming / sim LOD tiers — **OUT** (world is small enough to sim entire)
- Target entity scale (thousands) — not yet stressed; soak covers ~20 sols of a starter colony
- Persistence: auto + manual slots, import-friendly versioned JSON — **IN**; cloud — **OUT**
- Developer mode — **IN** (see TDD §22): runtime-only modifiers; fabrications are real

## 16 — Development Roadmap & MVP

Vertical slices and current state:

| Slice | Theme | Status |
|---|---|---|
| **P1** | terrain / camera / human / rover / resources / mining / inventory / construction | **IN** |
| **P2** | power / batteries / O₂ / water / food / day-night | **IN** |
| **P3** | wind / dust / storms / degradation | **IN** |
| **P4** | rover tasks / automation / logistics / charging / mining routes / garage | **IN** |
| **P5** | refining / manufacturing / utility networks / maintenance depth | **OUT** — next Engineering pillar |
| **P6** | procedural exploration / supply drops / salvage / expeditions | **PARTIAL** — discover/salvage/drops IN; survey, narrative, repairable wrecks, multi-site expeditions OUT |
| **P7** | colonists / skills / agriculture depth / medicine | **OUT** |
| **P8** | nuclear / underground / advanced robotics / closed-loop | **OUT** |

**Ordering note (unchanged conflict with TDD §25):** GDD puts refining at P5 and
exploration at P6; TDD folds POIs into T6 and never gives refining its own tier.
The live project took **P4 → first P6 slice** before P5. Choosing the next pillar
— **Engineering (P5)** vs finishing **Exploration (P6)** — is still an open
product call, not something the documents decided.

## 17 — Design Principles & Final Direction

Still the north star:

- Every major gameplay system should interact with ≥2 other systems.
- Research solves encountered problems; disasters create recoverable emergencies; UI exposes the simulation; automation shifts the player from operator to systems architect.
- End-state fantasy: zoom out from one person / two rovers / a few crates → solar fields, mines, greenhouses, habitats, underground facilities, autonomous logistics, resilient life support. Payoff: *"I built that."*

What the current build already delivers of that fantasy: one person, a growing
rover fleet, a powered life-support chain that can fail in bad weather, and a
planet with wrecks and Earth drops worth leaving the pad for.
