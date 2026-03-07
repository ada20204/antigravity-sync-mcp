"use strict";
/**
 * Registry schema version constants and validation helpers.
 *
 * The sidecar writes entries with a schema_version field. The MCP server
 * only processes entries whose schema version it understands.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPATIBLE_SCHEMA_VERSIONS = exports.SCHEMA_VERSION = void 0;
exports.isSchemaVersionSupported = isSchemaVersionSupported;
exports.entrySupportsCurrentSchema = entrySupportsCurrentSchema;
/** The current schema version written by this codebase. */
exports.SCHEMA_VERSION = 2;
/** All schema versions this codebase can read. */
exports.COMPATIBLE_SCHEMA_VERSIONS = [2];
/**
 * Returns true if the given version number is one this codebase supports.
 */
function isSchemaVersionSupported(version) {
    return exports.COMPATIBLE_SCHEMA_VERSIONS.includes(version);
}
/**
 * Returns true if the registry entry declares at least one schema version
 * that this codebase supports (checked via schema_version and
 * protocol.compatible_schema_versions).
 */
function entrySupportsCurrentSchema(entry) {
    const declared = new Set();
    if (Number.isFinite(Number(entry.schema_version))) {
        declared.add(Number(entry.schema_version));
    }
    if (Array.isArray(entry.protocol?.compatible_schema_versions)) {
        for (const raw of entry.protocol.compatible_schema_versions) {
            const version = Number(raw);
            if (Number.isFinite(version))
                declared.add(version);
        }
    }
    if (declared.size === 0)
        return false;
    return [...declared].some(isSchemaVersionSupported);
}
//# sourceMappingURL=schema.js.map