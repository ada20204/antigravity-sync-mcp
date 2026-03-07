import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Normalizes a workspace path for stable workspace_id hashing.
 * Must stay consistent across sidecar and server.
 */
export function normalizeWorkspacePath(rawPath: string): string {
    let normalized = rawPath.trim();
    if (!normalized) return "";

    try {
        normalized = fs.realpathSync(normalized);
    } catch {
        // Path may not exist locally; fall back to resolve.
    }

    normalized = path.resolve(normalized);
    normalized = normalized.replace(/\\/g, "/");
    normalized = normalized.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
    if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
}

/**
 * Computes the stable workspace_id used in the registry.
 */
export function computeWorkspaceId(rawPath: string): string {
    const normalized = normalizeWorkspacePath(rawPath);
    return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}
