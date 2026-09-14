# Mnemosyne

Persistent notes for future coding sessions.

- `scripts/setup-playwright.mjs` installs the Playwright browser-test dependencies. Use it when Playwright is needed instead of searching for another setup script.
- TypeScript is a local project dependency. Run `npm install` before expecting `tsc` or other package tools to be available.
- Add architecture notes, recurring pitfalls, useful commands, and unfinished work here as they are discovered.

## Design docs (realigned)

- `docs/design/GDD.md` and `docs/design/TDD.md` carry a living **§0 Implementation status** that maps every major system to **IN / PARTIAL / OUT** against the current tree (Prototype 4 + first P6 exploration slice). Prefer those tables over the original PDF wording when deciding what exists.
- Package is `0.3.0`; README correctly says Prototype 4. `SAVE_VERSION = 7`. Worker is the default transport (`WORKER_DEFAULT = true`).
- **Next-pillar fork is still open:** GDD wants P5 refining next; the project already shipped a P6 slice and TDD never gave refining its own tier. Pick Engineering (P5) vs finishing Exploration (T6) explicitly — the docs will not decide it for you.
- Deliberate locks encoded in sim + docs: bulk solids on rovers, fluids never; per-resource storage; dev *modifiers* never save, *fabrications* do; no field-fluid recovery in supply drops.

## Weather FX (dust devils)

- Devil behaviour lives in `src/render/particles/effects.ts` (`DustDevil`, `DevilManager`, `devilBand`, `MAX_DEVILS`).
  `FxContext` is the only interface between it and the world, and it now carries **`windRamp`** (m/s per sim second) —
  `WeatherFX.sync` derives it from the previous frame's reading, because the sim reports wind speed but never its
  derivative. Anything building an `FxContext` by hand (tests, tooling) must supply it.
- Devil counts are **rolled per intensity band and held**, not rolled per frame (`wantedFor` + `BAND_HOLD`). Rolling
  every frame would spawn and kill a devil on alternate frames as a storm hovers on a band boundary.
- `RAMP_MIN = 0.35 m/s²` was calibrated against the real sim, not guessed: 20 minutes of ambient weather across six
  seeds never trips it, a scheduled storm trips it as its front arrives. Re-check both directions before touching it.
- Budget: `MAX_DEVILS = 5`. Worst case measured at ~6155 of 9000 particles (5 devils fed to their growth cap plus a
  severe storm). `tests/render/particles.test.ts` pins that ceiling.
- **Adding a `rand()` draw to `DustDevil`'s constructor moves every seeded FX test** — the devil RNG is the FX RNG, and
  the size/spin/wander draws all come out of one stream. Expect to re-tune seeds when it changes.

## Dust field (the #2 / #7 rework)

- Ambient dust no longer blows into a fixed box: `WeatherFX.viewGeometry` derives `viewRadius`
  (half-diagonal of the viewed ground footprint) from rig radius, FOV, aspect and view angle, and
  `dustField(viewRadius)` in `particles/effects.ts` turns it into the emission envelope
  (`half`, `height`, `size` LOD, `alpha` haze, `swirl`, feather `r0`). `FxContext.viewRadius` is
  **required** — anything building an `FxContext` by hand (tests, tooling) must supply it.
- `half` is the emission box, the `wrapAmbient` radius *and* the rim feather's outer radius at
  once — that coincidence is what hides the box: `ParticlePool.setFalloff` fades ambient alpha to
  zero exactly at the wrap rim on a p=4 superellipse (stored in distance⁴ space so `writeRender`
  needs no roots). Never wrap at one radius and feather at another.
- `FIELD_MIN = 45` (close-up floor: up close you are inside the dust), `FIELD_MAX = 1000`
  (from-orbit ceiling: the world is 1280 m across, past that the field would hang over the void).
  Emission *rates* are deliberately view-independent — the box matches the view, so screen-space
  density is constant for free and the 9000-particle pool never grows.
- Storm grit is grit: sizes `(0.35–0.9, 0.9–1.8)·size`, strictly under the wind emitter's
  `(0.5–1.2, 1.2–2.1)·size`. The storm's wall-opacity comes from fog + sky haze, not from sprite
  coverage — do not "fix" thin-looking storms by re-inflating sprite sizes.
- Turbulence is now ONE coherent divergence-free roll (`CURL_K ≈ 157 m` cells, Taylor–Green via
  the sin(a±b) identity: 2 sines/particle, cheaper than the old 3-sine per-mote jitter) plus
  `CURL_SCAT` per-mote phase scatter. Coherence is the whole "fluid" read — neighbouring motes
  must turn together. `tests/render/particles.test.ts` pins coherence (cos ≈ 1 at 8 m, ≈ −1 half
  a roll away), path curvature and the downwind transport.
- Retuning traps: turbulence amplitude means *acceleration*; visible swing ≈ tb/ω² with
  ω ≈ wind·CURL_K + pattern drift. And `drag` silently eats wander over a particle's life.

## Learned the hard way

- **The two sim transports have different failure modes, and only the browser gates see both.** `LocalSimHost`'s view *is* the live sim, so anything that delays a view
  update is invisible to `npm test` and fatal on the worker. Concrete case: `workerRuntime` used to publish a view only on `advance`, so a command sent to a **paused**
  colony was applied and never shown. Found by `mobile-smoke` (which pauses before ordering) the day the worker became the default transport. If you touch
  `workerRuntime`'s message cases, run `node scripts/mobile-smoke.mjs` and `scripts/worker-smoke.mjs`, not just `npm test`.
- **`SMOKE_QUERY` must be explicit now that the worker is the default.** `SMOKE_QUERY='?worker=0'` for the in-process run; an empty query means "the default", which is
  the worker, so a CI pair of `?worker=1` + empty would test one transport twice. `worker-smoke` derives its expectation from the query for exactly this reason.
- **Attributing a smoke failure takes ~3 minutes and is worth it.** Export the base commit with `git archive <sha> | tar -x -C /tmp/base`, symlink `node_modules`, build,
  serve on another port, and point `BASE_URL` at it. That is how the paused-order bug was pinned on the worker flip rather than on the feature that landed next to it.
- **POI ids and entity ids are separate spaces.** Rovers, buildings and sites each allocate their own; anything keying a DOM node or a Map by id must namespace it
  (`hud/markers` uses `rover-12` / `poi-3`).
- Sites live on `World` (`world.pois`) but are *player-mutated* state (found, stripped, burial clock), so they cross the wire in the view payload and are snapshotted —
  do not try to re-derive them from the seed client-side the way the terrain is.
- Supply drops contain bulk resources and sometimes battery cells, never fluids. Exposed water or food would freeze, and the current rover logistics model has no
  field-fluid recovery path; do not bypass that boundary by teleporting fluid cargo into colony tanks.
- **Storm screenshots need patience, not time travel.** `dev/time` jumps re-anchor the clock but
  leave `weather.time` behind, so a conjured storm's envelope does not follow the jump — and the
  severe ramp is ~1.5 sim-hours anyway. The working recipe: `game.dev.enable()` +
  `game.dev.forceStorm('severe')` straight through the dev API (the panel's buttons need the PR #29
  master switch, and on a minified build the UI path is painful to debug), then run at 4× and
  `waitForFunction(stormIntensity > 0.75)` — a few real minutes. On a worker host, dev command
  acks are Promises: a synchronous `JSON.stringify(ack)` reads as `undefined`, which is not a failure.
- `src/audio/AudioSystem.ts` is presentation-only procedural Web Audio: it never writes sim state, starts on the first real input gesture to satisfy autoplay policy,
  and is deliberately updated at simulation speed 0 so paused colonies retain environmental ambience and brownout/storm reminders. Keep new `SimCommand` values
  represented in its exhaustive `COMMAND_CUES` map; `tests/audio/system.test.ts` pins that contract.
