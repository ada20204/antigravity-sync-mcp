/**
 * Platform detection utilities.
 */
/** Returns the current platform string (same as process.platform). */
export function getPlatform() {
    return process.platform;
}
/** Returns true when running on Windows. */
export function isWindows() {
    return process.platform === "win32";
}
/** Returns true when running on macOS. */
export function isMac() {
    return process.platform === "darwin";
}
/** Returns true when running on Linux. */
export function isLinux() {
    return process.platform === "linux";
}
//# sourceMappingURL=detection.js.map