/**
 * Registry schema version constants and validation helpers.
 *
 * The sidecar writes entries with a schema_version field. The MCP server
 * only processes entries whose schema version it understands.
 */
import type { RegistryEntry } from './types.js';
/** The current schema version written by this codebase. */
export declare const SCHEMA_VERSION = 2;
/** All schema versions this codebase can read. */
export declare const COMPATIBLE_SCHEMA_VERSIONS: readonly number[];
/**
 * Returns true if the given version number is one this codebase supports.
 */
export declare function isSchemaVersionSupported(version: number): boolean;
/**
 * Returns true if the registry entry declares at least one schema version
 * that this codebase supports (checked via schema_version and
 * protocol.compatible_schema_versions).
 */
export declare function entrySupportsCurrentSchema(entry: RegistryEntry): boolean;
//# sourceMappingURL=schema.d.ts.map