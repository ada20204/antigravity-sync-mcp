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
import { CDPConnection } from "./cdp.js";
export declare const DEFAULT_BANNED_COMMANDS: string[];
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
export declare function autoAcceptPoll(cdp: CDPConnection, bannedCommands?: string[]): Promise<{
    clicked: number;
    blocked: number;
}>;
//# sourceMappingURL=auto-accept.d.ts.map