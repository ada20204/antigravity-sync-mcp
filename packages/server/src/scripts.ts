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

import { CDPConnection, evaluateInAllContexts, evaluateInDefaultContext } from "./cdp.js";

const COMPOSER_MARKER = "Ask anything, @ to mention, / for workflows";

function isNoiseSegment(segment: string): boolean {
    const s = segment.trim();
    if (!s) return true;
    if (s.includes(COMPOSER_MARKER)) return true;
    if (/^Good\s*$/i.test(s) || /^Bad\s*$/i.test(s) || /^Good\s+Bad\s*$/i.test(s)) return true;
    if (/^Thought for\b/i.test(s)) return true;
    if (/^Worked for\b/i.test(s)) return true;
    if (/^Fast\b[\s\S]*\bSend$/i.test(s)) return true;
    if (/^```$/.test(s)) return true;
    // Filter out UI button text
    if (/^Copy\s*$/i.test(s)) return true;
    if (/^Retry\s*$/i.test(s)) return true;
    if (/^Edit\s*$/i.test(s)) return true;
    return false;
}

function pickLastAnswerSegment(text: string): string {
    const segments = text
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);

    for (let i = segments.length - 1; i >= 0; i--) {
        if (!isNoiseSegment(segments[i])) return segments[i];
    }
    return text.trim();
}

export function cleanExtractedResponseText(rawText: string, prompt?: string): string {
    let text = (rawText || "").trim();
    if (!text) return "";

    // Drop trailing composer panel text if present.
    const composerIdx = text.lastIndexOf(COMPOSER_MARKER);
    if (composerIdx !== -1) {
        text = text.slice(0, composerIdx).trim();
    }

    // Remove trailing feedback controls if captured with the response.
    text = text
        .replace(/\n+\s*Good\s*\n+\s*Bad\s*$/i, "")
        .replace(/\n+\s*Good\s+Bad\s*$/i, "")
        .trim();

    // Drop the "Worked for Ns" collapsible header when the whole article was captured.
    text = text.replace(/^Worked for\s+\S+\s*/i, "").trim();

    // Keep only the latest turn when the original prompt is visible in transcript.
    if (prompt) {
        const promptIdx = text.lastIndexOf(prompt);
        if (promptIdx !== -1) {
            text = text.slice(promptIdx + prompt.length).trim();
        }
    }

    return pickLastAnswerSegment(text);
}

const MODEL_UI_LABELS: Record<string, string[]> = {
    "gemini-3-flash": ["Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)", "Gemini 3 Flash", "Gemini Flash", "Flash"],
    "gemini-3.5-flash": ["Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)"],
    "gemini-3.5-flash-low": ["Gemini 3.5 Flash (Low)"],
    "gemini-3.5-flash-medium": ["Gemini 3.5 Flash (Medium)"],
    "gemini-3.5-flash-high": ["Gemini 3.5 Flash (High)"],
    "gemini-3-pro-low": ["Gemini 3.1 Pro (Low)", "Gemini 3 Pro (Low)", "Pro (Low)"],
    "gemini-3-pro-high": ["Gemini 3.1 Pro (High)", "Gemini 3.1 Pro", "Gemini 3 Pro", "Pro (High)"],
    "opus-4.5": ["Claude Opus 4.5", "Opus 4.5"],
    "opus-4.6": ["Claude Opus 4.6 (Thinking)", "Claude Opus 4.6", "Opus 4.6"],
    "sonnet-4.6": ["Claude Sonnet 4.6 (Thinking)", "Claude Sonnet 4.6", "Sonnet 4.6"],
    "gpt-oss-120b": ["GPT-OSS 120B (Medium)", "GPT-OSS 120B", "GPT OSS 120B"],
};

function toModeKeyword(mode?: string): string | undefined {
    const normalized = (mode || "").trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === "plan" || normalized === "planning" || normalized === "deep") {
        return "plan";
    }
    return "fast";
}

function modelCandidates(model?: string): string[] {
    const normalized = (model || "").trim().toLowerCase();
    if (!normalized) return [];
    return MODEL_UI_LABELS[normalized] || [model as string];
}

export async function applyModeAndModelSelection(
    cdp: CDPConnection,
    options: { mode?: string; model?: string }
): Promise<{ modeApplied: boolean; modelApplied: boolean; details: string[] }> {
    const mode = toModeKeyword(options.mode);
    const modelLabels = modelCandidates(options.model);
    if (!mode && modelLabels.length === 0) {
        return { modeApplied: false, modelApplied: false, details: [] };
    }

    const safeMode = JSON.stringify(mode || "");
    const safeModelLabels = JSON.stringify(modelLabels);

    const expression = `(async () => {
      const visible = (el) => !!el && el.offsetParent !== null;
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const textFor = (node) => normalize(node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || node?.getAttribute?.('data-value') || '');
      const details = [];
      let modeApplied = false;
      let modelApplied = false;

      const clickByText = (texts) => {
        const tokens = texts.map((t) => normalize(t)).filter(Boolean);
        if (!tokens.length) return false;
        const nodes = [...document.querySelectorAll('button,[role="button"],div[role="button"]')];
        for (const node of nodes) {
          if (!visible(node)) continue;
          const text = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || '');
          if (!text) continue;
          if (tokens.some((token) => text === token || text.includes(token))) {
            node.click();
            return true;
          }
        }
        return false;
      };

      const mode = ${safeMode};
      if (mode) {
        const modeTokens = mode === 'plan' ? ['plan', 'planning'] : ['fast'];
        modeApplied = clickByText(modeTokens);
        details.push(modeApplied ? 'mode_applied' : 'mode_not_found');
      }

      const targetLabels = ${safeModelLabels};
      if (targetLabels.length) {
        const targets = targetLabels.map((t) => normalize(t)).filter(Boolean);
        const matchesTarget = (text) => targets.some((t) => text === t || text.includes(t));

        // IDE ≥1.107: the picker trigger carries aria-label
        // "Select model, current: <name>" — read the active model from it.
        const trigger = [...document.querySelectorAll('button[aria-label^="Select model"]')].find(visible);
        if (trigger) {
          const current = normalize((trigger.getAttribute('aria-label') || '').split('current:')[1] || '');
          if (current && matchesTarget(current)) {
            modelApplied = true;
            details.push('model_already_active');
          }
        } else {
          const actionNodes = [...document.querySelectorAll('button,[role="button"],div[role="button"]')];
          const activeMatch = actionNodes.find((node) => visible(node) && matchesTarget(textFor(node)));
          if (activeMatch) {
            modelApplied = true;
            details.push('model_already_active');
          }
        }

        // Step 1: open model picker if available.
        let pickerOpened = false;
        if (!modelApplied) {
          if (trigger) {
            trigger.click();
            pickerOpened = true;
          } else {
            for (const node of [...document.querySelectorAll('button,[role="button"],div[role="button"]')]) {
              if (!visible(node)) continue;
              const text = textFor(node);
              const looksModelTrigger =
                text.includes('model') || text.includes('gemini') || text.includes('claude') || text.includes('gpt');
              const hasPopup = (node.getAttribute('aria-haspopup') || '').toLowerCase();
              if (looksModelTrigger || hasPopup === 'listbox' || hasPopup === 'menu') {
                node.click();
                pickerOpened = true;
                break;
              }
            }
          }
        }
        if (pickerOpened) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }

        if (!modelApplied) {
          const options = [
            ...document.querySelectorAll('[role="option"]'),
            ...document.querySelectorAll('[role="menuitem"]'),
            ...document.querySelectorAll('[data-value]'),
            ...document.querySelectorAll('button,li,div[role="button"]')
          ];
          for (const option of options) {
            if (!visible(option)) continue;
            const text = textFor(option);
            if (!text) continue;
            if (matchesTarget(text)) {
              option.click();
              modelApplied = true;
              break;
            }
          }
        }

        // Never leave the picker hanging open: an unmatched label used to leave
        // the dropdown covering the composer for the rest of the session.
        if (pickerOpened && !modelApplied) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          document.body.click();
          details.push('picker_closed_without_match');
        }

        if (details.indexOf('model_already_active') === -1) {
          details.push(modelApplied ? 'model_applied' : 'model_not_found');
        }
      }

      return { modeApplied, modelApplied, details };
    })()`;

    // DOM-mutating (clicks): must run in exactly one execution context.
    const result = await evaluateInDefaultContext(cdp, expression, true);
    if (!result || typeof result !== "object") {
        return { modeApplied: false, modelApplied: false, details: ["selection_no_context"] };
    }
    return {
        modeApplied: !!result.modeApplied,
        modelApplied: !!result.modelApplied,
        details: Array.isArray(result.details) ? result.details : [],
    };
}

// --- injectMessage ---

// Shared with the verify/submit steps below. IDE ≥1.107: a single Lexical
// contenteditable (aria-label="Message input"); older layouts kept as fallbacks.
const EDITOR_SELECTOR =
    '#conversation [contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"][aria-label="Message input"], #chat [contenteditable="true"], #cascade [contenteditable="true"]';

/**
 * Inject a text message into Antigravity's chat input and submit it.
 *
 * Three phases, with all waiting done on the Node side: when the IDE window is
 * occluded, the renderer throttles in-page timers to ~1s ticks and never fires
 * requestAnimationFrame, so any in-page await either lies or blows the CDP call
 * timeout. Node-side polling with quick synchronous evaluates is immune.
 *   1. insert  — focus editor, selectAll + insertText (replaces selection)
 *   2. verify  — poll editor text until it equals the prompt (Lexical renders
 *                its DOM asynchronously, late under an occluded window)
 *   3. submit  — click the send button only after the content is proven right
 *                (a wrong send burns quota and cannot be recalled)
 */
export async function injectMessage(
    cdp: CDPConnection,
    text: string,
    options: { maxWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<{ ok: boolean; method?: string; reason?: string; error?: string; waitedMs?: number }> {
    const maxWaitMs = options.maxWaitMs || 120000;
    const pollIntervalMs = options.pollIntervalMs || 500;
    const startTime = Date.now();
    const safeText = JSON.stringify(text);
    const safeEditorSelector = JSON.stringify(EDITOR_SELECTOR);

    // Best effort: an unoccluded window is not throttled, which makes Lexical
    // render promptly and keeps completion polling / extraction fresh too.
    try {
        await cdp.call("Page.bringToFront");
    } catch {
        // Not fatal; verification below still guards correctness.
    }

    // Phase 1: insert (synchronous side effects only, no in-page waits).
    const insertExpression = `(() => {
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) return { ok: false, reason: "busy" };

    const editors = [...document.querySelectorAll(${safeEditorSelector})].filter(el => el.offsetParent !== null);
    const editor = editors.at(-1);
    if (!editor) return { ok: false, error: "editor_not_found" };

    const textToInsert = ${safeText};
    editor.focus();
    // selectAll + insertText REPLACES the selection. Do not use
    // execCommand("delete") to clear: the Lexical editor ignores it, and a
    // clear-then-insert sequence silently accumulates text instead.
    document.execCommand?.("selectAll", false, null);
    let inserted = false;
    try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
    if (!inserted) {
      editor.textContent = textToInsert;
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: textToInsert }));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: textToInsert }));
    }
    return { ok: true };
  })()`;

    const readEditorExpression = `(() => {
    const editors = [...document.querySelectorAll(${safeEditorSelector})].filter(el => el.offsetParent !== null);
    const editor = editors.at(-1);
    return editor ? (editor.textContent || '') : null;
  })()`;

    const submitExpression = `(() => {
    // IDE ≥1.107 exposes data-testid; the lucide icon class is gone there but
    // kept for older layouts.
    const submit = document.querySelector('[data-testid="send-button"]')
      || document.querySelector('[data-tooltip-id="input-send-button-send-tooltip"]')
      || document.querySelector("svg.lucide-arrow-right")?.closest("button");
    if (submit && !submit.disabled) {
      submit.click();
      return { ok: true, method: "click_submit" };
    }
    const editors = [...document.querySelectorAll(${safeEditorSelector})].filter(el => el.offsetParent !== null);
    const editor = editors.at(-1);
    if (!editor) return { ok: false, error: "editor_not_found" };
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
    return { ok: true, method: "enter_keypress" };
  })()`;

    const normalized = (s: string) => (s || "").replace(/\s+/g, " ").trim();
    const expected = normalized(text);
    const VERIFY_WINDOW_MS = 8000;
    const VERIFY_POLL_MS = 250;
    const MAX_INSERT_ATTEMPTS = 2;

    // All expressions mutate or read the shared DOM: run them in exactly one
    // execution context (see evaluateInDefaultContext).
    while (true) {
        const inserted = await evaluateInDefaultContext(cdp, insertExpression);
        const waitedMs = Date.now() - startTime;
        if (!inserted) return { ok: false, reason: "no_context", waitedMs };

        if (inserted.ok) break;
        // Editor busy or not found — keep polling if time allows
        if (waitedMs >= maxWaitMs) {
            return { ok: false, reason: inserted.reason || inserted.error || "timeout", waitedMs };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Phase 2: verify from the Node side.
    let verified = false;
    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS && !verified; attempt++) {
        if (attempt > 1) {
            const again = await evaluateInDefaultContext(cdp, insertExpression);
            if (!again?.ok) break;
        }
        const deadline = Date.now() + VERIFY_WINDOW_MS;
        while (Date.now() < deadline) {
            const content = await evaluateInDefaultContext(cdp, readEditorExpression);
            if (typeof content === "string" && normalized(content) === expected) {
                verified = true;
                break;
            }
            await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
        }
    }
    if (!verified) {
        return { ok: false, reason: "insert_verify_failed", waitedMs: Date.now() - startTime };
    }

    // Phase 3: submit.
    const submitted = await evaluateInDefaultContext(cdp, submitExpression);
    const waitedMs = Date.now() - startTime;
    if (!submitted) return { ok: false, reason: "no_context", waitedMs };
    if (!submitted.ok) {
        return { ok: false, reason: submitted.reason || submitted.error || "submit_failed", waitedMs };
    }
    return { ...submitted, waitedMs };
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

    try {
        const result = await evaluateInAllContexts(cdp, expression);
        return result || { isGenerating: false };
    } catch {
        // CDP error: conservatively assume generation is still in progress
        // rather than signalling completion prematurely.
        return { isGenerating: true };
    }
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
    cdp: CDPConnection,
    prompt?: string
): Promise<string> {
    const expression = `(() => {
    const COMPOSER_MARKER = "Ask anything, @ to mention, / for workflows";
    const isComposerText = (text) => {
      if (!text) return true;
      const trimmed = text.trim();
      if (!trimmed) return true;
      if (trimmed.includes(COMPOSER_MARKER)) return true;
      if (/^Fast\\s+[\\s\\S]*\\s+Send$/.test(trimmed)) return true;
      return false;
    };
    // Filter out generation-in-progress placeholder text from Antigravity UI
    const isGeneratingPlaceholder = (text) => {
      if (!text) return false;
      const trimmed = text.trim().toLowerCase();
      if (/^generating\.{0,3}$/.test(trimmed)) return true;
      if (/^thinking\.{0,3}$/.test(trimmed)) return true;
      if (/^loading\.{0,3}$/.test(trimmed)) return true;
      if (/^writing\.{0,3}$/.test(trimmed)) return true;
      if (/^searching\.{0,3}$/.test(trimmed)) return true;
      if (/^analyzing\.{0,3}$/.test(trimmed)) return true;
      if (/^processing\.{0,3}$/.test(trimmed)) return true;
      return false;
    };

    // Find the main chat container
    const container = document.getElementById('conversation')
      || document.getElementById('chat')
      || document.getElementById('cascade');
    if (!container) return { error: 'chat_container_not_found' };

    // Strategy 0 (IDE ≥1.107): messages are role="article" with an aria-label
    // distinguishing "Agent response" from "User message". The composer (with
    // the model-selector label) also lives inside #conversation, so the old
    // "last text block in container" heuristic grabs the model name — never
    // fall through to it when articles exist.
    const articles = container.querySelectorAll('[role="article"][aria-label="Agent response"]');
    if (articles.length > 0) {
      const last = articles[articles.length - 1];
      // Content blocks skip the "Worked for Ns" collapsible header.
      const blocks = last.querySelectorAll('div.px-2.py-1');
      const text = blocks.length
        ? [...blocks].map((b) => b.innerText || '').join('\\n\\n').trim()
        : (last.innerText || last.textContent || '').trim();
      if (text && !isGeneratingPlaceholder(text)) return { text };
      return { error: 'agent_article_empty' };
    }

    // Strategy 1 (older layouts): message containers with role attributes
    const messages = container.querySelectorAll('[data-role="assistant"], [data-message-author="assistant"]');
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      const text = last.innerText || last.textContent || '';
      if (!isComposerText(text) && !isGeneratingPlaceholder(text)) return { text };
    }

    // Strategy 2: Look for all top-level message-like divs, skipping composer-like blocks.
    const allBlocks = container.querySelectorAll(':scope > div > div, :scope > div');
    for (let i = allBlocks.length - 1; i >= 0; i--) {
      const last = allBlocks[i];
      const text = last.innerText || last.textContent || '';
      if (text.length > 20 && !isComposerText(text) && !isGeneratingPlaceholder(text)) {
        return { text };
      }
    }

    // Strategy 3: Grab everything (for post-processing on Node side).
    const fullText = container.innerText || '';
    if (fullText.length > 0) {
      return { text: fullText.slice(-12000), partial: true };
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

    const cleaned = cleanExtractedResponseText(result.text || "", prompt);
    if (cleaned) return cleaned;

    return "Antigravity completed the task but response text could not be extracted. Check the Antigravity window directly.";
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

    // DOM-mutating (clicks): must run in exactly one execution context.
    const result = await evaluateInDefaultContext(cdp, expression, true);
    return result || { success: false, error: "no_context" };
}
