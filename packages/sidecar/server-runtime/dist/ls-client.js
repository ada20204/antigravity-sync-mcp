import https from "https";
const LS_SERVICE_PATH = "/exa.language_server_pb.LanguageServerService";
export function resolveLsEndpoint(discovered) {
    const ls = discovered.registry?.ls;
    if (!ls?.port || !ls?.csrfToken)
        return undefined;
    return ls;
}
function lsCandidateIps(discovered) {
    const host = discovered.registry?.ls?.sourceHost || discovered.ip;
    return host ? [host] : [discovered.ip];
}
function postLsJsonAtHost(params) {
    const { host, port, csrfToken, method, body, timeoutMs = 3500 } = params;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: host,
            port,
            path: `${LS_SERVICE_PATH}/${method}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "Connect-Protocol-Version": "1",
                "X-Codeium-Csrf-Token": csrfToken,
            },
            rejectUnauthorized: false,
            timeout: timeoutMs,
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`LS ${method} status=${res.statusCode} body=${data.slice(0, 240)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error(`LS ${method} returned non-JSON body`));
                }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error(`LS ${method} timeout`));
        });
        req.write(payload);
        req.end();
    });
}
export async function callLsJson(discovered, method, body) {
    const ls = resolveLsEndpoint(discovered);
    if (!ls?.port || !ls.csrfToken) {
        throw new Error("LS endpoint unavailable in registry");
    }
    const ips = lsCandidateIps(discovered);
    let lastError;
    for (const ip of ips) {
        try {
            return await postLsJsonAtHost({
                host: ip,
                port: ls.port,
                csrfToken: ls.csrfToken,
                method,
                body,
            });
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`LS ${method} failed`);
}
function collectByKeys(value, keys, out) {
    if (!value || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            collectByKeys(item, keys, out);
        return;
    }
    const obj = value;
    for (const [key, v] of Object.entries(obj)) {
        if (keys.has(key) && typeof v === "string" && v.trim()) {
            out.push(v.trim());
        }
        collectByKeys(v, keys, out);
    }
}
export async function resolveActiveCascadeId(discovered) {
    const candidateKeys = new Set(["cascadeId", "cascade_id", "id"]);
    const first = await callLsJson(discovered, "GetBrowserOpenConversation", {}).catch(() => null);
    if (first) {
        const ids = [];
        collectByKeys(first, candidateKeys, ids);
        if (ids.length > 0)
            return ids[0];
    }
    const second = await callLsJson(discovered, "GetAllCascadeTrajectories", {}).catch(() => null);
    if (second) {
        const ids = [];
        collectByKeys(second, new Set(["cascadeId", "cascade_id"]), ids);
        if (ids.length > 0)
            return ids[0];
    }
    return undefined;
}
// Word-boundary patterns for terminal state values — avoids false positives from
// substrings like "stopwatch", "failure_fallback", "incompleted", etc.
const TERMINAL_VALUE_PATTERNS = [
    /\bdone\b/,
    /\bcomplete(d)?\b/,
    /\bfinish(ed)?\b/,
    /\bstop(ped)?\b/,
    /\bcancel(l?ed)?\b/,
    /\bfail(ed|ure)?\b/,
];
function containsTerminalSignal(value) {
    if (!value || typeof value !== "object")
        return false;
    if (Array.isArray(value))
        return value.some((item) => containsTerminalSignal(item));
    const obj = value;
    for (const [key, raw] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (typeof raw === "boolean") {
            if (raw && (lowerKey.includes("done") || lowerKey.includes("complete") || lowerKey.includes("terminal"))) {
                return true;
            }
        }
        else if (typeof raw === "string") {
            if (lowerKey.includes("status") ||
                lowerKey.includes("state") ||
                lowerKey.includes("finish")) {
                const v = raw.toLowerCase();
                if (TERMINAL_VALUE_PATTERNS.some((p) => p.test(v))) {
                    return true;
                }
            }
        }
        if (containsTerminalSignal(raw))
            return true;
    }
    return false;
}
export function isTrajectoryTerminal(payload) {
    return containsTerminalSignal(payload);
}
async function openReactiveStreamAtHost(params) {
    const { host, port, csrfToken, cascadeId } = params;
    const state = {
        connected: false,
        ended: false,
        terminal: false,
        lastEventAt: 0,
    };
    let req = null;
    let resRef = null;
    const bodyBytes = Buffer.from(JSON.stringify({ protocolVersion: 1, id: cascadeId }), "utf-8");
    const envelope = Buffer.allocUnsafe(5 + bodyBytes.length);
    envelope.writeUInt8(0x00, 0);
    envelope.writeUInt32BE(bodyBytes.length, 1);
    bodyBytes.copy(envelope, 5);
    await new Promise((resolve, reject) => {
        req = https.request({
            hostname: host,
            port,
            path: `${LS_SERVICE_PATH}/StreamCascadeReactiveUpdates`,
            method: "POST",
            headers: {
                "Content-Type": "application/connect+json",
                "Connect-Protocol-Version": "1",
                "X-Codeium-Csrf-Token": csrfToken,
                "Content-Length": envelope.length,
            },
            rejectUnauthorized: false,
            timeout: 5000,
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Reactive stream status=${res.statusCode}`));
                return;
            }
            state.connected = true;
            resRef = res;
            let buffer = Buffer.alloc(0);
            res.on("data", (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length >= 5) {
                    const flags = buffer.readUInt8(0);
                    const len = buffer.readUInt32BE(1);
                    if (buffer.length < 5 + len)
                        break;
                    const payload = buffer.subarray(5, 5 + len);
                    buffer = buffer.subarray(5 + len);
                    if (flags === 0x02) {
                        continue;
                    }
                    try {
                        const event = JSON.parse(payload.toString("utf-8"));
                        state.lastEventAt = Date.now();
                        if (containsTerminalSignal(event)) {
                            state.terminal = true;
                            state.lastReason = "reactive_terminal_signal";
                        }
                    }
                    catch {
                        // Ignore unknown frames.
                    }
                }
            });
            res.on("end", () => {
                state.ended = true;
            });
            res.on("error", (error) => {
                state.error = error.message;
            });
            resolve();
        });
        req.on("error", reject);
        req.on("timeout", () => {
            req?.destroy();
            reject(new Error("Reactive stream timeout"));
        });
        req.write(envelope);
        req.end();
    });
    return {
        state,
        close: () => {
            resRef?.destroy();
            req?.destroy();
            state.ended = true;
        },
    };
}
export async function openReactiveStream(discovered, cascadeId) {
    const ls = resolveLsEndpoint(discovered);
    if (!ls?.port || !ls.csrfToken)
        return null;
    let lastError;
    for (const ip of lsCandidateIps(discovered)) {
        try {
            return await openReactiveStreamAtHost({
                host: ip,
                port: ls.port,
                csrfToken: ls.csrfToken,
                cascadeId,
            });
        }
        catch (error) {
            lastError = error;
        }
    }
    if (lastError instanceof Error) {
        throw lastError;
    }
    return null;
}
//# sourceMappingURL=ls-client.js.map