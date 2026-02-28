import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRegistryPath,
  inferWslGatewayFromRouteTable,
  getCandidateCdpIps,
} from '../dist/cdp.js';

test('normalizeRegistryPath handles backslash-prefixed WSL path', () => {
  assert.equal(
    normalizeRegistryPath('\\home\\elliot\\antigravity-sync'),
    '/home/elliot/antigravity-sync'
  );
});

test('inferWslGatewayFromRouteTable parses /proc/net/route hex gateway', () => {
  const routeTable = [
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t01D01FAC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  ].join('\n');

  assert.equal(inferWslGatewayFromRouteTable(routeTable), '172.31.208.1');
});

test('getCandidateCdpIps adds WSL gateway before localhost when registry ip is localhost', () => {
  const ips = getCandidateCdpIps({
    registryIp: '127.0.0.1',
    isWsl: true,
    nameserverIp: '100.100.100.100',
    gatewayIp: '172.31.208.1',
  });

  assert.equal(ips[0], '172.31.208.1');
  assert.ok(ips.includes('127.0.0.1'));
  assert.ok(ips.includes('100.100.100.100'));
});

import { selectCdpEndpoint } from '../dist/cdp.js';

test('selectCdpEndpoint prefers cdp.active port when state is ready and fresh', () => {
  const now = Date.now();
  const entry = {
    port: 9000,
    ip: '127.0.0.1',
    cdp: {
      state: 'ready',
      verifiedAt: now,
      active: { host: '127.0.0.1', port: 9010, verifiedAt: now, source: 'probe' },
    },
  };
  const result = selectCdpEndpoint(entry);
  assert.equal(result.port, 9010, 'should prefer active.port over legacy port');
});

test('selectCdpEndpoint uses cdp.active when state is error but verifiedAt is recent', () => {
  const now = Date.now();
  const entry = {
    port: 9000,
    ip: '127.0.0.1',
    cdp: {
      state: 'error',
      active: { host: '172.31.208.1', port: 9005, verifiedAt: now - 2 * 60 * 1000 },
    },
  };
  const result = selectCdpEndpoint(entry);
  assert.equal(result.port, 9005, 'should use active.port when recently verified');
  assert.equal(result.ip, '172.31.208.1', 'should use active.host when recently verified');
});

test('selectCdpEndpoint falls back to legacy port when active is stale', () => {
  const entry = {
    port: 9000,
    ip: '127.0.0.1',
    cdp: {
      state: 'error',
      active: { host: '172.31.208.1', port: 9005, verifiedAt: Date.now() - 15 * 60 * 1000 },
    },
  };
  const result = selectCdpEndpoint(entry);
  assert.equal(result.port, 9000, 'should fall back to legacy port when active is stale');
});

test('selectCdpEndpoint falls back to legacy port when no cdp field', () => {
  const entry = { port: 9000, ip: '127.0.0.1' };
  const result = selectCdpEndpoint(entry);
  assert.equal(result.port, 9000);
  assert.equal(result.ip, '127.0.0.1');
});
