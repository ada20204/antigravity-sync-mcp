/**
 * Registry I/O — shared registry read/write utilities.
 *
 * Extracted from cdp.ts to allow launch-antigravity.ts to read the registry
 * without importing the full CDP module.
 */
export declare function getRegistryFilePath(): string;
export declare function readRegistryObject(): Record<string, unknown> | null;
//# sourceMappingURL=registry-io.d.ts.map