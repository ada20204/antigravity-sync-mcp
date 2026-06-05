/**
 * Registry I/O — shared registry read utilities.
 *
 * Provides getRegistryFilePath() and readRegistryObject() so any package
 * can locate and read the sidecar registry without depending on the full
 * server package.
 */

import fs from "fs";
import path from "path";
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

/**
 * Atomically writes the registry JSON. Writes to a temp file in the same
 * directory then renames over the target — rename is atomic on a single
 * filesystem, so readers never observe a half-written file (no torn reads).
 *
 * NOTE: this prevents torn reads, NOT lost updates between concurrent writers.
 * The registry currently has multiple writers (sidecar + server __control__);
 * single-writer separation is a separate follow-up.
 */
export function writeRegistryObjectAtomic(
    registry: Record<string, unknown>,
    targetFile?: string
): void {
    const registryFile = targetFile ?? getRegistryFilePath();
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const tmp = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
        fs.renameSync(tmp, registryFile);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // temp already gone
        }
        throw e;
    }
}
