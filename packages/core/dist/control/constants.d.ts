/**
 * Control plane constants for the Antigravity registry.
 *
 * The registry JSON contains a special "__control__" key used by the sidecar
 * and MCP server to coordinate out-of-band requests (e.g. prompting the user
 * to open Antigravity when CDP is not available).
 */
/** Key used for the control plane object inside the registry JSON. */
export declare const REGISTRY_CONTROL_KEY = "__control__";
/** Key inside the control object that holds no-CDP prompt requests. */
export declare const CONTROL_NO_CDP_PROMPT_KEY = "cdp_prompt_requests";
/** Minimum milliseconds between repeated no-CDP prompt requests for the same workspace. */
export declare const NO_CDP_PROMPT_COOLDOWN_MS = 15000;
/** Type literal for a no-CDP-ready prompt request. */
export declare const NO_CDP_PROMPT_REQUEST_TYPE = "cdp_not_ready";
/** Source label written by the MCP server into prompt requests. */
export declare const NO_CDP_PROMPT_SOURCE = "server";
/** Status written when a prompt request is first created. */
export declare const NO_CDP_PROMPT_STATUS_PENDING = "pending";
//# sourceMappingURL=constants.d.ts.map