#!/usr/bin/env node
/**
 * Antigravity Account Switch Worker
 *
 * 独立进程，负责在 Antigravity 退出后修改 SQLite 数据库并重启。
 * 由 sidecar 以 detached 模式启动，完全独立运行。
 */

const fs = require('fs');
const path = require('path');
const { createExecutableKillMatcher, createRestartPrimitive } = require('../src/services/launcher');

async function loadStatusStoreModule() {
    return import(pathToFileURL(path.join(__dirname, '../src/services/switch-status-store.js')).href);
}

function pathToFileURL(filePath) {
    const resolved = path.resolve(filePath);
    const url = new URL('file://');
    url.pathname = resolved.startsWith('/') ? resolved : `/${resolved.replace(/\\/g, '/')}`;
    return url;
}

// ============================================================================
// 参数解析
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};

    for (let i = 0; i < args.length; i += 1) {
        const rawKey = args[i];
        if (!rawKey || !rawKey.startsWith('--')) {
            continue;
        }
        const key = rawKey.replace(/^--/, '');
        const value = (i + 1 < args.length && !args[i + 1].startsWith('--') || key === 'extra-arg') ? args[++i] : true;

        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            if (Array.isArray(parsed[key])) {
                parsed[key].push(value);
            } else {
                parsed[key] = [parsed[key], value];
            }
        } else {
            parsed[key] = value;
        }
    }

    return parsed;
}

function getParsedArgs() {
    return parseArgs();
}

function getRuntimeValue(key, fallback = undefined) {
    const value = getParsedArgs()[key];
    return value ?? fallback;
}
function getWorkspace() {
    return getRuntimeValue('workspace');
}

function getPort() {
    return getRuntimeValue('port');
}

function getExtraArgs() {
    const args = getParsedArgs();
    const values = args['extra-arg'];
    if (Array.isArray(values)) return values;
    if (typeof values === 'string' && values.length > 0) return [values];
    return [];
}


function getTargetEmail() {
    return getRuntimeValue('target-email');
}

function getDbPath() {
    return getRuntimeValue('db-path');
}

function getBackupDir() {
    return getRuntimeValue('backup-dir');
}

function getAntigravityPath() {
    return getRuntimeValue('antigravity-path');
}

function getAntigravityPid() {
    return getRuntimeValue('pid');
}

function getConfigDir() {
    return getRuntimeValue('config-dir');
}

function getRequestId() {
    return getRuntimeValue('request-id', `worker-${Date.now()}-${process.pid}`);
}

function validateArgs() {
    if (!getDbPath() || !getTargetEmail() || !getBackupDir() || !getAntigravityPath() || !getConfigDir() || !getWorkspace() || !getPort()) {
        console.error('Missing required arguments');
        console.error('Usage: switch-worker.js --db-path <path> --target-email <email> --backup-dir <dir> --antigravity-path <path> --pid <pid> --config-dir <dir> --request-id <id>');
        process.exit(1);
    }
}

// ============================================================================
// 常量
// ============================================================================

const ABSOLUTE_TIMEOUT_MS = 30000;  // 30 秒绝对超时
const WAIT_EXIT_TIMEOUT_MS = 10000; // 10 秒等待进程退出
const POLL_INTERVAL_MS = 500;       // 轮询间隔

function getLockFile() {
    return path.join(getConfigDir(), 'switch.lock');
}

function getResultFile() {
    return path.join(getConfigDir(), 'switch-result.json');
}

function getWorkerLogFile() {
    return path.join(getConfigDir(), 'switch-worker.log');
}

function getStatusFile() {
    return path.join(getConfigDir(), 'switch-status.json');
}

let statusStore = null;
let requestCreatedAt = Date.now();

async function getStatusStore() {
    if (statusStore) {
        return statusStore;
    }

    const { createSwitchStatusStore } = await loadStatusStoreModule();
    statusStore = createSwitchStatusStore({ filePath: getStatusFile() });
    return statusStore;
}

async function updateSharedStatus({ status, phase, error = null, includeLogs = false, target = getTargetEmail() }) {
    const store = await getStatusStore();
    const current = store.get(getRequestId());
    const timestamp = Date.now();
    const next = {
        requestId: getRequestId(),
        targetEmail: target,
        status,
        phase,
        error,
        createdAt: current?.createdAt ?? requestCreatedAt,
        updatedAt: timestamp,
        ...(includeLogs ? { logs: [...logs] } : (current?.logs ? { logs: current.logs } : {})),
    };
    store.set(getRequestId(), next);
    return next;
}

const DB_KEYS = {
    AUTH_STATUS: 'antigravityAuthStatus',
    OAUTH_TOKEN: 'antigravityUnifiedStateSync.oauthToken',
    USER_STATUS: 'antigravityUnifiedStateSync.userStatus',
    ONBOARDING: 'antigravityOnboarding',
};

// ============================================================================
// 日志收集
// ============================================================================

const logs = [];

function log(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    logs.push(logLine);
    try {
        fs.appendFileSync(getWorkerLogFile(), `${logLine}\n`);
    } catch {
        // ignore file logging failures
    }
}

function ensureConfigDir() {
    fs.mkdirSync(getConfigDir(), { recursive: true });
}

async function writeResult(status, phase, error = null) {
    const timestamp = new Date().toISOString();
    const result = {
        requestId: getRequestId(),
        status,
        target: getTargetEmail(),
        targetEmail: getTargetEmail(),
        timestamp,
        error,
        phase,
        createdAt: requestCreatedAt,
        updatedAt: Date.now(),
        logs,
    };
    ensureConfigDir();
    const tmpFile = getResultFile() + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2));
    fs.renameSync(tmpFile, getResultFile());
    await updateSharedStatus({ status, phase, error, includeLogs: true });
    log(`Result written: ${status} at phase ${phase}`);
}

function cleanup() {
    try {
        if (fs.existsSync(getLockFile())) {
            // 验证锁文件是否属于当前进程
            try {
                const lock = JSON.parse(fs.readFileSync(getLockFile(), 'utf-8'));
                if (lock.workerPid === process.pid) {
                    fs.unlinkSync(getLockFile());
                    log('Lock file removed');
                } else {
                    log(`Lock file belongs to another worker (PID ${lock.workerPid}), skipping cleanup`);
                }
            } catch (e) {
                // 锁文件损坏，直接删除
                fs.unlinkSync(getLockFile());
                log('Corrupted lock file removed');
            }
        }
    } catch (e) {
        log(`Cleanup warning: ${e.message}`);
    }
}

async function exitWithError(phase, error) {
    log(`ERROR at ${phase}: ${error}`);
    await writeResult('failed', phase, error);
    cleanup();
    process.exit(1);
}

function isProcessAlive(pid) {
    try {
        process.kill(parseInt(pid), 0);
        return true;
    } catch {
        return false;
    }
}

function summarizeAuthValue(raw) {
    if (!raw) return 'null';
    try {
        const parsed = JSON.parse(raw);
        const email = parsed.email || parsed.Email || 'unknown';
        return `json(email=${email},len=${raw.length})`;
    } catch {
        return `text(len=${raw.length})`;
    }
}

function queryValue(db, key) {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row.value || null;
    }
    stmt.free();
    return null;
}

function createWorkerRestartPrimitive({ log }) {
    return createRestartPrimitive({
        platform: process.platform,
        wait(ms) {
            const end = Date.now() + ms;
            while (Date.now() < end) { /* busy wait */ }
        },
    });
}

// ============================================================================
// Phase 0: 预检查
// ============================================================================

async function phase0_precheck() {
    log('Phase 0: Precheck');
    await updateSharedStatus({ status: 'running', phase: 'precheck' });

    // 原子获取 lock file
    let lockFd;
    try {
        // 使用 'wx' 标志原子创建锁文件
        lockFd = fs.openSync(getLockFile(), 'wx');
        const lock = {
            pid: getAntigravityPid(),
            workerPid: process.pid,
            startedAt: new Date().toISOString(),
            target: getTargetEmail(),
        };
        fs.writeSync(lockFd, JSON.stringify(lock, null, 2));
        fs.closeSync(lockFd);
        log(`Lock acquired (worker PID: ${process.pid})`);
    } catch (e) {
        if (e.code === 'EEXIST') {
            // Lock 文件已存在，检查是否是僵尸锁
            try {
                const existingLock = JSON.parse(fs.readFileSync(getLockFile(), 'utf-8'));
                if (isProcessAlive(existingLock.workerPid)) {
                    exitWithError('precheck', `Another worker is running (PID ${existingLock.workerPid})`);
                } else {
                    log('Stale lock file detected, cleaning up');
                    fs.unlinkSync(getLockFile());
                    // 递归重试一次
                    return phase0_precheck();
                }
            } catch (readErr) {
                log(`Corrupted lock file, removing: ${readErr.message}`);
                fs.unlinkSync(getLockFile());
                return phase0_precheck();
            }
        } else {
            exitWithError('precheck', `Failed to acquire lock: ${e.message}`);
        }
    }

    // 验证备份文件
    const backupFile = path.join(getBackupDir(), `${getTargetEmail()}.json`);
    if (!fs.existsSync(backupFile)) {
        return exitWithError('precheck', `Backup file not found: ${backupFile}`);
    }

    try {
        const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
        if (!backup[DB_KEYS.AUTH_STATUS]) {
            return exitWithError('precheck', 'Invalid backup file: missing authStatus');
        }
    } catch (e) {
        return exitWithError('precheck', `Invalid backup file: ${e.message}`);
    }

    log('Precheck passed');
}

// ============================================================================
// Phase 1: 等待 Antigravity 退出
// ============================================================================

async function phase1_waitExit() {
    log('Phase 1: Waiting for Antigravity to exit');
    await updateSharedStatus({ status: 'running', phase: 'wait_exit' });

    let actualPid = getAntigravityPid() ? parseInt(getAntigravityPid(), 10) : null;
    if (!Number.isFinite(actualPid) || actualPid <= 0) {
        actualPid = findAntigravityPid();
        if (actualPid) {
            log(`Resolved Antigravity PID via fallback: ${actualPid}`);
        }
    } else {
        log(`Using provided Antigravity PID: ${actualPid}`);
    }

    if (!actualPid) {
        log('Antigravity process not found, assuming already exited');
        return;
    }

    const startTime = Date.now();

    while (Date.now() - startTime < WAIT_EXIT_TIMEOUT_MS) {
        if (!isProcessAlive(actualPid)) {
            log(`Antigravity exited (PID ${actualPid})`);
            return;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    exitWithError('wait_exit', `Timeout waiting for Antigravity to exit (PID ${actualPid})`);
}

// ============================================================================
// Phase 2: 修改 DB
// ============================================================================

function findAntigravityPid() {
    return null;
}

function phase2_modifyDb() {
    log('Phase 2: Modifying database');

    return updateSharedStatus({ status: 'running', phase: 'modify_db' }).then(() => {
        const initSqlJs = require(path.join(__dirname, '../vendor/sql.js/sql-asm.js'));

        return initSqlJs().then(SQL => {
        // 读取数据库
        const dbBuffer = fs.readFileSync(getDbPath());
        log(`Database file size before modify: ${dbBuffer.length} bytes`);
        const db = new SQL.Database(dbBuffer);

        try {
            const beforeAuth = queryValue(db, DB_KEYS.AUTH_STATUS);
            const beforeOauth = queryValue(db, DB_KEYS.OAUTH_TOKEN);
            const beforeUser = queryValue(db, DB_KEYS.USER_STATUS);
            log(`DB before restore: auth=${summarizeAuthValue(beforeAuth)} oauth=${beforeOauth ? `len=${beforeOauth.length}` : 'null'} user=${beforeUser ? `len=${beforeUser.length}` : 'null'}`);

            // 清除旧 auth 字段
            log('Clearing old auth fields');
            db.run(`DELETE FROM ItemTable WHERE key = ?`, [DB_KEYS.AUTH_STATUS]);
            db.run(`DELETE FROM ItemTable WHERE key = ?`, [DB_KEYS.OAUTH_TOKEN]);
            db.run(`DELETE FROM ItemTable WHERE key = ?`, [DB_KEYS.USER_STATUS]);

            // 设置 onboarding 跳过
            db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`,
                [DB_KEYS.ONBOARDING, 'true']);

            // 读取目标账号备份
            const backupFile = path.join(getBackupDir(), `${getTargetEmail()}.json`);
            const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
            log(`Loaded backup file: ${backupFile}`);
            log(`Backup summary: auth=${summarizeAuthValue(backup[DB_KEYS.AUTH_STATUS])} oauth=${backup[DB_KEYS.OAUTH_TOKEN] ? `len=${backup[DB_KEYS.OAUTH_TOKEN].length}` : 'null'} user=${backup[DB_KEYS.USER_STATUS] ? `len=${backup[DB_KEYS.USER_STATUS].length}` : 'null'}`);

            // 写入新账号数据
            log('Restoring target account');
            if (backup[DB_KEYS.AUTH_STATUS]) {
                db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`,
                    [DB_KEYS.AUTH_STATUS, backup[DB_KEYS.AUTH_STATUS]]);
            }
            if (backup[DB_KEYS.OAUTH_TOKEN]) {
                db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`,
                    [DB_KEYS.OAUTH_TOKEN, backup[DB_KEYS.OAUTH_TOKEN]]);
            }
            if (backup[DB_KEYS.USER_STATUS]) {
                db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`,
                    [DB_KEYS.USER_STATUS, backup[DB_KEYS.USER_STATUS]]);
            }

            const afterAuth = queryValue(db, DB_KEYS.AUTH_STATUS);
            const afterOauth = queryValue(db, DB_KEYS.OAUTH_TOKEN);
            const afterUser = queryValue(db, DB_KEYS.USER_STATUS);
            log(`DB after restore (in-memory): auth=${summarizeAuthValue(afterAuth)} oauth=${afterOauth ? `len=${afterOauth.length}` : 'null'} user=${afterUser ? `len=${afterUser.length}` : 'null'}`);

            // 导出并原子写入
            const data = db.export();
            const buffer = Buffer.from(data);
            const tmpPath = getDbPath() + '.tmp';
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, getDbPath());

            const persistedBuffer = fs.readFileSync(getDbPath());
            log(`Database file size after modify: ${persistedBuffer.length} bytes`);
            log('Database modified successfully');

            // 处理 backup 数据库（如果存在）
            const backupDbPath = getDbPath().replace('.vscdb', '.vscdb.backup');
            if (fs.existsSync(backupDbPath)) {
                try {
                    fs.unlinkSync(backupDbPath);
                    log('Backup database removed');
                } catch (e) {
                    log(`Warning: failed to remove backup DB: ${e.message}`);
                }
            }

        } finally {
            db.close();
        }
        }).catch(e => {
            return exitWithError('modify_db', `Database modification failed: ${e.message}`);
        });
    });
}

// ============================================================================
// Phase 3: 重启 Antigravity
// ============================================================================

function phase3_restart() {
    log('Phase 3: Starting formal restart worker');

    return updateSharedStatus({ status: 'running', phase: 'restart' }).then(() => new Promise((resolve, reject) => {
        try {
            const restartWorkerPath = path.join(__dirname, 'restart-worker.js');
            const args = [
                restartWorkerPath,
                '--workspace', getWorkspace(),
                '--antigravity-path', getAntigravityPath(),
                '--port', String(getPort()),
                '--bind-address', '127.0.0.1',
                '--request-id', `switch-restart-${getRequestId()}`,
                '--config-dir', getConfigDir(),
                '--wait-for-cdp', 'true',
                ...getExtraArgs().flatMap((arg) => ['--extra-arg', arg]),
            ];

            const child = require('child_process').spawn('node', args, {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            log(`Formal restart worker started (pid=${child.pid || 'unknown'}) with requestId=switch-restart-${getRequestId()} workspace=${getWorkspace()} port=${getPort()} extraArgs=${JSON.stringify(getExtraArgs())}`);
            resolve();
        } catch (e) {
            reject(e);
        }
    })).catch((e) => {
        log(`Warning: restart worker launch failed: ${e.message}`);
        return writeResult('success', 'complete', `Restart worker launch failed: ${e.message}, please start manually`).then(() => {
            cleanup();
        });
    });
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    validateArgs();
    requestCreatedAt = Date.now();
    log('=== Antigravity Account Switch Worker Started ===');
    log(`Target: ${getTargetEmail()}`);
    log(`Request ID: ${getRequestId()}`);
    log(`DB: ${getDbPath()}`);
    log(`Antigravity PID: ${getAntigravityPid()}`);
    await updateSharedStatus({
        status: 'running',
        phase: 'starting',
        target: getTargetEmail(),
    });

    const absoluteTimeout = setTimeout(() => {
        log('ABSOLUTE TIMEOUT REACHED');
        writeResult('timeout', 'unknown', 'Worker exceeded 30s absolute timeout').finally(() => {
            cleanup();
            process.exit(1);
        });
    }, ABSOLUTE_TIMEOUT_MS);

    try {
        await phase0_precheck();
        await phase1_waitExit();
        await phase2_modifyDb();
        await phase3_restart();

        await writeResult('success', 'complete');
        cleanup();
        clearTimeout(absoluteTimeout);

        log('=== Switch completed successfully ===');
        process.exit(0);

    } catch (e) {
        clearTimeout(absoluteTimeout);
        await exitWithError('unknown', e.message);
    }
}

function resetTestState() {
    statusStore = null;
    requestCreatedAt = Date.now();
}

module.exports = {
    __testExports: {
        writeResult,
        updateSharedStatus,
        getStatusStore,
        resetTestState,
    },
};

if (require.main === module) {
    main().catch(async (e) => {
        log(`Unhandled error: ${e.message}`);
        await updateSharedStatus({ status: 'failed', phase: 'unknown', error: e.message, includeLogs: true });
        process.exit(1);
    });
}
