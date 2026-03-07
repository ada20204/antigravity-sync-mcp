/**
 * Registry I/O — shared registry read utilities.
 *
 * Provides getRegistryFilePath() and readRegistryObject() so any package
 * can locate and read the sidecar registry without depending on the full
 * server package.
 */
import fs from "fs";
import path from "path";
import os from "os";
const REGISTRY_DIR = ".config/antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOCAL_REGISTRY_FILE = path.join(os.homedir(), REGISTRY_DIR, REGISTRY_FILE_NAME);
/**
 * Returns the path to the registry JSON file.
 * Respects the ANTIGRAVITY_REGISTRY_FILE environment variable override.
 */
export function getRegistryFilePath() {
    return process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || LOCAL_REGISTRY_FILE;
}
/**
 * Reads and parses the registry JSON file.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readRegistryObject() {
    const registryFile = getRegistryFilePath();
    try {
        if (!fs.existsSync(registryFile))
            return null;
        const parsed = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }
    catch (e) {
        console.error(`[registry-io] Failed to read registry '${registryFile}': ${e.message}`);
    }
    return null;
}
//# sourceMappingURL=io.js.map