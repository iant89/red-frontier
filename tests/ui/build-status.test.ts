/**
 * @suite ui/build-status
 * @group unit
 * @covers src/ui/BuildStatus.ts
 * @desc Build hashes are validated and compared without trusting abbreviated or malformed IDs.
 */

import assert from 'node:assert/strict';
import { assessBuild, shortSha } from '../../src/ui/BuildStatus';
import { finish, group, test } from '../harness';

const CURRENT = '1f8e9e0fc803259a0bf43b05305bda5f5950fa06';
const OTHER = '7c48989d0e42a772c4f274e0d5468c7e68e17739';

group('build identity');

test('matching full commit hashes identify the latest build', () => {
  assert.deepEqual(assessBuild(CURRENT, CURRENT.toUpperCase()), {
    state: 'latest',
    current: CURRENT,
    latest: CURRENT,
  });
});

test('different valid hashes identify an old build', () => {
  assert.equal(assessBuild(CURRENT, OTHER).state, 'old');
});

test('abbreviated or malformed hashes cannot produce a false result', () => {
  assert.equal(assessBuild(CURRENT.slice(0, 7), CURRENT).state, 'unknown');
  assert.equal(assessBuild(CURRENT, 'not-a-commit').state, 'unknown');
});

test('display hashes are abbreviated to seven characters', () => {
  assert.equal(shortSha(CURRENT), '1f8e9e0');
  assert.equal(shortSha(null), 'unknown');
});

await finish('ui/build-status');
