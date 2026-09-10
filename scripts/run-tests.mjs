/**
 * The test runner.
 *
 * Every `tests/<area>/<name>.test.ts` file is a suite, and each declares in its
 * header comment what it is and what it pins:
 *
 *   @suite sim/power             the name you type on the command line
 *   @group unit                  unit | integration | determinism | load | hud
 *   @covers src/sim/power.ts …   sources this suite fails when they change
 *   @desc One line on what it is for.
 *
 * tests/full.test.ts imports every suite and links them into a single serial
 * run. `npm test` uses the faster isolated/parallel mode; `npm run test:serial`
 * keeps the linked run available for debugging shared-process behaviour:
 *
 *   node scripts/run-tests.mjs                   full linked serial run
 *   node scripts/run-tests.mjs --all             every suite, own process, in parallel
 *   node scripts/run-tests.mjs power storms      just the suites matching these words
 *   node scripts/run-tests.mjs --group unit      just the fast unit suites
 *   node scripts/run-tests.mjs --affected        just the suites the working diff touches
 *   node scripts/run-tests.mjs --affected=main   … against a branch instead
 *   node scripts/run-tests.mjs --watch --affected
 *   node scripts/run-tests.mjs --list            what exists, and what pins what
 *   node scripts/run-tests.mjs --check           the link list vs. the files on disk
 *
 * Options: --jobs N (default: cores), --verbose (stream every suite's detail),
 * --case TEXT (run only cases whose group/name contains TEXT), --force (rebuild).
 *
 * Suites are bundled with esbuild into node_modules/.test-dist (cached by file
 * signatures) and executed in a child Node process, so each gets a clean module
 * registry. The jsdom-backed HUD suites keep `jsdom` external and resolve it
 * from node_modules; the simulation suites need nothing at all.
 */

import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(root, 'node_modules', '.test-dist');
const FULL_REL = 'tests/full.test.ts';

const tty = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code) => (s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const C = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};
const tick = (ok) => (ok ? C.green('\u2714') : C.red('\u2718'));

// ---------------------------------------------------------------- discovery --
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts')) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Read the `@suite`/`@group`/`@covers`/`@desc` header of a suite file. */
function metaOf(rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const block = text.match(/^\/\*\*([\s\S]*?)\*\//);
  const body = block ? block[1].replace(/^[ \t]*\*[ \t]?/gm, '') : '';
  const tag = (name) => (body.match(new RegExp(`@${name}[ \\t]+([^\\n]*)`)) || [])[1]?.trim() ?? '';
  return {
    rel,
    suite: tag('suite') || rel.replace(/^tests\//, '').replace(/\.test\.ts$/, ''),
    group: tag('group') || 'ungrouped',
    covers: tag('covers').split(/\s+/).filter(Boolean),
    desc: tag('desc'),
    checks: (text.match(/^test\(/gm) || []).length,
  };
}

const suites = fs.existsSync(path.join(root, 'tests')) ? walk(path.join(root, 'tests')).filter((r) => r !== FULL_REL).map(metaOf) : [];

// ------------------------------------------------------------ import closure --
const TRY_EXT = ['', '.ts', '.js', '.mjs', '/index.ts'];

function resolveLocal(fromRel, spec) {
  if (!spec.startsWith('.')) return null; // a package or builtin: jsdom, three, node:*
  const base = path.posix.join(path.posix.dirname(fromRel), spec);
  for (const ext of TRY_EXT) {
    const p = path.join(root, base + ext);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return (base + ext).split(path.sep).join('/');
  }
  return null;
}

// Static imports with bindings, side-effect-only imports (the full suite's
// link list), and dynamic imports. Missing the side-effect form makes the full
// bundle cache blind to edits in every linked test file.
const IMPORT_RE =
  /(?:^|\n)\s*(?:(?:import|export)[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"])|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const r = resolveLocal(rel, m[1] || m[2] || m[3]);
    if (r) out.push(r);
  }
  return out;
}

const closureCache = new Map();

/** Every repo file this suite pulls in, transitively — tests and src alike. */
function closureOf(rel) {
  let seen = closureCache.get(rel);
  if (seen) return seen;
  seen = new Set();
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of importsOf(cur)) stack.push(dep);
  }
  closureCache.set(rel, seen);
  return seen;
}

function globToRe(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

/** The suites a set of changed paths can plausibly break. */
function affectedBy(suitesIn, changed) {
  const hit = new Map();
  for (const rel of changed) {
    for (const s of suitesIn) {
      if (hit.has(s.suite)) continue;
      const ownsIt =
        s.rel === rel ||
        s.covers.some((g) => globToRe(g).test(rel)) ||
        (rel.startsWith('tests/') && closureOf(s.rel).has(rel));
      if (ownsIt) hit.set(s.suite, { suite: s, via: rel });
    }
  }
  return hit;
}

// ----------------------------------------------------------------- git plumbing --
function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

const gitLines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * The files worth testing. With a ref, that is the diff to it; without one, the
 * working tree — and if the working tree is clean, the branch's own commits
 * against its base, so `--affected` still means something after you commit.
 */
function changedFiles(ref) {
  if (ref) return { ref, files: gitLines(git('diff', '--name-only', `${ref}...HEAD`)) };
  const work = [
    ...gitLines(git('diff', '--name-only', 'HEAD')),
    ...gitLines(git('ls-files', '--others', '--exclude-standard')),
  ];
  if (work.length) return { ref: 'the working tree', files: [...new Set(work)] };
  for (const base of ['main', 'origin/main', 'master']) {
    if (!git('rev-parse', '--verify', '--quiet', base).trim()) continue;
    const files = gitLines(git('diff', '--name-only', `${base}...HEAD`));
    if (files.length) return { ref: base, files };
  }
  return { ref: 'the working tree', files: [] };
}

// ------------------------------------------------------------------ bundling --
function fileSig(rel) {
  try {
    const st = fs.statSync(path.join(root, rel));
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'missing';
  }
}

async function bundle(rel) {
  const slug = rel.replace(/^tests\//, '').replace(/\.test\.ts$/, '').replace(/[^a-z0-9]+/gi, '__').toLowerCase();
  const out = path.join(outDir, `${slug}.mjs`);
  const stampPath = `${out}.sig`;
  const sig = [
    `esbuild`,
    process.version,
    ...(rel === FULL_REL ? [FULL_REL] : [rel]),
    ...[...closureOf(rel)].sort().map((f) => `${f}@${fileSig(f)}`),
  ].join('|');
  if (fs.existsSync(out) && !flags.force && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === sig) {
    return out;
  }
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    sourcemap: false,
    // The HUD suites reach for jsdom; keep it external and resolve it from
    // node_modules. The simulation suites import nothing at all.
    external: ['jsdom', 'canvas'],
    logLevel: 'warning',
  });
  fs.writeFileSync(stampPath, sig);
  return out;
}

// ------------------------------------------------------------------- running --
function runChild(outFile, { env = {}, capture = false, label }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [outFile], {
      cwd: root,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...env },
    });
    let buf = '';
    if (capture) {
      const grab = (d) => {
        buf += d.toString();
        if (flags.verbose) process.stdout.write(d);
      };
      child.stdout.on('data', grab);
      child.stderr.on('data', grab);
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      const summary = (buf.match(/\d+ checks passed[^\n]*/) || [''])[0];
      resolve({ code: code ?? 1, output: buf, summary, label, ms: Date.now() - startedAt });
    });
  });
}

const indent = (s) => String(s).split('\n').map((l) => `      ${l}`).join('\n');

/**
 * Run suites in child processes, at most `jobs` at a time. Each one is a
 * standalone suite (RF_LINKED unset) so it prints its own detail and fails its
 * own process; the runner owns the roll-up.
 */
const TIMINGS_FILE = path.join(outDir, 'suite-timings.json');

function readTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Longest-processing-time-first keeps every worker useful: in particular the
 * 20-sol soak starts immediately instead of waiting behind the tiny HUD suites.
 * Real timings from prior runs win; group/check estimates make a clean checkout
 * schedule sensibly on its first run too.
 */
function estimatedMs(suite, timings) {
  if (Number.isFinite(timings[suite.suite])) return timings[suite.suite];
  const groupBase = { load: 30000, integration: 4000, determinism: 1500, unit: 700, hud: 100 };
  return (groupBase[suite.group] ?? 500) + suite.checks * 25;
}

async function runSuites(selected, { jobs = 1, capture = false, env = {} } = {}) {
  const timings = readTimings();
  const queue = [...selected].sort(
    (a, b) => estimatedMs(b, timings) - estimatedMs(a, timings) || a.suite.localeCompare(b.suite),
  );
  const results = [];
  const worker = async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      const out = await bundle(s.rel);
      const res = await runChild(out, { env: { ...env, RF_LINKED: '0' }, capture, label: s.suite });
      results.push({ suite: s, res });
      if (capture) {
        const ok = res.code === 0;
        console.log(
          `  ${tick(ok)} ${C.bold(s.suite.padEnd(22))}${res.summary || (ok ? C.green('passed') : C.red(`exit ${res.code}`))}`,
        );
        if (!ok) console.log(indent(res.output.trim()));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, selected.length)) }, worker));

  // Smooth noisy runs rather than letting one contended process permanently
  // distort the queue. This cache lives beside generated bundles, outside Git.
  for (const { suite, res } of results) {
    const old = Number(timings[suite.suite]);
    timings[suite.suite] = Math.round(Number.isFinite(old) ? old * 0.35 + res.ms * 0.65 : res.ms);
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(TIMINGS_FILE, JSON.stringify(timings, null, 2));
  } catch {
    // Timing history is an optimisation only; a read-only cache must not fail tests.
  }
  return results;
}

async function runFull(env = {}) {
  const out = await bundle(FULL_REL);
  // The linked entry prints each suite's line and the roll-up itself.
  const res = await runChild(out, { env: { ...env, RF_LINKED: '1' }, capture: false, label: 'full' });
  return res.code === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- the layout --
/**
 * tests/full.test.ts lists suites by hand (so the run order is deliberate),
 * which means it can drift from the files on disk. It must not: an unlinked
 * suite is a suite that never runs.
 */
function checkLayout() {
  const linked = linkedSpecs();
  const onDisk = suites.map((s) => s.rel);
  const missing = onDisk.filter((r) => !linked.includes(r));
  const stale = linked.filter((r) => !onDisk.includes(r));
  let problems = 0;
  for (const m of missing) {
    console.log(`${tick(false)} ${m} is not linked into ${FULL_REL} \u2014 the full test would skip it`);
    problems++;
  }
  for (const s of stale) {
    console.log(`${tick(false)} ${FULL_REL} links ${s}, which is not on disk`);
    problems++;
  }
  const seen = new Set();
  for (const s of suites) {
    if (seen.has(s.suite)) {
      console.log(`${tick(false)} suite name "${s.suite}" is declared twice`);
      problems++;
    }
    seen.add(s.suite);
    if (!s.covers.length) {
      console.log(`${C.yellow('\u26a0')} ${s.rel} declares no @covers, so --affected can never select it`);
      problems++;
    }
    if (!s.desc) {
      console.log(`${C.yellow('\u26a0')} ${s.rel} declares no @desc`);
      problems++;
    }
  }
  const checks = suites.reduce((n, s) => n + s.checks, 0);
  if (problems) {
    console.log(C.red(`\n${tick(false)} test layout check failed (${problems} problem(s))`));
  } else {
    console.log(
      C.green(`\n${tick(true)} ${suites.length} suites, ${checks} checks \u2014 all linked, all declaring what they cover`),
    );
  }
  return problems ? 1 : 0;
}

function printList() {
  const width = Math.max(...suites.map((s) => s.suite.length));
  let last = '';
  for (const s of suites) {
    const area = s.suite.split('/')[0];
    if (area !== last) {
      console.log(`\n${C.bold(area)}`);
      last = area;
    }
    console.log(
      `  ${C.bold(s.suite.padEnd(width))}  ${C.dim(s.group.padEnd(11))}${String(s.checks).padStart(2)} checks  ${C.dim(s.covers.join(' ') || '\u2014')}`,
    );
  }
  const total = suites.reduce((n, s) => n + s.checks, 0);
  console.log(`\n${suites.length} suites, ${total} checks. \`npm test\` runs them in isolated parallel processes.`);
  const quick = suites.find((s) => s.group === 'unit') ?? suites[0];
  if (quick) console.log(C.dim(`Run one area instead: npm test -- ${quick.suite}`));
  return 0;
}

// ---------------------------------------------------------------------- CLI --
const argv = process.argv.slice(2);
const flags = {};
const words = [];
// Flags that carry a value, so `--jobs 2` and `--jobs=2` both work.
const VALUED = new Set(['jobs', 'group', 'case', 'affected']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) {
    words.push(a);
    continue;
  }
  const eq = a.indexOf('=');
  const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
  if (eq >= 0) flags[name] = a.slice(eq + 1);
  else if (VALUED.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
  else flags[name] = true;
}

/** Apply the command-line words to a set of suites. */
function narrow(list) {
  if (!words.length) return list;
  const sel = list.filter((s) => words.some((w) => s.suite.includes(w) || s.rel.includes(w)));
  return sel.length ? sel : list;
}

function select() {
  let sel = suites;
  if (flags.group) {
    const want = String(flags.group).split(',');
    sel = sel.filter((s) => want.includes(s.group));
    if (!sel.length) return { error: `no suite in group ${want.join(', ')}` };
  }
  if (words.length) {
    const byDesc = sel.filter(
      (s) => words.some((w) => s.suite.includes(w) || s.rel.includes(w) || s.desc.toLowerCase().includes(w.toLowerCase())),
    );
    if (!byDesc.length) {
      return { error: `no suite matches "${words.join(' ')}"`, hint: `try: ${C.cyan('npm run test:list')}` };
    }
    sel = byDesc;
  }
  return { selected: sel };
}

async function once({ selected, forceSuites = false }) {
  const t0 = Date.now();
  const jobs = Number(flags.jobs || Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length)));
  const env = { RF_CASE: flags.case ? String(flags.case) : '' };
  if (env.RF_CASE === '') delete env.RF_CASE;

  // Every unfiltered full run validates that the parallel discovery list and
  // linked serial entry still contain exactly the same suites.
  const isParallelBoard = !forceSuites && !words.length && !flags.group && flags.all && !flags.case;
  if (isParallelBoard) {
    const bad = checkLayoutQuiet();
    if (bad) return bad;
  }

  // No flags at all: the linked full test, in one process, streaming.
  const isWholeBoard = !forceSuites && !words.length && !flags.group && !flags.all && !flags.case && !flags.verbose;
  if (isWholeBoard) {
    const bad = checkLayoutQuiet();
    if (bad) return bad;
    console.log(C.bold(`full test \u2014 ${suites.length} suites linked by ${FULL_REL}`));
    const code = await runFull(env);
    console.log(`${tick(code === 0)} full run ${C.dim(`(${secs(t0)})`)}`);
    return code;
  }

  if (!selected.length) {
    console.log(`${tick(true)} nothing a suite covers has changed \u2014 no tests to run ${C.dim(`(${secs(t0)})`)}`);
    return 0;
  }
  console.log(C.bold(`${selected.length} suite(s)`) + ' \u00b7 ' + selected.map((s) => s.suite).join(' '));
  const capture = selected.length > 1 && !flags.verbose;
  const results = await runSuites(selected, { jobs, capture, env });
  const failed = results.filter((r) => r.res.code !== 0);
  // The per-case count is only known when the runner read the child's output.
  const counts = results.map((r) => Number((r.res.summary.match(/^(\d+)/) || [])[1]));
  const checks = counts.every((n) => !Number.isNaN(n))
    ? `, ${counts.reduce((a, b) => a + b, 0)} checks`
    : '';
  const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  console.log(
    failed.length
      ? `${tick(false)} ${C.bold(`${failed.length} of ${many(selected.length, 'suite')} failed`)} ${C.dim(`(${secs(t0)})`)}`
      : `${tick(true)} ${C.bold(`${many(selected.length, 'suite')}${checks} passed`)} ${C.dim(`(${secs(t0)})`)}`,
  );
  return failed.length ? 1 : 0;
}

/** What tests/full.test.ts imports, resolved the way the runner names suites. */
function linkedSpecs() {
  const text = fs.readFileSync(path.join(root, FULL_REL), 'utf8');
  return [...text.matchAll(/import '\.\/([^']+)';/g)]
    .map((m) => (m[1].endsWith('.test') ? `tests/${m[1]}.ts` : `tests/${m[1]}.test.ts`))
    .sort();
}

function checkLayoutQuiet() {
  const linked = linkedSpecs();
  const missing = suites.filter((s) => !linked.includes(s.rel));
  if (!missing.length) return 0;
  for (const m of missing) console.log(`${tick(false)} ${m.rel} is not linked into ${FULL_REL}`);
  console.log(C.dim(`  run ${C.cyan('node scripts/run-tests.mjs --check')} for the full layout report`));
  return 1;
}

const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function watch({ selected }) {
  let running = Promise.resolve();
  /** Queue runs behind each other: a save during a run waits, never overlaps. */
  const runOnce = (why) => {
    running = running.then(async () => {
      let sel = selected;
      if (flags.affected) {
        const { ref, files } = changedFiles(typeof flags.affected === 'string' ? flags.affected : undefined);
        sel = narrow([...affectedBy(suites, files).values()].map((h) => h.suite));
        why += ` \u2014 ${files.length} changed file(s) \u00b7 ${ref}`;
      }
      console.log(`\n${C.bold(why)}`);
      await once({ selected: sel, forceSuites: true });
    });
    return running;
  };
  await runOnce('\u25b6 watching');
  const dirs = ['src', 'tests'].filter((d) => fs.existsSync(path.join(root, d)));
  let timer = null;
  let dirty = new Set();
  console.log(`\n${C.dim(`watching ${dirs.join(', ')} \u2014 Ctrl-C to stop`)}`);
  for (const dir of dirs) {
    fs.watch(path.join(root, dir), { recursive: true }, (_ev, file) => {
      const rel = file ? file.split(path.sep).join('/') : '';
      if (!/\.(ts|tsx|js|mjs|css|html)$/.test(rel)) return;
      dirty.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const note = [...dirty].slice(0, 3).join(', ');
        dirty = new Set();
        runOnce(`\u25b6 ${note}`).catch((err) => console.error(C.red(String(err?.stack || err))));
      }, 200);
    });
  }
  return new Promise(() => {}); // stay alive
}

async function main() {
  if (flags.help || flags.h) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(src.match(/^\/\*\*([\s\S]*?)^\*\//m)[1].replace(/^ ?\* ?/gm, ''));
    return 0;
  }
  if (flags.list) return printList();
  if (flags.check) return checkLayout();

  const { selected, error, hint } = select();
  if (error) {
    console.error(`${tick(false)} ${error}${hint ? '\n' + hint : ''}`);
    return 1;
  }

  if (flags.affected) {
    const { ref, files } = changedFiles(typeof flags.affected === 'string' ? flags.affected : undefined);
    const hit = affectedBy(suites, files);
    const sel = narrow([...hit.values()].map((h) => h.suite));
    console.log(C.dim(`${files.length} changed file(s) \u00b7 ${ref}`));
    for (const s of sel) {
      console.log(C.dim(`  ${s.suite.padEnd(22)}\u2190 ${hit.get(s.suite).via}`));
    }
    if (flags.watch) return watch({ selected: sel });
    return once({ selected: sel, forceSuites: true });
  }

  if (flags.watch) return watch({ selected });
  return once({ selected });
}

process.exitCode = await main().catch((err) => {
  console.error(C.red(String(err?.stack || err)));
  process.exitCode = 1;
});
