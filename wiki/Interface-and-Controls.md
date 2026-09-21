> ← [Home](Home.md)

# Interface and Controls

The HUD is a plain DOM layer over a read model: every panel renders from
`SimView` and every interaction becomes a `SimCommand`. Nothing in `ui/` mutates
the colony — see [Architecture Overview](Architecture-Overview.md).

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Rotate camera | drag | drag |
| Zoom | wheel | pinch |
| Pan | `Shift`+drag / middle-drag | two-finger drag |
| Select | left click | tap |
| Engineering (on a building/rover) | right click | long press |
| Context move / EVA (empty ground) | right click | long press |
| Build | pick from palette, click terrain | tap palette, tap terrain |
| Place several | `Shift`+click | — |
| Queue rover orders | `Shift` + move/mine/repair/clean | — |
| Pause | `Space` | ❚❚ button |
| Cycle overlays | `V` | overlay buttons |
| Focus selection | `F` | Focus button |
| Blueprints 1–9 | `1`…`9` | — |
| Save | `Ctrl`/`Cmd`+`S` | auto every 45 s |
| Operations dashboard | `O` | 📊 topbar button |
| Bottleneck advisor | `B` | ⚠ topbar button (badged) |
| Developer panel | `` ` `` (backquote) | 🛠 topbar button |

Speed modes are `Paused / 1× / 2× / 4×`, multiplying sim steps per frame — the
simulation itself always ticks at a fixed 20 Hz (see
[Simulation Systems](Simulation-Systems.md)).

## Panel map

| Region | What lives there | Source |
|---|---|---|
| Left rail | Colony vitals: power generation/load, water/O₂/food with *empty in…* estimates, sol clock, weather cell | [`src/ui/HUD.ts`](https://github.com/iant89/red-frontier/blob/main/src/ui/HUD.ts) |
| Bottom bar | Build palette with per-blueprint costs, overlay switcher, save/alert counters | `src/ui/HUD.ts` |
| Right | Contextual inspector: rover, structure, crew, site — plus each rover's automation levers | `src/ui/HUD.ts` |
| Overlay | Alerts and the event log (conditions vs occurrences, deliberately separate) | `src/sim/alerts.ts` |
| Corner | Minimap (collapsible, draggable) → click to open the zoomable world map | [`src/ui/WorldMap.ts`](https://github.com/iant89/red-frontier/blob/main/src/ui/WorldMap.ts) |

Panels are **draggable and resizable, and snap to the viewport edges**; a
double-tap sends a panel home, and title bars do not scroll their own content.

## Inspectors

**Rover** — battery and charge floor, cargo type and load, drivetrain condition,
installed motor/board health, position-light switch, task queue and route,
automation rules, and the *Wait 1m* hold. A rover with a funded repair or a paid
refit shows its progress here, and refuses explain themselves ("short of 2 drive
motors").

**Structure** — power tier and draw, satisfaction, health, cleanliness, fluid
buffers, storage contributions, the Workshop's selected line and rack fill, the
Refinery's idle reason, and the **Water network** panel with commissioning state.

**Site** — required vs delivered materials, reserved mass, crew assignment.
Cancelling a site refunds everything already delivered.

**Crew** — suit O₂, health, indoor/sheltered state, current order.

## Overlays

Cycle with `V`: **none · power · life · water · weather**.

- *power* — tiers and satisfaction, so a brownout is legible as a colour
- *life* — fluid buffers along the survival chain
- *water* — pipe routes, directional flow beads, amber diamonds at ports that
  need attention
- *weather* — the storm field, cells and tracks (paired with the radar station)

## The operations dashboard

`O` or the 📊 topbar button opens **Red Frontier Operations**: the colony's six
headline rows (power, water, oxygen, food with fill % and a stability status,
fleet operational count, the autonomy streak), a *single points of failure*
strip naming any critical chain with exactly one producer, and nine toggleable
history graphs (power, water, oxygen, food, ore, rover utilization, battery
reserves, production, consumption) over the live ring or the per-sol record. It
is strictly a read: the dashboard states what the colony is doing and names no
fix — diagnosis stays the player's job.

## The bottleneck advisor

`B` or the ⚠ topbar button opens the **Bottleneck Advisor** — the counterpart
the dashboard deliberately does not carry. For each measured bottleneck
(worst first, of the three kinds it watches: water, oxygen, power) it states
production vs consumption per sol, the projected shortage in sols, the
*contributing factors* behind it (each one a measured fact — a damaged
machine, an emptied silo, a 2.4 km haul, a refinery outdrawing the grid), and
*possible solutions* — suggestions only. Tapping a factor or solution that
names a machine focuses it, exactly like an alert card. The advisor never
issues a command: it names the problem and solving it stays the player's. The
⚠ button carries a count badge in the worst severity's colour whenever any
bottleneck is active, so a shortage is visible even with the panel closed —
and the panel states "No bottlenecks" when nothing is short.

## The map

The minimap paints the whole claim from the read model — rovers, buildings, POIs,
deposits, the colonist, storm cells at true scale, claim bounds. Clicking it
opens a zoomable/pannable world map with fit-to-world, reset, zoom, a legend and
click-to-select markers. Its transform is independent of the camera rig, so
closing the map never moves your view.

## The Engineering screen

Right-click (desktop) or long-press (touch) a rover or building. It opens with a
slowly rotating model and **Overview / Upgrades / Appearance / Actions** tabs.
The colony pauses while you browse; closing restores the previous speed,
including an already-paused game. Reduced-motion preferences disable the
automatic spin. Details in [Engineering and Upgrades](Engineering-and-Upgrades.md).

## Menus, settings and saves

- **Main menu** — New Expedition (wizard), Load Game, and a build badge that
  opens the changelog timeline of every deploy since Prototype 1.
- **Mission wizard** — difficulty, world options, world size, seed, and the
  landing site on a spinnable globe.
- **Pause menu** — three tabs over the frozen colony: actions (resume / save /
  return to menu), settings (applied live), expedition (a plain-data portrait of
  the colony). While it is open the menu owns the keyboard and only `Esc` is honoured.
- **Persisted settings** — autopause on new critical alerts, save when the tab is
  hidden, autosave interval (off / 30 / 45 / 60 / 120 s), render resolution
  (ultra ≤2× / high ≤1.5× / performance 1×), shadows, weather FX, HUD hidden.
- **Saves** — one `localStorage` slot per expedition, versioned; see
  [Persistence and Save Format](Persistence-and-Save-Format.md).
- **Update card** — when a newer deploy is live the sim freezes and a card lists
  what is new; you save, then reload. Nothing happens by itself.

## Accessibility

Currently delivered: pause-friendly design, 44 px-class touch targets, icon +
text alerts (never colour alone), scalable panel chrome, `prefers-reduced-motion`
honoured in the Engineering screen, and full keyboard hotkeys on desktop.
A full accessibility pass is still open — and the procedural soundscape has **no
mute or volume control yet**, which is a known gap.

## Sound

Audio starts on the first click, tap or game hotkey (browser autoplay policy).
Menus carry a quiet command-deck ambience; the colony mixes wind, dust storms,
storm electrostatic discharges, machinery and power warnings from the live read
model. **Pausing fades time-bound machinery but keeps wind and storm audible**, so
inspecting a frozen colony never turns the world silent. Every menu control and
player command has a short confirmation cue. See
[Rendering and Audio](Rendering-and-Audio.md).

## Next

- [Blueprint Reference](Blueprint-Reference.md) — what everything costs and does
- [Developer Mode](Developer-Mode.md) — the panel, and why it cannot corrupt a save
