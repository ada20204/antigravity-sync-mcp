import { strict as assert } from "node:assert";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    getConfigDir,
    getRegistryPath,
    getLogDir,
    resolveAntigravityExecutable,
} from "../dist/platform/paths.js";

test("getConfigDir returns a string containing home dir", () => {
    const dir = getConfigDir();
    assert.equal(typeof dir, "string");
    assert.ok(dir.startsWith(homedir()) || dir.includes("antigravity-mcp"));
});

test("getRegistryPath ends with registry.json", () => {
    const p = getRegistryPath();
    assert.ok(p.endsWith("registry.json"), `expected registry.json, got: ${p}`);
});

test("getLogDir ends with logs", () => {
    const p = getLogDir();
    assert.ok(p.endsWith("logs"), `expected logs, got: ${p}`);
});

test("resolveAntigravityExecutable respects ANTIGRAVITY_EXECUTABLE env var", () => {
    const original = process.env.ANTIGRAVITY_EXECUTABLE;
    process.env.ANTIGRAVITY_EXECUTABLE = "/custom/path/antigravity";
    const result = resolveAntigravityExecutable();
    if (original === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE;
    else process.env.ANTIGRAVITY_EXECUTABLE = original;
    assert.equal(result, "/custom/path/antigravity");
});

test("resolveAntigravityExecutable returns string or undefined without env override", () => {
    const original = process.env.ANTIGRAVITY_EXECUTABLE;
    delete process.env.ANTIGRAVITY_EXECUTABLE;
    const result = resolveAntigravityExecutable();
    if (original !== undefined) process.env.ANTIGRAVITY_EXECUTABLE = original;
    assert.ok(result === undefined || typeof result === "string");
});
