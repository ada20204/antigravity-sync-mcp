"use strict";
/**
 * Registry I/O — shared registry read utilities.
 *
 * Provides getRegistryFilePath() and readRegistryObject() so any package
 * can locate and read the sidecar registry without depending on the full
 * server package.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRegistryFilePath = getRegistryFilePath;
exports.readRegistryObject = readRegistryObject;
const fs_1 = __importDefault(require("fs"));
const paths_js_1 = require("../platform/paths.js");
/**
 * Returns the path to the registry JSON file.
 * Respects the ANTIGRAVITY_REGISTRY_FILE environment variable override.
 */
function getRegistryFilePath() {
    return process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || (0, paths_js_1.getRegistryPath)();
}
/**
 * Reads and parses the registry JSON file.
 * Returns null if the file does not exist or cannot be parsed.
 */
function readRegistryObject() {
    const registryFile = getRegistryFilePath();
    try {
        if (!fs_1.default.existsSync(registryFile))
            return null;
        const parsed = JSON.parse(fs_1.default.readFileSync(registryFile, "utf-8"));
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