# Red Frontier

> *One human. A handful of machines. An entire planet that does not want you there.*
> Mars · 2066 — Real-Time Strategy · Survival · Automation · Exploration

A browser-first Mars survival RTS. This repository currently contains the
**Prototype 1 vertical slice**: a playable 3D browser demo of terrain, an orbit
camera, autonomous rovers, procedural resource deposits, mining, cargo/inventory,
and staged building construction.

Design & technical specifications are captured in [`docs/design/GDD.md`](docs/design/GDD.md)
and [`docs/design/TDD.md`](docs/design/TDD.md) (faithful copies of the shared source documents).

## Running it

```bash
npm install
npm run dev          # local dev server (Vite), http://localhost:5173
npm run build        # type-check + production build to dist/
npm run preview      # serve the production build
npm run typecheck    # TypeScript type-check only
npm run test:sim     # headless simulation tests (Node)
```

## Play it

On the start screen pick a world seed (and starter-deposit abundance), then **Begin Mission**.

- **Drag** — rotate the camera around the base
- **Mouse wheel / pinch** — zoom
- **Shift+drag** (desktop) / **two-finger drag** (mobile) — pan
- **Click/tap a rover** — select it (inspector opens on the right)
- With a rover selected:
  - **tap a deposit** → order it to mine
  - **tap the ground** → move
  - **right-click the ground** → quick move order
- **Build palette (bottom)** — pick a building, then click terrain to place it. An
  idle rover is dispatched automatically to construct it once materials are in storage.
- **Space** toggles pause; **Ctrl/Cmd+S** saves; **1–5** shortcut the build palette; **Esc** cancels.

Goal loop: mine regolith/iron near the pad → build a **Warehouse** to expand storage →
stockpile enough to erect **Solar arrays, batteries, a workshop, and a habitat**.
Materials only count toward builds once they sit in colony storage, so storage capacity
is the early bottleneck.

## What is simulated (this slice)

- **Deterministic, fixed-timestep sim (20 Hz)** running as a framework-agnostic module
  (structured so it can later move onto a Web Worker without rewiring rendering/UI).
- **Two rover types** (Mining, Utility) with battery, cargo capacity, movement energy
  drain, low-power auto-return to the base charger, and task commands (move / mine /
  auto-haul / auto-build).
- **Procedural Mars terrain** from a world seed + scattered deposits (regolith, iron,
  silica, aluminum, water ice).
- **Staged construction**: placement → builder dispatched → materials committed from
  colony storage → build progress → online. Warehouses grow storage capacity.
- **Colony storage** is capacity-bounded (base pad + online warehouses).
- **Save/load** (IndexedDB via `localStorage` snapshots): save simulation state only,
  never renderer state; deterministic restore; auto-save every 45 s + on demand.

## Module layout

```
docs/design/        GDD + TDD reference copies
src/
  main.ts           entry point
  app/              Game loop, input, camera rig, command dispatch
  sim/              framework-agnostic simulation (no DOM / no three.js)
    config.ts       balance constants
    defs.ts         data-driven blueprints (resources, rovers, buildings)
    World.ts        seeded terrain + deposits
    Simulation.ts   entities, tasks, construction, persistence
  render/           three.js renderer (terrain, rovers, buildings, deposits, picking)
  ui/               DOM HUD (resources, inspector, build palette, log, overlays)
  lib/              deterministic RNG + simplex noise
tests/              headless simulation tests
scripts/            esbuild test runner
```

## Architecture decisions (this slice)

Following the TDD's *gradual* path:

- The simulation is an isolated, side-effect-free-by-construction module. Rendering and
  UI only *read* it (per frame we call `renderer.sync(sim)`), matching "the renderer
  never owns authoritative gameplay state".
- Simulation runs on the main thread **for now**; because it has zero DOM/three.js
  imports and a fixed timestep, porting it to a `Worker` (TDD §16) is a contained change.
- Data (resources, blueprints, recipes, balance) lives outside game logic in `defs.ts`.
- Determinism: seeded PRNG, integer fixed ticks, stable iteration order. Verified by
  `tests/sim.test.ts`.

## Next milestones (per GDD §16 / TDD §25)

1. **Move the sim to a Web Worker** (TDD T1–T2 hardening) + a human colonist unit.
2. **Prototype 2** — real power network (solar/battery/consumers + day/night), then the
   water/oxygen/food life-support loop.
3. **Prototype 3+** — weather (dust storms that cut solar + degrade equipment),
   then procedural exploration, research, and colonists.
