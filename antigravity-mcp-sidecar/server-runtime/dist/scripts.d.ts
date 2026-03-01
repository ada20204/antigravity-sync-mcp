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
import { CDPConnection } from "./cdp.js";
export declare function cleanExtractedResponseText(rawText: string, prompt?: string): string;
export declare function applyModeAndModelSelection(cdp: CDPConnection, options: {
    mode?: string;
    model?: string;
}): Promise<{
    modeApplied: boolean;
    modelApplied: boolean;
    details: string[];
}>;
/**
 * Inject a text message into Antigravity's chat input and submit it.
 * Ported from OmniRemote server.js injectMessage() (lines 432-490).
 */
export declare function injectMessage(cdp: CDPConnection, text: string): Promise<{
    ok: boolean;
    method?: string;
    reason?: string;
    error?: string;
}>;
/**
 * Check if Antigravity is currently generating a response.
 * Looks for the Cancel/Stop button tooltip.
 */
export declare function pollCompletionStatus(cdp: CDPConnection): Promise<{
    isGenerating: boolean;
}>;
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
export declare function extractLatestResponse(cdp: CDPConnection, prompt?: string): Promise<string>;
/**
 * Click the Cancel/Stop button to halt generation.
 * Ported from OmniRemote server.js stopGeneration() (lines 592-623).
 */
export declare function stopGeneration(cdp: CDPConnection): Promise<{
    success: boolean;
    error?: string;
    method?: string;
}>;
//# sourceMappingURL=scripts.d.ts.map