#!/usr/bin/env node
/**
 * Publish the repository's wiki/ directory to the GitHub page wiki.
 *
 *   node scripts/publish-wiki.mjs                 # validate, then publish
 *   node scripts/publish-wiki.mjs --check         # validate only (links, titles, assets)
 *   node scripts/publish-wiki.mjs --dry-run       # show what would be written
 *   node scripts/publish-wiki.mjs -m "docs: …"    # custom commit message
 *
 * Why this exists: GitHub wikis are a *separate* git repository
 * (`<owner>/<repo>.wiki.git`) and there is no public REST API for pages, so the
 * only programmable path is a commit. Keeping the Markdown in the main repository
 * means documentation reviews like code and stays diffable against the source it
 * describes; this script makes the wiki a build artifact of that source.
 *
 * Link handling: pages link to each other as `[Water Networks](Water-Networks.md)`
 * so the same file reads correctly while browsing the repo. GitHub wikis address
 * pages without the extension, so each relative `.md` link is rewritten to its page
 * name on the way out.
 *
 * Needs push access to the wiki: a token with the repository **"Wikis: Write"**
 * permission. Without it GitHub answers `404 Repository not found` for
 * `<owner>/<repo>.wiki.git`, even on a public repository — which is also the reply
 * for a wiki that has never had a page created; the script distinguishes the two by
 * trying to create it and reporting exactly what to do next.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wikiSiteUrl, wikiUrlFromInput, wikiUrlFromRemote } from './wiki-url.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_DIR = path.join(ROOT, 'wiki');
/** Not published: it documents the workflow, not the game. */
const SKIP = new Set(['README.md']);
const ASSET_DIR = 'assets';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check' || a === 'check') flags.check = true;
  else if (a === '--dry-run' || a === '-n') flags.dryRun = true;
  else if (a === '--help' || a === '-h') flags.help = true;
  else if (a === '--no-clean') flags.noClean = true;
  else if (a === '--no-push') flags.noPush = true;
  else if (a === '--message' || a === '-m') flags.message = argv[++i];
  else if (a === '--url') flags.url = argv[++i];
  else if (a === '--branch') flags.branch = argv[++i];
  else if (a === '--dir') flags.dir = argv[++i];
  else die(`unknown argument: ${a}\n\n${USAGE}`);
}

const USAGE = `usage: node scripts/publish-wiki.mjs [--check] [--dry-run] [--no-push]
                        [-m MSG] [--url GIT_URL] [--branch NAME] [--dir PATH]

  --check      validate the wiki source (links, page names, assets, structure) and exit
  --dry-run    write and commit, but never push; print the plan instead
  --no-push    prepare a commit locally, leave it unpushed
  --url        wiki git url (default: derived from git remote origin)
  --branch     wiki branch (default: whatever the wiki's HEAD points at)
  --dir        where to stage the clone (default: a temp dir, removed afterwards)
  -m, --message commit message (default: generated with the source commit)
`;

if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

/**
 * The wiki branch. `--branch` wins; otherwise ask the remote what its HEAD points
 * at, because a wiki created before GitHub moved to `main` lives on `master` and a
 * `main` pushed beside it is a branch nobody will ever see. Fall back to the source
 * repository's default branch, then `main`, for a wiki that does not exist yet.
 */
function resolveBranch(url) {
  if (flags.branch) return flags.branch;
  const sym = git(['ls-remote', '--symref', url, 'HEAD'], { allowFail: true, cwd: os.tmpdir() });
  const m = typeof sym === 'string' && sym.match(/ref:\s*refs\/heads\/(\S+)/);
  if (m) return m[1];
  const local = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const lm = typeof local === 'string' && local.match(/origin\/(\S+)/);
  return lm ? lm[1] : 'main';
}
let BRANCH = flags.branch ?? 'main';

function die(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
}
const info = (m) => console.log(`\x1b[36m·\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd: opts.cwd ?? ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (opts.allowFail) {
      lastGitError = (e.stderr || e.message || '').toString().trim().split('\n')[0];
      return FAIL;
    }
    const why = (e.stderr || e.message || '').toString().trim().split('\n').slice(0, 3).join('\n  ');
    die(`git ${args.join(' ')} failed:\n  ${why}`);
  }
}
/** Sentinel so a *failed* call is distinguishable from one that succeeded quietly. */
const FAIL = Symbol('git-failed');
let lastGitError = '';

// ------------------------------------------------------------------ sources ----

if (!fs.existsSync(WIKI_DIR)) die(`no wiki directory at ${path.relative(ROOT, WIKI_DIR)}`);

/** All published pages, in a stable order, with their rewritten content. */
function collect() {
  const entries = fs.readdirSync(WIKI_DIR, { withFileTypes: true });
  const pages = [];
  const assets = [];

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(WIKI_DIR, e.name);
    if (e.isDirectory() && e.name === ASSET_DIR) {
      for (const f of walk(abs))
        assets.push({ rel: path.relative(WIKI_DIR, f).split(path.sep).join('/'), abs: f });
    } else if (e.isFile() && e.name.endsWith('.md') && !SKIP.has(e.name)) {
      pages.push({ rel: e.name, abs });
    } else if (e.isFile() && !SKIP.has(e.name)) {
      warn(`not published (not a .md page): wiki/${e.name}`);
    }
  }
  return { pages, assets };
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

const { pages, assets } = collect();
const pageNames = new Set(pages.map((p) => p.rel.replace(/\.md$/, '')));

/**
 * Relative `.md` links → wiki page links (`Foo.md` → `Foo`, anchors preserved).
 * Unknown targets are left alone: `check()` is what reports them.
 */
function rewrite(text) {
  let rewrites = 0;
  const out = text.replace(
    /\]\((?!https?:\/\/|mailto:)([^)\s]+?)(\s+"[^"]*")?\)/g,
    (full, target, title = '') => {
      const [filePart, anchor] = target.split('#');
      if (!filePart.endsWith('.md')) return full;
      const name = path.posix.basename(filePart, '.md');
      if (!pageNames.has(name)) return full;
      rewrites++;
      return `](${name}${anchor ? `#${anchor}` : ''}${title})`;
    },
  );
  return { text: out, rewrites };
}

// -------------------------------------------------------------------- check ----

const problems = [];
const notes = [];

function check() {
  if (!pageNames.has('Home')) problems.push('no wiki/Home.md — GitHub renders Home as the landing page');
  if (!pageNames.has('_Sidebar')) warn('no wiki/_Sidebar.md — the wiki will show its default navigation');
  if (!pageNames.has('_Footer')) warn('no wiki/_Footer.md — pages will have no shared footer');

  for (const p of pages) {
    const raw = fs.readFileSync(p.abs, 'utf8');
    const name = p.rel.replace(/\.md$/, '');

    const chrome = name.startsWith('_');
    if (!/^_?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      problems.push(`${p.rel}: page names must be hyphenated, without spaces or slashes`);

    const lines = raw.split('\n');
    const firstContent = lines.findIndex((l) => l.trim() !== '');
    const head = lines.slice(0, 5).join('\n');
    if (!chrome && !/^#\s+\S/m.test(head))
      problems.push(`${p.rel}: expected a "# Title" within the first few lines`);
    if (!chrome && name !== 'Home') {
      if (!/^\s*>\s*←\s*\[Home\]\(Home\.md\)/m.test(head))
        notes.push(`${p.rel}: missing the "> ← [Home](Home.md)" breadcrumb`);
    }
    if (!raw.endsWith('\n')) problems.push(`${p.rel}: file must end with a newline`);
    if (/\[\[/.test(raw)) notes.push(`${p.rel}: uses [[Gollum]] links — prefer [text](Page.md) so the repo renders too`);
    if (/~~~/.test(raw)) notes.push(`${p.rel}: uses ~~~ fences; prefer \`\`\` for the wiki renderer`);

    // Every relative link must name a published page file. Wiki chrome may use
    // extension-less wiki links, which only resolve once published.
    for (const l of raw.match(/\]\((?!https?:\/\/|mailto:|assets\/)[^)\s]+(?:#[^)]*)?\)/g) ?? []) {
      const target = l.slice(2, -1).split('#')[0];
      if (!target.endsWith('.md')) {
        if (chrome) continue;
        problems.push(`${p.rel}: non-page relative link "${target}" — write it as Page.md`);
      } else if (!pageNames.has(path.posix.basename(target, '.md'))) {
        problems.push(`${p.rel}: link target does not exist: ${target}`);
      }
    }
    const imgs = raw.match(/!\[[^\]]*\]\(([^)\s]+)\)/g) ?? [];
    for (const im of imgs) {
      const target = im.slice(im.indexOf('(') + 1, -1);
      if (/^https?:/.test(target)) continue;
      if (!fs.existsSync(path.join(WIKI_DIR, target)))
        problems.push(`${p.rel}: missing asset ${target}`);
    }
  }

  // Anchors inside our own pages: cheap check that `Page#anchor` exists.
  for (const p of pages) {
    const raw = fs.readFileSync(p.abs, 'utf8');
    for (const m of raw.matchAll(/\]\((?!https?:\/\/)([A-Za-z0-9._-]+)\.md#([a-z0-9-]+)\)/g)) {
      const target = path.join(WIKI_DIR, `${m[1]}.md`);
      if (!fs.existsSync(target)) continue;
      const slug = fs
        .readFileSync(target, 'utf8')
        .split('\n')
        .filter((l) => /^#{1,6}\s/.test(l))
        .map((l) =>
          l
            .replace(/^#+\s*/, '')
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-'),
        );
      if (!slug.includes(m[2]))
        problems.push(`${p.rel}: anchor #${m[2]} not found in ${m[1]}.md`);
    }
  }

  // Orphans: nothing in Home or the sidebar reaches them, so the wiki buries them.
  const nav = [path.join(WIKI_DIR, 'Home.md'), path.join(WIKI_DIR, '_Sidebar.md')]
    .map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''))
    .join('\n');
  for (const p of pages) {
    const n = p.rel.replace(/\.md$/, '');
    if (n === 'Home' || n.startsWith('_')) continue;
    if (!new RegExp(`\\]\\(${n}(?:[.#])?\\)`).test(nav) && !new RegExp(`\\]\\(${n}\.md`).test(nav))
      notes.push(`${p.rel}: not linked from Home or _Sidebar — an orphan page in the wiki`);
  }

  const counts = { pages: pages.length, assets: assets.length, chars: pages.reduce((n, p) => n + fs.statSync(p.abs).size, 0) };
  console.log(`\n${counts.pages} pages, ${counts.assets} assets, ${(counts.chars / 1024).toFixed(1)} KB of Markdown`);
  for (const p of pages) {
    const { rewrites } = rewrite(fs.readFileSync(p.abs, 'utf8'), p.rel);
    const line = `  ${p.rel.replace(/\.md$/, '').padEnd(36)} ${String(rewrites).padStart(2)} internal link(s)`;
    console.log(p.rel.startsWith('_') ? `\x1b[2m${line} (wiki chrome)\x1b[0m` : line);
  }

  if (problems.length) {
    console.error('');
    for (const pr of problems) console.error(`\x1b[31m✗\x1b[0m ${pr}`);
    die(`${problems.length} problem(s) in wiki/`);
  }
  for (const n of notes) warn(n);
  ok('wiki source is consistent');
}

// ------------------------------------------------------------------- publish ----

/**
 * Where to publish: `--url` when given, otherwise the wiki repository beside
 * `origin`. `origin` is spelled differently on every machine — an HTTPS clone, an
 * `scp`-style SSH remote, a URL with a trailing slash copied out of the browser —
 * so the parsing lives in `scripts/wiki-url.mjs`, where the spellings are pinned by
 * tests, and only the reporting lives here.
 */
function wikiUrl() {
  if (flags.url) {
    const url = wikiUrlFromInput(flags.url);
    if (!url) die('--url needs a git url, e.g. --url https://github.com/<owner>/<repo>.wiki.git');
    return url;
  }
  const remote = git(['remote', 'get-url', 'origin'], { allowFail: true });
  if (remote === FAIL || !remote)
    die('no git remote "origin" — pass --url https://github.com/<owner>/<repo>.wiki.git');
  const url = wikiUrlFromRemote(remote);
  if (!url)
    die(
      `cannot derive a wiki url from remote "${remote}"\n` +
        '  expected a GitHub repository remote such as\n' +
        '    https://github.com/<owner>/<repo>.git   or   git@github.com:<owner>/<repo>.git\n' +
        '  or pass the wiki url directly:\n' +
        '    npm run wiki:publish -- --url https://github.com/<owner>/<repo>.wiki.git',
    );
  return url;
}

function cfg(key, cwd) {
  const v = git(['config', key], { cwd, allowFail: true });
  return typeof v === 'string' && v ? v : '';
}

/**
 * A wiki clone is a fresh repository, so it usually has no identity of its own.
 * Borrow the main repository's configured (or last-authored) identity rather than
 * failing the publish at commit time.
 */
function authorArgs(dest) {
  if (cfg('user.email', dest) && cfg('user.name', dest)) return [];
  const name = cfg('user.name', ROOT) || git(['log', '-1', '--format=%an'], { allowFail: true }) || '';
  const email = cfg('user.email', ROOT) || git(['log', '-1', '--format=%ae'], { allowFail: true }) || '';
  if (!name || !email || name === FAIL || email === FAIL) {
    warn('no git identity available for the wiki commit — set user.name/user.email if the commit fails');
    return [];
  }
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

function stage(dest) {
  // Deliberately does not wipe `dest`: the cloned `.git` is how the commit gets a
  // remote to push to. Stale files are removed by prune() against the index.
  fs.mkdirSync(dest, { recursive: true });
  let written = 0;
  let links = 0;
  for (const p of pages) {
    const { text, rewrites } = rewrite(fs.readFileSync(p.abs, 'utf8'));
    fs.writeFileSync(path.join(dest, p.rel), text);
    links += rewrites;
    written++;
  }
  for (const a of assets) {
    const out = path.join(dest, a.rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(a.abs, out);
  }
  return { written, links };
}

/** Remove tracked files this source no longer has, so the wiki mirrors wiki/. */
function prune(dest) {
  const keep = new Set([...pages.map((p) => p.rel), ...assets.map((a) => a.rel)]);
  const listed = git(['ls-files'], { cwd: dest, allowFail: true });
  const tracked = typeof listed === 'string' ? listed.split('\n').filter(Boolean) : [];
  const gone = tracked.filter((f) => !keep.has(f));
  for (const f of gone) fs.rmSync(path.join(dest, f), { force: true });
  return gone;
}

async function publish() {
  const url = wikiUrl();
  BRANCH = resolveBranch(url);
  info(`wiki branch: ${BRANCH}`);
  const sha = git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) ?? 'unknown';
  const dest = flags.dir ? path.resolve(ROOT, flags.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'rf-wiki-'));

  info(`wiki remote: ${url}`);
  info(`staging in:  ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });

  // Three real states: (1) a wiki with pages → clone it; (2) a wiki repository
  // with no branch yet (a freshly created or empty wiki) → start from nothing but
  // keep the remote; (3) no reachable wiki git repo at all → try to create it, which
  // is exactly what a first push to <owner>/<repo>.wiki.git does when the token is
  // allowed to write wikis.
  const reachable = git(['ls-remote', url, 'HEAD'], { allowFail: true, cwd: os.tmpdir() }) !== FAIL;
  let bootstrapped = !reachable;

  if (reachable) {
    const cloned = git(['clone', '--quiet', '--depth', '1', '--branch', BRANCH, url, dest], {
      allowFail: true,
      cwd: os.tmpdir(),
    });
    if (cloned === FAIL) {
      bootstrapped = true;
      info(`could not clone "${BRANCH}" (${lastGitError || 'no such branch'}) — starting from an empty tree`);
    } else {
      info('cloned the current wiki pages');
    }
  } else {
    warn('no wiki git repository is reachable — preparing to create it with the first push');
  }

  if (bootstrapped) {
    git(['init', '--quiet', '--initial-branch', BRANCH, dest], { cwd: os.tmpdir() });
    git(['remote', 'add', 'origin', url], { cwd: dest });
  }

  const { written, links } = stage(dest);
  const removed = bootstrapped ? [] : prune(dest);
  ok(`staged ${written} pages (${links} internal links rewritten) and ${assets.length} assets` +
     (removed.length ? `, removing ${removed.length} stale file(s)` : ''));

  const status = git(['status', '--porcelain'], { cwd: dest });
  if (!status) {
    ok('the wiki already matches wiki/ — nothing to publish');
    cleanup(dest);
    return;
  }
  for (const line of status.split('\n')) console.log(`    ${line}`);
  if (flags.dryRun) {
    console.log(`\ndry run: ${written} page(s) would be committed to ${BRANCH} of ${url}`);
    cleanup(dest);
    return;
  }

  const msg = flags.message ?? `docs: publish the wiki from ${sha}\n\n${written} pages, ${assets.length} assets, generated from wiki/ by scripts/publish-wiki.mjs.`;
  const A = authorArgs(dest);
  git(['add', '-A'], { cwd: dest });
  git([...A, 'commit', '--quiet', '-m', msg], { cwd: dest });
  ok(`committed: ${git(['log', '-1', '--format=%s'], { cwd: dest })}`);

  if (flags.noPush) {
    warn('--no-push: the commit is staged in the clone, not published');
    console.log(`    cd ${dest} && git push origin ${BRANCH}\n`);
    return;
  }

  let pushErr = '';
  try {
    execFileSync('git', ['push', '--quiet', 'origin', `HEAD:${BRANCH}`], {
      cwd: dest,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    pushErr = (e.stderr || e.message || '').toString().trim();
  }
  if (pushErr) {
    console.error('');
    warn('the push was refused. Two common causes:');
    console.error(`  ${bootstrapped ? '1' : '2'}. **Token scope** — publishing needs the repository permission
     "Wikis: Write". With only "Contents: Write", GitHub answers
     "remote: Repository not found." for ${url}`);
    console.error(`  ${bootstrapped ? '2' : '1'}. **First page** — GitHub materialises a wiki's git repo when the
     wiki exists. Create one page, then re-run this command:
     https://github.com/iant89/red-frontier/wiki/_new`);
    if (!bootstrapped)
      console.error('  If the wiki moved while you were publishing, re-run — the clone is\n  disposable and the source of truth is wiki/.');
    console.error(`\n  git said:\n    ${pushErr.split('\n').join('\n    ')}`);
    console.log(`\nYour commit is preserved here: ${dest}`);
    console.log(`Finish manually with:  git -C ${dest} push origin HEAD:${BRANCH}\n`);
    process.exitCode = 1;
    return;
  }
  cleanup(dest);
  ok(`published ${written} pages to ${wikiSiteUrl(url)}`);
}

function cleanup(dest) {
  if (flags.noClean || flags.dir) return;
  if (dest.startsWith(os.tmpdir())) fs.rmSync(dest, { recursive: true, force: true });
}

// --------------------------------------------------------------------- main ----

check();
if (!flags.check) await publish();
