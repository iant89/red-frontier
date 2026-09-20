> ← [Home](Home.md)

# Getting Started

Everything you need to build the game and run a colony on your own machine.

## Requirements

| | |
|---|---|
| Node.js | **18+** (the launchers install Node LTS; CI uses 22) |
| Git | any recent version |
| Browser | any modern desktop or mobile browser with **WebGL2** and **module workers** |
| Disk | a few hundred MB for `node_modules` and `dist/` |

No accounts, no backend, no network access at runtime: the terrain textures and
every sound are generated in the browser, and the GLB model folder is optional.

## The short way (launchers)

Ready-made setup, build and preview scripts live in
[`launchers/`](https://github.com/iant89/red-frontier/tree/main/launchers) —
kept deliberately separate from the internal tooling in `scripts/`.

### Ubuntu / Debian

```bash
./launchers/setup_ubuntu.sh        # verify/install Git, Node LTS, npm dependencies
./launchers/update_and_build.sh    # pull latest commits, update deps, production build
./launchers/launch_preview.sh      # serve dist/ and open the browser
```

### Windows 11

```cmd
launchers\setup_windows.bat
launchers\update_and_build.bat
launchers\launch_preview.bat
```

The `.bat` files can also be double-clicked from Explorer. Useful flags:

| Script | Flags |
|---|---|
| `setup_ubuntu.sh` | `-y` unattended · `-d <dir>` clone target · `-s` skip system packages · `-v` verbose |
| `update_and_build.sh` | `-b <branch>` · `-s` skip pull · `-c` clean rebuild |
| `launch_preview.sh` | `-p <port>` · `-h <host>` · `-b` force rebuild · `--no-open` |

Windows equivalents: `/y`, `/skip-pull`, `/clean`, `/help`.

## The manual way

```bash
npm install
npm run dev             # Vite dev server → http://localhost:5173
npm run build           # tsc + vite build → dist/
npm run preview         # serve the production build (default :4173)
npm run typecheck       # type-check src and tests
npm test                # 87 suites / 983 checks, isolated parallel workers
```

`npm run build` runs `tsc` first, so a build failure is usually a type error
rather than a bundler complaint.

## Playing for the first time

1. **New Expedition** → the wizard asks for difficulty, world options, world
   size and a landing region (or just a seed). Random is fine for the first run.
2. You land with a descent stage, two rovers and roughly **four sols** of air,
   water and rations. The stage's RTG is your first 14 kW of power.
3. Build in this order: **Warehouse → Solar + Battery → Water Extractor →
   Oxygen Generator → Greenhouse → Habitat**. Watch the *empty in…* estimates on
   the left panel — they are the real clock.
4. When the chain holds, raise a **Refinery** and start smelting steel.

[How to Play](How-to-Play.md) covers the full loop, orders and storm prep.

## URL flags worth knowing

| Flag | Effect |
|---|---|
| `?worker=0` | Force the **in-process** sim host instead of the module worker. Every unit suite drives this transport; the fallback for browsers that cannot start a worker. |
| `?updateCheckMs=<n>` | Override the in-play build-check poll interval (min 1000 ms). QA knob for the update card. |

The colony runs on a worker **by default** (`WORKER_DEFAULT = true`). If a
worker cannot start — a `file:` page, a browser without module workers — the
factory logs why and falls back instead of showing a blank screen. See
[Host and Worker Protocol](Host-and-Worker-Protocol.md).

## Testing and validation

```bash
npm test                     # everything, in parallel (~1 min)
npm run test:serial          # same coverage, one linked process (easier debugging)
npm run test:affected        # only the suites your working changes touch
npm run test:watch           # …and again on every save
npm test -- power            # any suite whose name or description matches "power"
npm run test:list            # every suite and what it covers
```

Browser smokes need Playwright:

```bash
node scripts/setup-playwright.mjs     # the project's installer — don't hunt for another
npm run build && npx vite preview --port 5199 --strictPort &
node scripts/worker-smoke.mjs                          # the worker (default transport)
SMOKE_QUERY='?worker=0' node scripts/worker-smoke.mjs  # the same, in-process
```

Full details in [Testing and QA](Testing-and-QA.md).

## Mobile

The game is touch-first as well as mouse-first: tap to select, long-press for
Engineering or a context order, pinch to zoom, two-finger drag to pan. Panels
drag and snap to the viewport edges. Run the mobile smoke against a served build:

```bash
node scripts/mobile-smoke.mjs
```

## Where the build is deployed

`main` is published to GitHub Pages by
[`.github/workflows/pages.yml`](https://github.com/iant89/red-frontier/blob/main/.github/workflows/pages.yml):
`npm ci` → headless Chromium → `npm run build` (so every PR type-checks) → serve
that exact `dist/` → `mobile-smoke` → `worker-smoke` **once per transport** →
deploy on `main` only. **`npm test` is not part of CI** — the full suite is the
local and review contract.

Every build stamps its commit into the bundle and ships `dist/version.json`; a
newer deploy while you are playing freezes the colony and offers a save-then-
reload hand-off. Nothing saves or reloads by itself.

## Next

- [How to Play](How-to-Play.md) — the survival loop, orders, storm prep
- [Interface and Controls](Interface-and-Controls.md) — every panel and hotkey
- [Contributing](Contributing.md) — repo rules, review expectations, the wiki
