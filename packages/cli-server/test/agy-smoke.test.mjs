/**
 * Smoke tests for the agy CLI process-driver layer, using a FAKE agy binary
 * (no real agy, no quota). Covers runtime behavior the pure-logic tests can't:
 * subprocess spawn, process-exit completion, global-mutex serialization, async
 * task lifecycle, and cancellation. AGY_BIN points at a shell stub that prints
 * a reply then self-exits (mimicking agy with stdin closed).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";

// SLOW -> long-running (for cancel); DELAY -> ~1s (for measurable serialization);
// default -> print and exit immediately (mimics agy self-exit on completion).
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
case "$prompt" in
  *SLOW*) sleep 30 ;;
  *DELAY*) sleep 1 ;;
esac
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

test("runAgyPrompt returns cleaned reply (subprocess + self-exit completion)", async () => {
    const r = await cli.runAgyPrompt("hello", { hardTimeoutMs: 20000 });
    assert.match(r.text, /FAKE_REPLY:hello/);
    assert.equal(r.timedOut, false);
});

test("runAgyPrompt serializes concurrent calls via global mutex", async () => {
    const t0 = Date.now();
    await Promise.all([
        cli.runAgyPrompt("aDELAY", { hardTimeoutMs: 20000 }),
        cli.runAgyPrompt("bDELAY", { hardTimeoutMs: 20000 }),
    ]);
    const elapsed = Date.now() - t0;
    // Each DELAY run sleeps ~1s before exiting. Serialized => ~2s; parallel ~1s.
    assert.ok(elapsed > 1800, `expected serialized (>1800ms), got ${elapsed}ms`);
});

test("startTask lifecycle: queued/running -> done with result", async () => {
    tasks.__resetTasksForTest();
    const id = tasks.startTask("xyz", { hardTimeoutMs: 20000 });
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
    const id = tasks.startTask("SLOW", { hardTimeoutMs: 30000 });
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
