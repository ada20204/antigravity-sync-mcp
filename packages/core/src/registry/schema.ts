/**
 * Registry schema version constants and validation helpers.
 *
 * The sidecar writes entries with a schema_version field. The MCP server
 * only processes entries whose schema version it understands.
 */

import type { RegistryEntry } from './types.js';

/** The current schema version written by this codebase. */
export const SCHEMA_VERSION = 2;

/** All schema versions this codebase can read. */
export const COMPATIBLE_SCHEMA_VERSIONS: readonly number[] = [2];

/**
 * Returns true if the given version number is one this codebase supports.
 */
export function isSchemaVersionSupported(version: number): boolean {
    return (COMPATIBLE_SCHEMA_VERSIONS as number[]).includes(version);
}

/**
 * Returns true if the registry entry declares at least one schema version
 * that this codebase supports (checked via schema_version and
 * protocol.compatible_schema_versions).
 */
export function entrySupportsCurrentSchema(entry: RegistryEntry): boolean {
    const declared = new Set<number>();
    if (Number.isFinite(Number(entry.schema_version))) {
        declared.add(Number(entry.schema_version));
    }
    if (Array.isArray(entry.protocol?.compatible_schema_versions)) {
        for (const raw of entry.protocol!.compatible_schema_versions!) {
            const version = Number(raw);
            if (Number.isFinite(version)) declared.add(version);
        }
    }
    if (declared.size === 0) return false;
    return [...declared].some(isSchemaVersionSupported);
}
