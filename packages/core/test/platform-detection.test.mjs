import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    getPlatform,
    isWindows,
    isMac,
    isLinux,
} from "../dist/platform/detection.js";

test("getPlatform returns a non-empty string", () => {
    const p = getPlatform();
    assert.equal(typeof p, "string");
    assert.ok(p.length > 0);
});

test("exactly one of isWindows/isMac/isLinux is true on known platforms", () => {
    const platform = getPlatform();
    if (platform === "win32") {
        assert.equal(isWindows(), true);
        assert.equal(isMac(), false);
        assert.equal(isLinux(), false);
    } else if (platform === "darwin") {
        assert.equal(isWindows(), false);
        assert.equal(isMac(), true);
        assert.equal(isLinux(), false);
    } else if (platform === "linux") {
        assert.equal(isWindows(), false);
        assert.equal(isMac(), false);
        assert.equal(isLinux(), true);
    } else {
        // Unknown platform — just verify they return booleans
        assert.equal(typeof isWindows(), "boolean");
        assert.equal(typeof isMac(), "boolean");
        assert.equal(typeof isLinux(), "boolean");
    }
});
