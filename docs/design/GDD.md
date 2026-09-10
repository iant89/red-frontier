# Red Frontier — Game Design Document (reference)

Source: Ian Thomas's shared Dropbox (`Red_Frontier_GDD.pdf`, v1.0). Captured as working reference.

**Tagline:** Mars • 2066 | Real-Time Strategy • Survival • Automation • Exploration
**Design premise:** *One human. A handful of machines. An entire planet that does not want you there.*

## 01 — Executive Summary & Design Pillars

- Genre: RTS / survival / automation / exploration
- Platform: modern desktop + mobile web browsers
- Setting: Mars, 2066
- Perspective: 3D isometric / freely rotatable 3/4 camera
- Single-player at launch
- Player = humanity's first long-duration Mars colonist, with autonomous rovers and constrained inventory.
- Central fantasy: engineering — take a fragile outpost and turn it into a resilient, self-sustaining civilization (not empire building).
- Pillars: **Survival**, **Engineering**, **Automation**, **Exploration**.
- Core loop: Explore → Survey → Extract → Process → Build → Maintain → Automate → Expand → Explore farther.

## 02 — Core Gameplay & Simulation Systems

- Interacting systems; failure propagates (emergent stories).
- Dependency chain: Weather → Solar/Terrain/Damage → Power/Mining/Maintenance → Life Support/Industry → Food/Population → Labor → Automation → Expansion.
- Time: Martian sols (≈24h 39m 35s). Pause, 1×, 2×, 4× speed. Fixed timestep independent of rendering.
- Survival systems: electricity (network w/ gen/storage/loads/priorities/failures), water (extract/store/purify/distribute/recycle), oxygen (resource + atmosphere property in pressurized structures), food (controlled agriculture), temperature, radiation, maintenance/component wear.
- Cascading failure example: dust storm → solar drops → batteries drain → water pumps shut down → greenhouse irrigation stops → food declines. Player picks emergency power priorities, sends rover to repair exposed array.

## 03 — Resources & Industrial Economy

Raw resources: Regolith (construction/shielding/concrete), Iron ore (steel), Aluminum ore, Silica (glass/silicon), Magnesium (alloys), Sulfur (chemicals), Water ice (water/oxygen/agriculture), Carbon-bearing material (industrial chem), Rare minerals (advanced mfg).

Refined: Steel←Iron, Aluminum←Aluminum ore, Glass←Silica, Silicon←Silica, Ceramics←Minerals, Concrete←Regolith+binders, Carbon composites←Carbon+chemicals.

Industrial components (manufactured locally, data-driven recipes): pipes, wires, glass panels, motors, pumps, valves, circuit boards, battery cells, sensors, computers, solar cells.

Rep chain: Iron deposit → Mining → Iron ore → Crushing → Smelting → Steel → Component manufacturing → Construction.

## 04 — Buildings & Infrastructure

Buildings are functional machines: construction cost, utility interfaces, operating loads, wear, failure modes, maintenance.

| Building | Power | Function |
|---|---|---|
| Emergency Habitat | 5 kW | initial shelter / life support |
| Solar Panel | 0 kW | generation |
| Battery Bank | 0.2 kW | energy storage |
| Water Extractor | 18 kW | ice extraction |
| Oxygen Generator | 12 kW | O2 production |
| Greenhouse | 8 kW | food |
| Warehouse | 1 kW | storage |
| Workshop | 5 kW | repair / fabrication |
| Refinery | 35 kW | material processing |
| Laboratory | 10 kW | research |
| Rover Garage | 3 kW | vehicle service |
| Repair Bay | 8 kW | advanced maintenance |
| Nuclear Reactor | Variable | reliable base-load power |

Utility networks: Power, Water, Atmosphere, Waste, Data, Logistics. Infrastructure overlays (power/water/oxygen/heat/comms/logistics) toggleable; highlight broken links/overloaded segments.

## 05 — Rovers & Automation

| Rover | Cargo | Speed | Battery | Role |
|---|---|---|---|---|
| Scout | 100 kg | High | 20 kWh | exploration / mapping |
| Utility | 500 kg | Medium | 40 kWh | general work |
| Mining | 1,500 kg | Low | 80 kWh | drilling / extraction |
| Cargo | 3,000 kg | Low | 120 kWh | long-distance logistics |

Task system: MOVE, MINE, UNLOAD, HAUL, BUILD, REPAIR, CLEAN, SCOUT, SALVAGE, RECOVER, RETURN, CHARGE, WAIT — first-class, queueable/repeatable.
Automation rules (player-authored): IF battery <20% → return to charger; IF cargo >90% → return to warehouse; IF storm warning → return to shelter. Automation is a progression mechanic.
Rover failure: wheel/motor/battery/sensor/navigation/dust failures; stranded (recoverable) rather than destroyed → recovery expeditions.

## 06 — Mars World Generation & Exploration

Large local region around landing site, streaming chunks (not whole planet).

| Terrain | Rover difficulty | Value |
|---|---|---|
| Flat plain | Low | general resources |
| Rocky plain | Medium | high mineral potential |
| Dunes | High | low resources / mobility hazard |
| Crater | Medium | geological interest |
| Canyon | High | high resource potential |
| Ice field | Medium | major water source |
| Lava tube | Very high | potential protected habitat |

Procedural deposits: size/concentration/depth/extraction difficulty. Survey improves confidence (estimates before).
POIs: abandoned missions, repairable/salvageable old rovers, meteorites/geological samples, ice caves/lava tubes, scientific equipment/data caches, Earth supply containers, ideal future settlement spots.
Philosophy: map begins mostly unknown; exploration expands options (not every tile = reward).

## 07 — Weather, Climate & Environmental Hazards

| Event | Visibility | Solar | Damage | Effect |
|---|---|---|---|---|
| Dust devil | Reduced | Minor ↓ | Localized | short tactical disruption |
| Regional storm | Low | Major ↓ | Moderate | logistics risky |
| Severe storm | Very low | Severe ↓ | High | external work dangerous |
| Planetary dust event | Extreme | Very severe ↓ | Extended | colony-wide crisis |

Weather variables: wind speed/direction, dust density, temperature, solar irradiance, visibility, atmospheric pressure, radiation/SPE.
Forecasting: early uncertain; improved by comms/science/weather sensors.
Storm prep: charge batteries, shelter rovers, clean arrays, secure externals, fill water/O2 reserves, isolate damaged structures, shut down non-essential industry.

## 08 — Agriculture, Life Support & Population

- Atmosphere: pressurized volumes track pressure, O2%, CO2, temperature, humidity, volume. Breach → pressure loss → escalation.
- Water loop: Ice extraction → purification → storage → habitation/agriculture → wastewater → reclamation (late-game very high recovery).
- Food loop: humans consume food → biological waste processed → nutrients recovered → crops grow → harvested. Crops have distinct water/light/temp/nutrient needs.
- Population: begins with 1 human; later colonists add labor/expertise but increase O2/water/food/space/medical demand.
- Skills: Engineering (electrical/mechanical/construction), Science (geology/biology/research), Operations (logistics/machinery/rover control), Agriculture, Medical.

## 09 — Research & Progression

- Performed via physical laboratories; needs data, samples, power, infrastructure. Tech solves problems the player encountered.
- Tiers: 1 Survival (basic solar, water extraction, oxygen, agriculture, rover repair); 2 Industrialization (steel, aluminum, glass, batteries, automated mining); 3 Automation (rover scheduling, hauling, solar cleaning, repair robotics); 4 Advanced colony (nuclear, underground, advanced agriculture); 5 Independence (electronics mfg, advanced robotics, closed-loop ecology); 6 Endgame (terraforming research, planetary engineering, megastructures).
- Arc: Survival → Stability → Industrialization → Automation → Expansion → Colonization → Independence.

## 10 — Supply Drops, Earth & Narrative

- Cargo missions arrive at uncertain locations, marked by transponders; player decides to dispatch rovers/human before storms bury cargo.
- Cargo types: food/seeds, electronics, medical, batteries, replacement parts, scientific equipment, specialized machinery, experimental tech.
- Earth comms have realistic delay — submit requests, not instant orders.
- Narrative primarily environmental: logs, radio messages, abandoned hardware, discoveries, milestones. No conventional enemy armies; physics/weather/distance/equipment failure/scarcity are antagonists.

## 11 — UI/UX & Accessibility

- Desktop: left click select, right click context order, drag box-select, wheel zoom, middle drag pan, hotkeys.
- Mobile: tap select, tap terrain context movement/placement, long press command menu, pinch zoom, two-finger pan/rotate.
- Alerts: Critical (e.g. habitat pressure falling) / Warning (solar needs cleaning) / Information (supply drop detected) / Opportunity (new ice deposit surveyed).
- Accessibility: scalable text, high-contrast alert mode, color-independent icons, reduced motion, pause-friendly, 44px+ touch targets, tooltips.

## 12 — Visual, Audio & Presentation

- Visual target: OSRS clarity/stylization + modern rendering quality; not photorealism.
- Low-poly clean silhouettes, PBR materials, dynamic sun/shadow, dust particles/haze, detailed machinery/rover animations, contrast of rust Mars vs white/metallic habitats; green vegetation & blue water as meaningful signals.
- Camera: freely rotatable 3/4 camera, zoom levels (character/building/base/local/strategic), follow selected units, camera bookmarks.
- Audio: outside sparse/isolated; inside pumps/fans/airlocks/machinery soundscape; restrained music, prominent at discoveries/milestones.

## 13 — Victory, Failure & Difficulty

- Primary victory: full self-sufficiency (continuous critical survival resources + self-manufacture of maintenance parts w/o routine Earth resupply).
- Victory paths: Independence, Scientific, Industrial, Exploration, Population, Terraforming.
- Failure: final human dies; no survivable pressurized habitat; permanent loss of critical water; irrecoverable power; food reserves+production both fail; unrecoverable infrastructure.
- Soft failure philosophy: most disasters recoverable (emergency, not auto game-over).
- Difficulty params: resource abundance, weather severity, Earth support, equipment failure rate — independently configurable.

## 14 — Browser Technical Architecture

- Separate simulation from rendering & UI. Layers: UI (DOM/CSS), Renderer (WebGPU primary/WebGL2 fallback), Simulation (worker), World (terrain chunks/streaming), Persistence (IndexedDB + optional cloud), Audio (Web Audio).
- Recommended: **TypeScript** client+sim, WebGPU, WebGL2 fallback, Web Workers for sim, IndexedDB saves.
- Fixed timestep sim ~20 Hz; rendering 30–144+ FPS. Renderer consumes state, does not define logic.
- ECS/data-oriented entity model. Web Workers prevent long sim steps freezing the UI.

## 15 — Performance, Persistence & Scalability

- World streaming chunks; high detail near camera, distant retain sim state with reduced visuals.
- Simulation LOD: nearby full sim, distant simplified, far industrial systems statistical.
- Target scale: Early 20–100 entities; Medium 100–1,000; Large 1,000–5,000; Late 5,000+.
- Persistence: auto+manual slots, IndexedDB, optional cloud, import/export saves, save sim state not renderer state.
- Developer mode (TDD §22): an in-game tooling panel for weather/time control, setting selected-object properties, and spawning/upgrading — as hard contract, the mode's edits are runtime-only and **never written to the save file**; nothing the panel does outlives a reload. (Objects it fabricates, however, join the world for real and do save.)
- Multiplayer out of scope initially; later server-authoritative.

## 16 — Development Roadmap & MVP

Vertical slices: P1 terrain/camera/human/rover/resource nodes/mining/inventory/construction; P2 power/batteries/O2/water/food/temp/day-night; P3 wind/dust/accumulation/storms/degradation; P4 rover tasks/automation/logistics/charging/mining routes; P5 refining/manufacturing/utility networks/maintenance; P6 procedural exploration/supply drops/salvage/expeditions; P7 colonists/skills/agriculture depth/medicine; P8 nuclear/underground/advanced robotics/closed-loop ecosystem.

**MVP feature set:** World=procedural local Mars terrain, day/night, basic weather; Player=one human; Vehicles=two rovers; Resources=iron, regolith, water, silicon, aluminum; Buildings=habitat, solar, battery, water extractor, oxygen generator, greenhouse, storage, workshop; Simulation=mining, construction, electricity, water, oxygen, food; Environment=dust accumulation, dust storm, wind damage; UI=responsive desktop+mobile; Persistence=local save/load.

## 17 — Design Principles & Final Direction

- Every major gameplay system should interact with ≥2 other systems.
- Research solves encountered problems; disasters create recoverable emergencies; UI exposes the simulation; automation shifts player role from operator to systems architect.
- End-state fantasy: zoom out from one person/two rovers/a few crates → solar fields, mines, greenhouses, habitats, underground facilities, autonomous logistics, resilient life support. Payoff: "I built that."
