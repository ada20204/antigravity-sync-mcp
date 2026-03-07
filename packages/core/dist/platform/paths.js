/**
 * Platform-specific path resolution utilities.
 */
import path from "path";
import os from "os";
import fs from "fs";
const REGISTRY_DIR = ".config/antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOG_DIR_NAME = "logs";
/** Returns the user-level config directory for Antigravity MCP. */
export function getConfigDir() {
    return path.join(os.homedir(), REGISTRY_DIR);
}
/** Returns the default path to the registry JSON file. */
export function getRegistryPath() {
    return path.join(getConfigDir(), REGISTRY_FILE_NAME);
}
/** Returns the default path to the log directory. */
export function getLogDir() {
    return path.join(getConfigDir(), LOG_DIR_NAME);
}
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
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
export function resolveAntigravityExecutable() {
    const explicit = process.env.ANTIGRAVITY_EXECUTABLE?.trim();
    if (explicit)
        return explicit;
    if (process.platform === "win32") {
        const username = process.env.USERNAME || process.env.USER || "";
        const localAppData = process.env.LOCALAPPDATA || `C:\\Users\\${username}\\AppData\\Local`;
        const candidates = [
            path.win32.join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
            path.win32.join(localAppData, "Programs", "Cursor", "Cursor.exe"),
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