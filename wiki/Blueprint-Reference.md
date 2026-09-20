> ← [Home](Home.md)

# Blueprint Reference

Every number here is authored in
[`src/sim/defs.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/defs.ts)
and [`src/sim/config.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/config.ts)
— data drives content, so a new building is a table row, not a code change.

## Time and rate conventions

- A **sol** is 24 h 39 m of Mars time compressed into **240 game seconds** at 1×
  (≈4 real minutes); `SOL_HOURS = 24.6597`.
- **Material flows** (mining kg/s, construction seconds) are authored in *game
  seconds* for playability. **Energy and life support** (kW, kWh, kg/sol) are
  authored in *Mars time* so they read like real engineering figures.
  `HOURS_PER_SEC` / `SOLS_PER_SEC` bridge the two.
- Power tiers, served in order and shed from the bottom up: **0 Life support ·
  1 Oxygen & water · 2 Industry · 3 Logistics**.

## Bulk resources

| Id | Label | Mine rate | Origin | Role |
|---|---|---|---|---|
| `regolith` | Regolith | 12 kg/s | mined | construction, foundations, shielding |
| `iron` | Iron Ore | 5 kg/s | mined | structures, machinery, steel feedstock |
| `silicon` | Silica | 4 kg/s | mined | panels, electronics (glass still OUT) |
| `aluminum` | Aluminum Ore | 3.5 kg/s | mined | frames, trusses, hulls |
| `ice` | Water Ice | 3 kg/s | mined | the bridge into the fluid economy |
| `steel` | Steel | — | **refined** | heavy structures; no seam exists |

Base silo capacity is **260 kg per resource** (storage is per-resource on
purpose — a shared pool lets one load of regolith deadlock every chain).

## Fluids

| Id | Held in | Notes |
|---|---|---|
| `water` | building tanks | extractor output; habitat reclaim **55%** |
| `oxygen` | building tanks | colonist consumes **0.84 kg/sol** |
| `food` | building tanks | colonist consumes **1.5 kg/sol**; water **4 kg/sol** |

Fluids never ride a rover, so supply drops contain none.

## Manufactured components

Counted, not weighed: whole units on their own ledger with **rack slots** instead
of mass. `ROVER_PARTS` (wear-tracked) are motors and circuit boards; pipes are
construction inventory.

| Component | Used for |
|---|---|
| Drive Motor | rover assembly, drivetrain refits, Repair Bay replacement |
| Circuit Board | rover assembly, electronics refits, Repair Bay replacement |
| Water Pipe | 20 m pipe section for commissioned water networks |
| Battery Pack | larger energy reserves (refit line) |
| Cargo Frame | expanded beds and racks (refit line) |
| Drill Teeth | permanent mining-tool upgrades (refit line) |

## Buildings

15 buildable blueprints. "Draw" is the operating load; "idle" is what a powered
but inactive building still takes. All times are game seconds at full power.

| Blueprint | Draw / idle (kW) | Tier | Build | Storage | Cost |
|---|---|---|---|---|---|
| Warehouse | 1 / 0.4 | 2 | 25 s | +600 kg each | 35 regolith · 15 iron |
| Solar Array | generates **28 kW** peak | 3 | 18 s | — | 10 regolith · 18 silica · 12 aluminum |
| Battery Bank | 0 / 0.2 | 3 | 16 s | **200 kWh** | 8 regolith · 26 iron · 6 silica |
| Water Extractor | 18 / 1.5 | 1 | 30 s | 120 kg water | 20 regolith · 30 iron · 12 aluminum |
| Oxygen Generator | 12 / 1 | 1 | 32 s | 25 kg O₂ · 10 kg water | 15 regolith · 28 iron · 14 silica · 10 aluminum |
| Habitat | 5 / 1.2 | **0** | 46 s | +60 kg each · 200 water · 30 O₂ · 150 food | 60 regolith · 40 iron · 15 silica · 10 aluminum |
| Greenhouse | 8 / 1.5 | 1 | 38 s | 60 water · 80 food | 25 regolith · 18 iron · 30 silica · 8 aluminum |
| Workshop | 5 / 1 | 2 | 30 s | +120 kg each · **24 rack slots** | 30 regolith · 25 iron · 10 aluminum |
| Rover Garage | 3 / 0.8 | 2 | 34 s | +100 kg each | 25 regolith · 12 iron · 12 silica · **30 steel** |
| RTG Array | generates **5 kW** baseload | 3 | 52 s | — | 55 iron · 35 aluminum · 20 silica |
| Weather Radar Station | 10 / 2 | 2 | 44 s | — | 24 regolith · 18 iron · 28 silica · 18 aluminum · **25 steel** |
| Refinery | 35 / 4 | 2 | 48 s | +150 kg each | 40 regolith · 50 iron · 18 silica · 16 aluminum |
| Repair Bay | 8 / 1 | 2 | 38 s | — | 30 regolith · 18 iron · 12 aluminum · 10 silica · 20 steel |
| Pump Station | 6 / 0.5 | 1 | 26 s | 20 kg water | 20 regolith · 15 iron · 6 silica · 10 steel |
| Water Tank | 0 / 0 | 1 | 24 s | 250 kg water | 25 regolith · 20 iron · 10 aluminum |

The **landing pod** is not a blueprint: 14 kW RTG, 90 kWh battery, 2 kW of its own
scrubbers and heaters (tier 0), 16 kW of rover charging, and an 8 m exclusion
radius the siting rules respect.

Note the pricing rule that keeps the chain openable from a cold start: **nothing
that makes steel costs steel**, and **nothing that makes components costs
components** — the Refinery and Workshop are priced in raw ore. The survival
chain (habitat, solar, battery, extractor, oxygenator, greenhouse) never costs
steel, so **P5 gates industry and never gates breathing**.

### Processes

| Building | Conversion (per Mars hour, at full power) |
|---|---|
| Water Extractor | 1.4 kg ice → 1.15 kg water |
| Oxygen Generator | 0.14 kg water → 0.125 kg O₂ |
| Greenhouse | 0.42 kg water + light → 0.17 kg food (≈2 kg/sol) |
| Refinery | 2.6 kg iron ore → 1.6 kg steel |
| Workshop — Drive Motors | 2.5 kg steel + 1 kg aluminum → 1 motor / 2 h |
| Workshop — Circuit Boards | 1.2 kg silica + 0.4 kg aluminum + 0.2 kg steel → 1 board / ~3 h |
| Workshop — Water Pipes | 1 kg steel → 2 sections / h |
| Workshop — Battery Packs | 2 kg aluminum + 1 kg silica + 0.5 kg steel → 0.5 pack / h |
| Workshop — Cargo Frames | 3 kg aluminum + 2 kg steel → 0.5 frame / h |
| Workshop — Drill Teeth | 1 kg iron + 3 kg steel → 0.5 set / h |

A process **earns its output**: what a line produces in a tick is bounded by the
input that actually arrived, so two furnaces on one ore pile split the ore
instead of both smelting a full rate.

## Rovers

| Kind | Cargo | Battery | Cruise | Move / work power | Lights | Mine rate | Assembly |
|---|---|---|---|---|---|---|---|
| Utility | 500 kg | 40 kWh | 14 m/game-s | 6 / 7 kW | 0.5 kW | 0.6× | 40 s · 40 iron · 20 aluminum · 10 silica · 2 motors + 1 board |
| Mining | 1 500 kg | 80 kWh | 11 | 9 / 10 kW | 0.7 kW | **1.5×** | 55 s · 60 iron · 30 aluminum · 15 silica · 4 motors + 1 board |
| Cargo | 3 000 kg | 120 kWh | 7 | 12 / 8 kW | 0.9 kW | 0.25× | garage-assembled · 6 motors + 2 boards |

Battery floors: a rover stops working and recharges below **20%** charge, and is
considered flat (stranded) at **1%**. The Scout is designed but not in the build.

## Thresholds worth memorising

| Constant | Value | Meaning |
|---|---|---|
| `BASE_STORAGE_PER_RESOURCE` | 260 kg | pod silo per resource |
| `BASE_COMPONENT_SLOTS` | 0 | nothing can be crafted before a Workshop stands |
| `WATER_RECLAIM_FRACTION` | 0.55 | habitat reclaims 55% of used water |
| `ROVER_CHARGE_THRESHOLD` | 0.20 | recall-to-charge floor |
| `ROVER_DISABLED_THRESHOLD` | 0.01 | flat pack → stranded, strobe on |
| `ROVER_CONDITION_ALERT` | 35 | HUD nags below this condition |
| `STORM_WARN_LEAD_S` | 60 s | forecast lead (×2.25 with radar) |
| `WEATHER_ROLL_INTERVAL_S` | 84 s | weather re-roll cadence (≈0.35 sol) |
| `WEATHER_CALM_SOLS` | 2.2 | no storms before this |
| `POI_DISCOVER_M` | 55 m | discovery radius |
| `AUTOSAVE_INTERVAL_S` | 45 s | default autosave |
| `ROUTE_RESUME_ROOM_KG` | 60 kg | a parked haul route resumes at this much silo headroom |

Storm unlock sols: devil **3** · regional **4** · severe **7** · planetary **12**.

## Next

- [Industry and Manufacturing](Industry-and-Manufacturing.md) — why the numbers
  are shaped this way
- [Power and Life Support](Power-and-Life-Support.md) — the grid rules
- [`docs/design/GDD.md`](https://github.com/iant89/red-frontier/blob/main/docs/design/GDD.md) — the design source
