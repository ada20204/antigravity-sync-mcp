"use strict";
/**
 * Platform-specific path resolution utilities.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigDir = getConfigDir;
exports.getRegistryPath = getRegistryPath;
exports.getLogDir = getLogDir;
exports.resolveAntigravityExecutable = resolveAntigravityExecutable;
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const fs_1 = __importDefault(require("fs"));
const REGISTRY_DIR = ".config/antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOG_DIR_NAME = "logs";
/** Returns the user-level config directory for Antigravity MCP. */
function getConfigDir() {
    return path_1.default.join(os_1.default.homedir(), REGISTRY_DIR);
}
/** Returns the default path to the registry JSON file. */
function getRegistryPath() {
    return path_1.default.join(getConfigDir(), REGISTRY_FILE_NAME);
}
/** Returns the default path to the log directory. */
function getLogDir() {
    return path_1.default.join(getConfigDir(), LOG_DIR_NAME);
}
function fileExists(filePath) {
    try {
        return fs_1.default.existsSync(filePath);
    }
    catch {
        return false;
    }
}
/**
 * Resolves the Antigravity (or Cursor) executable path for the current platform.
 * Respects the ANTIGRAVITY_EXECUTABLE environment variable override.
 * Returns undefined if no executable is found.
 */
function resolveAntigravityExecutable() {
    const explicit = process.env.ANTIGRAVITY_EXECUTABLE?.trim();
    if (explicit)
        return explicit;
    if (process.platform === "win32") {
        const username = process.env.USERNAME || process.env.USER || "";
        const localAppData = process.env.LOCALAPPDATA || `C:\\Users\\${username}\\AppData\\Local`;
        const candidates = [
            path_1.default.win32.join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
            path_1.default.win32.join(localAppData, "Programs", "Cursor", "Cursor.exe"),
        ];
        return candidates.find(fileExists);
    }
    if (process.platform === "darwin") {
        const candidates = [
            "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
            "/Applications/Antigravity.app/Contents/MacOS/Electron",
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "/Applications/Cursor.app/Contents/MacOS/Cursor",
        ];
        return candidates.find(fileExists);
    }
    const linuxCandidates = [
        "/usr/bin/antigravity",
        "/usr/local/bin/antigravity",
        "/usr/bin/cursor",
        "/usr/local/bin/cursor",
    ];
    return linuxCandidates.find(fileExists);
}
//# sourceMappingURL=paths.js.map