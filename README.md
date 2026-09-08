# Red Frontier

> *One human. A handful of machines. An entire planet that does not want you there.*
> Mars · 2066 — Real-Time Strategy · Survival · Automation · Exploration

A browser-first Mars survival RTS. This repository currently contains the
**Prototype 2 vertical slice**: everything from Prototype 1 (terrain, orbit
camera, autonomous rovers, mining, staged construction) plus the three systems
that turn it into a survival game — a **power grid**, the **Mars sol**, and the
**water → oxygen → food** life-support chain keeping one human alive.

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
(closes the food loop) → **Habitat** (recycles 55 % of your water).

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
| Pause | `Space` | ❚❚ button |
| Cycle overlays | `V` | overlay buttons |
| Focus selection | `F` | Focus button |
| Blueprints 1–9 | `1`…`9` | — |
| Save | `Ctrl/Cmd+S` | auto every 45 s |

Select a rover, then tap a deposit to mine it or the ground to move. Select your
colonist and right-click to send them on an EVA — the suit carries a fixed
oxygen reserve, so the sim refuses walks it knows they cannot survive.

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
  stable iteration order. Tick counts are derived from *total elapsed time*
  rather than an accumulated remainder, so 60 s delivered in 3 600 ragged
  browser frames runs exactly as many ticks as 60 s delivered in one call —
  there is a test for precisely this.
- **Data drives content.** Resources, fluids, blueprints, processes, power
  tiers and balance all live in `defs.ts`/`config.ts`, outside game logic.
- **Storage is per-resource,** not one shared pool. A shared pool lets a single
  rover-load of regolith deadlock every other supply chain, which reads as a bug
  rather than a bottleneck.
- **Saves are versioned** and refuse to load a schema they don't understand
  rather than silently corrupting a colony.

### Testing

`npm run test:sim` runs 55 checks across two suites, covering TDD §21's
categories:

- **Unit** — power allocation, tier shedding, energy conservation, the sun model.
- **Integration** — ice → water → oxygen actually produces oxygen; a full colony
  reaches a sustainable steady state with a net-positive food loop; batteries
  charge by day and drain by night; switching a building off drops grid demand.
- **Determinism** — identical seeds and identical elapsed time produce identical
  state hashes regardless of frame pacing.
- **Persistence** — snapshot/restore round-trips exactly, a reloaded colony
  continues identically, and bad saves are rejected.
- **HUD** — every panel exists and patches live under jsdom; callbacks fire.

The renderer needs a GPU and is not covered headlessly.

## Next milestones (per GDD §16 / TDD §25)

1. **Move the sim to a Web Worker** (TDD T1–T2 hardening).
2. **Prototype 3 — weather.** Dust accumulation on panels, wind, and storms that
   cut solar and damage exposed equipment. The `dustTransmission` hook and the
   maintenance-shaped gaps in the building model are already in place for it.
3. **Prototype 4+** — research, procedural exploration, supply drops, and more
   colonists.
