> ← [Home](Home.md)

# Industry and Manufacturing

The industrial pillar answers one question: **what does it take to make a
machine?** Ore → steel → components → rover is a functioning loop, and each link
is a building with a power draw, a bottleneck and an idle reason.

## Why the chain exists

The survival chain is dug: regolith, iron, silica, aluminum and ice all have seams.
Everything *above* that is manufactured, so the colony's growth is gated by
capacity decisions rather than by map luck. Two rules keep the chain honest and
always openable from a cold start:

- **Nothing that makes steel costs steel.** The Refinery is priced in raw ore:
  40 regolith · 50 iron · 18 silica · 16 aluminum.
- **Nothing that makes components costs components.** The Workshop costs
  30 regolith · 25 iron · 10 aluminum.

And one rule keeps it from being free: **P5 gates industry and never gates
breathing.** Habitat, solar, battery, extractor, oxygenator and greenhouse are all
priced in ore, so a colony can always survive without ever smelting.

## Refining — the Refinery

| | |
|---|---|
| Draw | **35 kW** active, 4 kW idle — tier 2 (industry) |
| Process | **2.6 kg iron ore → 1.6 kg steel** per Mars hour |
| Storage | +150 kg to every silo (steel included) |
| Build | 48 s, then it needs steel-priced work to justify itself |

**Steel is a bulk resource like any other** — a `ResourceId` with `origin:
'refined'`. It rides a rover's bed, fills a silo, gets reserved by a construction
site, and shows up in the stock chips, all through the same logistics code as ore.
The one difference: **it has no seam.** The world never scatters it, no rover can
mine it, and developer mode will not survey one in. The only way to own steel is to
make it.

The furnace behaves like every other line and throttles on three things: ore
supply, silo headroom (**"Steel silo full"** is its own idle reason) and power.
That last one is the design point — 35 kW is more than a single array makes, so
smelting **competes with the colony**, and industry is shed before life support
ever is. Run the furnace when the sun is up.

Downstream, steel prices the heavy structures: **Rover Garage 30 kg**, **Weather
Radar Station 25 kg**, **Pump Station 10 kg**, **Repair Bay 20 kg**.

## Manufacturing — the Workshop

5 kW, tier 2, +120 kg of bulk storage, **24 component rack slots**, and the
colony's only machine shop. It runs **one of six lines you choose**, per building,
saved with the colony:

| Line | Recipe |
|---|---|
| Drive Motors | 2.5 kg steel + 1 kg aluminum → 1 motor / 2 h |
| Circuit Boards | 1.2 kg silica + 0.4 kg aluminum + 0.2 kg steel → 1 board / ~3 h |
| Water Pipes | 1 kg steel → 2 sections / h (each spans 20 m) |
| Battery Packs | 2 kg aluminum + 1 kg silica + 0.5 kg steel → 0.5 / h |
| Cargo Frames | 3 kg aluminum + 2 kg steel → 0.5 / h |
| Drill Teeth | 1 kg iron + 3 kg steel → 0.5 sets / h |

Switching lines **keeps whatever is half-made on the bench** — `Building.craft` is
keyed by component, not by recipe, so a changeover never throws a motor away. The
mechanism: `RECIPES.workshop` **replaces** the blueprint's fixed process (a kind
has one source of truth, never both — and a test pins that), and `Building.recipe`
is the selected index, resolved through one function `activeProcess()` that the
sim, the renderer and the HUD all read, so they cannot disagree about what a
building is doing.

### Components are counted, not weighed

Manufactured units live on their own **integer ledger** with *rack slots* instead
of silo mass — a motor is one motor, not 40 kg of something. Consequences:

- **Whole units only.** The unfinished fraction stays on the building making it,
  never in the ledger.
- **Rack space is a building's, and it gates the line.** Only the Workshop has
  slots; the landing pod has none, so **nothing can be crafted until one stands**.
- **A full rack stops the line** with its own idle reason ("Drive Motor rack
  full") rather than inventing storage.

## Who spends parts

Rovers are the end of the chain, and the garage asks **both ledgers** before it
spends either:

| Rover | Metal | Components |
|---|---|---|
| Utility | 40 iron · 20 aluminum · 10 silica | 2 motors + 1 board |
| Mining | 60 iron · 30 aluminum · 15 silica | 4 motors + 1 board |
| Cargo | 80 iron · 50 aluminum · 25 silica | 6 motors + 2 boards |

A refusal **names the part you are short of** rather than quietly building a rover
without wheels. The same parts price permanent refits (see
[Engineering and Upgrades](Engineering-and-Upgrades.md)) and Repair Bay
replacements (see [Maintenance and Repairs](Maintenance-and-Repairs.md)).

## Where the code lives

| Concern | Source |
|---|---|
| What a process wants, why it is idle, the mass it moves, the units it racks, the line it runs | `src/sim/systems/ProductionSystem.ts` |
| The bulk (kg) ledger, cargo, reservations | `src/sim/systems/LogisticsSystem.ts` |
| The manufactured-unit ledger, rack space, whole units | `src/sim/systems/ComponentSystem.ts` |
| Blueprints, resources, components, `RECIPES` | `src/sim/defs.ts` |
| Assembly line and reservations | `src/sim/systems/GarageSystem.ts` |

## Deliberately not in yet

A wider parts catalogue (valves), a second refined material (**glass** from
silica — the per-building recipe selection already provides the machinery for it),
oxygen/heat/data networks, and building-level component wear.

## Related

- [Blueprint Reference](Blueprint-Reference.md) ·
  [Maintenance and Repairs](Maintenance-and-Repairs.md) ·
  [Water Networks](Water-Networks.md)
