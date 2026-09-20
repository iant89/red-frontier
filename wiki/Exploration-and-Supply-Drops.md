> ← [Home](Home.md)

# Exploration and Supply Drops

The first slice of "a planet with somewhere to go": content the map does not show
until you earn it, and cargo that will be buried if you do not come for it.

## The map begins mostly unknown

[`src/sim/pois.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/pois.ts)
carries the content tables; `World` scatters them **from the seed**. Two radius
rules define the experience:

| Rule | Value |
|---|---|
| Nothing spawns near home | **150 m** from the landing site |
| A site reveals itself | **55 m** (`POI_DISCOVER_M`) from a rover or your colonist |

Finding a site is a **permanent event** and raises an **Opportunity** alert naming
what it is and roughly how much is salvageable. Discovery is one-way: once found,
it stays on the map for the colony.

## Site kinds

| Kind | In build | Behaviour today |
|---|---|---|
| Wrecked rover | yes | salvage — **not** yet repairable back into the fleet |
| Abandoned mission | yes | salvage |
| Meteorite | yes | salvage, iron-heavy |
| Ice cave | yes | salvage (not yet a water source with its own rules) |
| Science cache | yes | salvage |
| Settlement site | yes | marker only — nothing to haul, a place worth building |
| Supply drop | yes | scheduled Earth cargo with a burial clock |

Sites are **silently ordinary** right now: no narrative logs, no radio traffic,
no survey confidence. That is the honest status of this pillar, not a
simplification — see [Roadmap and Status](Roadmap-and-Status.md).

## SALVAGE

Select a rover, tap a site, and the rover runs the `salvage` task:

1. cut bulk salvage free at **26 kg/s** — modified by the *same* weather and
   drivetrain multipliers that govern mining, so a storm slows a wreck-cut as
   honestly as it slows a drill;
2. fill its hold;
3. haul home;
4. go back out until the site is stripped.

Afterwards salvage is ordinary cargo: it lands in the silos through the same unload
path ore does. There is no special "wreck inventory" — the reward of exploration is
logistics.

A rover's `goal`/`phase` pair for this is `toSalvage` → `salvage`; refusals
(site already stripped, out of reach, no hull) are named in the inspector rather
than silent.

## Earth cargo missions

Drops are **scheduled, not generated**:

| Parameter | Value |
|---|---|
| First drop | **2–4 sols** in |
| Cadence | every **5–9 sols** |
| Landing distance | **30–85%** of the way out to the edge of your claim |
| Manifest | battery cells, replacement parts, specialised machinery, or scientific equipment |
| Burial clock | **3 sols**, and a storm runs it up to **3×** faster |

The transponder announces a bearing and a manifest, and an edge marker on the map
carries the deadline. **That clock is the whole design**: the drop is not lost
because time passed, it is lost because the sky came in while you were deciding. A
buried container is gone — refused, logged, and left on the landscape as a dim
marker.

Two consequences of the same honesty:

- **Drops contain no fluids.** Exposed water and food cargo would freeze, and the
  logistics model has no way to recover fluids in the field.
- **Surviving battery cells go straight into the grid store** when the rover strips
  the bulk cargo. Cells that exceed available battery capacity are **lost and
  logged** — there is no silent overflow into a magic warehouse.

## Still owed to this pillar (T6's exit criterion)

- **Survey confidence** — site contents are exact today; they should be a range
  until surveyed ("survey improves confidence; estimates before").
- **Expeditions as a decision** — a manifest is visible from the transponder, but
  there is no range/fuel planning and no multi-site routing.
- **Narrative content** — logs, radio messages and abandoned hardware that tell you
  something. The sites are silent placeholders right now.
- **Repairable wrecks** — GDD §06 wants a wreck you can bring back into the fleet,
  which means the garage's assembly line accepting a salvaged chassis (and there is
  now a price list to charge against: motors and boards as well as metal).
- **Deeper POI variety** — lava tubes and ice caves as rulesets, not flat salvage.
- **POI-specific markers** (issue #19).

## Related

- [Rover Logistics](Rover-Logistics.md) — how a task gets executed
- [World Generation](World-Generation.md) — how a site gets placed
- [Interface and Controls](Interface-and-Controls.md) — the minimap and world map
