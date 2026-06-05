import { test } from "node:test";
import assert from "node:assert/strict";

import {
    RollingBuffer,
    pollTask,
    cancelTask,
    listTasks,
    __resetTasksForTest,
} from "../build/dist/agy-tasks.js";

test("RollingBuffer keeps only the most recent bytes", () => {
    const buf = new RollingBuffer(10);
    buf.append("aaaaa");
    buf.append("bbbbb");
    buf.append("ccccc"); // total 15 > 10, oldest dropped
    const tail = buf.tail();
    assert.ok(tail.length <= 10, `tail too long: ${tail.length}`);
    assert.ok(tail.endsWith("ccccc"), `tail should keep newest: ${tail}`);
    assert.ok(!tail.includes("aaaaa"), "oldest chunk should be evicted");
});

test("RollingBuffer keeps last chunk even if larger than cap", () => {
    const buf = new RollingBuffer(4);
    buf.append("0123456789");
    assert.equal(buf.tail(), "0123456789"); // never drops the only chunk
});

test("pollTask returns null for unknown runId", () => {
    __resetTasksForTest();
    assert.equal(pollTask("nope"), null);
});

test("cancelTask reports not-found for unknown runId", () => {
    __resetTasksForTest();
    assert.equal(cancelTask("nope"), "not-found");
});

test("listTasks is empty after reset", () => {
    __resetTasksForTest();
    assert.deepEqual(listTasks(), []);
});
