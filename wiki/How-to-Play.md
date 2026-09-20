> ← [Home](Home.md)

# How to Play

*One human, two rovers, four sols of consumables, and a planet that does not
want you there.* This page is the loop; [Blueprint Reference](Blueprint-Reference.md)
has the numbers.

## The three chains

**The chain that keeps you breathing:**

```
ice deposit → [rover hauls] → Water Extractor → water → Oxygen Generator → O₂
                                                  └───→ Greenhouse → food
```

**The chain that lets you grow:**

```
iron deposit → [rover hauls] → Refinery → steel → Rover Garage / Radar Station
                                    ↑ 35 kW: the grid pays for every kilo
```

**The chain that builds machines:**

```
steel + aluminum ──→ Workshop (motors line) ──┐
silica + aluminum ─→ Workshop (boards line) ──┴→ component rack → Rover Garage → rover
                     one line at a time, your choice; 24 slots of rack
```

Oxygen kills in **hours**, water in **days**, food in **weeks** — so build in
that order. The *empty in…* estimates in the left panel are the real clock;
everything else is a detail.

## A workable opening

1. **Warehouse** — storage first, because mining outruns a 260 kg/resource silo
   immediately and a full silo throttles the fleet.
2. **Solar Array + Battery Bank** — 28 kW of peak sun and 200 kWh to survive the
   night. The pod's 14 kW RTG does not carry a night with industry running.
3. **Water Extractor** — 18 kW, and the first thing your rovers will feed.
4. **Oxygen Generator** — 12 kW of electrolysis; this is the one you cannot skip.
5. **Greenhouse** — closes the food loop on water and light.
6. **Habitat** — pressurised shelter that recycles **55%** of your water.
7. Then **Refinery** (35 kW, tier 2) — heavy structures are built from steel now,
   and steel is *made, not dug*. Budget the power before you pour the foundation:
   the furnace will brown out rather than borrow from your air.

With a steel silo behind it, a **Rover Garage** (30 kg steel) pays for itself:
32 kW charging (twice the pod's 16 kW) halves fleet downtime, the bay keeps
drivetrains at 100%, and the assembly line adds a **cargo rover** (3 t hopper,
120 kWh) for the long hauls.

## Orders, queues and routes

- Select a rover, then tap a deposit to mine, empty ground to move, or a
  battered/buried structure to clean or repair it.
- **Shift+order stacks** tasks into a queue — the inspector shows the route; a
  plain order replaces the queue. *Wait 1m* holds position between jobs.
- A mining task can become a **repeating haul route**: it loops the seam and
  parks at the depot only while the silo is full, resuming the moment
  consumption frees **60 kg** of room.
- Idle rovers self-dispatch: **auto-haul** fetches what the build queue is short
  of (construction outranks hauling), **auto maintenance** answers repair and
  cleaning jobs, **storm sheltering** recalls them, **auto-rescue** answers a
  stranded rover, and a **charge floor** (10–60%) sends it home before the ride
  gets expensive. Dispatch is energy-aware — it only accepts a seam the rover can
  reach, dig, and get back from — and **reserves seams** so the fleet spreads
  instead of dogpiling. Your explicit orders always win over any reservation.

A stranded rover (battery flat) goes dark and flashes a **yellow strobe**:
select another rover and tap it to jump-start.

## Living with the sky

Weather is a **field**, not a mood: each storm is a travelling system with a
local intensity, so a rover 20 m from the pad can sit in clear air while the
colony is hammered. Consequences you can plan around:

| Symptom | What it means | What to do |
|---|---|---|
| Solar output sagging, dust climbing | Panels are burying | Clean arrays (or let auto-maintenance do it) |
| *"Industry at 62%"* | Brownout — tiers shed from the bottom up | Charge batteries, kill the furnace, remember the RTG does not care about the sky |
| Lightning strikes | Dust ≥ 0.15 with real storm intensity | Shelter rovers, keep crews indoors, expect damaged arrays |
| EVA refused | The suit would not survive it | Wait it out — the sim aborts the walk before it becomes fatal |

Storms arrive with **60 s** of forecast lead (game seconds), **×2.25** with a
powered **Weather Radar Station** — which also plots storm cells and their
predicted tracks on the world map. Dust devils are possible from sol 3,
planetary dust events from sol 12.

## Getting off the pad

The map begins mostly unknown. The world scatters **sites** from your seed —
wrecked rovers, abandoned camps, meteorites, ice caves, science caches, a flat
spot worth building on — none inside 150 m of the pad and none *on the map*
until a rover or your colonist comes within **55 m**.

- Select a rover, tap a site, and it runs a **SALVAGE** task: cuts bulk salvage
  free at 26 kg/s, fills its hold, hauls home, goes back until the site is
  stripped. Salvage is ordinary cargo once it lands.
- **Earth cargo missions** are scheduled, not generated: the first lands 2–4
  sols in, then one every 5–9 sols, 30–85% of the way to the claim edge. The
  transponder gives a bearing and a manifest, and from that moment the container
  is on a **3-sol burial clock** that a storm runs up to three times faster. The
  drop is not lost because time passed — it is lost because the sky came in while
  you were deciding. A buried container is gone.

## Failure, softly

Rovers strand and get jump-started. A bolt bruises and can trip a structure
offline; it does not delete the colony. A worn drivetrain never costs you more
than half a work rate, so a colony can always dig itself out. The hard loss is
the one you do not notice: the colonist dies when the life-support chain stops,
and the ways to die now include lightning on an EVA.

## Difficulty and world options

Three presets are multipliers on the same simulation: **Settler** (0.85× appetite,
0.55× storms, 1.35× supplies), **Pioneer** (the intended expedition), **Survivor**
(1.2× appetite, 1.5× storms and lightning, 0.75× supplies). The wizard also lets
you set storm level, starting supplies, deposit richness and **spread** (how much
of the seam count sits in the near ring), world size (Outpost 840 m → Planetary
Survey 2.56 km claim), and a named landing region from the globe picker — or a
seed, which is the whole point: the same seed and options build the same planet.

## Next

- [Interface and Controls](Interface-and-Controls.md) — hotkeys, panels, gestures
- [Blueprint Reference](Blueprint-Reference.md) — costs, power, processes
- [Developer Mode](Developer-Mode.md) — the panel that never touches your save
