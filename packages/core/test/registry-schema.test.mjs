import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    SCHEMA_VERSION,
    COMPATIBLE_SCHEMA_VERSIONS,
    isSchemaVersionSupported,
    entrySupportsCurrentSchema,
} from "../dist/registry/schema.js";

test("SCHEMA_VERSION is 2", () => {
    assert.equal(SCHEMA_VERSION, 2);
});

test("COMPATIBLE_SCHEMA_VERSIONS contains 2", () => {
    assert.ok(Array.isArray(COMPATIBLE_SCHEMA_VERSIONS));
    assert.ok(COMPATIBLE_SCHEMA_VERSIONS.includes(2));
});

test("isSchemaVersionSupported returns true for supported version", () => {
    assert.equal(isSchemaVersionSupported(2), true);
});

test("isSchemaVersionSupported returns false for unsupported version", () => {
    assert.equal(isSchemaVersionSupported(1), false);
    assert.equal(isSchemaVersionSupported(99), false);
});

test("entrySupportsCurrentSchema returns true for schema_version 2", () => {
    const entry = { schema_version: 2 };
    assert.equal(entrySupportsCurrentSchema(entry), true);
});

test("entrySupportsCurrentSchema returns true via protocol.compatible_schema_versions", () => {
    const entry = {
        schema_version: 99,
        protocol: { compatible_schema_versions: [2] },
    };
    assert.equal(entrySupportsCurrentSchema(entry), true);
});

test("entrySupportsCurrentSchema returns false for unsupported schema", () => {
    const entry = { schema_version: 1 };
    assert.equal(entrySupportsCurrentSchema(entry), false);
});

test("entrySupportsCurrentSchema returns false for empty entry", () => {
    assert.equal(entrySupportsCurrentSchema({}), false);
});
