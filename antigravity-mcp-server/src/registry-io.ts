/**
 * Registry I/O — shared registry read/write utilities.
 *
 * Extracted from cdp.ts to allow launch-antigravity.ts to read the registry
 * without importing the full CDP module.
 */

import fs from "fs";
import path from "path";
import os from "os";

const REGISTRY_DIR = ".config/antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOCAL_REGISTRY_FILE = path.join(os.homedir(), REGISTRY_DIR, REGISTRY_FILE_NAME);

export function getRegistryFilePath(): string {
    return process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || LOCAL_REGISTRY_FILE;
}

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
