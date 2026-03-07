/**
 * Registry I/O — shared registry read utilities.
 *
 * Provides getRegistryFilePath() and readRegistryObject() so any package
 * can locate and read the sidecar registry without depending on the full
 * server package.
 */
/**
 * Returns the path to the registry JSON file.
 * Respects the ANTIGRAVITY_REGISTRY_FILE environment variable override.
 */
export declare function getRegistryFilePath(): string;
/**
 * Reads and parses the registry JSON file.
 * Returns null if the file does not exist or cannot be parsed.
 */
export declare function readRegistryObject(): Record<string, unknown> | null;
//# sourceMappingURL=io.d.ts.map