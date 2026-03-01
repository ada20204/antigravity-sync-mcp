import test from 'node:test';
import assert from 'node:assert/strict';

// Mirror the safety logic from auto-accept.ts to test behavioral contract.
const ACCEPT_PATTERNS = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'close', 'refine'];
const BANNED = ['rm -rf /', 'rm -rf ~', 'format c:'];

function isCommandBanned(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return BANNED.some(b => lower.includes(b.toLowerCase()));
}

// Simulate FIXED behavior: check ALL accept buttons
function wouldClick(buttonText, nearbyCmd) {
    const text = buttonText.toLowerCase();
    if (REJECT_PATTERNS.some(r => text.includes(r))) return { click: false, blocked: false };
    if (!ACCEPT_PATTERNS.some(p => text.includes(p))) return { click: false, blocked: false };
    if (isCommandBanned(nearbyCmd)) return { click: false, blocked: true };
    return { click: true, blocked: false };
}

test('blocks accept button near rm -rf /', () => {
    assert.deepEqual(wouldClick('Accept', 'rm -rf /'), { click: false, blocked: true });
});

test('blocks apply button near rm -rf /', () => {
    assert.deepEqual(wouldClick('Apply Changes', 'rm -rf /'), { click: false, blocked: true });
});

test('blocks confirm button near rm -rf /', () => {
    assert.deepEqual(wouldClick('Confirm', 'rm -rf /'), { click: false, blocked: true });
});

test('blocks run button near rm -rf /', () => {
    assert.deepEqual(wouldClick('Run', 'rm -rf /'), { click: false, blocked: true });
});

test('clicks accept button with safe command', () => {
    assert.deepEqual(wouldClick('Accept', 'npm install'), { click: true, blocked: false });
});

test('does not click cancel button regardless', () => {
    const r = wouldClick('Cancel', 'npm install');
    assert.equal(r.click, false);
});

test('clicks accept button with no nearby command', () => {
    assert.deepEqual(wouldClick('Accept', ''), { click: true, blocked: false });
});
