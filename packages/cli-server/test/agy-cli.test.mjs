import { test } from "node:test";
import assert from "node:assert/strict";

import {
    stripAnsi,
    interpretAgyResult,
    AgyAuthRequiredError,
    AgyTimeoutError,
    buildChangeModePrompt,
    enqueueAgyRun,
    AgySandboxUnsupportedError,
} from "../build/dist/agy-cli.js";

test("stripAnsi removes CSI color/cursor sequences", () => {
    const input = "\x1b[32mPONG\x1b[0m\x1b[2K";
    assert.equal(stripAnsi(input), "PONG");
});

test("stripAnsi removes OSC sequences and carriage returns", () => {
    const input = "\x1b]0;title\x07hello\r";
    assert.equal(stripAnsi(input), "hello");
});

test("interpretAgyResult returns cleaned text on normal output", () => {
    const r = interpretAgyResult("\x1b[36mPONG\x1b[0m\n", false);
    assert.equal(r.text, "PONG");
    assert.equal(r.timedOut, false);
    assert.equal(r.raw, "\x1b[36mPONG\x1b[0m\n");
});

test("interpretAgyResult throws AgyAuthRequiredError on auth prompt", () => {
    assert.throws(
        () => interpretAgyResult("Authentication required. Please visit the URL", false),
        (err) => err instanceof AgyAuthRequiredError
    );
});

test("interpretAgyResult throws AgyTimeoutError on agy print-timeout text", () => {
    assert.throws(
        () => interpretAgyResult("Error: timed out waiting for response", false),
        (err) => err instanceof AgyTimeoutError
    );
});

test("interpretAgyResult keeps partial text when timed out", () => {
    const r = interpretAgyResult("partial answer", true);
    assert.equal(r.timedOut, true);
    assert.equal(r.text, "partial answer");
});

test("interpretAgyResult allows empty text when timed out", () => {
    const r = interpretAgyResult("", true);
    assert.equal(r.timedOut, true);
    assert.equal(r.text, "");
});

test("interpretAgyResult throws on empty output without timeout", () => {
    assert.throws(
        () => interpretAgyResult("", false),
        /produced no reply/
    );
});

test("interpretAgyResult includes stderr tail in empty-output error", () => {
    assert.throws(
        () => interpretAgyResult("", false, "\x1b[31mquota exceeded for model\x1b[0m\n"),
        /produced no reply.*agy stderr tail:\nquota exceeded for model/s
    );
});

test("interpretAgyResult omits stderr section when stderr is empty", () => {
    assert.throws(
        () => interpretAgyResult("", false, "  \n"),
        (err) => /produced no reply/.test(err.message) && !/stderr tail/.test(err.message)
    );
});

test("buildChangeModePrompt wraps prompt with OLD/NEW contract", () => {
    const out = buildChangeModePrompt("rename foo to bar");
    assert.match(out, /CHANGEMODE INSTRUCTIONS/);
    assert.match(out, /OLD:/);
    assert.match(out, /NEW:/);
    assert.match(out, /rename foo to bar/);
});

test("buildChangeModePrompt normalizes file: refs to @path", () => {
    const out = buildChangeModePrompt("edit file:src/app.ts and file:lib/x.ts");
    assert.match(out, /@src\/app\.ts/);
    assert.match(out, /@lib\/x\.ts/);
    assert.doesNotMatch(out, /file:src/);
});

test("enqueueAgyRun refuses sandbox=true with AgySandboxUnsupportedError", async () => {
    await assert.rejects(
        enqueueAgyRun("hi", { sandbox: true }).promise,
        (err) => err instanceof AgySandboxUnsupportedError
    );
});
