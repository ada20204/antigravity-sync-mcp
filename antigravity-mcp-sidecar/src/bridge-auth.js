const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRIDGE_TOKEN_FILE = 'bridge.token';
const DEFAULT_MAX_SKEW_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTokenFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return '';
        return String(fs.readFileSync(filePath, 'utf-8') || '').trim();
    } catch {
        return '';
    }
}

function writeTokenFile(filePath, token) {
    try {
        fs.writeFileSync(filePath, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch {
        // Best effort only.
    }
}

function ensureBridgeToken(baseDir, configuredToken) {
    const direct = String(configuredToken || '').trim();
    if (direct) return direct;

    ensureDir(baseDir);
    const tokenFile = path.join(baseDir, BRIDGE_TOKEN_FILE);
    const existing = readTokenFile(tokenFile);
    if (existing) return existing;

    const generated = crypto.randomBytes(32).toString('hex');
    writeTokenFile(tokenFile, generated);
    return generated;
}

function canonicalRequestString(req) {
    const parts = [
        String(req.id || ''),
        String(req.workspace_id || ''),
        String(req.action || ''),
        String(req.ts || ''),
        String(req.nonce || ''),
        String(req.from_node_id || ''),
        String(req.to_node_id || ''),
    ];
    return parts.join('|');
}

function signControlRequest(req, token) {
    const key = String(token || '').trim();
    if (!key) return '';
    return crypto.createHmac('sha256', key).update(canonicalRequestString(req), 'utf8').digest('hex');
}

class NonceCache {
    constructor(ttlMs = NONCE_TTL_MS) {
        this.ttlMs = ttlMs;
        this.map = new Map();
    }

    prune(nowMs = Date.now()) {
        for (const [nonce, expireAt] of this.map.entries()) {
            if (expireAt <= nowMs) this.map.delete(nonce);
        }
    }

    seen(nonce, nowMs = Date.now()) {
        const expireAt = this.map.get(nonce);
        if (!expireAt) return false;
        if (expireAt <= nowMs) {
            this.map.delete(nonce);
            return false;
        }
        return true;
    }

    add(nonce, nowMs = Date.now()) {
        this.map.set(nonce, nowMs + this.ttlMs);
    }
}

function verifyControlRequest(req, token, opts = {}) {
    const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    const maxSkewMs = typeof opts.maxSkewMs === 'number' ? opts.maxSkewMs : DEFAULT_MAX_SKEW_MS;
    const nonceCache = opts.nonceCache;
    const key = String(token || '').trim();

    if (!key) {
        return { ok: false, code: 'auth_token_missing', message: 'bridge token is missing' };
    }
    if (!req || typeof req !== 'object') {
        return { ok: false, code: 'invalid_request', message: 'request object missing' };
    }
    if (!req.id || !req.workspace_id || !req.action || !req.nonce) {
        return { ok: false, code: 'invalid_request', message: 'required request fields missing' };
    }
    const ts = Number(req.ts);
    if (!Number.isFinite(ts)) {
        return { ok: false, code: 'auth_timestamp_invalid', message: 'request timestamp invalid' };
    }
    if (Math.abs(nowMs - ts) > maxSkewMs) {
        return { ok: false, code: 'auth_timestamp_skew', message: 'request timestamp skew exceeded' };
    }
    if (nonceCache && nonceCache.seen(req.nonce, nowMs)) {
        return { ok: false, code: 'auth_nonce_replay', message: 'request nonce replay detected' };
    }

    const expected = signControlRequest(req, key);
    if (!expected || !req.signature) {
        return { ok: false, code: 'auth_signature_invalid', message: 'request signature verification failed' };
    }
    let sigMatch = false;
    try {
        const expectedBuf = Buffer.from(expected, 'hex');
        const actualBuf = Buffer.from(String(req.signature), 'hex');
        sigMatch = expectedBuf.length === actualBuf.length &&
            crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
        sigMatch = false;
    }
    if (!sigMatch) {
        return { ok: false, code: 'auth_signature_invalid', message: 'request signature verification failed' };
    }

    if (nonceCache) nonceCache.add(req.nonce, nowMs);
    return { ok: true };
}

module.exports = {
    BRIDGE_TOKEN_FILE,
    DEFAULT_MAX_SKEW_MS,
    NONCE_TTL_MS,
    NonceCache,
    ensureBridgeToken,
    readTokenFile,
    signControlRequest,
    verifyControlRequest,
};
