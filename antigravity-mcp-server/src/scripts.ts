/**
 * DOM Interaction Scripts for Antigravity
 *
 * These functions inject JavaScript into Antigravity's workbench page
 * via CDP Runtime.evaluate to control the chat interface.
 *
 * Ported from:
 * - OmniAntigravityRemoteChat/src/server.js (injectMessage, stopGeneration)
 * - auto-accept-agent selectors
 */

import { CDPConnection, evaluateInAllContexts } from "./cdp.js";

// --- injectMessage ---

/**
 * Inject a text message into Antigravity's chat input and submit it.
 * Ported from OmniRemote server.js injectMessage() (lines 432-490).
 */
export async function injectMessage(
    cdp: CDPConnection,
    text: string
): Promise<{ ok: boolean; method?: string; reason?: string; error?: string }> {
    const safeText = JSON.stringify(text);

    const expression = `(async () => {
    // Check if AI is already generating
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) return { ok: false, reason: "busy" };

    // Find the visible contenteditable editor
    const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
      .filter(el => el.offsetParent !== null);
    const editor = editors.at(-1);
    if (!editor) return { ok: false, error: "editor_not_found" };

    const textToInsert = ${safeText};

    editor.focus();
    document.execCommand?.("selectAll", false, null);
    document.execCommand?.("delete", false, null);

    let inserted = false;
    try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
    if (!inserted) {
      editor.textContent = textToInsert;
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: textToInsert }));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: textToInsert }));
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Try clicking the submit button
    const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
    if (submit && !submit.disabled) {
      submit.click();
      return { ok: true, method: "click_submit" };
    }

    // Fallback: simulate Enter key
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));

    return { ok: true, method: "enter_keypress" };
  })()`;

    const result = await evaluateInAllContexts(cdp, expression, true);
    return result || { ok: false, reason: "no_context" };
}

// --- pollCompletionStatus ---

/**
 * Check if Antigravity is currently generating a response.
 * Looks for the Cancel/Stop button tooltip.
 */
export async function pollCompletionStatus(
    cdp: CDPConnection
): Promise<{ isGenerating: boolean }> {
    const expression = `(() => {
    // Check for cancel button (visible = generation active)
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) {
      return { isGenerating: true };
    }

    // Fallback: check for a square stop icon in the send button area
    const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
    if (stopBtn && stopBtn.offsetParent !== null) {
      return { isGenerating: true };
    }

    return { isGenerating: false };
  })()`;

    const result = await evaluateInAllContexts(cdp, expression);
    return result || { isGenerating: false };
}

// --- extractLatestResponse ---

/**
 * ⚠️ REVERSE ENGINEERING REQUIRED
 *
 * Extract the text content of the last AI assistant response.
 * This implementation is a best-effort heuristic since no reference
 * project has implemented Antigravity chat text extraction.
 *
 * Strategy: Look for the last message container in the chat area
 * that appears to be from the assistant (not user-authored).
 */
export async function extractLatestResponse(
    cdp: CDPConnection
): Promise<string> {
    const expression = `(() => {
    // Find the main chat container
    const container = document.getElementById('conversation')
      || document.getElementById('chat')
      || document.getElementById('cascade');
    if (!container) return { error: 'chat_container_not_found' };

    // Strategy 1: Look for message containers with role attributes
    const messages = container.querySelectorAll('[data-role="assistant"], [data-message-author="assistant"]');
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      return { text: last.innerText || last.textContent || '' };
    }

    // Strategy 2: Look for all top-level message-like divs, take the last one
    // Antigravity typically alternates user/assistant messages
    const allBlocks = container.querySelectorAll(':scope > div > div, :scope > div');
    if (allBlocks.length > 0) {
      const last = allBlocks[allBlocks.length - 1];
      const text = last.innerText || last.textContent || '';
      // Only return if it has substantial content (not just a toolbar)
      if (text.length > 20) {
        return { text };
      }
    }

    // Strategy 3: Grab everything and return the tail portion
    const fullText = container.innerText || '';
    if (fullText.length > 0) {
      // Return last 5000 chars as a fallback
      return { text: fullText.slice(-5000), partial: true };
    }

    return { error: 'no_response_found' };
  })()`;

    const result = await evaluateInAllContexts(cdp, expression);

    if (!result) {
        return "Antigravity completed the task but response text could not be extracted. Check the Antigravity window directly.";
    }

    if (result.error) {
        return `Antigravity completed the task but response extraction failed (${result.error}). Check the Antigravity window directly.`;
    }

    return result.text || "";
}

// --- stopGeneration ---

/**
 * Click the Cancel/Stop button to halt generation.
 * Ported from OmniRemote server.js stopGeneration() (lines 592-623).
 */
export async function stopGeneration(
    cdp: CDPConnection
): Promise<{ success: boolean; error?: string; method?: string }> {
    const expression = `(async () => {
    // Look for the cancel button
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) {
      cancel.click();
      return { success: true, method: 'cancel_tooltip' };
    }

    // Fallback: Look for a square icon in the send button area
    const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
    if (stopBtn && stopBtn.offsetParent !== null) {
      stopBtn.click();
      return { success: true, method: 'fallback_square' };
    }

    return { success: false, error: 'No active generation found to stop' };
  })()`;

    const result = await evaluateInAllContexts(cdp, expression, true);
    return result || { success: false, error: "no_context" };
}
