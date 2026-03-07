const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const LOG_RETENTION_DAYS = 7;
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function shortHostName() {
    const host = String(os.hostname() || 'node').trim().toLowerCase();
    return host.replace(/[^a-z0-9_.-]/g, '') || 'node';
}

function createNodeId(role) {
    const seed = `${role}:${os.userInfo().username}:${os.hostname()}`;
    return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 12);
}

function createTraceId() {
    const rand = Math.random().toString(16).slice(2, 10);
    return `${Date.now().toString(16)}${rand}`;
}

function cleanupOldLogs(logDir, retentionMs = LOG_RETENTION_MS, nowMs = Date.now()) {
    try {
        if (!fs.existsSync(logDir)) return;
        const entries = fs.readdirSync(logDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const fullPath = path.join(logDir, entry.name);
            try {
                const st = fs.statSync(fullPath);
                if (nowMs - st.mtimeMs > retentionMs) {
                    fs.unlinkSync(fullPath);
                }
            } catch {
                // Ignore individual cleanup failures.
            }
        }
    } catch {
        // Best-effort cleanup only.
    }
}

function createStructuredLogger(params) {
    const {
        baseDir,
        outputChannel,
        role,
        nodeId,
        getWorkspaceId,
        debugEnabled = false,
    } = params;

    const logsDir = path.join(baseDir, 'logs');
    ensureDir(logsDir);
    cleanupOldLogs(logsDir);

    const day = new Date().toISOString().slice(0, 10);
    const fileName = `${day}-${role}-${shortHostName()}-${process.pid}.log`;
    const logFile = path.join(logsDir, fileName);

    function write(level, message, fields = {}) {
        if (level === 'debug' && !debugEnabled) return;
        const traceId = fields.trace_id || createTraceId();
        const workspaceId = fields.workspace_id || (typeof getWorkspaceId === 'function' ? getWorkspaceId() : undefined);
        const event = {
            ts: new Date().toISOString(),
            level,
            role,
            node_id: nodeId,
            peer_node_id: fields.peer_node_id || null,
            workspace_id: workspaceId || null,
            trace_id: traceId,
            plane: fields.plane || 'ctrl',
            state: fields.state || null,
            error_code: fields.error_code || null,
            message,
        };
        const merged = { ...event, ...(fields.extra && typeof fields.extra === 'object' ? fields.extra : {}) };
        try {
            fs.appendFileSync(logFile, `${JSON.stringify(merged)}\n`, 'utf-8');
        } catch {
            // Avoid crashing extension on logging failure.
        }

        const time = new Date().toLocaleTimeString();
        const errorSuffix = merged.error_code ? ` [${merged.error_code}]` : '';
        const human = `[${time}] ${message}${errorSuffix}`;
        console.log(human);
        if (outputChannel) {
            outputChannel.appendLine(human);
        }
        return traceId;
    }

    return {
        logsDir,
        logFile,
        write,
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
        debug: (message, fields) => write('debug', message, fields),
        cleanupOldLogs: () => cleanupOldLogs(logsDir),
    };
}

module.exports = {
    LOG_RETENTION_DAYS,
    LOG_RETENTION_MS,
    createNodeId,
    createTraceId,
    cleanupOldLogs,
    createStructuredLogger,
};
