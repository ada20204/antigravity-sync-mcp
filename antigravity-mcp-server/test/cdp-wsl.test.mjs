import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWorkspaceId,
} from '../dist/cdp.js';

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

// WSL mirror workspace_id matching tests
test('WSL path produces different workspace_id than Windows path', () => {
  const windowsPath = 'c:/Users/elliot/workspace';
  const wslPath = '/mnt/c/Users/elliot/workspace';

  const windowsId = computeWorkspaceId(windowsPath);
  const wslId = computeWorkspaceId(wslPath);

  // They should be different because the normalized paths are different
  assert.notEqual(windowsId, wslId);
});

test('Same normalized path produces same workspace_id', () => {
  const path1 = '/home/elliot/workspace';
  const path2 = '/home/elliot/workspace/';

  // Trailing slash should be normalized away
  assert.equal(computeWorkspaceId(path1), computeWorkspaceId(path2));
});
