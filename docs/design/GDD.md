# Red Frontier — Game Design Document

Source: Ian Thomas's shared Dropbox (`Red_Frontier_GDD.pdf`, v1.0), realigned to the
live codebase on branch `arena/01a0bc5e-red-frontier` (package `0.3.0`, README
**Prototype 4** + first exploration slice).

**Last realignment: 2026-09-20**, swept against a tree at `SAVE_VERSION = 8` with
**76 test suites / 866 checks** green and refactor-roadmap **Phases 0–30 complete**.
New since the previous pass, and now reflected below: the procedural **audio**
soundscape (§12), **lightning** as a storm hazard and **weather as a spatial
field** (§07), the **minimap + zoomable world map** (§11), rover **proximity
crawling** (§05), MOLA-relief terrain that follows every world size (§06), the
Weather Radar Station as an eleventh blueprint (§04), and the profiling /
benchmark / replay harness that turned TDD §20's budgets into tests (§15).

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
of **P6** (POIs, SALVAGE, supply drops) and **both shipped slices of P5** —
refining (the Refinery, `steel`, heavy blueprints priced in it) and manufacturing
(the Workshop's two selectable lines, a counted component rack, and rovers priced
in motors and boards as well as metal). What is left of **P5** is multi-utility
networks and maintenance depth; **P7–P8** are OUT. TDD §25 **T1–T5** are IN;
**T6** is PARTIAL; **T8** is PARTIAL but no longer unmeasured — save migrations
v3→v10 are IN and the performance budgets are now enforced by a regression
suite.

| Pillar / system | Status | Notes |
|---|---|---|
| Terrain + orbit camera + day/night | **IN** | Seeded local window on a Mars globe landing site; MOLA-derived relief prior |
| One human colonist + EVA suit O₂ | **IN** | Single crew; skills / multi-colonist OUT |
| Rovers (mining, utility, cargo) | **IN** | Scout kind still OUT |
| Rover proximity awareness | **IN** | Hull-clearance crawl near obstacles; no collision physics, no re-pathing |
| Mining, inventory, staged construction | **IN** | Materials Reserved + assembly; full stage names simplified |
| Power grid (solar / battery / RTG / priorities) | **IN** | Pure resolver, tier shedding 0–3 |
| Water → oxygen → food life support | **IN** | Fluids in building tanks; no field-fluid logistics |
| Weather, dust, storms, degradation | **IN** | Devil / regional / severe / planetary + forecast, sampled per entity |
| Lightning (electrostatic discharge) | **IN** | Dust-gated strike hazard: damages structures, rovers, an EVA crew |
| Weather Radar Station | **IN** | 520 km scope, storm cells + tracks on the world map, 2.25× forecast lead |
| Rover task queue, haul routes, automation rules | **IN** | Garage charge (32 kW) / service / assemble |
| POIs, SALVAGE, Earth supply drops | **PARTIAL** | Discover + strip + bury clock; no survey confidence / narrative logs |
| Minimap + zoomable world map | **IN** | Canvas chrome over the read model; closes without moving the camera |
| Audio (procedural soundscape) | **IN** | Web Audio, synthesised in-browser, no fetched assets; presentation only |
| Refining (ore → steel) | **IN** | Refinery: 2.6 kg iron ore → 1.6 kg steel / Mars hour at 35 kW; steel gates the garage + radar station |
| Manufacturing, component recipes | **IN** (P5 slice 2) | Workshop runs motors *or* boards; counted rack; rovers cost parts as well as metal |
| Water / atmosphere / heat / data / logistics nets | **OUT** | Power is the only utility network |
| Research tech tree | **OUT** | No `research` symbol in `src/` |
| Multi-colonist skills / medicine | **OUT** | Architecture hooks only (one `Colonist`) |
| Nuclear / underground / closed-loop endgame | **OUT** | RTG Array is a small baseload stand-in, not a reactor |
| Desktop + mobile UI, alerts, save/load | **IN** | localStorage slots; configurable autosave; in-play update card |
| Developer mode panel | **IN** | Runtime-only overlays; fabrications save |
| Profiling / benchmarking / replay harness | **IN** | Dev-only counters, fleet benchmarks, canonical transcripts, state hash |

**MVP feature set (§16) — scorecard**

| MVP item | Status |
|---|---|
| Procedural local Mars terrain, day/night, basic weather | **IN** |
| One human | **IN** |
| Two rovers (start); three kinds buildable | **IN** (no Scout) |
| Resources: iron, regolith, water (ice), silicon, aluminum | **IN** (+ steel, refined from iron ore) |
| Buildings: habitat, solar, battery, water extractor, oxygen generator, greenhouse, storage, workshop | **IN** (+ garage, RTG Array, Weather Radar Station, Refinery beyond MVP) |
| Sim: mining, construction, electricity, water, oxygen, food | **IN** |
| Environment: dust accumulation, dust storm, wind damage | **IN** (+ lightning) |
| UI: responsive desktop + mobile | **IN** |
| Persistence: local save/load | **IN** (localStorage, versioned v3→v10) |

**Deliberate design locks already enforced in code** (do not "fix" without a design change):

- Bulk solids ride rovers; **fluids never do**. Supply drops contain no water/food cargo.
- Storage is **per-resource**, not one shared pool.
- **One bulk ledger.** Refined material (`steel`) is a `ResourceId` on the same
  ledger as ore — hauled, siloed, reserved and spent by the same code — not a
  parallel inventory. The only difference is `origin`: a *mined* resource has
  seams on the planet, a *refined* one is made by a building process and can
  never be scattered, mined or surveyed in.
- **A process earns its output.** What a line produces in a tick is bounded by
  the input that actually arrived, so two furnaces on one ore pile split the ore
  instead of both smelting a full rate.
- Soft failure: rovers strand and get jump-started; most disasters are recoverable.
  Lightning follows the same rule — a bolt bruises and can trip a structure offline,
  it does not delete the colony.
- Developer-mode *modifiers* never enter the save; *fabricated objects* do.
- **Audio and particles are presentation.** They read the sim and never write it,
  and they animate on *sim time*, so a paused colony freezes its FX but keeps its
  ambience. A save/replay stays byte-for-byte deterministic with the sound on.
- **Lightning has its own seeded RNG stream** (`weather.lightningRoll`), so strikes
  never perturb the weather rolls — and a forced dev strike never moves the sky.


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

- Interacting systems; failure propagates (emergent stories). — **PARTIAL** (power ↔ weather ↔ life support ↔ rover work ↔ refining ↔ manufacturing: a stalled line, a full rack and a garage short of motors all propagate; part-level *wear* still waits on maintenance depth)
- Dependency chain: Weather → Solar/Terrain/Damage → Power/Mining/Maintenance → Life Support/Industry → Food/Population → Labor → Automation → Expansion.
- Time: Martian sols (≈24h 39m 35s). Pause, 1×, 2×, 4× speed. Fixed timestep independent of rendering. — **IN** (`SIM_TICK` 20 Hz; sol = 240 game seconds at 1×)
- Survival systems:
  - Electricity (network w/ gen/storage/loads/priorities/failures) — **IN**
  - Water (extract/store/…/recycle) — **PARTIAL** (extract → tank → consume/recycle in habitat; no multi-node water pipe network)
  - Oxygen — **PARTIAL** (tank resource + pressurized flag; no per-volume atmosphere sim / breach propagation)
  - Food (controlled agriculture) — **PARTIAL** (single greenhouse process; no crop varieties)
  - Temperature, radiation — **OUT**
  - Electrostatic discharge (lightning) — **IN** as a storm hazard (see §07)
  - Maintenance / component wear — **PARTIAL** (building health + cleanliness + rover drivetrain; components are now crafted and spent, but nothing wears one out yet — part-level replacement waits on maintenance depth)

Cascading failure example (dust storm → solar drops → batteries drain → …) — **IN** for the power and exposure path; irrigation stoppage follows if the extractor browns out. A storm now also brings **bolts**: the same dust that dims the panels is what electrifies the sky, so the cascade has a second, sharper edge.

## 03 — Resources & Industrial Economy

**Bulk resources (rover cargo) — IN**

| Id | Role |
|---|---|
| Regolith | construction / shielding |
| Iron ore | structures / machinery, and the feedstock for steel |
| Aluminum ore | frames / trusses (smelting still OUT) |
| Silica | glass / silicon feedstock (refining still OUT) |
| Water ice | bridge into the fluid economy via Water Extractor |
| **Steel** *(refined)* | heavy structures — made by the Refinery, never dug |

GDD-original extras (Magnesium, Sulfur, carbon-bearing, rare minerals) — **OUT**.

**Fluids (building tanks only) — IN:** water, oxygen, food.

**Refined materials — PARTIAL.** `steel` is **IN**: the Refinery smelts 2.6 kg of
iron ore into 1.6 kg of steel per Mars hour for 35 kW (tier 2 — industry is shed
before life support, so smelting is a power *decision*, not a free tap). Steel
sits on the bulk ledger beside the ores, with one difference: it has no seam, so
the only way to own it is to make it. `glass` and the rest are **OUT** — a
building runs one process today, so a second refined output would need recipe
selection first.

**Industrial components** (motors, circuit boards, pipes, …) — **PARTIAL** (P5
slice 2). Drive motors and circuit boards are **IN**: the Workshop runs one of two
player-selected lines and racks what it finishes. Pipes, valves and the rest of
the parts catalogue are still OUT — they belong to the utility-network slice,
which has no networks to serve yet.

The replication chain *Iron deposit → mine → crush → smelt → steel → components →
build* is now complete end to end: ore is smelted into steel, steel and silica are
machined into motors and boards, and a rover leaving the garage has spent both.
Two rules keep the chain honest and openable from a cold start — nothing that
makes steel costs steel (the Refinery is priced in raw ore: 40 regolith / 50 iron /
18 silica / 16 aluminum), and nothing that makes components costs components (the
Workshop is priced in ore too: 30 regolith / 25 iron / 10 aluminum). Components are
**counted, not weighed**: they live on their own integer ledger with rack space
instead of silo mass, because a motor is a unit, not 40 kg of something.

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
| Workshop | 5 kW | **IN** (P5 slice 2) | repair / nearby build speed (1.35× within 70 m), plus the colony's only machine shop: two selectable lines — 2.5 kg steel + 1 kg aluminum → 1 drive motor per 2 h, or 1.2 kg silica + 0.4 kg aluminum + 0.2 kg steel → 1 circuit board per ~3 h — and a 24-slot component rack that stalls when it fills |
| Rover Garage | 3 kW | **IN** (beyond original table) | 32 kW charge (2× the pod), drivetrain service, assemble rovers; costs 30 kg steel |
| RTG Array | 0 / 5 kW baseload | **IN** (stand-in) | storm-proof trickle power |
| Weather Radar Station | 10 kW (2 kW idle) | **IN** (beyond original table) | 520 km radar scope, storm cells + predicted tracks, 2.25× forecast lead; costs 25 kg steel |
| Refinery | 35 kW (4 kW idle) | **IN** (P5 slice 1) | iron ore → steel, +150 kg per silo, blast-furnace body; the gate on heavy construction |
| Laboratory | 10 kW | **OUT** | research |
| Repair Bay | 8 kW | **OUT** | advanced maintenance |
| Nuclear Reactor | variable | **OUT** | base-load power |

Landing pod (not a blueprint): 14 kW RTG, 90 kWh battery, 2 kW of its own
scrubbers/heaters (tier 0), 16 kW rover charging, and an 8 m exclusion radius that
siting respects — **IN**. Its visual body is a ~56 m descent stage on three splayed
legs with a windward reentry burn; presentation only, never in a save (§12).

Utility networks: Power **IN**; Water / Atmosphere / Waste / Data / Logistics pipe networks **OUT**.
Infrastructure overlays toggleable — **PARTIAL** (`none` / `power` / `life` / `weather`).

## 05 — Rovers & Automation

| Rover | Cargo | Battery | Cruise (m / game-s) | Status | Role in build |
|---|---|---|---|---|---|
| Scout | 100 kg | 20 kWh | — | **OUT** | exploration / mapping |
| Utility | 500 kg | 40 kWh | 14 | **IN** | general work / build |
| Mining | 1,500 kg | 80 kWh | 11 | **IN** | drilling / extraction (1.5× dig rate) |
| Cargo | 3,000 kg | 120 kWh | 7 | **IN** | long-haul logistics (garage-assembled) |

*(Game seconds, not wall-clock: a sol is 240 game seconds — TDD §4's two time bases.)*

Assembly prices (P5 slice 2): a rover costs bulk metal **and** manufactured parts —
Utility 2 motors + 1 board, Mining 4 + 1, Cargo 6 + 2 — so the garage can only
build what a Workshop has already crafted, and it refuses with the missing part
named rather than quietly building a rover without wheels.

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

**Proximity awareness — IN** (issue #11): a moving rover measures *hull clearance*
— centre distance minus both radii — against anything it can hit (other rovers,
buildings, the landing pod, discovered non-buried sites). Something inside the
bubble drops it to an immediate crawl: **1.5 m clearance → 28 % speed** in open
country, **3.0 m → 15 %** inside the colony yard around the pad. The crawl is
never zero, so a nose-to-nose pair keeps inching and cannot deadlock, and move
power scales with the multiplier so slowing down is a brake rather than a battery
tax. The rover's current destination is exempt once inside arrival reach, or a
builder crawling up to its own site would never finish. Still **OUT**: collision
physics (rovers never shove each other), re-pathing around an obstacle, and
per-part failures.

Rover failure: drivetrain wear (soft slowdown), battery-flat strand + yellow strobe, jump-start recovery — **IN**. Wheel/motor/sensor part failures as distinct systems — **OUT**.

## 06 — Mars World Generation & Exploration

Large local region around landing site — **IN** as a seeded playable square, not a
whole-planet streamer. The landing site is picked first on a compact Mars globe
(`marsGlobe.ts`: biomes + a MOLA-scale elevation model), then the local window is
generated around it (`terrain.ts`).

**World sizes** (mission wizard, saved with the colony):

| Size | Label | Half-extent | Claim |
|---|---|---|---|
| small | Outpost | 420 m | 840 × 840 m |
| medium | Territory | 640 m (default) | 1.28 × 1.28 km |
| large | Province | 960 m | 1.92 × 1.92 km |
| planet | Planetary Survey | 1 280 m | 2.56 × 2.56 km |

Terrain mesh, nav grid, camera bounds and POI scatter all read the *chosen*
half-extent — the mesh used to be hard-coded to the default and left the largest
map driving off into void (issue #17, fixed and regression-covered).

**Globe picker:** 18 named landable regions (Amazonis, Chryse, Utopia, Elysium,
Isidis, Meridiani, Arabia, Noachis, Hellas, Syrtis Major, Gale, Jezero, Gusev,
Oxia Planum …), each with a biome and a jitter radius; a spinnable three.js globe
whose surface texture is *generated* from the same MOLA-like elevation model the
terrain sampler uses, so no imagery ships. A seed alone picks the site; a chosen
region constrains it.

| Terrain idea | Status |
|---|---|
| Flat / rocky plains, craters, canyons, dunes-ish local geology | **PARTIAL** — MOLA-derived regional relief prior + seeded broad landforms + HiRISE-scale local geology (mixed-age craters, grit, rim rocks) over a globe biome |
| Ice field / lava tube as special rules | **PARTIAL** (ice-cave POI is salvage + water-ish scrap, not a ruleset) |
| Chunk streaming | **OUT** (fixed window; terrain is a pure function of seed, re-derived on both sides of the worker seam) |

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

**Storms are places, not moods.** Each storm is a circular weather *system* with a
kilometre-scale footprint that forms, travels along a heading and dies on a
ramp-hold-decay envelope. The colony reads whatever system is overhead: a storm
*arrives* (leading edge crosses the site), *passes over*, and *moves on*. Weather
is re-rolled every 84 game seconds after ≥2.2 calm sols, with a 96 s cooldown
between storms.

| Event | Status | Per-roll chance | Unlocks |
|---|---|---|---|
| Dust devil | **IN** | 10 % | sol 3 |
| Regional storm | **IN** | 4.5 % | sol 4 |
| Severe storm | **IN** | 1.2 % | sol 7 |
| Planetary dust event | **IN** | 0.6 % (grows with sol) | sol 12 |

Weather variables in sim: wind, dust density, solar irradiance (via dust transmission + sun), visibility, storm intensity — **IN**. Atmospheric pressure / radiation / SPE as gameplay — **OUT**.

**Weather is a field, not one number — IN.** `localIntensity(x, z)` and
`localDust(x, z)` sample the storm footprint at a position plus a fine seeded
noise term, and every weather decision — shelter rovers, block EVA, work-rate
penalty, damage rate — has an `…At(x, z)` form evaluated *at the entity*. A rover
20 m from the pad can be in comparatively clear air while the colony is hammered.
The HUD weather cell, the forecast and the alerts all read the same field.

**Lightning (electrostatic discharge) — IN.** Airborne dust is the charge source,
so calm clear air never strikes:

| Lever | Value |
|---|---|
| Gates | dust ≥ 0.15 **and** local intensity ≥ 0.15 |
| Rate | 0.06 strikes / game-s at full hazard × dust^1.6 × storm factor × difficulty |
| Storm factor | devil 0.5 · regional 1.0 · severe 1.7 · planetary 2.3 |
| Difficulty | Settler 0.6 · Pioneer 1.0 · Survivor 1.5 |
| Aim | 25 % of strikes target a weighted anchor (exposure × vulnerability: solar 1.9, battery/oxygen generator 1.5, workshop 1.3), jittered ±9 m; the rest land anywhere in the claim |
| Damage | within 24 m of the bolt, falling off with distance: `16 × exposure × vulnerability × falloff × damageMul` health to structures (≤25 health trips them offline); 18 % drivetrain condition to rovers; inside 10 m a rover also loses 35 % of its pack (and strands if that empties it); 30 health to a colonist on EVA — which can end the mission |
| Presentation | a double-flash point light driven by `weather.lastStrike`, a colony-log line, a critical/warning alert, and a thunder cue in the audio mix |
| Determinism | its own seeded RNG stream (`lightningRoll`), part of the save; a dev **force strike** drops one exactly on the most exposed thing standing |

Forecasting with lead time — **IN**: 60 game seconds of warning by default, **×2.25
with a powered Weather Radar Station**, which also plots live storm cells and their
predicted tracks on the world map (520 km coverage). Sensors/research reducing
uncertainty beyond that — **OUT**.

**Dust devils as an ecology — IN, presentation-side.** The sim owns the devil
*storm class*; the wandering vortices you see live in the renderer's particle
layer: counts rolled per storm class and intensity band (0–4, held 2 s so a storm
hovering on a band boundary does not strobe), each devil drawing its own size,
spin, wander frequencies and wind bias so two in one storm never share a track,
and pair physics on contact (mutual cancellation, orbit-then-die, consume-and-grow,
twin co-orbit → split). A sharp wind ramp (d(wind)/dt above 0.35 m/s²) banks charge
and spins one up out of clear air; at most 5 exist at once.

Storm prep levers that work today: charge batteries, shelter rovers (auto rule), clean arrays, power priorities, and keep a garage-serviced fleet out of the open when the sky is electric. — **IN**

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
- Mobile: tap select, long-press context, pinch zoom, one-finger and two-finger pan — **IN** (the one-finger pan is issue #1's fix; still marked *in progress* pending a device check)
- Alerts: Critical / Warning / Information / Opportunity — **IN** (condition bus ≠ event log)
- Accessibility (scalable text, high-contrast, reduced motion, 44px targets) — **PARTIAL** (pause-friendly, touch targets, icon+text alerts; full a11y pass still open)
- Mission wizard (difficulty, world size, world options, landing site on a spinnable globe) — **IN**
- Main menu / load game / build palette / inspectors / fleet / garage UI — **IN**
- **Minimap + world map — IN.** A small always-up minimap panel (collapsible, draggable) paints the whole claim from the read model — rovers, buildings, POIs, deposits, the colonist, storm cells at true scale, claim bounds. Clicking it opens a zoomable/pannable world-map overlay with fit-to-world, reset, zoom buttons, a legend and click-to-select markers; its transform is independent of the camera rig, so closing it never moves the game camera (issue #18).
- **Pause menu — IN.** Three tabs over the frozen colony: actions (resume / save / return to menu), settings (applied live), expedition (a plain-data portrait of the colony). While open the menu owns the keyboard and only Esc is honoured.
- **Persisted settings — IN**: autopause on new critical alerts, save when the tab is hidden, autosave interval (off / 30 / 45 / 60 / 120 s), render resolution (ultra ≤2× / high ≤1.5× / performance 1×), shadows, weather FX, HUD hidden. No audio mute/volume control yet — **OUT** (a real gap, see §12).
- **Draggable, resizable HUD panels that snap to the viewport edges**, with a double-tap to send a panel home and title bars that do not scroll their own content (issues #12/#13) — **IN**
- **Build changelog — IN.** The main-menu build badge is a real button that opens a newest-first timeline of every deploy since Prototype 1, curated by hand in `src/ui/Changelog.ts` (generating it from Git metadata is issue #15, still open).
- **In-play update card — IN.** When a newer deploy is live, the sim freezes and a card lists what is new; the player saves, then reloads. Nothing saves or reloads by itself (TDD §23).

## 12 — Visual, Audio & Presentation

- Visual: stylized Mars, three.js WebGL2 renderer, day/night sky + fog, dust haze, particles (wind, grit, devils, rover trails), sun-tracking panels — **IN**
- **Terrain material — IN:** a 2×2 PBR atlas (albedo / normal / roughness / metallic / AO / height) sampled per texel, plus a world-spanning *macro* albedo composed once from the same source imagery so the colour map reads as a landscape rather than wallpaper. Specular follows slope and dust. A neutral material is generated when the sheets are missing, so the game never depends on a texture download.
- **GLB asset pipeline — PARTIAL (plumbing IN, art OUT):** `assetCatalog` maps logical ids (derived from the blueprint kinds) to `public/models/…`, `ModelRegistry` loads/clones/preloads, and every mesh factory asks the registry first and falls back to the existing procedural mesh on a miss. With the models tree empty — as it is today, apart from a 0.6 KB fixture — visuals are identical to pre-pipeline. Drop `.glb`s at the catalog paths to enable them; rover night lights and solar tracking expect named nodes.
- **Particle system — IN:** one 9 000-mote pool, a camera-scaled emission field (45–1 000 m, feathered at the wrap rim so no box is ever visible), one coherent divergence-free curl roll for turbulence (≈157 m cells) plus per-mote scatter, and storm grit kept visibly finer than wind-blown dust. Rates are view-independent, so screen-space density is constant for free. Every emitter takes an injectable RNG — FX are deterministic and run on **sim time**, so a pause freezes them.
- **Props with a body — IN, presentation only:** the descent stage (tripod legs at load-bearing azimuths, a two-pass reentry burn that glows at night), the Weather Radar Station (azimuth dish, nodding RAXpol feed, spinning anemometer cups, wind vane, status LEDs — all pure functions of sim time), building contribution markers, a damage ring, and a true-circle **selection ring** with a pulsing white halo that breathes on sim time (issues #9/#10).
- **Lightning flash — IN:** a double-flash envelope driving a point light at the strike's world position, straight from the sim's `lastStrike` record.
- WebGPU primary path — **OUT** (TDD still lists it as future)
- Skybox / star field — **OUT** (issue #16; the scene has no environment map, which is why metalness is kept low on the descent stage)
- Camera: rotatable 3/4, zoom, follow selection — **IN**; bookmarks — **OUT**
- **Audio — IN** (`src/audio/AudioSystem.ts`), and deliberately not the PDF's plan: there are **no sound files**. Everything is synthesised in-browser on a Web Audio graph, so a fresh offline build has a soundscape and there is no network race at boot.
  - *Scenes:* a quiet command-deck ambience on the menus, and a colony mix of world drone, wind, storm grit and machinery driven from the live read model (wind speed, dust, storm intensity, active rovers, online buildings).
  - *Pause contract:* machinery is time-bound and fades out at speed 0, but world ambience, wind, storm and the brownout reminder stay audible — inspecting a frozen colony never goes silent.
  - *Cues:* every player and dev command has a short confirmation (an exhaustive command→cue map, pinned by `tests/audio/system.test.ts`), plus select, reject, saved, mission-start, alert and lightning cues.
  - *Autoplay policy:* the graph unlocks on the first real pointer/key gesture.
  - *Still OUT:* a user-facing mute/volume setting, music, and interior/exterior acoustic distinction.

## 13 — Victory, Failure & Difficulty

- Primary victory / multi-path victories — **OUT** (no victory checker)
- Failure: final human dies — **IN** (`gameOver`), and the ways to die now include a lightning strike on EVA alongside the life-support cascade. Other hard-loss conditions (no habitat, permanent water loss, …) — **PARTIAL** / mostly soft via the cascade.
- Soft failure philosophy — **IN**
- Difficulty — **IN** as three presets, each a set of multipliers on the same simulation:

| Preset | Consumption | Storms | Damage | Lightning | Supplies |
|---|---|---|---|---|---|
| **Settler** — a gentler Mars | 0.85× | 0.55× | 0.6× | 0.6× | 1.35× |
| **Pioneer** — the intended expedition | 1× | 1× | 1× | 1× | 1× |
| **Survivor** — Mars at its worst | 1.2× | 1.5× | 1.4× | 1.5× | 0.75× |

- Advanced world options, independently configurable (the GDD's separate axes), all collected by the New Expedition wizard and all saved with the colony:
  - **storm level** — calm / normal / brutal
  - **starting supplies** — lean / standard / abundant
  - **deposit richness** — poor / standard / rich
  - **deposit spread** — scarce / standard / plentiful: 8 % / 20 % / 34 % of the seams placed in the near ring around the pad ("long treks to the good seams" vs "a forgiving first week")
  - **world size** — the four presets in §06
  - **landing region** — one of the 18 named regions, or a random site
  - **seed** — free text (max 32 chars) with a reseed button; the same seed + the same options build the same planet

## 14 — Browser Technical Architecture

See **TDD** for the living technical picture. Short version vs original GDD §14:

| Layer | Original target | Current |
|---|---|---|
| UI | DOM/CSS | **IN** (`src/ui`) |
| Renderer | WebGPU + WebGL2 fallback | **WebGL2 via three.js** (no WebGPU yet) |
| Simulation | Worker | **Worker default** + in-process fallback (`?worker=0`) |
| World | streaming chunks | **Fixed seeded window** + globe landing |
| Persistence | IndexedDB | **localStorage** versioned snapshots (v3→v8) |
| Audio | Web Audio | **IN** — procedural Web Audio, no assets (§12) |

## 15 — Performance, Persistence & Scalability

- World streaming / sim LOD tiers — **OUT** (world is small enough to sim entire)
- Target entity scale (thousands) — **PARTIAL**: nothing renders thousands of entities yet, but the numbers are measured rather than hoped for. A fleet benchmark runs 10 / 25 / 50 / 100 / 250 rovers and reports tick, pathfind, view-projection, worker-transport and payload size; a large-colony stress scenario pins invariants under 100 rovers + 250 buildings through a sustained storm; and a regression suite fails the build if any of it goes quadratic (at 250 rovers the average tick is ~4.7 ms of a 50 ms budget). `sim/soak` still covers 20 sols of live operation.
- Profiling — **IN** as dev-only instrumentation (tick/pathfind/command/worker-message counters, view-generation and step timing), default off, tree-shaken out of the app bundle. An in-game perf HUD is still **OUT**.
- Determinism tooling — **IN**: a canonical command transcript can be replayed (`npm run test:replay`) and a deterministic state hash (`rf1-<14hex>-<14hex>` over canonical JSON) turns "did this change behavior?" into a string comparison.
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
| **P5** | refining / manufacturing / utility networks / maintenance depth | **PARTIAL** — refining IN (Refinery + steel + steel-priced blueprints) and manufacturing IN (Workshop lines + component rack + part-priced rovers, save v10); utility networks and maintenance depth OUT |
| **P6** | procedural exploration / supply drops / salvage / expeditions | **PARTIAL** — discover/salvage/drops IN; survey, narrative, repairable wrecks, multi-site expeditions OUT |
| **P7** | colonists / skills / agriculture depth / medicine | **OUT** |
| **P8** | nuclear / underground / advanced robotics / closed-loop | **OUT** |

**Ordering note (conflict with TDD §25, now resolved for engineering):** GDD puts
refining at P5 and exploration at P6; TDD folds POIs into T6 and never gives
refining its own tier. The live project took **P4 → first P6 slice → P5 slice 1 →
P5 slice 2**, so the open product call recorded two realignments ago
("Engineering vs finishing Exploration") was answered in favour of Engineering and
then paid off: the one-process-per-building model that blocked the second slice is
gone, replaced by a per-building line selection (`RECIPES` + `Building.recipe`).
What remains of P5 is the unglamorous half — multi-utility networks and
maintenance depth — and neither blocks anything the current build promises.

**P5 slice 1 — refining (shipped):**

- *The bulk ledger gained a second origin:* `steel` is a `ResourceId` with
  `origin: 'refined'`, so it is hauled, siloed, reserved and spent by the
  existing logistics code. Deposits, world scatter and the dev "survey in a
  seam" backdoor are typed to *mined* resources only — there is no steel to dig.
- *The Refinery is the twelfth blueprint:* 35 kW, tier 2, 48 s build, +150 kg per
  silo, priced in raw ore so the chain can be opened from a cold start. Its
  process is the first `solidOut` in the game: 2.6 kg iron ore → 1.6 kg steel per
  Mars hour, throttled by ore supply, silo headroom and power like every other
  line, with "Steel silo full" as its own idle reason.
- *Heavy construction now goes through it:* the Rover Garage (30 kg) and the
  Weather Radar Station (25 kg) cost steel. The survival chain — habitat, solar,
  battery, extractor, oxygenator, greenhouse — deliberately does not, so P5 gates
  industry and never gates breathing.
- *A process now earns its output:* conversion is bounded by the input that
  actually arrived in the tick, which closes a mass-from-nothing edge when two
  lines draw on one silo (it applied to ice → water before steel existed).
- *Saves moved to v9* (additive: a v8 colony simply has an empty steel silo), and
  a save that claims a steel seam loses that row on restore.

**P5 slice 2 — manufacturing (shipped):**

- *The second ledger is counted, not weighed:* `ComponentId` (`motor`,
  `circuitBoard`) with its own integer store, its own capacity (rack *slots*, not
  kg) and the same API shape as the bulk ledger, so a reader who knows one knows
  the other. Whole units only — the unfinished fraction lives on the building that
  is making it (`Building.craft`), never in the ledger.
- *The Workshop became a machine shop with a choice:* `RECIPES.workshop` lists two
  lines (drive motors, circuit boards) and **replaces** the blueprint's fixed
  process — a kind has one source of truth, never both, and a test pins that.
  `Building.recipe` is the selected index, saved, hashed and resolved through one
  function (`activeProcess`) that the sim, the renderer and the HUD all read, so
  they cannot disagree about what a building is doing.
- *Rack space is a building's, and it gates the line:* only the Workshop has slots
  (24), the landing pod has none, so a colony cannot craft anything until one
  stands — the same bootstrap logic the Refinery follows for steel, one step
  further down. A full rack stops the line and says "Drive Motor rack full"
  instead of inventing storage.
- *Rovers are the end of the chain:* every rover's garage price now includes
  components (Utility 2 motors + 1 board, Mining 4 + 1, Cargo 6 + 2). The garage
  asks both ledgers before spending either, and a refusal names the missing part.
- *Switching lines keeps the work in progress:* `craft` is keyed by component, not
  by recipe, so a changeover never throws away a half-made motor — and an
  out-of-range recipe index (stale UI, future save) resolves to the first line
  rather than taking the tick down.
- *Saves moved to v10* (additive again: a v9 colony arrives with an empty rack,
  every building on its first line, every bench empty), and a hand-edited rack is
  sanitised on restore — whole non-negative units, bench fractions clamped to
  0…1.

**What actually shipped between P4 and this realignment** (none of it a new
pillar, all of it depth the pillars stand on):

- *Weather became spatial and dangerous:* per-entity sampling of the storm field,
  lightning as a dust-gated hazard, the Weather Radar Station as an eleventh
  blueprint, and dust devils as a small wandering ecology (§07).
- *Presentation grew up:* procedural audio soundscape, the 9 000-mote particle
  system with a camera-scaled field and coherent curl turbulence, a PBR terrain
  atlas with a macro albedo, the descent stage and radar station given bodies, a
  true-circle pulsing selection ring, and the GLB asset pipeline wired but empty
  (§12).
- *The world got bigger and honest about it:* MOLA-derived relief steering every
  world size, four sizes up to a 2.56 km claim, and terrain/nav/camera all
  following the chosen half-extent (§06).
- *Navigation gained manners:* hull-clearance proximity crawling (§05).
- *Chrome caught up with the sim:* minimap + zoomable world map, pause menu with
  live settings and an expedition dossier, draggable snapping panels, a build
  changelog timeline, and the in-play save-then-reload update card (§11).
- *The architecture was rebuilt underneath all of it:* the 30-phase refactor
  roadmap in `ARCHITECTURAL-REFACTOR-ROADMAP.md` is **complete** — tick
  responsibilities extracted into `sim/systems/`, state formalised in
  `ColonyState`, persistence under `sim/persistence/`, `Game.ts` split into app
  controllers, the `SimHost` seam strengthened (immutable views, domain events,
  a command architecture that separates player intent from dev backdoors), plus
  the debug harness (invariants, state hash, profiler, transcripts, benchmarks,
  stress) and an optional network transport adapter. See TDD §3.

## 17 — Design Principles & Final Direction

Still the north star:

- Every major gameplay system should interact with ≥2 other systems.
- Research solves encountered problems; disasters create recoverable emergencies; UI exposes the simulation; automation shifts the player from operator to systems architect.
- End-state fantasy: zoom out from one person / two rovers / a few crates → solar fields, mines, greenhouses, habitats, underground facilities, autonomous logistics, resilient life support. Payoff: *"I built that."*

What the current build already delivers of that fantasy: one person, a growing
rover fleet that watches where it is going, a powered life-support chain that can
fail in bad weather — and now also fail to a lightning strike on the array that
was keeping it alive — a soundscape that tells you the sky changed before you
look, a map of the claim in your pocket, and a planet with wrecks and Earth drops
worth leaving the pad for.
