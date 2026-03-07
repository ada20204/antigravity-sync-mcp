/**
 * Registry I/O — shared registry read utilities.
 *
 * Provides getRegistryFilePath() and readRegistryObject() so any package
 * can locate and read the sidecar registry without depending on the full
 * server package.
 */

import fs from "fs";
import { getRegistryPath } from "../platform/paths.js";

/**
 * Returns the path to the registry JSON file.
 * Respects the ANTIGRAVITY_REGISTRY_FILE environment variable override.
 */
export function getRegistryFilePath(): string {
    return process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || getRegistryPath();
}

/**
 * Reads and parses the registry JSON file.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readRegistryObject(): Record<string, unknown> | null {
    const registryFile = getRegistryFilePath();
    try {
        if (!fs.existsSync(registryFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
        }
    } catch (e) {
        console.error(`[registry-io] Failed to read registry '${registryFile}': ${(e as Error).message}`);
    }
    return null;
}
