import test from 'node:test';
import assert from 'node:assert/strict';
import { signControlRequest, verifyControlRequest, NonceCache, signBridgeHttpRequest, verifyBridgeHttpRequest } from '../src/bridge-auth.js';

const TOKEN = 'test-token-abc123';

function makeReq(overrides = {}) {
    const base = {
        id: 'req-001',
        workspace_id: 'ws-aabbccdd',
        action: 'restart',
        ts: Date.now(),
        nonce: 'nonce-xyz-' + Math.random(),
        from_node_id: 'node-a',
        to_node_id: 'node-b',
        signature: '',
    };
    return { ...base, ...overrides };
}

test('rejects wrong signature', () => {
    const req = makeReq();
    req.signature = 'deadbeef'.repeat(8);
    const result = verifyControlRequest(req, TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_signature_invalid');
});

test('accepts correct signature', () => {
    const req = makeReq();
    req.signature = signControlRequest(req, TOKEN);
    const result = verifyControlRequest(req, TOKEN);
    assert.equal(result.ok, true);
});

test('rejects replayed nonce', () => {
    const cache = new NonceCache();
    const req = makeReq();
    req.signature = signControlRequest(req, TOKEN);
    assert.equal(verifyControlRequest(req, TOKEN, { nonceCache: cache }).ok, true);
    assert.equal(verifyControlRequest(req, TOKEN, { nonceCache: cache }).ok, false);
});

test('rejects timestamp skew', () => {
    const req = makeReq({ ts: Date.now() - 10 * 60 * 1000 });
    req.signature = signControlRequest(req, TOKEN);
    const result = verifyControlRequest(req, TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_timestamp_skew');
});

test('rejects missing token', () => {
    const req = makeReq();
    req.signature = signControlRequest(req, TOKEN);
    assert.equal(verifyControlRequest(req, '').ok, false);
});

test('NonceCache.prune removes expired entries', () => {
    const cache = new NonceCache(100);
    cache.add('n1', 0);
    cache.add('n2', 50);
    cache.prune(200);
    assert.equal(cache.map.size, 0);
});

test('NonceCache.prune keeps unexpired entries', () => {
    const cache = new NonceCache(1000);
    const now = Date.now();
    cache.add('n1', now);
    cache.prune(now + 500);
    assert.equal(cache.map.size, 1);
});

// ── signBridgeHttpRequest / verifyBridgeHttpRequest ──────────────────────────

const HTTP_TOKEN = 'http-bridge-token-xyz';

function makeHttpReq(overrides = {}) {
    const base = {
        method: 'POST',
        path: '/v1/snapshot',
        bodyHash: 'a'.repeat(64),
        ts: Date.now(),
        nonce: 'nonce-' + Math.random(),
        nodeId: 'node-remote-1',
    };
    return { ...base, ...overrides };
}

test('HTTP bridge: accepts correct signature', () => {
    const req = makeHttpReq();
    const signature = signBridgeHttpRequest(req, HTTP_TOKEN);
    const result = verifyBridgeHttpRequest({ ...req, signature }, HTTP_TOKEN);
    assert.equal(result.ok, true);
});

test('HTTP bridge: rejects wrong signature', () => {
    const req = makeHttpReq();
    const result = verifyBridgeHttpRequest({ ...req, signature: 'deadbeef'.repeat(8) }, HTTP_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_signature_invalid');
});

test('HTTP bridge: rejects missing token', () => {
    const req = makeHttpReq();
    const signature = signBridgeHttpRequest(req, HTTP_TOKEN);
    const result = verifyBridgeHttpRequest({ ...req, signature }, '');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_token_missing');
});

test('HTTP bridge: rejects timestamp skew', () => {
    const req = makeHttpReq({ ts: Date.now() - 10 * 60 * 1000 });
    const signature = signBridgeHttpRequest(req, HTTP_TOKEN);
    const result = verifyBridgeHttpRequest({ ...req, signature }, HTTP_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_timestamp_skew');
});

test('HTTP bridge: rejects replayed nonce', () => {
    const cache = new NonceCache();
    const req = makeHttpReq();
    const signature = signBridgeHttpRequest(req, HTTP_TOKEN);
    assert.equal(verifyBridgeHttpRequest({ ...req, signature }, HTTP_TOKEN, { nonceCache: cache }).ok, true);
    assert.equal(verifyBridgeHttpRequest({ ...req, signature }, HTTP_TOKEN, { nonceCache: cache }).ok, false);
});

test('HTTP bridge: rejects missing headers', () => {
    const req = makeHttpReq();
    const result = verifyBridgeHttpRequest({ ...req, nonce: '', signature: 'x', nodeId: 'n' }, HTTP_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_headers_missing');
});

test('HTTP bridge: different method produces different signature', () => {
    const req = makeHttpReq();
    const sig1 = signBridgeHttpRequest(req, HTTP_TOKEN);
    const sig2 = signBridgeHttpRequest({ ...req, method: 'GET' }, HTTP_TOKEN);
    assert.notEqual(sig1, sig2);
});

test('HTTP bridge: different path produces different signature', () => {
    const req = makeHttpReq();
    const sig1 = signBridgeHttpRequest(req, HTTP_TOKEN);
    const sig2 = signBridgeHttpRequest({ ...req, path: '/v1/health' }, HTTP_TOKEN);
    assert.notEqual(sig1, sig2);
});
