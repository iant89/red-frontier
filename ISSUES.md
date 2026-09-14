# Issues

A backlog of player-facing bugs and feature gaps, written down so they don't
get lost between the bigger pieces of work. Nothing here is scheduled — pull
an item off the list whenever there's a spare window.

**Status values:** `Open` · `In progress` · `Blocked` · `Done`
**Priority:** `P1` annoying every session · `P2` noticeable · `P3` polish

Line references were accurate as of `bcb1314` (post PR #23, the MOLA terrain
work). They will drift — treat them as a starting point, not a promise.

| # | Issue | Area | Priority | Status |
|---|---|---|---|---|
| 1 | Mobile camera controls — pan is nearly unusable | `app/` | P1 | In progress |
| 2 | Dust storms turn into a cube when you zoom out | `render/particles` | P1 | Done |
| 3 | Dust devils only ever spawn two at a time | `render/particles` + `render/WeatherFX` | P2 | Done |
| 4 | Dust devils follow each other instead of their own path | `render/particles` | P2 | Done |
| 5 | Dust devils don't interact when they collide | `render/particles` | P3 | Done |
| 6 | Weather is uniform — real storms hit some areas harder | `sim/weather` | P2 | Open |
| 7 | Storm dust is too coarse and flows too straight | `render/particles` | P1 | Done |
| 8 | No lightning risk from high dust | `sim/` + `render/` | P2 | Open |
| 9 | Rover selection ring isn't a circle | `render/Renderer` | P1 | Done |
| 10 | Rover selection ring needs a pulsing white glow | `render/Renderer` | P3 | Done |
| 11 | Rovers have no collision or proximity awareness | `sim/` | P1 | Done |
| 12 | Draggable panels scroll their own title bar | `ui/HUD` + `style.css` | P2 | Open |
| 13 | Draggable panels don't snap to the viewport edges | `ui/HUD` | P3 | Open |

---

## 1. Mobile camera controls — pan is nearly unusable

**P1 · In progress · `src/app/Game.ts`, `src/app/CameraRig.ts`, `src/app/gestures.ts`**

> Panning barely moves the camera — dragging a finger across the whole screen
> only shifts the view a little. **One finger should pan. Looking around should
> be a stationary finger plus a second finger that drags.**

### What the code does today

The whole gesture map lives in `pointerMove` (`Game.ts:455-471`):

- **One pointer** → `rotateByPixels` — orbits the camera around `target`. The
  target never moves, so the view swings in place rather than travelling.
- **One pointer + `shiftHeld`** → `panByPixels`. On touch there is no Shift key
  and no middle button, so **this path is unreachable on a phone**.
- **Two pointers** → pinch `dolly` **and** midpoint `panByPixels` at the same
  time (`Game.ts:469-471`). Pan is welded to zoom: you cannot translate
  without also changing altitude, and the pan only covers the distance your
  fingers physically travel, so crossing the map means repeating the gesture
  over and over.

Two plausible causes for the "it barely moves" feel, to be confirmed on a real
device before fixing:

1. Players are orbiting when they think they are panning (one finger = orbit),
   and the target staying put reads as "the camera won't move".
2. Two-finger pan fights the simultaneous dolly, so the net translation is
   much smaller than the finger travel suggests.

`panByPixels` itself (`CameraRig.ts:54-78`) is 1:1 screen-space — the world
offset per pixel is `(2 · radius · tan(fov/2)) / viewHeight`, with `fov = 55`
(`Renderer.ts:130`). That part looks correct, so the problem is most likely the
gesture map, not the sensitivity.

### Wanted

- **One finger drag = pan** (the primary way to move around on touch).
- **Two fingers = look around.** Hold one finger down, drag the second to
  orbit/tilt. Pinch to zoom stays as it is.
- Desktop mouse behaviour is a separate decision — see open questions.

### Acceptance criteria

- [x] One-finger drag on touch pans the camera, and content tracks the finger
      1:1 instead of orbiting.
- [x] Two-finger gesture orbits when one finger is roughly stationary and the
      other drags; it still zooms when the fingers move apart or together.
- [x] A stationary finger resting on the screen does not jitter the camera.
- [x] Long-press context order (480 ms) still fires on a still finger and still
      cancels once the finger starts to travel — untouched, and it keys off
      `travel`, which is still accumulated exactly as before.
- [x] Single tap to select, and tap-to-place, are unaffected — the tap test in
      `pointerUp` is unchanged.
- [x] Desktop shortcuts (Shift-drag / middle-drag pan, wheel zoom, LMB orbit)
      still behave as they do now.
- [ ] **Verified by hand on a real phone, not just a desktop devtools
      emulator.** ← the one thing that cannot be done from here.

### Resolution (pending device check)

The gesture map moved out of `pointerMove` into `src/app/gestures.ts` as pure
functions, so it is unit testable (`tests/ui/gestures.test.ts`, 15 checks) —
real touch events cannot be driven in the node harness, and the map was the
whole bug.

Both of the causes this issue guessed at turned out to be real, and both are
fixed:

1. **One finger was orbiting, not panning.** `singlePointerGesture` now routes
   touch to `panByPixels`. The old Shift/middle-button pan path was
   unreachable on a phone; desktop keeps its existing map (plain drag orbits,
   Shift/middle pans).
2. **Two-finger pan fought the dolly.** The simultaneous midpoint
   `panByPixels` is **gone**. Two fingers now mean *look*: when one finger is
   resting (`isResting` — under 8 px of travel, or under 35 % of the other
   finger's), the travelling finger drives `rotateByPixels`. Pinch still
   drives the dolly every frame, and a span change that dominates the finger
   movement suppresses the orbit so a straight pinch doesn't also swing the
   camera.

`ActivePointer` gained `touch`, `dx`/`dy` and `gestureTravel`; the last is
reset in `resetPinch` so the finger that happened to go down first isn't
credited as "the mover" for free.

`panByPixels` itself was left alone — as the issue predicted, the 1:1
screen-space maths was already correct, so no sensitivity tuning was needed.

### Follow-up: the look also zoomed (device report, fixed)

The first real-phone report after this shipped: holding one finger down and
looking with the other zoomed the camera at the same time (radius 170 → 126
on a 90 px look in the lab repro). Two causes, both in the two-finger path:

1. **The dolly was always live.** `twoPointerGesture` applied
   `prevDist / dist` every frame, and a look drifts the span purely by
   geometry (tangential travel moves it second-order). The dominance gate only
   ran one way — it suppressed the orbit during a pinch, but nothing
   suppressed the dolly during a look. The map now classifies each frame as
   either a zoom or a look from *accumulated* travel (span drift since
   touch-down vs the mover's travel), so a look holds its zoom exactly and a
   slow pinch still zooms at any event rate.
2. **The map read the wrong travel.** `Game` passed the raw pointers, whose
   `travel` accumulates since touch-down, while the reset in `resetPinch`
   zeroes `gestureTravel` — so after panning with one finger, the look
   credited the wrong finger as the mover. The call now projects
   `{ dx, dy, travel: gestureTravel }` explicitly.

Covered by `tests/ui/gestures.test.ts` (a look asserts `dolly === 1`, a slow
pinch asserts the dolly survives) and by two new `mobile-smoke.mjs` checks —
single-finger drag and two-finger look both assert the radius never moves.
The smoke suite never asserted zoom stability before, which is how the
always-live dolly shipped.

### Open questions

- ~~Does the new one-finger-pan map apply to touch only, or does the desktop
  mouse flip to drag-to-pan as well?~~ **Touch only** — desktop already has a
  working pan (Shift/middle-drag) and flipping LMB would break orbit muscle
  memory for existing players. Revisit if desktop users ask.
- Do we want an on-screen hint the first time a touch session starts?
- Is there a camera settings toggle worth having, or is one good default
  enough?

---

## 2. Dust storms turn into a cube when you zoom out

**P1 · Open · `src/render/particles/effects.ts`**

> Zoom out during a dust storm and the dust becomes a cube.

### What the code does today

Both ambient emitters spawn inside a **fixed-size box** centred on the view
focus:

- `StormEmitter.emitOne` — `W = 110`, `D = 110`, `H = 26` (`effects.ts:160-162`)
- `WindEmitter` — `W = 150`, `D = 150`, `H = 34` (`effects.ts:99-101`)

`WeatherFX.sync` also clamps ambient particles into a **75-unit** radius around
the focus (`WeatherFX.ts:184`, `wrapAmbient` at `ParticlePool.ts:259`).

The camera can pull back to `maxRadius = 1600` (`CameraRig.ts`). At that
distance a 110 × 110 × 26 box is a small brick hanging in the middle of the
view, with hard edges on all six sides — the cube. The 75-unit wrap makes the
edges sharper, not softer.

### Wanted

Dust should read as weather happening *everywhere*, at every zoom level.

### Acceptance criteria

- [ ] Emission volume scales with camera distance/altitude so the storm fills
      the viewed area at `minRadius` and at `maxRadius`.
- [ ] No visible box edges at any zoom, from ground level or from orbit.
- [ ] Particle count stays inside the existing pool budget (default 9000,
      `WeatherFX.ts:94`) — scale coverage by growing the box and thinning
      alpha, not by spawning without limit.
- [ ] Frame rate during a severe storm is no worse than it is today.

### Implementation notes

The cheap version drives `W`/`D`/`H` and the `wrapAmbient` radius from
`camera.position.y` / rig radius, and fades alpha with distance so the far
field reads as haze rather than geometry. The better version spawns in a
frustum-aligned volume. Start cheap, measure, escalate only if edges still
show.

---

## 3. Dust devils only ever spawn two at a time

**P2 · Done · `src/render/particles/effects.ts`, `src/render/WeatherFX.ts`**

> Dust devils only spawn 2. It should be random, and a rapid rise in wind
> speed should spin one up.

### What the code did

`DevilManager.wantedFor` was a hard-coded ladder that never exceeded two:

| Storm | Count |
|---|---|
| `devil` | 0 / 1 / 2 by intensity |
| `regional` | 0 / 1 / 2 by intensity |
| `severe` | 0 / 1 / 2 by intensity |
| `planetary` | 0 |

`DevilManager.update` spawned up to `want` and wound the rest down. Nothing
reacted to **how fast** the wind was rising — only to the current storm class
and intensity.

### Wanted

- **Randomised counts.** A range per storm class (and per intensity band),
  rolled from the FX RNG, not a fixed ladder. A big regional front should be
  able to carry a handful; a weak one should sometimes make none.
- **Spin up on wind ramp.** Track `d(windSpeed)/dt`; when it crosses a
  threshold, spawn a devil even outside a declared storm.

### Acceptance criteria

- [x] Devil count per storm varies run to run — the count is a roll per
      intensity band, not a ladder. (Reproducible under a seeded RNG, which
      the FX determinism rule requires; see the note under Resolution.)
- [x] A sharp wind ramp spins up a devil with no storm declared.
- [x] Counts stay bounded — no runaway spawning when the wind keeps climbing.
- [x] Deterministic under a seeded RNG so the FX unit suites stay reproducible.

### Resolution

**Counts are rolled per band, and held.** `devilBand(storm, intensity)` returns
an inclusive `[min, max]` range; `wantedFor` rolls it from the FX RNG (biased
toward the low end, so a handful is a big storm's exception rather than its
default) and **holds** the roll while the storm stays in the band. A band change
waits out `BAND_HOLD` (2 s) before re-rolling, so a storm hovering on a
boundary doesn't spawn and kill a devil every frame — without the hold, the
ladder would have been replaced by per-frame churn.

| Storm | ≤0.05 | low | mid | high |
|---|---|---|---|---|
| `devil` | 0 | 0–1 | 1–2 | 1–3 |
| `regional` | — | 0–1 (<0.5) | 0–2 (<0.8) | 1–4 |
| `severe` | — | 0–1 (<0.6) | 0–2 (<0.85) | 1–4 |
| `calm` / `planetary` | — | — | — | 0 |

Planetary stays at zero: a uniform sheet of dust has no coherent vortices in
it, exactly as before.

**Wind ramp.** `FxContext` gained `windRamp` (m/s per sim second), derived in
`WeatherFX.sync` from the previous frame's reading and lightly smoothed
(τ = 1.2 s) so a single-frame jump doesn't read as a front. `DevilManager`
banks the *excess* ramp above `RAMP_MIN` (0.35 m/s²) and spends a full charge
(`RAMP_CHARGE` 1.6) on one devil, with `RAMP_COOLDOWN` (30 s) between ramp
spawns and a `RAMP_LIFE` (45 s) mandate so the devil outlives the gust. A wind
that climbs all sol therefore holds one or two devils, never a sky full.

`RAMP_MIN` was calibrated against the real sim rather than guessed: twenty
minutes of ambient weather across six seeds (which wanders between 5 and 14 m/s)
never trips it, while a scheduled severe storm trips it right as its front
arrives.

**Ceiling.** `MAX_DEVILS = 5`, and `spawnNear` nudges a new devil off any
funnel already standing there so it doesn't resolve as a collision before it
has been seen. A storm band tops out at 4, leaving room for one ramp devil.
Worst case measured at **6155 of 9000** particles (5 devils already fed to
their growth cap, plus a severe storm's grit and ambient wind), so the pool
still has headroom.

**Verified in a real browser**, not just the unit suite: a conjured severe
storm carried 1 → 2 → 3 devils as it deepened, with no console errors.

### Note on "varies run to run with the same seed"

Taken literally, that criterion contradicts the next one — a seeded FX RNG is
reproducible by design, and the repo's cross-cutting rules require it. The
rolls are per band and per session, so two runs differ; a replayed seed does
not. Determinism won.

---

## 4. Dust devils follow each other instead of their own path

**P2 · Done · `src/render/particles/effects.ts`**

> They should follow their own path — right now they follow each other.

### What the code did

`DustDevil.update` drove travel off **global sim time**, with one shared pair
of frequencies and a shared amplitude:

```ts
this.x += (ctx.windX * 0.22 + Math.cos(t * 0.3 + this.wanderA) * 1.6) * ctx.dt;
this.z += (ctx.windZ * 0.22 + Math.sin(t * 0.23 + this.wanderA * 1.7) * 1.6) * ctx.dt;
```

Every instance differed only by a phase offset, and `spawnNear` dropped them
all upwind of the same focus at `28 + rand()*44` units. Same wind vector, same
frequencies, near-identical start distance → the devils drifted downwind **in
formation**.

### Wanted

Each devil should wander on its own: its own meander frequency, amplitude and
heading bias, plus mild separation so two that end up side by side peel apart.

### Acceptance criteria

- [x] Two devils in the same storm do not hold a fixed formation.
- [x] Tracks visibly diverge within ~15 s of simulation time.
- [x] Motion still reads as downwind travel — wandering, not drifting freely.
- [x] Deterministic under a seeded RNG.

### Resolution

Every devil now draws its own travel parameters in the constructor:

- `wanderF1` / `wanderF2` — two independent meander frequencies (0.19–0.45,
  0.15–0.37) instead of one global pair.
- `wanderAmp` — its own meander amplitude (1.1–2.6 m/s).
- `driftBias` — a fixed angle off the wind (±26°), so two devils in the same
  wind walk visibly different headings.
- `windFollow` — its own fraction of the wind (0.17–0.32).

`wander()` walks at `atan2(windX, windZ) + driftBias` at its own fraction of
the wind speed, with its own meander on top. Measured from a common start at
24 m/s of wind: **19–34 m apart after 15 s**, while each still travels 29–58 m
downwind against ≤13 m of crosswind — so it reads as wandering downwind, not
as free drift.

`spawnNear` also fans the bearing wider (±75° instead of ±60°) over a longer
range (24–102 m instead of 28–72 m) and nudges spawns off funnels already
standing, so an outbreak no longer starts as a line.

**Mild separation** lives on `DevilManager.separate(dt)`: two devils inside
`2.4 ×` their summed radii push apart at `0.15/s` of the overlap. Gentle
enough to read as crowding rather than shoving — a devil 200 m away is not
touched at all. Separation is skipped between paired devils, which are meant
to be close.

---

## 5. Dust devils don't react when they collide

**P3 · Done · `src/render/particles/effects.ts`**

Devils used to pass through each other — there was no pair interaction at all.

### Wanted

1. **Mutual cancellation** — both spin down and disappear.
2. **Size mismatch** — the smaller one dances around the larger one and dies
   off, **or** the larger one consumes the smaller one and grows.
3. **Matched size** — twin dust devils orbiting a shared centre, which later
   split apart or decay.

### Acceptance criteria

- [x] Pair detection runs on contact (roughly the sum of the two base radii).
- [x] Outcome is chosen from the rules above, weighted by relative size.
- [x] Consumption visibly grows the survivor (`height`, `baseR`, emission rate).
- [x] Twin state is stable for a while, then resolves into split or decay.
- [x] Devils already dying (`target === 0`) are not valid merge targets.
- [x] No interaction thrash — a resolution should not immediately re-trigger.

### Resolution

Pair logic lives in `DevilManager` (`resolveContacts`, and the public
`separate`), one resolution per frame so a cluster can't cascade. Contact is
`(a.baseR + b.baseR) × 1.15`; both devils must be properly spun up
(`target === 1`, `strength ≥ 0.5`), unpaired, and past their cooldown.

Outcome is chosen from the size ratio `q = big.baseR / small.baseR`:

| Ratio | Outcome |
|---|---|
| `q ≥ 1.9` | **Consume** — the little one is torn apart, the survivor grows |
| `1.25 ≤ q < 1.9` | **Dance** (75 %) — the little one circles the big one for 5–11 s, then winds down — or **consume** (25 %) |
| `q < 1.25` | **Twin** (60 %) — a shared orbit for 9–18 s, then split or decay — or **mutual cancellation** (40 %) |

**Consumption** is visible: `DustDevil.grow()` widens the footprint and the
column and raises `emitScale`, which multiplies the column, skirt and deposit
emitters — a fed devil throws more dust, not just wider. Growth is capped
against the devil's birth size (1.8 × radius and height, 2.2 × emission), so
repeated meals can't grow one without limit.

**Pairings** are one small shared state object (`DevilTwin`), as the issue
anticipated:

- a `twin` drifts downwind as a unit with both devils half a turn apart on the
  orbit; it ends by peeling them clear of contact range (`split`) or by
  winding one or both down (`decay`);
- a `dance` tracks the bigger devil's *live* position, so the follower never
  trails behind it, and the bigger devil keeps walking its own path.

**No thrash**: one resolution per frame, a 14 s pair cooldown on both devils
after any resolution, and a split that lands them outside contact range. Five
devils dropped on top of each other in a severe storm settle in **≤ 6
resolutions over two minutes** rather than grinding through dozens.

---

## 6. Weather is uniform — real storms hit some areas harder

**P2 · Open · `src/sim/weather.ts`**

> The weather should be how it is on Earth with a storm: how it moves, where
> some areas are barely hit while others are hit worse.

### What the code does today

`Weather` (`src/sim/weather.ts:205`) tracks a **single global** state — one
`windSpeed`, one `dust`, one `stormIntensity`, one `visibility` for the entire
map. Every panel, rover and crop on Mars gets the same number at the same
moment. A storm front doesn't have a position; "storm" is a global switch.

### Wanted

A storm should be a **thing with a shape and a position** that crosses the map:
a leading edge, a worst-hit core, and a trailing side — so a rover twenty
metres away can be in clear air while the colony is getting hammered.

### Acceptance criteria

- [ ] Intensity varies by position during a storm, not just by time.
- [ ] The system advects downwind, so the storm arrives, peaks and passes.
- [ ] Readings the player already sees (HUD weather cell, forecast, alerts)
      stay truthful under the new model.
- [ ] Saves written before this change still load.

### Open questions / risk

This is the largest item on the list. It changes simulation state, the view
payload, saved games, and the dev panel. Worth splitting into its own piece of
work with a design pass first:

- Is intensity a function of position, or do we track discrete storm cells?
- Does `dust` on solar panels become per-panel, or sampled at the colony?
- What does the forecast promise once the storm has a shape?
- Per-rover shelter decisions (`weather.ts:512`) now depend on where the rover
  is, not on a global flag.

---

## 7. Storm dust is too coarse and flows too straight

**P1 · Open · `src/render/particles/effects.ts`**

> Dust storms don't look intense. The particles aren't small enough — they
> look like small clouds. They need to be small and fluid, with a wavy,
> unpredictable path flowing in the direction of the wind.

### What the code does today

Storm grit is spawned **much larger** than ambient wind dust:

| Emitter | `size0` | `size1` |
|---|---|---|
| `WindEmitter` (`effects.ts:115-116`) | 0.5 – 1.2 | 1.2 – 2.1 |
| `StormEmitter` (`effects.ts:179-180`) | 2.0 – 3.6 | 4.0 – 6.5 |

Those are world units, and **1 world unit = 1 m** (`src/sim/config.ts:27`). A
4–6.5 m dust mote *is* a small cloud — that's the whole complaint.

Motion is also close to ballistic: wind velocity plus uniform random jitter
with `turbulence: 2.2 + 2.5k` (`effects.ts:187`) and a single sine `heave`
(`effects.ts:170`). It reads as straight-line streaks, not flowing air.

### Wanted

- **Smaller particles** — grit-sized, not cloud-sized.
- **Many more of them**, so the storm reads as density rather than blobs.
- **Wavy, unpredictable flow**, still travelling downwind overall.

### Acceptance criteria

- [ ] Storm particle sizes are at or below the ambient wind-dust sizes.
- [ ] Storm grain reads as fine at ground level and while zoomed out.
- [ ] Particle paths visibly curve and wander; no straight-line streaking.
- [ ] Net transport is still downwind — the storm has a direction.
- [ ] Total particle count stays within the pool budget; frame rate in a
      severe storm is no worse than today.

### Implementation notes

Shrinking particles means raising the spawn rate to keep the same visual
density, so this trades against the 9000-particle pool
(`WeatherFX.ts:94`) — budget it deliberately. For the flow, curl-style noise
advection (or a cheap layered-sine approximation of it) will do more for the
"fluid" read than adding more jitter. This interacts with **#2**: whatever
scales the emission volume has to stay correct here too.

---

## 8. No lightning risk from high dust

**P2 · Open · `src/sim/`, `src/render/`, `src/sim/alerts.ts`**

> During any storm with dust, the higher the dust percentage the higher the
> risk of lightning, due to friction between dust particles (static
> electricity).

**Nothing like this exists yet** — there is no lightning, discharge, or
electrical-hazard code anywhere in `src/`. This is a new feature, not a fix.

### Wanted

- Strike chance rises with airborne dust percentage during any dust-carrying
  storm.
- Visible flash and a colony log entry / alert when one lands.
- Consequences worth caring about: exposed hardware and rovers at risk, solar
  arrays and electronics more exposed than sealed structures.

### Acceptance criteria

- [ ] Strike probability is a documented function of dust (and storm class).
- [ ] Calm, clear weather never produces strikes.
- [ ] A strike has a visible flash plus a log/alert entry.
- [ ] Damage is deterministic under a seeded RNG and reproducible in tests.
- [ ] Difficulty settings can scale the risk (`src/sim/difficulty.ts`).
- [ ] Dev panel can force a strike for testing.

### Open questions

- Which structures are vulnerable, and how much damage does a strike do?
- Does lightning add a *new* survival pressure, or restate risks the storm
  damage model already covers?
- Sequencing: this depends on **#6** if strike risk should follow the storm's
  local intensity rather than the global dust reading.

---

## 9. Rover selection ring isn't a circle

**P1 · Done · `src/render/Renderer.ts`**

> When a rover is selected, the circle that appears under it is not a circle.

### What the code does today — and why it's an ellipse

`makeRing` (`Renderer.ts:452-465`) builds a `RingGeometry` in the XY plane and
lays it flat with `rotation.x = -Math.PI / 2`.

`syncSelection` then scales it (`Renderer.ts:1415`):

```ts
this.selectionRing.scale.set(entity.radius, 1, entity.radius);
```

three.js composes the local matrix as **T · R · S**, so scale is applied in the
mesh's *own* axes **before** the rotation:

- local **X** × `radius` → world **X** × `radius`
- local **Y** × `1` → world **Z** × `1` (the −90° rotation maps local Y onto
  world Z)

So the ring is stretched along world X by the rover's radius (2.4 – 3.4,
`src/sim/defs.ts`) and left at 1.0 along world Z. Rover-sized radii mean a
2.4:1 to 3.4:1 ellipse, and the ring's own thickness is stretched with it.

### Fix

Scale uniformly — `setScalar(entity.radius)` — or scale the geometry's own
axes (`scale.set(radius, radius, 1)`) before the flat rotation. The building
damage ring (`Renderer.ts:762`) builds at its final radius and never
non-uniformly scales, which is why it looks right.

### Acceptance criteria

- [x] Selection ring is a true circle under every rover type.
- [x] Ring radius scales with the rover's own radius.
- [x] Even thickness all the way around, at every zoom level.
- [x] Still sits flat on the terrain and doesn't z-fight on slopes — position
      and the `+0.2` ground offset are unchanged.

### Resolution

`setSelection` now scales uniformly with
`scale.setScalar(entity.radius / SELECTION_RING_RADIUS)`, dividing out the
1.4-unit radius the geometry is built at so the ring's world radius matches
`entity.radius` exactly. The build radius and thickness are now named
constants (`SELECTION_RING_RADIUS`, `SELECTION_RING_THICKNESS`).

---

## 10. Rover selection ring needs a pulsing white glow

**P3 · Done · `src/render/Renderer.ts`**

> I'd like it to be a circle with a pulsing white glow.

The selection ring is currently static: `MeshBasicMaterial`, flat white,
`opacity: 0.9` (`Renderer.ts:452-465`). No animation, no glow.

### Wanted

A soft white halo that breathes — enough to draw the eye to the selected rover
without strobing.

### Acceptance criteria

- [x] Ring pulses smoothly; the cycle is slow enough to read as a breath —
      a 0..1 cosine over a 1.9 s period, so there is no seam at the wrap.
- [x] Glow reads on both pale dust and dark rock, day and night — the halo is
      additively blended, so it lifts off dark terrain rather than washing out.
- [x] Pulse is driven by **sim time** (`clockT`, set from `sim.simTime` in
      `sync`), so it freezes when the colony is paused.
- [x] Selection remains obvious at maximum zoom-out — the halo scales with the
      ring, and the core ring never dips below 0.72 opacity.

### Resolution

A second, wider ring (`selectionGlow`, 1.18× radius and 3.2× thickness) is
drawn under the core ring with `AdditiveBlending` and `renderOrder = -1`.
`syncSelectionPulse` — called from both `sync` and `setSelection` — breathes
the pair: ring opacity `0.72 → 1.0`, halo `0.16 → 0.42`, plus a 6 % swell on
the halo's radius. The swell is derived from the *ring's* scale each frame, so
it cannot accumulate. The curve is exported as `selectionPulse` /
`selectionPulseOpacity` and covered by `tests/render/selection.test.ts`.

### Implementation notes

`syncBuildings` already animates a damaged building's ring opacity
(`Renderer.ts:802-805`, `0.5 + 0.4 * pulse`) — reuse that pattern and its
time source rather than inventing a second one.

---

## 11. Rovers have no collision or proximity awareness

**P1 · Done · `src/sim/Simulation.ts`, `src/sim/config.ts`**

> Rovers need collision detection and should actively watch for objects. If
> they detect anything within 5 feet while moving they should instantly slow
> down, especially when coming back into the colony area.

### What the code did

Rovers path over the navgrid and drive at full `cruiseSpeed` straight through
anything in the way. There was no obstacle query, no slowdown, and no notion
of a crowded colony yard.

### Unit decision

**Hull clearance, option 1.** 1 world unit = 1 m and rover radii are 2.4–3.4 m,
so a centre-to-centre "5 ft" would sit *inside* the chassis. The bubble is
measured as `centreDist − selfR − otherR` against a clearance of **1.5 m**
(≈ 5 ft) in open country and **3.0 m** inside the colony yard.

### Resolution

Proximity lives in `moveRover` via `proximitySpeedMul` /
`nearestObstacleClearance`:

| Constant | Value | Role |
|---|---|---|
| `ROVER_PROXIMITY_CLEARANCE_M` | 1.5 m | Open-country hull bubble |
| `ROVER_PROXIMITY_COLONY_CLEARANCE_M` | 3.0 m | Yard hull bubble |
| `ROVER_PROXIMITY_SPEED_MUL` | 0.28 | Open-country crawl |
| `ROVER_PROXIMITY_COLONY_SPEED_MUL` | 0.15 | Yard crawl |
| `ROVER_COLONY_YARD_M` | `SPAWN_RADIUS + 22` | Pad + approach lanes |

Obstacles watched: other rovers, buildings, the landing pod, and discovered
(non-buried, non-marker) POIs. The **destination of the current goal is
skipped** once the rover is inside that task's arrival reach — otherwise a
builder crawling up to a site, or a rescuer closing on a stranded rover,
would slow forever and never finish the job.

Speed drops **immediately** (no ramp): clear → 1.0, inside bubble → crawl.
Crawl is never zero, so two rovers nose-to-nose keep inching and cannot lock.
Move power scales with the actual speed so a crawl is a brake, not a battery
tax.

**Slow down only** — no full stop, no re-path, no alert. The existing task
queue and arrival logic are untouched; proximity only multiplies the step
length inside `moveRover`.

### Acceptance criteria

- [x] Obstacle query while moving, at a documented threshold (hull clearance).
- [x] Detection causes an immediate speed drop, not a slow ramp.
- [x] Stricter behaviour inside the colony area (wider bubble, slower crawl).
- [x] Rovers never end up permanently stuck nose-to-nose with an obstacle.
- [x] Behaviour is deterministic and covered by `tests/sim/proximity.test.ts`.
- [x] Cost is a linear scan of the live fleet / buildings / POIs per moving
      rover — fine at current fleet sizes; no spatial index added.

### Open questions resolved

- **Slow down only, or full stop and re-path?** Slow down only. A crawl keeps
  jobs finishing; re-path would fight the existing A* and arrival skips.
- **Alert on block?** No — silent. A log line every time two rovers pass would
  spam the board; the inspector already shows "Moving".
- **Task queue / arrival?** Destination skip inside arrival reach, so
  construct / clean / repair / recover / salvage / charge / unload still
  complete.

---

## 12. Draggable panels scroll their own title bar

**P2 · Open · `src/ui/HUD.ts`, `src/style.css`**

> When a draggable panel is scrolled, the title bar should not scroll.

### What the code does today

The panels are their own scroll containers, and the header is a child *inside*
that scroll box:

- `#vitals` — `overflow-y: auto` (`style.css:633-641`), header `.vitals-head`
  inside it
- `#inspector` — `overflow-y: auto` (`style.css:1151-1161`), header `.i-bar`
  inside it

So scrolling the content drags the header — and with it the drag handle
(`.hud-drag`, `style.css:1953`) — out of view.

### Wanted

Header stays put; only the body scrolls.

### Acceptance criteria

- [ ] Title bar remains visible while the body scrolls, on every draggable
      panel.
- [ ] The header is still a valid drag handle after scrolling.
- [ ] Collapse toggle and resize grip stay reachable.
- [ ] Behaviour holds after a panel is dragged, resized, or restored from
      stored geometry.
- [ ] Verified on a phone-height viewport, where panels actually overflow.

### Implementation notes

Two options: move `overflow-y: auto` onto a body wrapper, or keep the panel as
the scroller and make the header `position: sticky; top: 0` with a background.
Sticky is the smaller change but interacts with `backdrop-filter` on `.panel`
(`style.css:100-107`) — check for a doubled-blur seam before committing to it.
The log panel (`#log`, header `.lg-title`) needs the same treatment.

---

## 13. Draggable panels don't snap to the viewport edges

**P3 · Open · `src/ui/HUD.ts`**

> Panels should have the ability to snap against the edges of the viewport.

### What the code does today

`enablePanelWindows` (`HUD.ts:548`) wires drag by handle, resize by
`.panel-grip`, geometry persistence, and a double-tap return home
(`HUD.ts:579`, `beginPanelDrag` at `HUD.ts:593`). There is **no snapping** — a
panel stays exactly where you drop it, so lining one up with a screen edge is
manual.

### Wanted

Panels snap to the viewport edges and corners when released near them.

### Acceptance criteria

- [ ] Snap threshold feels forgiving on touch and precise with a mouse.
- [ ] Snaps to edges and corners; snapping to a viewport edge never leaves a
      panel partially off-screen.
- [ ] Works with the existing geometry persistence — a snapped panel reloads
      snapped.
- [ ] Doesn't fight the double-tap return home.
- [ ] Snapping is skipped (or gentler) while a panel is being resized.

### Open questions

- Should panels also snap to *each other*, or only to the viewport?
- Show a snap preview while dragging, or just land there on release?
- Keep snapping off on small screens where panels are docked anyway?

---

## Cross-cutting notes

- **#2 and #7 are coupled.** Both rework `StormEmitter`'s emission volume and
  particle sizes. Taking them together avoids tuning the same numbers twice.
- **#6 blocks the interesting version of #8.** Lightning risk that follows a
  storm's local intensity needs the spatial weather model first.
- ~~**#3, #4 and #5 all live in `DevilManager` / `DustDevil`.** Cheapest picked
  off in one sitting, in that order.~~ **Done together** — rolled counts + wind
  ramp spin-up, own-path wandering, and pair interaction. `FxContext` now
  carries `windRamp` (derived in `WeatherFX.sync`); anything constructing an
  `FxContext` by hand has to supply it.
- **FX must stay deterministic.** Every particle system takes an injectable
  `Rand` (`WeatherFxOptions`, `WeatherFX.ts:60-63`, applied in the constructor
  at `WeatherFX.ts:92-95`); new randomness has to go through it or the FX unit
  suites stop reproducing.
- **Devil counts are held per band, not rolled per frame.** `wantedFor` keeps
  its roll until the storm changes band (and waits 2 s after it does), so a
  storm sitting on a band boundary doesn't spawn and kill a devil every frame.
  New per-devil randomness also shifts the seeded RNG stream — every FX test
  that seeds a `DustDevil` moves when the constructor draws more.
- **FX runs on sim time.** Anything animated (`#10`'s pulse especially) must
  freeze when the colony is paused, like the rest of the FX layer.
- **Smoke tests gate the transports.** `npm test` alone doesn't catch
  worker-transport issues — run `node scripts/mobile-smoke.mjs` and
  `scripts/worker-smoke.mjs` before calling an item done.
