import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeWorkspaceId, discoverCDPDetailed } from '../build/dist/cdp.js';

function writeRegistry(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

test.after(() => {
  delete process.env.ANTIGRAVITY_REGISTRY_FILE;
});

test('discoverCDPDetailed returns registry_missing when registry file does not exist', async () => {
  const missing = path.join(os.tmpdir(), `ag-mcp-missing-${Date.now()}.json`);
  process.env.ANTIGRAVITY_REGISTRY_FILE = missing;

  const result = await discoverCDPDetailed('/tmp/does-not-matter');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'registry_missing');
});

test('discoverCDPDetailed returns schema_mismatch for unsupported schema_version', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-schema-${Date.now()}.json`);
  const workspacePath = '/tmp/project-schema';
  const workspaceId = computeWorkspaceId(workspacePath);
  writeRegistry(registryFile, {
    [workspacePath]: {
      schema_version: 1,
      workspace_id: workspaceId,
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      ttl_ms: 30_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  const result = await discoverCDPDetailed(workspacePath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'schema_mismatch');
});

test('discoverCDPDetailed returns entry_not_ready with state when registry entry is not ready', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-not-ready-${Date.now()}.json`);
  const workspacePath = '/tmp/project-not-ready';
  const workspaceId = computeWorkspaceId(workspacePath);
  writeRegistry(registryFile, {
    [workspacePath]: {
      schema_version: 2,
      workspace_id: workspaceId,
      role: 'host',
      state: 'app_down',
      verified_at: Date.now(),
      ttl_ms: 30_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  const result = await discoverCDPDetailed(workspacePath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'entry_not_ready');
  assert.equal(result.error.state, 'app_down');
});

test('discoverCDPDetailed returns entry_stale when verified_at is too old', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-stale-${Date.now()}.json`);
  const workspacePath = '/tmp/project-stale';
  const workspaceId = computeWorkspaceId(workspacePath);
  writeRegistry(registryFile, {
    [workspacePath]: {
      schema_version: 2,
      workspace_id: workspaceId,
      role: 'host',
      state: 'ready',
      verified_at: Date.now() - 120_000,
      ttl_ms: 10_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  const result = await discoverCDPDetailed(workspacePath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'entry_stale');
});

test('discoverCDPDetailed matches entry by original_workspace_id for WSL mirror', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-mirror-${Date.now()}.json`);
  const wslPath = '/home/elliot/wsl-project';
  const windowsPath = '/mnt/c/Users/elliot/win-project'; // different path → different workspace_id
  const wslId = computeWorkspaceId(wslPath);
  const windowsId = computeWorkspaceId(windowsPath);
  // Entry has workspace_id=WSL hash, original_workspace_id=Windows hash
  writeRegistry(registryFile, {
    [wslPath]: {
      schema_version: 2,
      workspace_id: wslId,
      original_workspace_id: windowsId,
      role: 'host',
      state: 'ready',
      verified_at: Date.now() - 120_000, // stale so we don't reach network
      ttl_ms: 10_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  // Look up using the Windows path (original_workspace_id should match)
  const result = await discoverCDPDetailed(windowsPath);
  assert.equal(result.ok, false);
  // entry_stale means the entry was FOUND (not workspace_not_found)
  assert.equal(result.error.code, 'entry_stale',
    `expected entry_stale but got ${result.error.code}: ${result.error.message}`);
});
