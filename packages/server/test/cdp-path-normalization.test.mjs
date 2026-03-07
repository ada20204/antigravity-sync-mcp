import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWorkspaceId,
} from '../build/dist/cdp.js';

test('computeWorkspaceId generates consistent hash for same path', () => {
  const path1 = '/home/elliot/workspace';
  const path2 = '/home/elliot/workspace';

  assert.equal(computeWorkspaceId(path1), computeWorkspaceId(path2));
});

test('computeWorkspaceId generates different hashes for different paths', () => {
  const path1 = '/home/elliot/workspace1';
  const path2 = '/home/elliot/workspace2';

  assert.notEqual(computeWorkspaceId(path1), computeWorkspaceId(path2));
});

test('computeWorkspaceId produces 16-character hex string', () => {
  const id = computeWorkspaceId('/some/path');

  assert.equal(id.length, 16);
  assert.match(id, /^[0-9a-f]+$/);
});

test('Different normalized path roots produce different workspace_id', () => {
  const windowsPath = 'c:/Users/elliot/workspace';
  const remotePath = '/home/elliot/workspace';

  const windowsId = computeWorkspaceId(windowsPath);
  const remoteId = computeWorkspaceId(remotePath);

  assert.notEqual(windowsId, remoteId);
});

test('Same normalized path produces same workspace_id', () => {
  const path1 = '/home/elliot/workspace';
  const path2 = '/home/elliot/workspace/';

  // Trailing slash should be normalized away
  assert.equal(computeWorkspaceId(path1), computeWorkspaceId(path2));
});
