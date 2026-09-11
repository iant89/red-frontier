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
