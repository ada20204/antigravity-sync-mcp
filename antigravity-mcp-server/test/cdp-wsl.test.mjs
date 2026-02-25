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
