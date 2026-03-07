import { strict as assert } from "node:assert";
import { test } from "node:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    getRegistryFilePath,
    readRegistryObject,
} from "../dist/registry/io.js";

test("getRegistryFilePath returns a string", () => {
    const p = getRegistryFilePath();
    assert.equal(typeof p, "string");
    assert.ok(p.length > 0);
});

test("getRegistryFilePath respects ANTIGRAVITY_REGISTRY_FILE env var", () => {
    const original = process.env.ANTIGRAVITY_REGISTRY_FILE;
    process.env.ANTIGRAVITY_REGISTRY_FILE = "/tmp/custom-registry.json";
    assert.equal(getRegistryFilePath(), "/tmp/custom-registry.json");
    if (original === undefined) delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    else process.env.ANTIGRAVITY_REGISTRY_FILE = original;
});

test("readRegistryObject returns null when file does not exist", () => {
    const original = process.env.ANTIGRAVITY_REGISTRY_FILE;
    process.env.ANTIGRAVITY_REGISTRY_FILE = join(tmpdir(), `nonexistent-${Date.now()}.json`);
    const result = readRegistryObject();
    assert.equal(result, null);
    if (original === undefined) delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    else process.env.ANTIGRAVITY_REGISTRY_FILE = original;
});

test("readRegistryObject returns parsed object from valid JSON file", () => {
    const dir = join(tmpdir(), `ag-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "registry.json");
    const payload = { abc123: { workspace_id: "abc123", state: "ready" } };
    writeFileSync(file, JSON.stringify(payload), "utf-8");

    const original = process.env.ANTIGRAVITY_REGISTRY_FILE;
    process.env.ANTIGRAVITY_REGISTRY_FILE = file;
    const result = readRegistryObject();
    if (original === undefined) delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    else process.env.ANTIGRAVITY_REGISTRY_FILE = original;

    rmSync(dir, { recursive: true, force: true });

    assert.ok(result !== null);
    assert.deepEqual(result, payload);
});

test("readRegistryObject returns null for invalid JSON", () => {
    const dir = join(tmpdir(), `ag-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "registry.json");
    writeFileSync(file, "not valid json", "utf-8");

    const original = process.env.ANTIGRAVITY_REGISTRY_FILE;
    process.env.ANTIGRAVITY_REGISTRY_FILE = file;
    const result = readRegistryObject();
    if (original === undefined) delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    else process.env.ANTIGRAVITY_REGISTRY_FILE = original;

    rmSync(dir, { recursive: true, force: true });

    assert.equal(result, null);
});
