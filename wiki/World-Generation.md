> ← [Home](Home.md)

# World Generation

A planet that is a **function of a seed**, on both sides of the worker boundary.
That single property is what lets terrain be re-derived instead of transmitted, and
what makes "the same seed builds the same planet" a testable claim rather than a
promise.

## Two layers: a globe, then a window

1. **Pick a landing site** on a compact geographic Mars —
   [`src/sim/marsGlobe.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/marsGlobe.ts):
   biomes, elevation, and which regions are landable, sampled from a MOLA-derived
   elevation table (`marsDem.ts`).
2. **Generate the playable window** around that site —
   [`src/sim/terrain.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/terrain.ts):
   local height and material from the seed, using a MOLA-relief prior plus seeded
   broad landforms and HiRISE-scale local geology (mixed-age craters, grit, rim
   rocks).

The **globe picker** offers **18 named landable regions** — Amazonis, Chryse,
Utopia, Elysium, Isidis, Meridiani, Arabia, Noachis, Hellas, Syrtis Major, Gale,
Jezero, Gusev, Oxia Planum and the rest — each with a biome and a jitter radius. It
is a spinnable three.js globe whose surface texture is **generated from the same
elevation model the terrain sampler uses**, so no imagery ships with the game.

A seed alone picks the site; a chosen region constrains it. The landing site is
fixed before the window is generated, so `seed + region` is the whole input.

## World sizes

| Id | Label | Half-extent | Claim |
|---|---|---|---|
| `small` | Outpost | 420 m | 840 × 840 m |
| `medium` | Territory | **640 m** (default) | 1.28 × 1.28 km |
| `large` | Province | 960 m | 1.92 × 1.92 km |
| `planet` | Planetary Survey | 1 280 m | 2.56 × 2.56 km |

The chosen half-extent (`world.half`) drives the **terrain mesh, nav grid, camera
bounds and POI scatter**. This was not always so: the mesh was hard-coded to the
default, which left the largest map driving off into void — issue #17, now fixed
and regression-covered.

The playable region is `[-WORLD_HALF, WORLD_HALF]²` with 1 unit = 1 m, and the
landing clear zone is a flat **26 m** radius (`SPAWN_RADIUS`) at the origin. Siting
respects the pod's own **8 m** exclusion radius.

## Terrain is a pure function — and that is a load-bearing fact

Heights, slope and surface geology are derived from the seed. So:

- the **worker never sends terrain** to the main thread; the mirror re-derives it
  from the seed the worker reported;
- the build ghost can answer `canPlace` **synchronously** by running the same
  `evaluateSite` the simulation runs
  ([`src/sim/rules.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/rules.ts)) —
  one tick of lag, never a different rule;
- a save does not need to store a single height value.

Chunk streaming is **OUT** by design: the world is a fixed window, small enough to
sim entirely, so `Simulation` keeps no LOD tiers.

## Deposits

Procedural, with size and concentration rolled from the seed, and shaped by two
wizard options:

| Option | Values | Effect |
|---|---|---|
| **Richness** | poor / standard / rich | how much is in a seam |
| **Spread** | scarce / standard / plentiful | **8% / 20% / 34%** of seams placed in the near ring around the pad |

Spread is the "forgiving first week vs long treks to the good seams" dial, and it is
saved with the colony. Refined material (`steel`) **cannot** have a seam — deposits,
world scatter and the dev "survey in a seam" backdoor are typed to *mined*
resources only.

## Navigation

[`src/sim/navgrid.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/navgrid.ts)
holds the walk/build grid, a reachability flood, and a **zero-allocation A\*** with
a binary min-heap. Movement is not physics: rovers follow the grid, and the
hull-clearance crawl (see [Rover Logistics](Rover-Logistics.md)) modulates speed
rather than steering. Collision resolution, re-pathing around obstacles and
per-part failures are **OUT**.

Pathfinding is budget-tested, not assumed: **avg query <3 ms at 50 rovers**, with a
suite that fails the build if scaling goes quadratic
([Performance Budgets](Performance-Budgets.md)).

## Siting rules

`evaluateSite` answers one question in one place — *can this building go here* —
and every consumer gets the same verdict: the palette ghost, the worker's
`applyCommand`, the Repair Bay/Garage placement checks, and developer-mode spawns,
which pass the **real** siting checks and arrive online rather than glued down.

## What generation is not

- **Not streaming.** One seeded square window, no infinite world.
- **Not a heightmap asset.** Everything is computed; the only texture inputs are the
  PBR atlas in `public/textures/pbr/`, and a neutral material is generated if the
  sheets are missing, so the game never depends on a texture download.
- **Not a physical Mars.** The globe is *compact and honest about scale* — an
  elevation and biome prior that makes your landing region read like a place, not a
  GIS client.

## Related

- [Weather and Hazards](Weather-and-Hazards.md) — the sky above the window
- [Architecture Overview](Architecture-Overview.md) — why pure functions matter here
