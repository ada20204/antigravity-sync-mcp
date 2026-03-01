/**
 * Auto-Accept Pipeline
 *
 * Automatically detects and clicks confirmation buttons (Accept, Run Command,
 * Apply, Execute) that Antigravity presents during code generation.
 * Includes safety checks to avoid executing dangerous commands.
 *
 * Ported from:
 * - auto-accept-agent/extension/main_scripts/modules/03_clicking.js
 * - auto-accept-agent/extension/main_scripts/modules/00_selectors.js
 */
import { evaluateInAllContexts } from "./cdp.js";
// Default banned command patterns (from auto-accept-agent extension.js)
export const DEFAULT_BANNED_COMMANDS = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "format c:",
    "del /f /s /q",
    "rmdir /s /q",
    ":(){:|:&};:", // fork bomb
    "dd if=",
    "mkfs.",
    "> /dev/sda",
    "chmod -R 777 /",
];
/**
 * Single CDP evaluate call that:
 * 1. Finds all visible accept-class buttons
 * 2. Safety-checks each against banned commands
 * 3. Clicks safe ones
 *
 * Returns the number of buttons clicked.
 *
 * All logic runs inside the browser context to minimize CDP round-trips.
 */
export async function autoAcceptPoll(cdp, bannedCommands = DEFAULT_BANNED_COMMANDS) {
    const bannedJson = JSON.stringify(bannedCommands);
    const expression = `(() => {
    const ACCEPT_PATTERNS = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
    const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'close', 'refine'];
    const BANNED_COMMANDS = ${bannedJson};

    // --- Selectors (from 00_selectors.js) ---
    const BUTTON_SELECTORS = ['button', '.bg-ide-button-background', '[class*="button"]'];

    let clicked = 0;
    let blocked = 0;

    // Utility: get all documents including iframes
    function getDocuments(root) {
      let docs = [root || document];
      try {
        const iframes = (root || document).querySelectorAll('iframe, frame');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) docs.push(...getDocuments(iframeDoc));
          } catch (e) {}
        }
      } catch (e) {}
      return docs;
    }

    function queryAll(selector) {
      const results = [];
      getDocuments().forEach(doc => {
        try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) {}
      });
      return results;
    }

    // --- Button detection (from 03_clicking.js isAcceptButton) ---
    function isAcceptButton(el) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (text.length === 0 || text.length > 50) return false;

      // Reject patterns take priority
      if (REJECT_PATTERNS.some(r => text.includes(r))) return false;
      // Must match at least one accept pattern
      if (!ACCEPT_PATTERNS.some(p => text.includes(p))) return false;

      // Visibility check
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && rect.width > 0 && style.pointerEvents !== 'none' && !el.disabled;
    }

    // --- Banned command detection (from 03_clicking.js) ---
    function findNearbyCommandText(el) {
      let commandText = '';
      let container = el.parentElement;
      let depth = 0;
      while (container && depth < 10) {
        let sibling = container.previousElementSibling;
        let siblingCount = 0;
        while (sibling && siblingCount < 5) {
          if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
            const text = sibling.textContent.trim();
            if (text.length > 0) commandText += ' ' + text;
          }
          const codeEls = sibling.querySelectorAll('pre, code, pre code');
          for (const codeEl of codeEls) {
            if (codeEl?.textContent) {
              const text = codeEl.textContent.trim();
              if (text.length > 0 && text.length < 5000) commandText += ' ' + text;
            }
          }
          sibling = sibling.previousElementSibling;
          siblingCount++;
        }
        if (commandText.length > 10) break;
        container = container.parentElement;
        depth++;
      }

      if (el.getAttribute('aria-label')) commandText += ' ' + el.getAttribute('aria-label');
      if (el.getAttribute('title')) commandText += ' ' + el.getAttribute('title');
      return commandText.trim().toLowerCase();
    }

    function isCommandBanned(commandText) {
      if (BANNED_COMMANDS.length === 0 || !commandText) return false;
      const lowerText = commandText.toLowerCase();
      for (const banned of BANNED_COMMANDS) {
        const pattern = banned.trim();
        if (!pattern) continue;
        try {
          if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
            const lastSlash = pattern.lastIndexOf('/');
            const regex = new RegExp(pattern.substring(1, lastSlash), pattern.substring(lastSlash + 1) || 'i');
            if (regex.test(commandText)) return true;
          } else {
            if (lowerText.includes(pattern.toLowerCase())) return true;
          }
        } catch (e) {
          if (lowerText.includes(pattern.toLowerCase())) return true;
        }
      }
      return false;
    }

    // --- Main: find and click accept buttons ---
    const found = [];
    BUTTON_SELECTORS.forEach(s => queryAll(s).forEach(el => found.push(el)));
    const unique = [...new Set(found)];

    for (const el of unique) {
      if (isAcceptButton(el)) {
        // Safety check applies to ALL accept-class buttons, not just run/execute.
        const nearbyText = findNearbyCommandText(el);
        if (isCommandBanned(nearbyText)) {
          blocked++;
          continue;
        }

        // Click it
        el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
        clicked++;
      }
    }

    return { clicked, blocked };
  })()`;
    const result = await evaluateInAllContexts(cdp, expression);
    return result || { clicked: 0, blocked: 0 };
}
//# sourceMappingURL=auto-accept.js.map