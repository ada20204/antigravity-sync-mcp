"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWorkspacePath = normalizeWorkspacePath;
exports.computeWorkspaceId = computeWorkspaceId;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Normalizes a workspace path for stable workspace_id hashing.
 * Must stay consistent across sidecar and server.
 */
function normalizeWorkspacePath(rawPath) {
    let normalized = rawPath.trim();
    if (!normalized)
        return "";
    try {
        normalized = fs_1.default.realpathSync(normalized);
    }
    catch {
        // Path may not exist locally; fall back to resolve.
    }
    normalized = path_1.default.resolve(normalized);
    normalized = normalized.replace(/\\/g, "/");
    normalized = normalized.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    if (normalized.length > 1 && normalized.endsWith("/"))
        normalized = normalized.slice(0, -1);
    return normalized;
}
/**
 * Computes the stable workspace_id used in the registry.
 */
function computeWorkspaceId(rawPath) {
    const normalized = normalizeWorkspacePath(rawPath);
    return crypto_1.default.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}
//# sourceMappingURL=workspace.js.map