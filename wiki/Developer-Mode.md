> ← [Home](Home.md)

# Developer Mode

Open with `` ` `` (backquote) or the 🛠 topbar button in play. Everything the panel
does is a live edit to the running colony — and, by contract, **none of it is
written into the save file**.

## The contract

The mode lives **outside** the sim, and that is structural rather than a convention:

- every edit leaves the panel as a `dev/*` **command** on the colony's host, exactly
  as a player's move order does;
- the keep-battery pin is a host **overlay** (a name plus entity ids, applied by a
  sim-side registry) rather than a per-frame poke from the UI;
- the save payload is built **inside the host**, where the mode has no handle at all;
- building upgrade marks ride on a `level` field that `snapshot()` deliberately skips
  and `restore()` defaults back to 1.

The panel carries an `UNSAVED` badge to say all of this out loud. Verified three ways:
a sim suite, a host-suite snapshot check, and a live read of the stored
`localStorage` blob.

> **Master switch ≠ visibility.** `DevMode.enabled` is the *mode*; opening the panel
> is presentation. Closing the panel leaves the mode and its pins exactly as they
> were — and `overlayState()` publishes nothing at all unless the mode is on. That is
> also why any script that exercises pins (e.g. `scripts/worker-smoke.mjs`'s battery
> check) has to call `dev.enable()` first.

## Environment

Jump to any sol and time of day — the slider **scrubs the sun live**. Conjure or
dismiss any class of dust storm, including the planet-encircling ones. Set airborne
dust directly. Switch the storm scheduler off to fly the sky by hand.

**A screenshot trap:** a `dev/time` jump leaves `weather.time` behind, so a conjured
storm's envelope does not follow the calendar. For imagery, **force the storm and run
at 4×** rather than time-travelling.

Forcing a bolt is reproducible by design: `aim='exact'` drops one on the most exposed
thing standing, with no jitter and no RNG, and because the lightning stream is
separate it does not perturb the weather rolls.

## Spawn

Fabricate rovers, buildings and resource deposits at the camera target — or arm
*place…* and click terrain (`Shift`-click to keep placing, `Esc` to cancel: the same
grammar as the build palette).

Fabrications are **honest sim objects**: buildings pass the real `evaluateSite`
siting checks and come online instantly, rovers arrive fully charged, deposits are
real seams — and everything made this way **does** persist like something you
earned. That asymmetry with the modifiers is intentional: *fabricated objects are
saved, dev modifiers are not.*

## Selection

With a rover, structure or the colonist selected, the panel edits the thing directly:

| Target | Controls |
|---|---|
| Rover | battery charge (+ *keep full while dev mode is on*, which also revives stranded rovers), cargo type and load, drivetrain condition, position lights |
| Structure | health, damage state, cleanliness, power switch, one-click completion for unfinished sites, developer **upgrade** buttons walking Mk 1–5 at **+35% output per mark** |
| Colonist | health, suit O₂ |

The developer `level` is **runtime-only**. Authoritative player refits are
`upgrades` / `upgradeJob` and are saved; the two never touch each other
([Engineering and Upgrades](Engineering-and-Upgrades.md)).

## Input discipline

Hotkeys are swallowed while any form control has focus — the panel's own number
boxes included — so typing a cargo tonnage does not silently pause the colony or
fire a build order. The click-to-place arm grammar is the palette's: `Shift` keeps
placing, `Esc` disarms first and only then closes the panel.

## Debug harness (not in the panel — yet)

| Module | Provides |
|---|---|
| `sim/debug/Profiler.ts` | tick, pathfind, command, worker-message and view-generation counters, plus `Simulation.step` batch timings. A **process-wide switch, default on only under the test harness**, and tree-shaken out of the app bundle |
| `sim/debug/StateHash.ts` | `rf1-<14hex>-<14hex>` over canonical JSON (sorted keys, entity arrays sorted by id) — turns "did this change behaviour?" into a string comparison |
| `sim/debug/Transcript.ts` | a colony as *seed + difficulty + world options + timed commands*, replayed by `npm run test:replay` against pinned hashes |
| `sim/debug/SimulationAssertions.ts` | invariant checks incl. `checkRoverExecution()`, the rover goal/phase table as code |
| `sim/debug/Benchmark.ts` · `LargeColonyScenario.ts` | the fleet benchmark and the 100-rovers + 250-buildings storm scenario |

The state hash covers **live state**, not `snapshot()`, on purpose: a live sim and
its just-restored twin do **not** hash equal, because restore resumes entities at
rest. Compare restored-vs-restored, or both after one advance.

**Still missing** per TDD §22: an on-screen tick/frame perf readout, worker queue
inspection, a state-hash readout, and teleport/reveal cheat commands.

## Related

- [Host and Worker Protocol](Host-and-Worker-Protocol.md) — why every edit is a command
- [Persistence and Save Format](Persistence-and-Save-Format.md) — what exclusion from
  a save actually takes
- [Performance Budgets](Performance-Budgets.md) — the harness that measures it
