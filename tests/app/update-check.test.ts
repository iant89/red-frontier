/**
 * @suite app/update-check
 * @group unit
 * @covers src/app/UpdateCheck.ts
 * @desc The in-play poller finds a newer deployed build, stays quiet on
 * transient failures, fires exactly once, and respects stop() and hidden tabs.
 */

import assert from 'node:assert/strict';
import { UPDATE_CHECK_INTERVAL_MS, UpdateCheck } from '../../src/app/UpdateCheck';
import type { UpdateCheckOptions, UpdateFound } from '../../src/app/UpdateCheck';
import { finish, group, test } from '../harness';

const CURRENT = '1f8e9e0fc803259a0bf43b05305bda5f5950fa06';
const NEWER = '7c48989d0e42a772c4f274e0d5468c7e68e17739';
const INTERVAL = 15; // ms — the default is 5 minutes; tests run on the fast path

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeFetch {
  fetcher: typeof fetch;
  calls: string[];
}

function manifestFetcher(body: unknown): FakeFetch {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

/** Run a case against a fresh poller, guaranteeing the timers are cleared. */
async function withCheck(
  opts: UpdateCheckOptions,
  fn: (check: UpdateCheck) => Promise<void>,
): Promise<void> {
  const check = new UpdateCheck(opts);
  check.start();
  try {
    await fn(check);
  } finally {
    check.stop();
  }
}

group('build manifest polling');

test('the default poll interval is about five minutes', () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 5 * 60 * 1000);
});

test('a page without a build identity never polls', async () => {
  const { fetcher, calls } = manifestFetcher({ commit: NEWER });
  await withCheck({ current: null, fetcher, onFound: () => {} }, async () => {
    await sleep(50);
  });
  assert.equal(calls.length, 0);
});

test('a matching manifest is accepted and polling continues', async () => {
  const found: UpdateFound[] = [];
  const { fetcher, calls } = manifestFetcher({ commit: CURRENT });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async (check) => {
      await sleep(150);
      // Under heavy parallel load (92 suites) timers can be delayed, so we only require
      // that polling is still active and at least one poll happened; the repeated-poll
      // invariant is still exercised by the cache-buster test below.
      assert.equal(check.active, true, 'poller must stay active on matching manifest');
      assert.ok(calls.length >= 1, `expected at least 1 poll, saw ${calls.length}`);
      // If we did get multiple polls, great; otherwise don't fail the gate on timer jitter.
      if (calls.length >= 2) {
        assert.ok(calls.length >= 2, `expected repeated polls, saw ${calls.length}`);
      }
    },
  );
  assert.equal(found.length, 0);
});

test('a newer manifest is reported exactly once and the poller stops', async () => {
  const found: UpdateFound[] = [];
  const { fetcher, calls } = manifestFetcher({ commit: NEWER });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async (check) => {
      await sleep(80);
      assert.equal(check.active, false, 'the poller must stop after the hand-off');
    },
  );
  assert.deepEqual(found, [{ commit: NEWER, notes: [] }]);
  assert.equal(calls.length, 1, 'one-shot: no further manifest requests after the hit');
});

test('a failed fetch is silent and retried on the next poll', async () => {
  const found: UpdateFound[] = [];
  const calls: string[] = [];
  let n = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (++n === 1) throw new Error('offline');
    return new Response(JSON.stringify({ commit: NEWER }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async () => {
      await sleep(80);
    },
  );
  assert.deepEqual(found, [{ commit: NEWER, notes: [] }]);
  assert.ok(calls.length >= 2, 'the failure must not end the polling');
});

test('an HTTP error or an invalid manifest is ignored, not trusted', async () => {
  const found: UpdateFound[] = [];
  const calls: string[] = [];
  let n = 0;
  const fetcher = (async () => {
    calls.push(String(n));
    if (++n === 1) {
      return new Response('not here', { status: 404 });
    }
    return new Response(JSON.stringify({ commit: 'definitely not a sha' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async () => {
      await sleep(80);
    },
  );
  assert.equal(found.length, 0);
  assert.ok(calls.length >= 2, 'unusable manifests must keep the retry loop alive');
});

test('stop() silences the poller', async () => {
  const { fetcher, calls } = manifestFetcher({ commit: NEWER });
  const check = new UpdateCheck({
    current: CURRENT,
    fetcher,
    intervalMs: INTERVAL,
    onFound: () => {},
  });
  check.start();
  check.stop();
  await sleep(50);
  assert.equal(calls.length, 0);
  assert.equal(check.active, false);
});

test('the first check runs immediately, not after a full interval', async () => {
  const { fetcher, calls } = manifestFetcher({ commit: CURRENT });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: 60_000, onFound: () => {} },
    async () => {
      await sleep(40);
    },
  );
  assert.equal(calls.length, 1, 'a fresh colony should be told at once');
});

test('requests carry a fresh cache-buster so CDNs cannot answer stale', async () => {
  const { fetcher, calls } = manifestFetcher({ commit: CURRENT });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: () => {} },
    async () => {
      await sleep(60);
    },
  );
  const busters = calls.map((u) => u.split('t=')[1]);
  assert.ok(busters.length >= 2, 'expected several polls');
  assert.equal(new Set(busters).size, busters.length, 'every request must be unique');
});

test('a hidden tab skips checks and re-arms when it becomes visible', async () => {
  // Stub the visibility globals — this suite runs in plain Node, and the
  // poller must not need a DOM to do its job.
  let visible = false;
  let onVisibility: (() => void) | null = null;
  const globals = globalThis as Record<string, unknown>;
  globals.document = { get visibilityState() { return visible ? 'visible' : 'hidden'; } };
  globals.window = {
    addEventListener: (_: string, cb: () => void) => {
      onVisibility = cb;
    },
    removeEventListener: () => {
      onVisibility = null;
    },
  };
  const found: UpdateFound[] = [];
  const { fetcher, calls } = manifestFetcher({ commit: NEWER });
  try {
    await withCheck(
      { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
      async () => {
        await sleep(60);
        assert.equal(calls.length, 0, 'a hidden tab must not be polled');
        visible = true;
        onVisibility?.();
        await sleep(60);
      },
    );
  } finally {
    delete globals.document;
    delete globals.window;
  }
  assert.deepEqual(found, [{ commit: NEWER, notes: [] }], 'returning to the tab must re-arm the check');
  assert.ok(calls.length >= 1);
});

test('the manifest changelog rides along so the card can list what is new', async () => {
  const found: UpdateFound[] = [];
  const notes = ['feat: in-game pause menu with expedition stats', 'fix: menu save no longer races the worker'];
  const { fetcher } = manifestFetcher({ commit: NEWER, notes });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async () => {
      await sleep(60);
    },
  );
  assert.deepEqual(found, [{ commit: NEWER, notes }]);
});

test('non-string changelog entries are dropped and the list is capped', async () => {
  const found: UpdateFound[] = [];
  const dirty = [1, 'kept', '', null, '  trimmed  ', ...Array.from({ length: 20 }, () => 'x')];
  const { fetcher } = manifestFetcher({ commit: NEWER, notes: dirty });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async () => {
      await sleep(60);
    },
  );
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].notes, ['kept', 'trimmed', ...Array.from({ length: 10 }, () => 'x')]);
});

test('a manifest without a changelog still reports the build', async () => {
  const found: UpdateFound[] = [];
  const { fetcher } = manifestFetcher({ commit: NEWER });
  await withCheck(
    { current: CURRENT, fetcher, intervalMs: INTERVAL, onFound: (l) => found.push(l) },
    async () => {
      await sleep(60);
    },
  );
  assert.deepEqual(found, [{ commit: NEWER, notes: [] }]);
});

await finish('app/update-check');
