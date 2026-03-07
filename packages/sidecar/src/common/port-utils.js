const http = require('http');

const CDP_PORT_RANGE_MIN = 9000;
const CDP_PORT_RANGE_MAX = 9014;
const CDP_PROBE_SUMMARY_LIMIT = 40;

function getJson(url, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function dedupeStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const v = String(value || '').trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

function parsePortCandidates(spec) {
    const source = String(spec || '').trim();
    if (!source) return [];
    const out = [];
    for (const tokenRaw of source.split(',')) {
        const token = tokenRaw.trim();
        if (!token) continue;
        const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
            const start = Number(range[1]);
            const end = Number(range[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const lo = Math.max(1, Math.min(start, end));
            const hi = Math.min(65535, Math.max(start, end));
            for (let p = lo; p <= hi; p++) out.push(p);
            continue;
        }
        const port = Number(token);
        if (!Number.isFinite(port)) continue;
        if (port >= 1 && port <= 65535) out.push(port);
    }
    return [...new Set(out)];
}

function isStrictCdpPortSpec(spec) {
    const parsed = parsePortCandidates(spec);
    if (parsed.length === 0) return false;
    return parsed.every((port) => port >= CDP_PORT_RANGE_MIN && port <= CDP_PORT_RANGE_MAX);
}

function buildPortCandidateOrder(portRange, preferredPort) {
    const lo = portRange ? Number(portRange[0]) : 9000;
    const hi = portRange ? Number(portRange[1]) : 9014;
    const ordered = [];
    const preferred = Number(preferredPort);
    if (Number.isFinite(preferred) && preferred >= lo && preferred <= hi) {
        ordered.push(preferred);
    }
    for (let port = lo; port <= hi; port++) {
        if (port === preferred) continue;
        ordered.push(port);
    }
    return ordered;
}

function collectRegistryOccupiedPorts(registry) {
    const occupied = new Set();
    try {
        for (const [key, entry] of Object.entries(registry || {})) {
            if (key.startsWith('__')) continue;
            const port = entry && entry.local_endpoint && Number(entry.local_endpoint.port);
            if (Number.isFinite(port) && port > 0) occupied.add(port);
        }
    } catch (_) {
    }
    return occupied;
}

function trimProbeSummary(summary) {
    if (!Array.isArray(summary)) return [];
    if (summary.length <= CDP_PROBE_SUMMARY_LIMIT) return summary;
    const half = Math.floor(CDP_PROBE_SUMMARY_LIMIT / 2);
    return [...summary.slice(0, half), ...summary.slice(summary.length - half)];
}

function buildCandidateMatrix(hosts, ports, limit = CDP_PROBE_SUMMARY_LIMIT) {
    const out = [];
    for (const host of hosts || []) {
        for (const port of ports || []) {
            out.push({ host, port });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function previewTokens(values, limit = 3) {
    const list = Array.isArray(values) ? values : [];
    if (list.length === 0) return 'none';
    if (list.length <= limit) return list.join(',');
    return `${list.slice(0, limit).join(',')}...(+${list.length - limit})`;
}

function summarizeProbePlan(hosts, ports) {
    const hostList = Array.isArray(hosts) ? hosts : [];
    const portList = Array.isArray(ports) ? ports : [];
    return `hosts=${hostList.length}[${previewTokens(hostList, 3)}] ports=${portList.length}[${previewTokens(portList, 5)}]`;
}

module.exports = {
    getJson,
    dedupeStrings,
    parsePortCandidates,
    isStrictCdpPortSpec,
    buildPortCandidateOrder,
    collectRegistryOccupiedPorts,
    trimProbeSummary,
    buildCandidateMatrix,
    previewTokens,
    summarizeProbePlan,
    CDP_PORT_RANGE_MIN,
    CDP_PORT_RANGE_MAX,
    CDP_PROBE_SUMMARY_LIMIT,
};
