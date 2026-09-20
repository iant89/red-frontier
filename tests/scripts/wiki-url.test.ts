/**
 * @suite scripts/wiki-url
 * @group unit
 * @covers scripts/wiki-url.mjs scripts/publish-wiki.mjs
 * @desc Wiki publishing resolves <owner>/<repo>.wiki.git from any spelling of a
 * GitHub remote — HTTPS, SSH, scp-like, trailing slash, embedded token — reports
 * a remote it cannot use instead of guessing, and keeps an explicit --url intact.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseGithubRepo,
  wikiSiteUrl,
  wikiUrlFromInput,
  wikiUrlFromRemote,
} from '../../scripts/wiki-url.mjs';
import { finish, group, test } from '../harness';

const WIKI = 'https://github.com/iant89/red-frontier.wiki.git';

const root = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

group('the reported failure — a trailing slash on origin');

test('a remote copied from a browser address bar derives the wiki url', () => {
  assert.equal(wikiUrlFromRemote('https://github.com/iant89/red-frontier/'), WIKI);
});

test('a .git remote with a trailing slash derives the wiki url', () => {
  assert.equal(wikiUrlFromRemote('https://github.com/iant89/red-frontier.git/'), WIKI);
});

test('surrounding whitespace from command output is ignored', () => {
  assert.equal(wikiUrlFromRemote('  https://github.com/iant89/red-frontier.git\n'), WIKI);
});

group('every spelling of a GitHub remote means the same wiki');

const REMOTES: [string, string][] = [
  ['https://github.com/iant89/red-frontier.git', WIKI],
  ['https://github.com/iant89/red-frontier', WIKI],
  ['HTTPS://GitHub.com/iant89/red-frontier.git', WIKI],
  ['git@github.com:iant89/red-frontier.git', WIKI],
  ['git@github.com:iant89/red-frontier', WIKI],
  ['ssh://git@github.com/iant89/red-frontier.git', WIKI],
  ['git://github.com/iant89/red-frontier.git', WIKI],
  ['https://github.com/iant89/red-frontier.wiki.git', WIKI],
  ['https://github.com/iant89/red-frontier.wiki', WIKI],
  ['https://github.com/iant89/red-frontier/tree/main', WIKI],
  ['https://github.com/iant89/red-frontier/wiki', WIKI],
  ['https://github.com/iant89/red-frontier/issues/12', WIKI],
];

for (const [remote, expected] of REMOTES) {
  test(`${remote} → ${expected}`, () => {
    assert.equal(wikiUrlFromRemote(remote), expected);
  });
}

test('a repository name containing a dot is not truncated', () => {
  assert.equal(
    wikiUrlFromRemote('https://github.com/iant89/red.frontier.git'),
    'https://github.com/iant89/red.frontier.wiki.git',
  );
});

test('a remote already pointed at a wiki does not gain a second .wiki', () => {
  const parsed = parseGithubRepo('git@github.com:iant89/red-frontier.wiki.git');
  assert.deepEqual(parsed && { owner: parsed.owner, repo: parsed.repo }, {
    owner: 'iant89',
    repo: 'red-frontier',
  });
});

group('credentials in the remote are kept, so the push can authenticate');

test('a token embedded in an HTTPS remote survives', () => {
  assert.equal(
    wikiUrlFromRemote('https://x-access-token:ghp_s3cret@github.com/iant89/red-frontier.git'),
    'https://x-access-token:ghp_s3cret@github.com/iant89/red-frontier.wiki.git',
  );
});

test('the ssh user is dropped rather than carried into an https url', () => {
  assert.equal(wikiUrlFromRemote('git@github.com:iant89/red-frontier.git'), WIKI);
  assert.equal(wikiUrlFromRemote('ssh://git@github.com/iant89/red-frontier.git'), WIKI);
  assert.equal(parseGithubRepo('ssh://git@github.com/iant89/red-frontier.git')?.userinfo, '');
  assert.equal(
    parseGithubRepo('https://x-access-token:t@github.com/iant89/red-frontier.git')?.userinfo,
    'x-access-token:t@',
  );
});

group('a remote that is not a GitHub repository is reported, not guessed');

const REJECTED: unknown[] = [
  '',
  '   ',
  null,
  undefined,
  'origin',
  'https://gitlab.com/iant89/red-frontier.git',
  'git@gitlab.com:iant89/red-frontier.git',
  'https://github.com/iant89',
  'https://github.com/',
  'https://github.enterprise.com/iant89/red-frontier.git',
];

for (const remote of REJECTED) {
  test(`${JSON.stringify(remote)} is not a GitHub repository remote`, () => {
    assert.equal(wikiUrlFromRemote(remote), null);
    assert.equal(parseGithubRepo(remote), null);
  });
}

group('an explicit --url is canonicalised, and anything else is left alone');

test('a repository url passed to --url becomes the wiki url', () => {
  assert.equal(wikiUrlFromInput('https://github.com/iant89/red-frontier'), WIKI);
  assert.equal(wikiUrlFromInput('https://github.com/iant89/red-frontier.wiki.git/'), WIKI);
});

test('a non-GitHub url passes through apart from a trailing slash', () => {
  assert.equal(
    wikiUrlFromInput('https://git.corp.example/iant89/red-frontier.wiki.git/'),
    'https://git.corp.example/iant89/red-frontier.wiki.git',
  );
  assert.equal(
    wikiUrlFromInput('https://git.corp.example/iant89/red-frontier.wiki'),
    'https://git.corp.example/iant89/red-frontier.wiki.git',
  );
});

test('an empty --url is refused', () => {
  assert.equal(wikiUrlFromInput(''), null);
  assert.equal(wikiUrlFromInput('   '), null);
});

group('the success line names the human page');

test('a wiki git url maps to its /wiki page', () => {
  assert.equal(wikiSiteUrl(WIKI), 'https://github.com/iant89/red-frontier/wiki');
  assert.equal(
    wikiSiteUrl('https://token@github.com/iant89/red-frontier.wiki.git'),
    'https://github.com/iant89/red-frontier/wiki',
  );
});

test('a repository name containing a dot keeps the whole name', () => {
  assert.equal(
    wikiSiteUrl('https://github.com/iant89/red.frontier.wiki.git'),
    'https://github.com/iant89/red.frontier/wiki',
  );
});

test('a url it cannot parse is echoed back unchanged', () => {
  assert.equal(wikiSiteUrl('/srv/wikis/red-frontier'), '/srv/wikis/red-frontier');
});

group('publish-wiki.mjs delegates to the shared derivation');

const publishSrc = root('scripts/publish-wiki.mjs');

test('the inline remote regex is gone', () => {
  assert.ok(!publishSrc.includes('github\\.com[:/]'), 'the one-spelling regex is still inlined');
  assert.ok(publishSrc.includes("from './wiki-url.mjs'"), 'wiki-url.mjs is not imported');
  assert.ok(publishSrc.includes('wikiUrlFromRemote(remote)'));
  assert.ok(publishSrc.includes('wikiUrlFromInput(flags.url)'));
  assert.ok(publishSrc.includes('wikiSiteUrl(url)'));
});

test('a failed `git remote get-url` is caught instead of crashing', () => {
  // git() returns the truthy FAIL symbol on a failed call, so `!remote` never fires;
  // without this guard the script died with "remote.match is not a function".
  assert.ok(
    /remote === FAIL/.test(publishSrc),
    'the missing-origin branch does not compare against the FAIL sentinel',
  );
});

await finish('scripts/wiki-url');
