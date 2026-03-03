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

test('discoverCDPDetailed writes a pending no-cdp prompt request when entry is not ready', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-not-ready-prompt-${Date.now()}.json`);
  const workspacePath = '/tmp/project-not-ready-prompt';
  const workspaceId = computeWorkspaceId(workspacePath);
  writeRegistry(registryFile, {
    [workspacePath]: {
      schema_version: 2,
      workspace_id: workspaceId,
      role: 'host',
      state: 'app_up_no_cdp',
      verified_at: Date.now(),
      ttl_ms: 30_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  const result = await discoverCDPDetailed(workspacePath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'entry_not_ready');

  const registryAfter = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
  const control = registryAfter.__control__;
  assert.ok(control && typeof control === 'object');
  const requests = control.cdp_prompt_requests;
  assert.ok(requests && typeof requests === 'object');
  const key = `no_cdp_${workspaceId}`;
  assert.equal(requests[key].status, 'pending');
  assert.equal(requests[key].reason_code, 'entry_not_ready');
  assert.equal(requests[key].workspace_id, workspaceId);
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

test('discoverCDPDetailed matches entry by original_workspace_id for remote mirror', async () => {
  const registryFile = path.join(os.tmpdir(), `ag-mcp-mirror-${Date.now()}.json`);
  const remotePath = '/home/remote/dev/project';
  const hostPath = 'c:/Users/elliot/win-project'; // different path → different workspace_id
  const remoteId = computeWorkspaceId(remotePath);
  const hostId = computeWorkspaceId(hostPath);
  // Entry has workspace_id=remote hash, original_workspace_id=host hash
  writeRegistry(registryFile, {
    [remotePath]: {
      schema_version: 2,
      workspace_id: remoteId,
      original_workspace_id: hostId,
      role: 'host',
      state: 'ready',
      verified_at: Date.now() - 120_000, // stale so we don't reach network
      ttl_ms: 10_000,
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  // Look up using the host path (original_workspace_id should match)
  const result = await discoverCDPDetailed(hostPath);
  assert.equal(result.ok, false);
  // entry_stale means the entry was FOUND (not workspace_not_found)
  assert.equal(result.error.code, 'entry_stale',
    `expected entry_stale but got ${result.error.code}: ${result.error.message}`);
});
