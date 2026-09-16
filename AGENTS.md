# Agent instructions

Read `mnemosyne.md` before working in this repository. If it does not exist, create it in the repository root. You may add useful information to it at any time so that future sessions have a shared project notepad.

Read `ARCHITECTURAL-REFACTOR-ROADMAP.md` before generating new code. Respect any refactoring work in progress or planned refactoring phases when adding code: prefer the target architecture (separate systems under `sim/systems/`, state in `ColonyState`, persistence under `sim/persistence/`, application controllers under `app/`) over adding new responsibilities to `Simulation.ts` or `Game.ts` when a reasonable incremental choice exists. If newly generated code contains a known shortcut, temporary coupling, or responsibility that will eventually need to be refactored into one of the roadmap phases, add an entry for it into the appropriate phase section of `ARCHITECTURAL-REFACTOR-ROADMAP.md` so the debt is tracked.

## Repository notes

- This is a TypeScript/Vite project. Keep simulation logic, host-boundary code, and presentation code in their existing areas unless there is a good reason to change the structure. Follow the target source layout in `ARCHITECTURAL-REFACTOR-ROADMAP.md` section 50 when creating new files.
- The simulation (`src/sim/`) must remain independent of the DOM, Three.js, and React/UI state. See the "Golden Rules" and "Things NOT to Modify" sections of the roadmap.
- Commands represent player intent; UI code must never mutate simulation state directly.
- The Playwright setup script is `scripts/setup-playwright.mjs`. Run that script when Playwright is needed; do not spend time searching for a separate installer.
- Install project dependencies before running validation. The TypeScript compiler (`tsc`) is provided by the project's TypeScript dependency, rather than assumed to be globally installed.

## Useful commands

```sh
npm install
npm run typecheck
npm test
npm run build
```

For browser smoke-test dependencies, use:

```sh
node scripts/setup-playwright.mjs
```

## Session setup

At the start of a fresh session, ensure the required project tooling is installed through the package manifest. In particular, verify that these commands are available through the local dependencies before using them:

- `tsc` / TypeScript
- Vite
- the project's test runner dependencies
- Playwright, when browser smoke tests are required

Do not install tools globally unless the repository explicitly requires it. Prefer `npm install` and the scripts already defined in `package.json`.

## Working rules

- Read relevant existing code and tests before changing behavior.
- Add or update tests for behavior changes when practical.
- Run the narrowest relevant checks first, then broader validation when time permits.
- Keep generated artifacts and large temporary files out of Git unless the project requires them.
- Do not commit or push unless the task explicitly calls for it.
