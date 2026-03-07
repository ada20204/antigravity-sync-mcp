import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    REGISTRY_CONTROL_KEY,
    CONTROL_NO_CDP_PROMPT_KEY,
    NO_CDP_PROMPT_COOLDOWN_MS,
    NO_CDP_PROMPT_REQUEST_TYPE,
    NO_CDP_PROMPT_SOURCE,
    NO_CDP_PROMPT_STATUS_PENDING,
} from "../dist/control/constants.js";

test("REGISTRY_CONTROL_KEY is __control__", () => {
    assert.equal(REGISTRY_CONTROL_KEY, "__control__");
});

test("CONTROL_NO_CDP_PROMPT_KEY is cdp_prompt_requests", () => {
    assert.equal(CONTROL_NO_CDP_PROMPT_KEY, "cdp_prompt_requests");
});

test("NO_CDP_PROMPT_COOLDOWN_MS is 15000", () => {
    assert.equal(NO_CDP_PROMPT_COOLDOWN_MS, 15_000);
});

test("NO_CDP_PROMPT_REQUEST_TYPE is cdp_not_ready", () => {
    assert.equal(NO_CDP_PROMPT_REQUEST_TYPE, "cdp_not_ready");
});

test("NO_CDP_PROMPT_SOURCE is server", () => {
    assert.equal(NO_CDP_PROMPT_SOURCE, "server");
});

test("NO_CDP_PROMPT_STATUS_PENDING is pending", () => {
    assert.equal(NO_CDP_PROMPT_STATUS_PENDING, "pending");
});
