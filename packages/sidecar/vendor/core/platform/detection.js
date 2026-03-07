"use strict";
/**
 * Platform detection utilities.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlatform = getPlatform;
exports.isWindows = isWindows;
exports.isMac = isMac;
exports.isLinux = isLinux;
/** Returns the current platform string (same as process.platform). */
function getPlatform() {
    return process.platform;
}
/** Returns true when running on Windows. */
function isWindows() {
    return process.platform === "win32";
}
/** Returns true when running on macOS. */
function isMac() {
    return process.platform === "darwin";
}
/** Returns true when running on Linux. */
function isLinux() {
    return process.platform === "linux";
}
//# sourceMappingURL=detection.js.map