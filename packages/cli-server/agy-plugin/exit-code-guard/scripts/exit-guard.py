#!/usr/bin/env python3
"""PreToolUse gate for agy's run_command tool.

agy's print (-p) mode silently aborts the entire run when a shell command
exits non-zero (agy exits 0, stdout goes empty, remaining steps are dropped).
Deny any command that does not end in `|| true`, with a rewrite hint in the
reason; the model resubmits the wrapped command and the run survives expected
failures (test-red phases, linters, probes).
"""
import json
import re
import sys

data = json.load(sys.stdin)
cmd = (data.get("toolCall", {}).get("args", {}) or {}).get("CommandLine", "")
if re.search(r"\|\|\s*true\s*$", cmd):
    print(json.dumps({"decision": "allow"}))
else:
    print(json.dumps({
        "decision": "deny",
        "reason": (
            "BLOCKED by exit-code-guard: this runtime silently aborts the whole run "
            "if a shell command exits non-zero. Re-run the SAME command wrapped as: "
            "( " + cmd + " ) || true — and judge success/failure from the printed "
            "output, never from the exit code."
        ),
    }))
