> ← [Home](Home.md)

# Rendering and Audio

Presentation reads the colony and **never writes it**. Everything in `src/render/`
and `src/audio/` is a consumer of `SimView`, and both animate on **sim time** — so a
pause freezes the FX while the world keeps sounding, and a replay is byte-for-byte
deterministic whether the sound is on or off.

## The renderer

[`src/render/Renderer.ts`](https://github.com/iant89/red-frontier/blob/main/src/render/Renderer.ts)
owns a three.js **WebGL2** scene, synced once per frame with
`renderer.sync(view)`. The camera rig (orbit / pan / zoom / focus-selection) lives
on the app side in `src/app/CameraRig.ts`, not in the renderer.

There is **no WebGPU path** — the original GDD target, still OUT. A splash screen
says so rather than rendering a black canvas, because WebGL2 is a hard requirement.

### Terrain material

- A **2×2 PBR atlas** (albedo / normal / roughness / metallic / AO / height) sampled
  per texel from `public/textures/pbr/`.
- A world-spanning **macro albedo** composed once from the same source imagery, so
  the colour map reads as a landscape rather than wallpaper.
- **Specular follows slope and dust.**
- A **neutral material is generated when the sheets are missing**, so the game never
  depends on a texture download.

Mesh geometry is sized to `world.half` with segment count scaled to match — see
[World Generation](World-Generation.md).

### Day, night and the sky

The authoritative `SunState` drives sky colour, fog keyframes, shadow direction, the
shadow map's near plane (30), and **panels physically tilting to track the sun**. No
second clock exists, so the sky can never disagree with a production number.

A **skybox / star field is still OUT** (issue #16): the scene has no environment
map, which is why metalness is deliberately kept low on the descent stage.

### Particles

One system, **9 000 motes**, in `src/render/particles/`:

| Property | Value |
|---|---|
| Emission field | camera-scaled, 45–1 000 m, feathered at the wrap rim so no box is ever visible |
| Turbulence | one coherent divergence-free curl roll (≈157 m cells) plus per-mote scatter |
| Storm grit | kept visibly finer than wind-blown dust |
| Rates | view-independent, so screen-space density is constant for free |
| Worst measured case | 6 155 / 9 000 — five devils at their growth cap inside a severe storm |

Every emitter takes an **injectable RNG**, so FX are deterministic and run on sim
time. The ceiling is pinned by `tests/render/particles.test.ts`.

### Props with a body

Presentation-only, never in a save, and derived as pure functions of sim time:

- **Descent stage** — a ~56 m hull on three splayed legs at load-bearing azimuths,
  a two-pass reentry burn on the windward flank that glows at night.
- **Weather Radar Station** — azimuth dish, nodding RAXpol feed, spinning
  anemometer cups, wind vane, status LEDs.
- **Selection ring** — a true circle with a pulsing white halo that breathes on sim
  time (issues #9/#10).
- Building contribution markers, a damage ring, and the **lightning flash**: a
  double-flash envelope driving a point light at the strike's world position, read
  straight from `weather.lastStrike`.

### The GLB asset pipeline

Plumbing **IN**, art **OUT**. `assetCatalog.ts` maps logical ids (derived from the
blueprint kinds) to `public/models/…`; `ModelRegistry` loads, clones and preloads;
every mesh factory asks the registry **first** and falls back to the existing
procedural mesh on a miss. With the models tree empty — as it is today, apart from a
0.6 KB fixture — visuals are identical to pre-pipeline.

To use it: drop `.glb` files at the catalog paths. Rover night lights and solar
tracking expect **named nodes**. `tests/render/glb-assets.test.ts` pins the fallback
contract: a missing or broken asset degrades, it does not crash.

### Water overlay

`WaterNetworkOverlay.ts` draws pipe routes, directional flow beads and amber
diamond markers at ports needing attention
([Water Networks](Water-Networks.md)). `WeatherFX.ts` is the FX director: it derives
`viewRadius` and `windRamp` and decides how hard the sky reads.

## Audio

[`src/audio/AudioSystem.ts`](https://github.com/iant89/red-frontier/blob/main/src/audio/AudioSystem.ts)
synthesises the whole soundscape on a Web Audio graph. **There are no sound files** —
deliberately *not* the original PDF's plan — so a fresh offline build has a
soundscape and there is no network race at boot.

| Layer | Mixes from |
|---|---|
| Command-deck ambience | menus only |
| World drone, wind, storm grit | wind speed, dust, storm intensity |
| Machinery | active rovers, online buildings |
| Power warnings | grid satisfaction, brownout state |
| Cues | every player and dev command, select, reject, saved, mission-start, alert, lightning |

- **The pause contract.** Machinery is time-bound and fades out at speed 0; world
  ambience, wind, storm and the brownout reminder stay audible. Inspecting a frozen
  colony never goes silent.
- **Autoplay policy.** The graph unlocks on the first real pointer/key gesture —
  that is why the first click matters, and it is also why the very first tap in a
  session can look like a dead button.
- **Command cues are exhaustive by construction**: the `COMMAND_CUES` map is keyed
  by the command union, so adding a command without a cue is a type error.
  `tests/audio/system.test.ts` pins the whole map.

**Still OUT:** a user-facing mute/volume setting (the one shipped feature a player
cannot turn off —
[issue backlog](https://github.com/iant89/red-frontier/blob/main/ISSUES.md)), music,
and interior/exterior acoustic distinction.

## Motion and performance

- Render resolution is a setting: **ultra ≤2× / high ≤1.5× / performance 1×**, plus
  toggles for shadows and weather FX.
- The renderer needs a GPU, so it is **not** covered by the headless suites beyond
  GPU-free checks (particle budget/coherence, leg clearances, animation, fallback
  contract, selection pulse). The real gate is `scripts/mobile-smoke.mjs` in headless
  Chromium.
- `draw calls < 1 000` is a stated target that is **still not instrumented** — see
  [Performance Budgets](Performance-Budgets.md).

## Related

- [Interface and Controls](Interface-and-Controls.md) — the DOM half of presentation
- [Architecture Overview](Architecture-Overview.md) — why presentation cannot write
