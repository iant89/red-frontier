> ← [Home](Home.md)

# Roadmap and Status

An honest map of **what the browser build does today** versus what the design
documents still promise. Vocabulary used everywhere in this wiki and in the GDD:

| Tag | Meaning |
|---|---|
| **IN** | shipped and gated by tests / playable in the build |
| **PARTIAL** | present in a reduced form; design depth still open |
| **OUT** | not in `src/` yet — still a design commitment |

## Where the build sits

| Slice | Theme | Status |
|---|---|---|
| **P1** | terrain / camera / human / rover / resources / mining / inventory / construction | **IN** |
| **P2** | power / batteries / O₂ / water / food / day-night | **IN** |
| **P3** | wind / dust / storms / degradation | **IN** |
| **P4** | rover tasks / automation / logistics / charging / haul routes / garage | **IN** |
| **P5** | refining / manufacturing / utility networks / maintenance depth | **PARTIAL** — four slices in |
| **P6** | procedural exploration / supply drops / salvage / expeditions | **PARTIAL** — first slice in |
| **P7** | colonists / skills / agriculture depth / medicine | **OUT** |
| **P8** | nuclear / underground / advanced robotics / closed-loop | **OUT** |

And the technical tiers (TDD §25): **T1–T5 IN**, **T6 PARTIAL**, **T7 OUT**,
**T8 PARTIAL** (migrations v3→v13 in, sim budgets measured and enforced in;
on-device frame budgets and sim LOD out).

### The four shipped P5 slices

| Slice | What it added | Save |
|---|---|---|
| 1 · Refining | `steel` as a refined `ResourceId`, the Refinery, heavy blueprints priced in steel, "a process earns its output" | v9 |
| 2 · Manufacturing | `ComponentId` on a counted ledger with rack slots, `RECIPES` + per-building line selection replacing one-process-per-building, rovers priced in motors and boards | v10 |
| 3 · Maintenance | installed part wear + timed Repair Bay replacement | v11 |
| 4 · Water | pipes, pumps, per-port tanks, safe commissioning | v12 |

Engineering & customisation (permanent tiers, timed refits, paint) closed as a
fifth increment at **v13**. The MVP building set from GDD §16 is complete, and so is
GDD §03's replication chain: **ore → steel → components → machine**.

The **30-phase architectural refactor roadmap is complete**: systems extracted,
`ColonyState` formalised, persistence and app controllers split out, the host seam
strengthened, and the debug/perf harness in place. What remains is *content and
product*, not structure.

## What is IN, by system

| System | Status | Notes |
|---|---|---|
| Terrain + orbit camera + day/night | IN | seeded window on a Mars globe landing site; MOLA-derived relief prior |
| One human + EVA suit O₂ | IN | single crew; skills and multi-colonist OUT |
| Rovers (utility, mining, cargo) | IN | Scout kind still OUT |
| Rover proximity awareness | IN | hull-clearance crawl; no collision physics, no re-pathing |
| Mining, inventory, staged construction | IN | Materials Reserved + assembly |
| Power grid | IN | pure resolver, tiers 0–3, even shedding |
| Water → oxygen → food | IN | fluids in building tanks; no field-fluid logistics |
| Weather, dust, storms, degradation | IN | four storm classes, forecast, per-entity sampling |
| Lightning | IN | dust-gated hazard on structures, rovers and an EVA crew |
| Weather Radar Station | IN | 520 km scope, tracks on the world map, 2.25× forecast lead |
| Rover task queue, routes, automation | IN | garage charge / service / assemble |
| Refining, manufacturing, maintenance | IN | see the P5 table above |
| Water utility networks | IN (commissioned) | power + water only; atmosphere / heat / data OUT |
| Minimap + world map | IN | canvas chrome over the read model |
| Procedural audio | IN | synthesised, presentation only; **no mute/volume setting** |
| Desktop + mobile UI, alerts, save/load | IN | `localStorage` slots, configurable autosave, in-play update card |
| Developer mode | IN | runtime-only overlays; fabrications persist |
| Profiling / benchmark / replay harness | IN | dev-only, tree-shaken |
| First-30-minutes onboarding | IN | 12 milestones, forecast-driven warnings ("water runs dry in 1.8 sols"), dismissible hints, opt-in funnel |
| Engineering projects + unlock registry | IN | five data-driven projects in `src/sim/projects/`, five unlocks, projects panel; **nothing is gated on an unlock yet** |
| **POIs, SALVAGE, supply drops** | **PARTIAL** | discover + strip + burial clock; no survey confidence, no narrative logs |
| Research tech tree | OUT | no `research` symbol anywhere in `src/` |
| Multi-colonist skills / medicine | OUT | architecture hooks only (one `Colonist`) |
| Nuclear / underground / closed-loop endgame | OUT | the RTG Array is a small baseload stand-in, not a reactor |
| Victory conditions | OUT | there is no victory checker; the only hard loss is a dead colonist. The nearest thing is the **Autonomous Colony** project, which needs ten sols without a manual order and sits at the end of the project chain |

## The open list, in the order the code argues for it

1. **Live with the worker as the default, then delete the fallback.** The gate is in
   place on both transports; what is missing is a release or two of soak, after
   which `createHost`'s in-process branch (and `LocalSimHost`'s use outside tests)
   can go. Optional later, each behind its own guard: a true 20 Hz worker timer with
   render interpolation, transferables for terrain, `OffscreenCanvas`. None of it is
   measured as a bottleneck today.
2. **Finish P5's depth**: a second refined material (glass from silica), a wider
   parts catalogue (valves), further utility networks (oxygen, heat, data), and
   building-level component wear. Plus GDD §04's **Laboratory** and **Nuclear
   Reactor**.
3. **Finish T6**: survey confidence, expeditions as a real decision (range/fuel
   planning, multi-site routing), narrative content, repairable wrecks entering the
   garage line, lava tubes and ice caves as rulesets, POI-specific markers (#19).
4. **Presentation gaps already on the backlog**: a skybox/star field (#16), changelog
   data generated from Git instead of the hand-curated table (#15), a device check on
   the mobile one-finger pan (#1).
5. **Audio settings** — a mute/volume row. The soundscape is the one shipped feature
   a player cannot turn off.
6. **TDD §22 remainder** — surface the profiler and the state hash in the dev panel,
   plus teleport/reveal.
7. **T7** — the research DAG, agriculture depth, multi-colonist.
8. **Persistence upgrade** — IndexedDB if slot size or quota becomes a real limit;
   a service worker for offline.

### The ordering conflict, and how it was answered

GDD §16 puts **refining at P5** and exploration at P6; TDD §25 folds POIs into
**T6** and never gives refining its own tier. The build took a slice of each, in the
order they were worth doing: **P4 → first P6 slice → P5 slices 1–4**. So the open
product question is no longer *which pillar comes next* but **whether the remaining
engineering depth is worth more than finishing exploration** — and TDD §25 still has
no tier for the industrial layer, which is why P5 progress is tracked in GDD §0/§16
and TDD Appendix B rather than in a T-row of its own.

## Acceptance test for the prototype

A fresh world can (and the suites and smokes assert most of it): generate terrain
from a seed · spawn a player and two rovers · mine regolith, iron, ice, silica and
aluminum · construct all fifteen blueprints · smelt ore into a refined material and
build heavy structures from it · machine components and build a rover from them ·
run day/night · lose solar output and take damage in a dust storm · vary weather
across the claim and strike lightning · dispatch rovers automatically · save,
reload, identical state hash · discover POIs, salvage, and recover a drop before
burial · play with sound, on a worker, on a phone-sized screen.

**The most important criterion, unchanged:** the simulation stays understandable,
deterministic, recoverable and performant under pressure from Mars — not visual
fidelity first.

## Related

- [`GDD §16`](https://github.com/iant89/red-frontier/blob/main/docs/design/GDD.md) ·
  [`TDD §25 + Appendix B`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md) ·
  [`ISSUES.md`](https://github.com/iant89/red-frontier/blob/main/ISSUES.md) ·
  [`mnemosyne.md`](https://github.com/iant89/red-frontier/blob/main/mnemosyne.md)
- [Contributing](Contributing.md)
