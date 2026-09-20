> ← [Home](Home.md)

# Contributing

How work actually gets done in this repository. The authoritative short version is
[`AGENTS.md`](https://github.com/iant89/red-frontier/blob/main/AGENTS.md)
at the repo root — it is written for humans and for coding agents alike.

## Before you touch anything

```bash
npm install
npm run typecheck
npm test
npm run build
```

Install project tooling **through the package manifest** — `tsc`, Vite, the test
runner and (when browser smokes are needed) Playwright via
`node scripts/setup-playwright.mjs`. Do not install tools globally; the repo does
not require it.

Read, in this order:

| Document | Why |
|---|---|
| [`AGENTS.md`](https://github.com/iant89/red-frontier/blob/main/AGENTS.md) | working rules, useful commands, session setup |
| [`mnemosyne.md`](https://github.com/iant89/red-frontier/blob/main/mnemosyne.md) | the shared project notepad — including *"Learned the hard way"* |
| [`ARCHITECTURAL-REFACTOR-ROADMAP.md`](https://github.com/iant89/red-frontier/blob/main/ARCHITECTURAL-REFACTOR-ROADMAP.md) | the golden rules, and where debt is tracked |
| [`docs/design/GDD.md`](https://github.com/iant89/red-frontier/blob/main/docs/design/GDD.md) / [`TDD.md`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md) | design target vs as-built, per section |
| [`docs/design/ROVER-STATE.md`](https://github.com/iant89/red-frontier/blob/main/docs/design/ROVER-STATE.md) | the rover state model, before you touch `RoverSystem` |

## Working rules

- **Read the relevant existing code and tests before changing behaviour.**
- **Add or update tests for behaviour changes.** A behaviour with no test is a
  behaviour that will be "refactored" away.
- **Run the narrowest relevant check first** (`npm test -- <area>/<suite>`,
  `npm run test:affected`), then broaden when time permits.
- **Commands represent player intent.** UI code must never mutate simulation state
  directly — see [Host and Worker Protocol](Host-and-Worker-Protocol.md).
- **`src/sim/` stays independent** of the DOM, three.js and React/UI state.
- **Keep the tick order.** It is commented as load-bearing in `Simulation.ts`.
- **Track your shortcuts.** If new code contains a known shortcut, temporary
  coupling, or a responsibility that belongs to a later phase, add an entry to the
  relevant phase section of `ARCHITECTURAL-REFACTOR-ROADMAP.md`. Debt is only
  invisible when it is untracked.
- **Keep generated artifacts out of Git** unless the project requires them.
- **Do not commit or push unless the task calls for it** — the standing rule for
  automated sessions in this repo.

## The loop for a change

```bash
npm run test:affected                 # while iterating
npm run typecheck && npm test         # before a PR
npm run build                         # what CI will run (tsc + vite)
node scripts/setup-playwright.mjs     # only if a smoke is affected
npm run build && npx vite preview --port 5199 --strictPort &
node scripts/worker-smoke.mjs && SMOKE_QUERY='?worker=0' node scripts/worker-smoke.mjs
```

CI on a PR runs `npm ci` → Chromium → `npm run build` → mobile smoke → worker smoke
**once per transport**. It does **not** run `npm test`, so the suite is your
responsibility, not the pipeline's.

## Where to put things

| Adding… | Touch |
|---|---|
| a **blueprint or bulk resource** | `src/sim/defs.ts` (+ `config.ts` for balance) — **no protocol change needed**; the decoder validates against the tables |
| a **component** | `defs.ts` (`ComponentId`, `COMPONENTS`, `emptyComponents`, `RECIPES`) + `ComponentSystem` capacity + rack UI |
| a **player command** | the five-step checklist in [Host and Worker Protocol](Host-and-Worker-Protocol.md#adding-a-command-the-checklist) |
| a **dev backdoor** | `src/sim/DevBackdoors.ts` + a `dev/*` command — never a player path |
| a **save field** | `SaveSchema.ts`, `SAVE_VERSION`, `migrations/vN.ts`, restore defaults — [Persistence and Save Format](Persistence-and-Save-Format.md#adding-a-field-checklist) |
| a **test suite** | `tests/<area>/<name>.test.ts` with the four-line header, then link it in `tests/full.test.ts` |
| a **system** | `src/sim/systems/<Name>System.ts` as a static API over `ColonyState` |
| a **3D model** | drop a `.glb` at the `assetCatalog` path — the fallback contract means nothing breaks while it is missing |

Three things never change without a design decision: bulk solids ride rovers while
**fluids never do**; storage stays **per-resource**; developer-mode *modifiers*
never enter a save while *fabricated objects* always do.

## Issues and status vocabulary

[`ISSUES.md`](https://github.com/iant89/red-frontier/blob/main/ISSUES.md) is the
backlog of player-facing bugs and feature gaps — status `Open · In progress ·
Blocked · Done`, priority `P1` (annoying every session) `P2` (noticeable) `P3`
(polish). Nothing there is scheduled; pull an item when there is a window. Its line
references drift on purpose — they are a starting point, not a promise.

Design sections use `IN · PARTIAL · OUT`
([Roadmap and Status](Roadmap-and-Status.md)), and a doc realignment is a real
commit: it re-sweeps §0 status, the test counts and the save version against the
tree. When you ship a slice, **update GDD §0/§16, TDD §25/Appendix B, the README and
`mnemosyne.md`** — the docs are the project's memory and they go stale in weeks.

## This wiki

Wiki source lives in-repo at
[`wiki/`](https://github.com/iant89/red-frontier/tree/main/wiki) so documentation
reviews like code, and is published to the GitHub wiki by
[`scripts/publish-wiki.mjs`](https://github.com/iant89/red-frontier/blob/main/scripts/publish-wiki.mjs).

```bash
node scripts/publish-wiki.mjs --check     # validate links, titles and assets
node scripts/publish-wiki.mjs --dry-run   # show what would change
node scripts/publish-wiki.mjs -m "docs: clarify the tick order"
```

Conventions for writing a page:

- **File name = page name**: `Power-and-Life-Support.md` → the page
  `Power-and-Life-Support`. No spaces, no `.md` in links between pages.
- Link sibling pages with a plain relative link to the file —
  `[Water Networks](Water-Networks.md)` — and let the publish step turn it into a
  wiki link. Absolute links to **code** use full `github.com` URLs, because the wiki
  is a different repository from the code.
- Keep the `> ← [Home](Home.md)` breadcrumb at the top of every non-Home page.
- Pages are **as-built**: state what the code does, name the file that does it, and
  say plainly when something is out of scope. A wiki that describes the design
  instead of the build is a second GDD, and this repo already has one.
- Numbers come from `config.ts` / `defs.ts`. If you change a balance constant,
  change the page in the same PR — run `node scripts/publish-wiki.mjs --check` to
  catch broken links, and grep the wiki for the old value.

## Reviewing a change

The questions this repo actually asks:

1. Does the tick order and the host seam survive?
2. Is the behaviour pinned by a test, and does that test name what it covers?
3. Same seed, same commands, same elapsed time — same state hash?
4. Does an older save still load, with sane defaults rather than compensation?
5. Did the docs move with the code?

## Related

- [Getting Started](Getting-Started.md) · [Testing and QA](Testing-and-QA.md) ·
  [Architecture Overview](Architecture-Overview.md)
