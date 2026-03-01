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
import { evaluateInAllContexts } from "./cdp.js";
const COMPOSER_MARKER = "Ask anything, @ to mention, / for workflows";
function isNoiseSegment(segment) {
    const s = segment.trim();
    if (!s)
        return true;
    if (s.includes(COMPOSER_MARKER))
        return true;
    if (/^Good\s*$/i.test(s) || /^Bad\s*$/i.test(s) || /^Good\s+Bad\s*$/i.test(s))
        return true;
    if (/^Thought for\b/i.test(s))
        return true;
    if (/^Fast\b[\s\S]*\bSend$/i.test(s))
        return true;
    if (/^```$/.test(s))
        return true;
    return false;
}
function pickLastAnswerSegment(text) {
    const segments = text
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
        if (!isNoiseSegment(segments[i]))
            return segments[i];
    }
    return text.trim();
}
export function cleanExtractedResponseText(rawText, prompt) {
    let text = (rawText || "").trim();
    if (!text)
        return "";
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
    // Keep only the latest turn when the original prompt is visible in transcript.
    if (prompt) {
        const promptIdx = text.lastIndexOf(prompt);
        if (promptIdx !== -1) {
            text = text.slice(promptIdx + prompt.length).trim();
        }
    }
    return pickLastAnswerSegment(text);
}
const MODEL_UI_LABELS = {
    "gemini-3-flash": ["Gemini 3 Flash", "Gemini Flash", "Flash"],
    "gemini-3-pro-low": ["Gemini 3 Pro (Low)", "Gemini Pro Low", "Pro (Low)"],
    "gemini-3-pro-high": ["Gemini 3 Pro", "Gemini Pro", "Pro (High)", "Pro"],
    "opus-4.5": ["Claude Opus 4.5", "Opus 4.5", "Claude 4.5"],
    "opus-4.6": ["Claude Opus 4.6", "Opus 4.6", "Claude Opus"],
};
function toModeKeyword(mode) {
    const normalized = (mode || "").trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (normalized === "plan" || normalized === "planning" || normalized === "deep") {
        return "plan";
    }
    return "fast";
}
function modelCandidates(model) {
    const normalized = (model || "").trim().toLowerCase();
    if (!normalized)
        return [];
    return MODEL_UI_LABELS[normalized] || [model];
}
export async function applyModeAndModelSelection(cdp, options) {
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
        const actionNodes = [...document.querySelectorAll('button,[role="button"],div[role="button"]')];
        const activeMatch = actionNodes.find((node) => visible(node) && matchesTarget(textFor(node)));
        if (activeMatch) {
          modelApplied = true;
          details.push('model_already_active');
        }

        // Step 1: open model picker if available.
        const triggerCandidates = actionNodes;
        let pickerOpened = false;
        for (const node of triggerCandidates) {
          if (modelApplied) break;
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
        if (details.indexOf('model_already_active') === -1) {
          details.push(modelApplied ? 'model_applied' : 'model_not_found');
        }
      }

      return { modeApplied, modelApplied, details };
    })()`;
    const result = await evaluateInAllContexts(cdp, expression, true);
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
/**
 * Inject a text message into Antigravity's chat input and submit it.
 * Ported from OmniRemote server.js injectMessage() (lines 432-490).
 */
export async function injectMessage(cdp, text) {
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
export async function pollCompletionStatus(cdp) {
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
    }
    catch {
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
export async function extractLatestResponse(cdp, prompt) {
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

    // Find the main chat container
    const container = document.getElementById('conversation')
      || document.getElementById('chat')
      || document.getElementById('cascade');
    if (!container) return { error: 'chat_container_not_found' };

    // Strategy 1: Look for message containers with role attributes
    const messages = container.querySelectorAll('[data-role="assistant"], [data-message-author="assistant"]');
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      const text = last.innerText || last.textContent || '';
      if (!isComposerText(text)) return { text };
    }

    // Strategy 2: Look for all top-level message-like divs, skipping composer-like blocks.
    const allBlocks = container.querySelectorAll(':scope > div > div, :scope > div');
    for (let i = allBlocks.length - 1; i >= 0; i--) {
      const last = allBlocks[i];
      const text = last.innerText || last.textContent || '';
      if (text.length > 20 && !isComposerText(text)) {
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
    if (cleaned)
        return cleaned;
    return "Antigravity completed the task but response text could not be extracted. Check the Antigravity window directly.";
}
// --- stopGeneration ---
/**
 * Click the Cancel/Stop button to halt generation.
 * Ported from OmniRemote server.js stopGeneration() (lines 592-623).
 */
export async function stopGeneration(cdp) {
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
//# sourceMappingURL=scripts.js.map