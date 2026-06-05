/**
 * Smoke tests for the agy CLI process-driver layer, using a FAKE agy binary
 * (no real agy, no quota). Covers the runtime behavior the pure-logic unit
 * tests can't: PTY spawn, idle completion, global-mutex serialization, async
 * task lifecycle, and cancellation. AGY_BIN points at a shell stub that prints
 * a reply then sleeps (mimicking agy not self-exiting under a PTY).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";

const FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.0.5"; exit 0; fi
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'FAKE_REPLY:%s\\n' "$prompt"
sleep 30
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmpDir;
let cli;
let tasks;

before(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-smoke-"));
    const fakeBin = path.join(tmpDir, "fake-agy");
    writeFileSync(fakeBin, FAKE_SCRIPT, "utf8");
    chmodSync(fakeBin, 0o755);
    process.env.AGY_BIN = fakeBin;
    cli = await import("../build/dist/agy-cli.js");
    tasks = await import("../build/dist/agy-tasks.js");
});

after(() => {
    delete process.env.AGY_BIN;
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
});

test("runAgyPrompt returns cleaned reply from fake agy (PTY + idle completion)", async () => {
    const r = await cli.runAgyPrompt("hello", { idleMs: 400, hardTimeoutMs: 20000 });
    assert.match(r.text, /FAKE_REPLY:hello/);
    assert.equal(r.timedOut, false);
});

test("runAgyPrompt serializes concurrent calls via global mutex", async () => {
    const t0 = Date.now();
    await Promise.all([
        cli.runAgyPrompt("a", { idleMs: 400, hardTimeoutMs: 20000 }),
        cli.runAgyPrompt("b", { idleMs: 400, hardTimeoutMs: 20000 }),
    ]);
    const elapsed = Date.now() - t0;
    // Each run is ~(spawn + 400ms idle). Serialized => ~2x; parallel would be ~1x.
    assert.ok(elapsed > 800, `expected serialized (>800ms), got ${elapsed}ms`);
});

test("startTask lifecycle: queued/running -> done with result", async () => {
    tasks.__resetTasksForTest();
    const id = tasks.startTask("xyz", { idleMs: 400, hardTimeoutMs: 20000 });
    let p;
    for (let i = 0; i < 60; i++) {
        await sleep(200);
        p = tasks.pollTask(id);
        if (p && (p.status === "done" || p.status === "failed")) break;
    }
    assert.equal(p.status, "done");
    assert.match(p.result.text, /FAKE_REPLY:xyz/);
});

test("cancelTask cancels a running task and reports cancelled", async () => {
    tasks.__resetTasksForTest();
    // Large idle so the task stays running (fake outputs immediately, then sleeps).
    const id = tasks.startTask("slow", { idleMs: 8000, hardTimeoutMs: 30000 });
    let running = false;
    for (let i = 0; i < 20; i++) {
        await sleep(150);
        const p = tasks.pollTask(id);
        if (p && p.status === "running") {
            running = true;
            break;
        }
    }
    assert.ok(running, "task should reach running state");
    assert.equal(tasks.cancelTask(id), "cancelling");
    let p;
    for (let i = 0; i < 30; i++) {
        await sleep(150);
        p = tasks.pollTask(id);
        if (p && p.status === "cancelled") break;
    }
    assert.equal(p.status, "cancelled");
});
