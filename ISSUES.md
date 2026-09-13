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
| 1 | Mobile camera controls — pan is nearly unusable | `app/` | P1 | Open |
| 2 | Dust storms turn into a cube when you zoom out | `render/particles` | P1 | Open |
| 3 | Dust devils only ever spawn two at a time | `render/particles` | P2 | Open |
| 4 | Dust devils follow each other instead of their own path | `render/particles` | P2 | Open |
| 5 | Dust devils don't interact when they collide | `render/particles` | P3 | Open |
| 6 | Weather is uniform — real storms hit some areas harder | `sim/weather` | P2 | Open |
| 7 | Storm dust is too coarse and flows too straight | `render/particles` | P1 | Open |
| 8 | No lightning risk from high dust | `sim/` + `render/` | P2 | Open |
| 9 | Rover selection ring isn't a circle | `render/Renderer` | P1 | Done |
| 10 | Rover selection ring needs a pulsing white glow | `render/Renderer` | P3 | Open |
| 11 | Rovers have no collision or proximity awareness | `sim/` | P1 | Open |
| 12 | Draggable panels scroll their own title bar | `ui/HUD` + `style.css` | P2 | Open |
| 13 | Draggable panels don't snap to the viewport edges | `ui/HUD` | P3 | Open |

---

## 1. Mobile camera controls — pan is nearly unusable

**P1 · Open · `src/app/Game.ts`, `src/app/CameraRig.ts`**

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

- [ ] One-finger drag on touch pans the camera, and content tracks the finger
      1:1 instead of orbiting.
- [ ] Two-finger gesture orbits when one finger is roughly stationary and the
      other drags; it still zooms when the fingers move apart or together.
- [ ] A stationary finger resting on the screen does not jitter the camera.
- [ ] Long-press context order (`Game.ts:418-428`, 480 ms) still fires on a
      still finger and still cancels once the finger starts to travel.
- [ ] Single tap to select, and tap-to-place, are unaffected.
- [ ] Desktop shortcuts (Shift-drag / middle-drag pan, wheel zoom, LMB orbit)
      still behave as they do now.
- [ ] Verified by hand on a real phone, not just a desktop devtools emulator.

### Open questions

- Does the new one-finger-pan map apply to touch only, or does the desktop
  mouse flip to drag-to-pan as well?
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

**P2 · Open · `src/render/particles/effects.ts`**

> Dust devils only spawn 2. It should be random, and a rapid rise in wind
> speed should spin one up.

### What the code does today

`DevilManager.wantedFor` (`effects.ts:514-527`) is a hard-coded ladder that
never exceeds two:

| Storm | Count |
|---|---|
| `devil` | 0 / 1 / 2 by intensity |
| `regional` | 0 / 1 / 2 by intensity |
| `severe` | 0 / 1 / 2 by intensity |
| `planetary` | 0 |

`DevilManager.update` (`effects.ts:529-536`) spawns up to `want` and winds the
rest down. Nothing reacts to **how fast** the wind is rising — only to the
current storm class and intensity.

### Wanted

- **Randomised counts.** A range per storm class (and per intensity band),
  rolled from the FX RNG, not a fixed ladder. A big regional front should be
  able to carry a handful; a weak one should sometimes make none.
- **Spin up on wind ramp.** Track `d(windSpeed)/dt`; when it crosses a
  threshold, spawn a devil even outside a declared storm. `FxContext`
  (`effects.ts`) currently carries `windSpeed` but not its derivative —
  `WeatherFX.sync` (`WeatherFX.ts:136-160`) is where that would be added, from
  the previous frame's `Weather` reading.

### Acceptance criteria

- [ ] Devil count per storm varies run to run with the same seed and settings.
- [ ] A sharp wind ramp spins up a devil with no storm declared.
- [ ] Counts stay bounded — no runaway spawning when the wind keeps climbing.
- [ ] Deterministic under a seeded RNG so the FX unit suites stay reproducible.

---

## 4. Dust devils follow each other instead of their own path

**P2 · Open · `src/render/particles/effects.ts`**

> They should follow their own path — right now they follow each other.

### What the code does today

`DustDevil.update` drives travel off **global sim time** (`effects.ts:302-303`):

```ts
this.x += (ctx.windX * 0.22 + Math.cos(t * 0.3 + this.wanderA) * 1.6) * ctx.dt;
this.z += (ctx.windZ * 0.22 + Math.sin(t * 0.23 + this.wanderA * 1.7) * 1.6) * ctx.dt;
```

Every instance shares the same frequencies (`0.3`, `0.23`) and differs only by
a phase offset, and `spawnNear` (`effects.ts:542-553`) drops them all upwind of
the same focus at `28 + rand()*44` units. Same wind vector, same frequencies,
near-identical start distance → the devils drift downwind **in formation**.

### Wanted

Each devil should wander on its own: its own meander frequency, amplitude and
heading bias, plus mild separation so two that end up side by side peel apart.

### Acceptance criteria

- [ ] Two devils in the same storm do not hold a fixed formation.
- [ ] Tracks visibly diverge within ~15 s of simulation time.
- [ ] Motion still reads as downwind travel — wandering, not drifting freely.
- [ ] Deterministic under a seeded RNG.

---

## 5. Dust devils don't react when they collide

**P3 · Open · `src/render/particles/effects.ts`**

Devils pass through each other today — there is no pair interaction at all.
Wanted behaviour when two come within contact range:

1. **Mutual cancellation** — both spin down and disappear.
2. **Size mismatch** — one is clearly larger:
   - the smaller one dances around the larger one and eventually dies off, **or**
   - the larger one consumes the smaller one and grows.
3. **Matched size** — they can become **twin dust devils** orbiting a shared
   centre. After a while they either split apart and carry on, or one or both
   die off.

### Acceptance criteria

- [ ] Pair detection runs on contact (roughly the sum of the two base radii).
- [ ] Outcome is chosen from the rules above, weighted by relative size.
- [ ] Consumption visibly grows the survivor (`height`, `baseR`, emission rate).
- [ ] Twin state is stable for a while, then resolves into split or decay.
- [ ] Devils already dying (`target === 0`) are not valid merge targets.
- [ ] No interaction thrash — a resolution should not immediately re-trigger.

### Implementation notes

`DustDevil` owns `baseR`, `height`, `strength`, `target` and `radiusScale`, so
size comparison and growth are available. Pair resolution belongs in
`DevilManager.update` (`effects.ts:529-536`) before or after the per-devil
update, and needs a "already resolved this tick" guard. The twin-orbit case is
the fiddly one: it likely wants a small shared state object rather than a flag
on each devil.

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

**P3 · Open · `src/render/Renderer.ts`**

> I'd like it to be a circle with a pulsing white glow.

The selection ring is currently static: `MeshBasicMaterial`, flat white,
`opacity: 0.9` (`Renderer.ts:452-465`). No animation, no glow.

### Wanted

A soft white halo that breathes — enough to draw the eye to the selected rover
without strobing.

### Acceptance criteria

- [ ] Ring pulses smoothly; the cycle is slow enough to read as a breath.
- [ ] Glow reads on both pale dust and dark rock, day and night.
- [ ] Pulse is driven by **sim time**, so it freezes when the colony is paused.
- [ ] Selection remains obvious at maximum zoom-out.

### Implementation notes

`syncBuildings` already animates a damaged building's ring opacity
(`Renderer.ts:802-805`, `0.5 + 0.4 * pulse`) — reuse that pattern and its
time source rather than inventing a second one.

---

## 11. Rovers have no collision or proximity awareness

**P1 · Open · `src/sim/`**

> Rovers need collision detection and should actively watch for objects. If
> they detect anything within 5 feet while moving they should instantly slow
> down, especially when coming back into the colony area.

**No collision, avoidance, or proximity code exists** in `src/sim/` or
`src/render/` today. Rovers path over the navgrid and drive through anything
in the way. This is new work.

### Wanted

- Rovers watch for obstacles while moving: other rovers, buildings, POIs,
  terrain hazards.
- On detection within the threshold, slow down immediately — not a gradual
  ease.
- Strictest around the colony, where rovers are returning into a crowded
  yard.

### ⚠️ Unit question — resolve before building this

**1 world unit = 1 m** (`src/sim/config.ts:27`), and rover radii are **2.4 –
3.4 m** (`src/sim/defs.ts`). So 5 ft ≈ **1.52 m** is *inside the rover's own
footprint*. Options:

1. Threshold measured from the **hull**, not the centre: `rover.radius + 1.52`.
2. "5 feet" is shorthand for a slightly larger personal-space bubble — say
   5 m — measured centre-to-centre.
3. Something else entirely.

Pick one before implementing; it changes every test bound.

### Acceptance criteria

- [ ] Obstacle query while moving, at a documented threshold.
- [ ] Detection causes an immediate speed drop, not a slow ramp.
- [ ] Stricter behaviour inside the colony area.
- [ ] Rovers never end up permanently stuck nose-to-nose with an obstacle.
- [ ] Behaviour is deterministic and covered by sim tests.
- [ ] No measurable frame-time cost with the full fleet moving.

### Open questions

- Slow down only, or full stop and re-path?
- Should a blocked rover raise an alert, or silently wait?
- How does this interact with the existing task queue and arrival logic?

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
- **#3, #4 and #5 all live in `DevilManager` / `DustDevil`.** Cheapest picked
  off in one sitting, in that order.
- **FX must stay deterministic.** Every particle system takes an injectable
  `Rand` (`WeatherFxOptions`, `WeatherFX.ts:60-63`, applied in the constructor
  at `WeatherFX.ts:92-95`); new randomness has to go through it or the FX unit
  suites stop reproducing.
- **FX runs on sim time.** Anything animated (`#10`'s pulse especially) must
  freeze when the colony is paused, like the rest of the FX layer.
- **Smoke tests gate the transports.** `npm test` alone doesn't catch
  worker-transport issues — run `node scripts/mobile-smoke.mjs` and
  `scripts/worker-smoke.mjs` before calling an item done.
