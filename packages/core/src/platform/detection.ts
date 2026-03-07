/**
 * Platform detection utilities.
 */

/** Returns the current platform string (same as process.platform). */
export function getPlatform(): NodeJS.Platform {
    return process.platform;
}

/** Returns true when running on Windows. */
export function isWindows(): boolean {
    return process.platform === "win32";
}

/** Returns true when running on macOS. */
export function isMac(): boolean {
    return process.platform === "darwin";
}

/** Returns true when running on Linux. */
export function isLinux(): boolean {
    return process.platform === "linux";
}
