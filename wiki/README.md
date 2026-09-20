# Red Frontier — wiki source

This directory is the **source of truth** for the
[project wiki](https://github.com/iant89/red-frontier/wiki). Pages are ordinary
Markdown files in the repository so they can be reviewed in a pull request, diffed
against the code they describe, and published as one atomic set.

## Layout

```
wiki/
  Home.md              the wiki landing page
  _Sidebar.md          wiki chrome: the navigation rail (only rendered by the wiki)
  _Footer.md           wiki chrome: shown on every page
  README.md            this file — not published
  <Page-Name>.md       one file per wiki page
  assets/              images copied into the wiki repo (published, ~1100 px wide)
```

## Rules for a page

- **File name is the page name.** `Power-and-Life-Support.md` → page
  `Power-and-Life-Support`. Hyphens, no spaces, no capitals mid-word.
- First line is `# Title` in sentence case; every non-Home page starts with the
  breadcrumb `> ← [Home](Home.md)`.
- Link sibling pages with a relative link **to the file** —
  `[Water Networks](Water-Networks.md)`. The publish step rewrites it to the wiki
  page form, so the same text works while browsing the repo.
- Link **code** with absolute `github.com` URLs, because the wiki is a separate
  repository from the source (`…/blob/main/src/sim/power.ts`,
  `…/tree/main/wiki`).
- One topic per page; cross-link rather than repeat. Balance numbers come from
  `src/sim/config.ts` and `src/sim/defs.ts` — quote them, don't invent them.
- Write **as-built**: what the code does today, with `IN · PARTIAL · OUT` where the
  design and the build disagree (see [Roadmap-and-Status.md](Roadmap-and-Status.md)).
- Keep the status vocabulary honest. If a page describes something the build cannot
  do, it must say so.

## Workflow

The publisher requires Node.js 18 or newer. Prefer the npm commands below: they
run the repository's Node-version preflight before loading the native ESM
publisher, so an old installation gets a useful upgrade message instead of an
`Unexpected token {` parser error.

```bash
# 1. edit or add a page here, on a branch
$EDITOR wiki/Rover-Logistics.md

# 2. validate links, titles and assets
node scripts/publish-wiki.mjs --check

# 2b. optionally, read it rendered like the wiki does (needs: npm i --no-save marked)
npm run wiki:preview            # → http://localhost:5175

# 3. see what would be published
node scripts/publish-wiki.mjs --dry-run

# 4. open a pull request; merge it
# 5. publish the wiki from the merged tree
node scripts/publish-wiki.mjs -m "docs: clarify the rover goal/phase table"
```

Publishing **replaces** the wiki content with this directory (plus `assets/`) in one
commit. Pages edited in the GitHub wiki web UI are therefore not merged — they are
overwritten. Use the wiki UI for a drive-by fix only when you intend to port it back
into `wiki/` right after.

If a page must exist that this directory does not have, add the file first and let
the publisher create the page.

## When to update which page

| You changed… | Also update |
|---|---|
| a balance constant in `config.ts` / `defs.ts` | [Blueprint-Reference.md](Blueprint-Reference.md), plus any page quoting it |
| a system's responsibilities or the tick order | [Simulation-Systems.md](Simulation-Systems.md) |
| the save schema or a migration | [Persistence-and-Save-Format.md](Persistence-and-Save-Format.md) |
| the protocol surface or a command | [Host-and-Worker-Protocol.md](Host-and-Worker-Protocol.md) |
| performance budgets or measured baselines | [Performance-Budgets.md](Performance-Budgets.md) |
| a shipped slice or a status tag | [Roadmap-and-Status.md](Roadmap-and-Status.md), `Home.md` |
| repo workflow, launcher scripts, CI gates | [Getting-Started.md](Getting-Started.md), [Contributing.md](Contributing.md) |

A doc realignment is a real commit: `npm test` first, then sweep the numbers
(suite/check counts, `SAVE_VERSION`, blueprint counts) so a page never claims a
figure the tree does not have.

## Publishing requirements

The publisher needs push access to the wiki's git repository:

```
https://github.com/<owner>/red-frontier.wiki.git
```

- **Token scope** — a fine-grained PAT or GitHub App installation needs
  **“Wikis: Write”** (repository permissions). `contents: write` alone is not
  enough: GitHub answers `404 Repository not found` for a wiki you cannot write,
  even on a public repository.
- **Bootstrap** — GitHub only materialises the wiki's git repo when the wiki exists.
  If `Settings → Pages and wikis → Wikis` is enabled but the wiki has no pages yet,
  create `Home` once in the web UI
  (<https://github.com/iant89/red-frontier/wiki/_new>), then run the publisher; it
  will fast-forward from there.
- The publisher also accepts `--url`, `--branch` and `--no-push`, and prints the
  exact command to finish manually if it cannot reach the remote.

### Optional: publish from CI

There is no wiki API, so an automated publish is a `git push` from a workflow — and
the workflow's built-in `GITHUB_TOKEN` cannot authorise it, because `wikis` is not
one of the permission keys `GITHUB_TOKEN` supports. The working recipe is a
fine-grained PAT stored as a secret, scoped to this repository with
**Contents: Read** and **Wikis: Write**:

```yaml
  publish-wiki:
    needs: verify
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # The publisher shells out to `git`, so it needs a credential for
      # github.com — not an API token in an env var.
      - name: Authorise git for the wiki repository
        run: |
          git config --global credential.helper store
          echo "https://x-access-token:${{ secrets.WIKI_PAT }}@github.com" > ~/.git-credentials

      - name: Publish wiki/ to the page wiki
        run: node scripts/publish-wiki.mjs -m "docs: publish the wiki from ${GITHUB_SHA:0:7}"
```

Deliberately not wired up by default: the docs are published when a maintainer
publishes them, not on every merge, and a secret with wiki write access is a
capability worth deciding on consciously.
