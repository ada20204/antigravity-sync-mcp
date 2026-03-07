/**
 * Platform-specific path resolution utilities.
 */
/** Returns the user-level config directory for Antigravity MCP. */
export declare function getConfigDir(): string;
/** Returns the default path to the registry JSON file. */
export declare function getRegistryPath(): string;
/** Returns the default path to the log directory. */
export declare function getLogDir(): string;
/**
 * Resolves the Antigravity (or Cursor) executable path for the current platform.
 * Respects the ANTIGRAVITY_EXECUTABLE environment variable override.
 * Returns undefined if no executable is found.
 */
export declare function resolveAntigravityExecutable(): string | undefined;
//# sourceMappingURL=paths.d.ts.map