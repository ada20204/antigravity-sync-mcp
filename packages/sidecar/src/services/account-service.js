/**
 * Account Service — Antigravity 多账号管理
 *
 * 通过 sql.js (WASM) 读写 Antigravity 的 state.vscdb，
 * 实现账号备份、还原、切换。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// DB 常量（与 antigravity-agent 保持一致）
const DB_KEYS = {
    AUTH_STATUS: 'antigravityAuthStatus',
    OAUTH_TOKEN: 'antigravityUnifiedStateSync.oauthToken',
    USER_STATUS: 'antigravityUnifiedStateSync.userStatus',
    ONBOARDING: 'antigravityOnboarding',
};

/**
 * 获取 Antigravity 的 state.vscdb 路径（跨平台）
 */
function getAntigravityDbPath() {
    const platform = process.platform;
    let baseDir;

    if (platform === 'darwin') {
        // macOS: ~/Library/Application Support/Antigravity/User/globalStorage/
        baseDir = path.join(os.homedir(), 'Library', 'Application Support');
    } else if (platform === 'win32') {
        // Windows: %APPDATA%\Antigravity\User\globalStorage\
        baseDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else {
        // Linux: ~/.config/Antigravity/User/globalStorage/
        baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    }

    return path.join(baseDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * 获取账号备份目录
 */
function getAccountsDir() {
    const dir = path.join(os.homedir(), '.config', 'antigravity-mcp', 'accounts');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * 延迟加载 sql.js（使用 vendor 的 ASM.js 版本，纯 JS 无 WASM 依赖）
 * @returns {Promise<import('sql.js').SqlJsStatic>}
 */
let _sqlJsPromise = null;
function getSqlJs() {
    if (!_sqlJsPromise) {
        const initSqlJs = require('../../vendor/sql.js/sql-asm.js');
        _sqlJsPromise = initSqlJs();
    }
    return _sqlJsPromise;
}

/**
 * 打开 SQLite 数据库
 * @param {string} dbPath
 * @returns {Promise<import('sql.js').Database>}
 */
async function openDb(dbPath) {
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    return new SQL.Database(buffer);
}

/**
 * 保存数据库到文件
 * @param {import('sql.js').Database} db
 * @param {string} dbPath
 */
function saveDb(db, dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    // 原子写入：先写临时文件再 rename
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);
}

/**
 * 从数据库读取指定 key 的 value
 * @param {import('sql.js').Database} db
 * @param {string} key
 * @returns {string|null}
 */
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

/**
 * 读取当前 Antigravity 的 auth 字段
 * @returns {Promise<{authStatus: string|null, oauthToken: string|null, userStatus: string|null}>}
 */
async function readCurrentAuthFields() {
    const dbPath = getAntigravityDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Antigravity database not found: ${dbPath}`);
    }

    const db = await openDb(dbPath);
    try {
        return {
            authStatus: queryValue(db, DB_KEYS.AUTH_STATUS),
            oauthToken: queryValue(db, DB_KEYS.OAUTH_TOKEN),
            userStatus: queryValue(db, DB_KEYS.USER_STATUS),
        };
    } finally {
        db.close();
    }
}

/**
 * 从 authStatus JSON 中提取 email
 * @param {string} authStatusJson
 * @returns {string|null}
 */
function extractEmail(authStatusJson) {
    try {
        const parsed = JSON.parse(authStatusJson);
        // authStatus 可能是 camelCase 或 snake_case
        return parsed.email || parsed.Email || null;
    } catch {
        return null;
    }
}

/**
 * 清除数据库中的 auth 字段（模拟登出）
 * @returns {Promise<{cleared: number, dbPath: string}>}
 */
async function clearAuthFields() {
    const dbPath = getAntigravityDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Antigravity database not found: ${dbPath}`);
    }

    const db = await openDb(dbPath);
    try {
        let cleared = 0;
        for (const key of [DB_KEYS.AUTH_STATUS, DB_KEYS.OAUTH_TOKEN, DB_KEYS.USER_STATUS]) {
            const result = db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
            cleared += db.getRowsModified();
        }

        // 设置 onboarding 跳过标志
        db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [DB_KEYS.ONBOARDING, 'true']);

        saveDb(db, dbPath);

        // 同时处理 backup 数据库
        const backupDbPath = dbPath.replace('.vscdb', '.vscdb.backup');
        if (fs.existsSync(backupDbPath)) {
            try { fs.unlinkSync(backupDbPath); } catch { /* ignore */ }
        }

        return { cleared, dbPath };
    } finally {
        db.close();
    }
}

/**
 * 将 auth 字段写回数据库（还原账号）
 * @param {{authStatus: string, oauthToken?: string, userStatus?: string}} fields
 * @returns {Promise<{restored: number, dbPath: string}>}
 */
async function restoreAuthFields(fields) {
    const dbPath = getAntigravityDbPath();

    // 确保数据库目录存在
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = await openDb(dbPath);
    try {
        let restored = 0;

        if (fields.authStatus) {
            db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                [DB_KEYS.AUTH_STATUS, fields.authStatus]);
            restored++;
        }

        if (fields.oauthToken) {
            db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                [DB_KEYS.OAUTH_TOKEN, fields.oauthToken]);
            restored++;
        }

        if (fields.userStatus) {
            db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                [DB_KEYS.USER_STATUS, fields.userStatus]);
            restored++;
        }

        saveDb(db, dbPath);

        // 同时写入 backup 数据库（如果存在）
        const backupDbPath = dbPath.replace('.vscdb', '.vscdb.backup');
        if (fs.existsSync(backupDbPath)) {
            const backupDb = await openDb(backupDbPath);
            try {
                if (fields.authStatus) {
                    backupDb.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                        [DB_KEYS.AUTH_STATUS, fields.authStatus]);
                }
                if (fields.oauthToken) {
                    backupDb.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                        [DB_KEYS.OAUTH_TOKEN, fields.oauthToken]);
                }
                if (fields.userStatus) {
                    backupDb.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                        [DB_KEYS.USER_STATUS, fields.userStatus]);
                }
                saveDb(backupDb, backupDbPath);
            } finally {
                backupDb.close();
            }
        }

        return { restored, dbPath };
    } finally {
        db.close();
    }
}

/**
 * 备份当前账号到文件
 * @returns {Promise<{email: string, filePath: string}>}
 */
async function saveCurrentAccount() {
    const fields = await readCurrentAuthFields();
    if (!fields.authStatus) {
        throw new Error('No account is currently logged in (antigravityAuthStatus not found)');
    }

    const email = extractEmail(fields.authStatus);
    if (!email) {
        throw new Error('No account is currently logged in');
    }

    const backup = {};
    backup[DB_KEYS.AUTH_STATUS] = fields.authStatus;
    if (fields.oauthToken) backup[DB_KEYS.OAUTH_TOKEN] = fields.oauthToken;
    if (fields.userStatus) backup[DB_KEYS.USER_STATUS] = fields.userStatus;

    const filePath = path.join(getAccountsDir(), `${email}.json`);
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');

    return { email, filePath };
}

/**
 * 列出所有已保存的账号
 * @returns {{email: string, filePath: string, modifiedTime: Date}[]}
 */
function listSavedAccounts() {
    const dir = getAccountsDir();
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(dir, f);
            const stat = fs.statSync(filePath);
            return {
                email: f.replace('.json', ''),
                filePath,
                modifiedTime: stat.mtime,
            };
        })
        .sort((a, b) => b.modifiedTime - a.modifiedTime);
}

/**
 * 读取备份文件中的 auth 字段
 * @param {string} email
 * @returns {{authStatus: string, oauthToken?: string, userStatus?: string}}
 */
function loadBackupFields(email) {
    const filePath = path.join(getAccountsDir(), `${email}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Backup file not found for account: ${email}`);
    }

    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
        authStatus: content[DB_KEYS.AUTH_STATUS] || null,
        oauthToken: content[DB_KEYS.OAUTH_TOKEN] || null,
        userStatus: content[DB_KEYS.USER_STATUS] || null,
    };
}

/**
 * 删除已保存的账号备份
 * @param {string} email
 */
function deleteAccount(email) {
    const filePath = path.join(getAccountsDir(), `${email}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

module.exports = {
    DB_KEYS,
    getAntigravityDbPath,
    getAccountsDir,
    readCurrentAuthFields,
    extractEmail,
    clearAuthFields,
    restoreAuthFields,
    saveCurrentAccount,
    listSavedAccounts,
    loadBackupFields,
    deleteAccount,
};
