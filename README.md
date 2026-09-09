# Red Frontier

> *One human. A handful of machines. An entire planet that does not want you there.*
> Mars · 2066 — Real-Time Strategy · Survival · Automation · Exploration

A browser-first Mars survival RTS. This repository currently contains the
**Prototype 4 vertical slice**: everything from Prototypes 1–3 (terrain, orbit
camera, autonomous rovers, mining, staged construction, the power grid, the
Mars sol, the water → oxygen → food life-support chain keeping one human alive,
and weather — wind, dust that buries your panels, forecastable storms that dim
the sun and batter exposed hardware) plus **rover logistics** — queueable task
orders, repeating haul routes, per-rover automation rules, deposit
reservations that spread the fleet across seams, a Rover Garage that
fast-charges, services drivetrains and assembles new rovers, and the wear &
jump-start recovery loop that keeps the machines on the road.

Design & technical specifications live in [`docs/design/GDD.md`](docs/design/GDD.md)
and [`docs/design/TDD.md`](docs/design/TDD.md).

## Running it

```bash
npm install
npm run dev          # local dev server (Vite), http://localhost:5173
npm run build        # type-check + production build to dist/
npm run preview      # serve the production build
npm run typecheck    # TypeScript type-check only
npm run test:sim     # headless simulation + HUD tests (Node)
npm run test:sim sim # just the simulation suite
npm run test:sim hud # just the HUD suite
```

## How to survive

You land with a descent stage, two rovers, and roughly four sols of air, water
and rations. Everything after that you build.

**The chain that keeps you breathing:**

```
ice deposit → [rover hauls] → Water Extractor → water → Oxygen Generator → O₂
                                                  └───→ Greenhouse → food
```

A workable opening: **Warehouse** (storage) → **Solar + Battery** (power that
survives the night) → **Water Extractor** → **Oxygen Generator** → **Greenhouse**
(closes the food loop) → **Habitat** (recycles 55 % of your water). Once the
chain holds, a **Rover Garage** pays for itself — 40 kW charging halves the
fleet's downtime, the bay keeps drivetrains at 100%, and the assembly line can
add a **cargo rover** (3 t hopper, 120 kWh) for the long hauls.

Oxygen kills in hours, water in days, food in weeks — so build in that order.
Watch the *empty in…* estimates on the left panel; they are the real clock.

### Controls

| Action | Desktop | Touch |
|---|---|---|
| Rotate camera | drag | drag |
| Zoom | wheel | pinch |
| Pan | Shift+drag / middle-drag | two-finger drag |
| Select | left click | tap |
| Context order (move / EVA) | right click | long press |
| Build | pick from palette, click terrain | tap palette, tap terrain |
| Place several | Shift+click | — |
| Queue rover orders | Shift + move/mine/repair/clean | — |
| Pause | `Space` | ❚❚ button |
| Cycle overlays | `V` | overlay buttons |
| Focus selection | `F` | Focus button |
| Blueprints 1–9 | `1`…`9` | — |
| Save | `Ctrl/Cmd+S` | auto every 45 s |

Select a rover, then tap a deposit to mine it, the ground to move, or a
battered/buried structure to clean or repair it. **Shift+order** stacks tasks
into a queue — the rover's inspector shows the route — and a *Wait 1m* button
holds position between jobs. A mining task can be set as a **repeating haul
route** that loops the seam and pauses at the depot only while the silo is
full. A stranded rover (battery flat) shows a pulsing beacon: select another
rover and tap it to jump-start.

Each rover carries its own automation levers in the inspector: **auto-haul**
(fetch what the build queue is short of), **auto maintenance** (repair and
panel-cleaning dispatches), **storm sheltering**, **auto-rescue**, and a
**charge floor** (10–60%) that recalls it before the ride home gets
expensive. Auto dispatch **reserves seams** so the fleet spreads across
deposits instead of dogpiling — a rich seam is still shared, a worked-out
scrap heap never is, and no rover idles merely because its nearest seam is
taken.

The **Rover Garage** fast-charges at 40 kW (twice the pod), services parked
rovers' drivetrains back to 100%, and its assembly line builds **utility,
mining and cargo rovers** from stockpiled parts. Work wears drivetrains — a
worn rover works at as little as half rate — so schedule garage time before
the fleet grinds to a crawl.

Select your colonist and right-click to send them on an EVA — the suit carries
a finite oxygen reserve, so the sim refuses walks it knows they cannot survive
(and refuses all of them in a storm).

When the forecast turns ugly: charge the batteries, shelter the crews, clean
the arrays — and remember the RTG does not care what the sky is doing.

## What is simulated

### Power grid (`sim/power.ts`)
A pure, deterministic resolver: generation → batteries → consumers, allocated by
**priority tier** (0 life support, 1 oxygen & water, 2 industry, 3 logistics).
Tiers are served in order and shed from the bottom up; within a tier every
consumer degrades by the same fraction, so a brownout reads as *"Industry at
62 %"* rather than an arbitrary subset going dark. Solar output tracks the
authoritative sun, batteries buffer the night, and the descent-stage RTG is the
14 kW that keeps you alive until you build something better.

### The Mars sol (`sim/clock.ts`)
A sol is 24 h 39 m of Mars time compressed into 4 minutes at 1× speed. One
`SunState` drives solar generation, greenhouse growth, sky colour, shadow
direction and the panels physically tilting to track the sun — TDD §12's
"single authoritative sun".

Energy and life support are authored in *Mars time* (kW·h per Mars hour, kg per
sol) so the numbers read like real engineering figures, while mining and
construction are paced in *game seconds* for playability. `HOURS_PER_SEC` and
`SOLS_PER_SEC` bridge the two.

### Life support (`sim/lifesupport.ts`)
Fluids (water, oxygen, food) live in tanks provided by buildings, entirely
separate from the bulk solids rovers haul. The colonist consumes 0.84 kg O₂,
4 kg water and 1.5 kg food per sol; a habitat reclaims 55 % of the water. Going
outside puts them on a finite suit reserve, and the sim aborts an EVA before it
becomes fatal.

### Automation
Idle rovers work out what the build queue is short of and go fetch it, keeping a
standing ice order weighted by how thin the water reserve is. Construction
outranks hauling (TDD §8), so a stocked site always gets a builder. Explicit
player orders always win.

Auto dispatch is energy-aware — it only sends a rover to a seam it can reach,
dig a worthwhile load from, *and get home from*, reserving enough battery for
the ride back. Deposit reservations spread the fleet: auto runs prefer
unclaimed seams, share rich ones, and never idle a rover because its nearest
seam is held. A player order outranks any reservation.

### Rover logistics (P4)
Rovers carry a **task queue** (`moveTo`, `mine`, `construct`, `clean`, `repair`,
`recover`, `wait`); the head task is the current command, the rest wait.
Shift+orders append; a plain order replaces the queue. A `mine` task can repeat
as a **haul route** that parks at the depot while the silo is full and resumes
the moment consumption frees 60 kg of room.

**Wear & recovery:** tool work, driving and storms grind drivetrain condition;
below 45% a rover works progressively slower (never below half rate — rovers
fail *soft*). A battery-flat rover strands with a beacon; a rescuer transfers
just enough charge for the ride home. The garage bay services parked rovers
back to 100%.

Materials flow into sites *without* a rover parked there — the "Materials
Reserved" stage of TDD §7. A site quietly accumulates regolith while a rover
fetches iron, and cancelling one refunds everything already delivered.

### Alerts (`sim/alerts.ts`)
Conditions that are *currently true* (raised once, cleared once) are kept
distinct from events that *happened* (streamed to the log). That separation is
what stops a brownout producing 200 identical log lines.

## Module layout

```
docs/design/        GDD + TDD reference copies
src/
  main.ts           entry point
  app/              Game loop, input, camera rig, command dispatch
  sim/              framework-agnostic simulation (no DOM / no three.js)
    config.ts       balance constants + the two time bases
    defs.ts         data-driven blueprints (resources, fluids, rovers, buildings)
    clock.ts        Mars sol clock + authoritative sun
    power.ts        pure power-grid resolver
    lifesupport.ts  fluid pools, colonist needs, health
    alerts.ts       alert bus (conditions) + event log (occurrences)
    weather.ts      wind, dust, storm scheduler + envelopes
    World.ts        seeded terrain + deposits
    Simulation.ts   entities, tick order, construction, persistence
  render/           three.js renderer (terrain, entities, day/night, overlays)
  ui/               DOM HUD (vitals, alerts, inspectors, build palette)
  lib/              deterministic RNG + simplex noise
tests/              headless simulation + jsdom HUD tests
scripts/            esbuild test runner
```

## Architecture

- **The simulation is authoritative.** It has zero DOM and zero three.js
  imports; rendering and UI only read it (`renderer.sync(sim)` per frame).
  Moving it onto a Worker (TDD §16) remains a contained change.
- **Determinism is enforced, not hoped for.** Seeded PRNG, integer tick counter,
  stable iteration order. The tick accumulator holds its remainder in
  `[0, step)` and telescopes, so 60 s delivered in 3 600 ragged browser frames
  runs exactly as many ticks as 60 s delivered in one call — there is a test
  for precisely this. Weather runs on its own seeded stream and a pure
  storm envelope, so two colonies with the same seed live through the same
  skies (also tested, through a save/restore).
- **Data drives content.** Resources, fluids, blueprints, processes, power
  tiers and balance all live in `defs.ts`/`config.ts`, outside game logic.
- **Storage is per-resource,** not one shared pool. A shared pool lets a single
  rover-load of regolith deadlock every other supply chain, which reads as a bug
  rather than a bottleneck.
- **Saves are versioned** and refuse to load a schema they don't understand
  rather than silently corrupting a colony. v3 saves (Prototype 3) migrate to
  the v4 schema on load: rovers gain a task queue, drivetrain condition and
  automation rules, and buildings gain an assembly slot.

### Testing

`npm run test:sim` runs 86 checks across two suites, covering TDD §21's
categories:

- **Unit** — power allocation, tier shedding, energy conservation, the sun
  model, dust transmission and visibility.
- **Integration** — ice → water → oxygen actually produces oxygen; a full colony
  reaches a sustainable steady state with a net-positive food loop; batteries
  charge by day and drain by night; switching a building off drops grid demand;
  storms cut solar, bury arrays, damage structures, shelter crews, refuse EVAs,
  and recover; the full cascade (storm → solar collapse → battery strain →
  repair and recovery) runs end to end. The P4 suite covers the queue (order,
  replace, WAIT), haul routes parking on a full silo and resuming, seam
  reservations (claim, player override, fleet spread), jump-start recovery,
  drivetrain wear slowing work, garage service/fast-charge/assembly, per-rover
  automation rules, the v3→v4 save migration, and a P4-heavy state round-trip.
- **Determinism** — identical seeds and identical elapsed time produce identical
  state hashes regardless of frame pacing; weather is identical across replays
  and across a save/restore.
- **Persistence** — snapshot/restore round-trips exactly, a reloaded colony
  continues identically, and bad saves are rejected.
- **HUD** — every panel exists and patches live under jsdom; callbacks fire;
  the weather panel and the maintenance inspector track the sim.

The renderer needs a GPU and is not covered headlessly.

## Next milestones (per GDD §16 / TDD §25)

1. **Move the sim to a Web Worker** (TDD T1–T2 hardening).
2. **Prototype 4+** — research, procedural exploration, supply drops, rover
   recovery missions, and more colonists.
