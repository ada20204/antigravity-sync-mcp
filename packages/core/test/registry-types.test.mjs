import { strict as assert } from "node:assert";
import { test } from "node:test";

// Types are compile-time only; we verify the module exports exist at runtime
// by importing the compiled output.
import * as types from "../dist/registry/types.js";

test("registry/types module exports are defined", () => {
    // All exports from types.ts are interfaces/types — no runtime values.
    // The module should load without error and be an object.
    assert.equal(typeof types, "object");
});

test("RegistryEntry object can be constructed", () => {
    /** @type {import("../dist/registry/types.js").RegistryEntry} */
    const entry = {
        schema_version: 2,
        workspace_id: "abc123",
        state: "ready",
        verified_at: Date.now(),
        ttl_ms: 30000,
        local_endpoint: { host: "127.0.0.1", port: 9229 },
    };
    assert.equal(entry.schema_version, 2);
    assert.equal(entry.workspace_id, "abc123");
    assert.equal(entry.state, "ready");
    assert.equal(entry.local_endpoint?.port, 9229);
});

test("RegistryQuotaSnapshot object can be constructed", () => {
    /** @type {import("../dist/registry/types.js").RegistryQuotaSnapshot} */
    const snapshot = {
        timestamp: Date.now(),
        source: "live",
        promptCredits: {
            available: 500,
            monthly: 1000,
            usedPercentage: 50,
            remainingPercentage: 50,
        },
        models: [
            { modelId: "claude-3-5-sonnet", isSelected: true, remainingFraction: 0.8 },
        ],
        activeModelId: "claude-3-5-sonnet",
    };
    assert.equal(snapshot.source, "live");
    assert.equal(snapshot.promptCredits?.available, 500);
    assert.equal(snapshot.models?.[0]?.modelId, "claude-3-5-sonnet");
});
