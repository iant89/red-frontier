/**
 * The shared test harness.
 *
 * Every `tests/<area>/<name>.test.ts` file is a **suite**: it registers cases
 * with `test()` and then `await finish()`. A suite is runnable on its own —
 * that is the whole point of the split, so a one-line change to `power.ts`
 * costs the power suite and nothing else.
 *
 * `tests/full.test.ts` imports every suite and links them into a single run.
 * The runner marks that run with `RF_LINKED=1`: each suite then keeps its
 * report to one line and leaves the exit code to the linked entry, which prints
 * the roll-up. Set `RF_VERBOSE=1` to get the per-case detail anyway, or
 * `RF_CASE=<substring>` to run a single case out of a suite.
 */

/** Colour only when it is safe to emit it, exactly like the runner does. */
const tty = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: number) => (text: string) =>
  tty ? `\u001b[${code}m${text}\u001b[0m` : String(text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);

export type CaseFn = () => void | Promise<void>;

export interface Case {
  name: string;
  group: string;
  fn: CaseFn;
}

export interface Failure {
  /** `group › case`, so a bare name still says where it came from. */
  name: string;
  message: string;
}

export interface SuiteRecord {
  name: string;
  pass: number;
  skip: number;
  failures: Failure[];
  ms: number;
}

/** True inside `tests/full.test.ts`, where suites must not exit the process. */
export const linked = process.env.RF_LINKED === '1';
const verbose = linked ? process.env.RF_VERBOSE === '1' : true;
const only = process.env.RF_CASE ? process.env.RF_CASE.toLowerCase() : '';

const records: SuiteRecord[] = [];
let suiteName = 'suite';
let groupName = '';
let cases: Case[] = [];

/** Name this suite for the report. Optional: `finish(name)` also sets it. */
export function suite(name: string): void {
  suiteName = name;
}

/** Start a section. Suites run linearly, so this is just a label. */
export function group(name: string): void {
  groupName = name;
}

/** Register a case. A thrown assertion fails it; nothing else is needed. */
export function test(name: string, fn: CaseFn): void {
  cases.push({ name, group: groupName, fn });
}

/** Register a case that is knowingly not run (no DOM backend, GPU, network…). */
export function skip(name: string, why: string): void {
  test(name, () => {
    throw new Error(`skipped: ${why}`);
  });
}

function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0] || String(err);
}

/** Run every registered case, report, and (when standalone) exit non-zero. */
export async function finish(name = suiteName): Promise<void> {
  const pending = cases;
  cases = [];
  const rec: SuiteRecord = { name, pass: 0, skip: 0, failures: [], ms: 0 };
  const t0 = performance.now();

  if (verbose) console.log(`\n${bold(`── ${name} ──`)}`);
  let shown = '';
  for (const c of pending) {
    const haystack = `${c.group} ${c.name}`.toLowerCase();
    if (only && !haystack.includes(only)) {
      rec.skip++;
      continue;
    }
    if (verbose && c.group !== shown) {
      console.log(`\n${c.group}`);
      shown = c.group;
    }
    try {
      await c.fn();
      rec.pass++;
      if (verbose) console.log(`  \u2714 ${c.name}`);
    } catch (err) {
      rec.failures.push({ name: c.group ? `${c.group} \u203a ${c.name}` : c.name, message: firstLine(err) });
      if (verbose) console.log(`  \u2718 ${c.name}\n      ${firstLine(err)}`);
    }
  }
  rec.ms = performance.now() - t0;
  records.push(rec);

  if (linked && !verbose) {
    const bad = rec.failures.length;
    const tag = bad ? `\u2718` : rec.pass ? `\u2714` : `\u2013`;
    console.log(
      `  ${tag} ${name.padEnd(22)} ${String(rec.pass).padStart(3)} passed` +
        (bad ? `, ${red(`${bad} FAILED`)}` : '') +
        (rec.skip ? `, ${rec.skip} filtered` : '') +
        `  ${dim(`${Math.round(rec.ms)} ms`)}`,
    );
    return;
  }

  const bad = rec.failures.length;
  console.log(
    `\n${rec.pass} checks passed in ${name}${
      bad ? `, ${red(`${bad} FAILED`)}` : ''
    }${rec.skip ? ` (${rec.skip} filtered out)` : ''} \u2014 ${Math.round(rec.ms)} ms`,
  );
  if (bad) {
    for (const f of rec.failures) console.log(`  \u2718 ${f.name}: ${f.message}`);
    process.exit(1);
  }
}

/** Every suite report collected so far (in a linked run, that is all of them). */
export function collected(): SuiteRecord[] {
  return records;
}

/**
 * Print the roll-up for a linked run and exit non-zero on any failure.
 * `expected` is the number of suites that *should* have reported, so a suite
 * that never ran (a broken import, a file not linked in) cannot pass silently.
 */
export function report(expected: number): void {
  const pass = records.reduce((n, r) => n + r.pass, 0);
  const fails = records.flatMap((r) => r.failures);
  const suites = records.length;
  const ms = Math.round(records.reduce((n, r) => n + r.ms, 0));
  console.log(
    bold(
      `${suites}/${expected} suites, ${pass} checks passed${
        fails.length ? `, ${fails.length} FAILED` : ''
      } in ${(ms / 1000).toFixed(1)}s`,
    )
  );
  if (fails.length) {
    console.log('\nFailures:');
    for (const f of fails) console.log(`  \u2718 ${f.name}\n      ${f.message}`);
  }
  if (suites !== expected) {
    console.log(
      suites < expected
        ? `  \u2718 only ${suites} of ${expected} linked suites reported \u2014 one died on import, or tests/full.test.ts is out of date`
        : `  \u2718 ${suites} suites reported but tests/full.test.ts expects ${expected} \u2014 update report(n) (or run npm run test:check)`,
    );
  }
  if (fails.length || suites !== expected) process.exit(1);
}
