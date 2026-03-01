const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
// Mode-first deterministic chains. The first item is preferred.
const MODE_CHAINS = {
    fast: [
        "gemini-3-flash",
        "gemini-3-pro-low",
        "gemini-3-pro-high",
        "opus-4.5",
        "opus-4.6",
    ],
    plan: [
        "opus-4.6",
        "opus-4.5",
        "gemini-3-pro-high",
        "gemini-3-pro-low",
        "gemini-3-flash",
    ],
};
const MODEL_ALIASES = {
    "gemini-3-flash": ["gemini-3-flash", "gemini flash", "flash"],
    "gemini-3-pro-low": ["gemini-3-pro-low", "gemini pro low", "pro low"],
    "gemini-3-pro-high": ["gemini-3-pro-high", "gemini-3-pro", "gemini pro", "pro high"],
    "opus-4.5": ["opus-4.5", "claude opus 4.5", "opus 4.5"],
    "opus-4.6": ["opus-4.6", "claude opus 4.6", "opus 4.6"],
};
function normalizeMode(input) {
    const value = (input || "").trim().toLowerCase();
    if (value === "plan" || value === "planning" || value === "deep")
        return "plan";
    return "fast";
}
export function buildCandidateChain(mode, requestedModel) {
    const chain = [...MODE_CHAINS[mode]];
    const normalizedRequested = normalizeModelName(requestedModel);
    if (!normalizedRequested)
        return chain;
    const withoutRequested = chain.filter((m) => m !== normalizedRequested);
    return [normalizedRequested, ...withoutRequested];
}
function normalizeModelName(model) {
    if (!model)
        return undefined;
    const v = model.trim().toLowerCase();
    for (const [canonical, aliases] of Object.entries(MODEL_ALIASES)) {
        if (aliases.some((alias) => v === alias || v.includes(alias))) {
            return canonical;
        }
    }
    return v || undefined;
}
function isQuotaStale(snapshot, nowMs, staleAfterMs) {
    if (!snapshot?.timestamp || !Number.isFinite(snapshot.timestamp))
        return true;
    return nowMs - snapshot.timestamp > staleAfterMs;
}
function getRemainingFraction(snapshot, model) {
    const models = snapshot?.models || [];
    const aliases = MODEL_ALIASES[model] || [model];
    for (const item of models) {
        const modelId = (item.modelId || "").toLowerCase();
        const label = (item.label || "").toLowerCase();
        const match = aliases.some((alias) => modelId.includes(alias) || label.includes(alias));
        if (!match)
            continue;
        if (typeof item.remainingFraction === "number")
            return item.remainingFraction;
    }
    return undefined;
}
function canUseModel(snapshot, model) {
    const remaining = getRemainingFraction(snapshot, model);
    if (remaining === undefined) {
        return { ok: true };
    }
    if (remaining <= 0) {
        return { ok: false, reason: "quota_exhausted" };
    }
    return { ok: true };
}
export function selectModelWithQuotaPolicy(input) {
    const nowMs = input.nowMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const mode = normalizeMode(input.mode);
    const chain = buildCandidateChain(mode, input.requestedModel);
    const staleQuota = isQuotaStale(input.quota, nowMs, staleAfterMs);
    const skipped = [];
    for (const candidate of chain) {
        if (staleQuota) {
            return {
                selectedModel: candidate,
                mode,
                chain,
                skipped,
                staleQuota,
            };
        }
        const gate = canUseModel(input.quota, candidate);
        if (gate.ok) {
            return {
                selectedModel: candidate,
                mode,
                chain,
                skipped,
                staleQuota,
            };
        }
        skipped.push({ model: candidate, reason: gate.reason || "filtered" });
    }
    // Fallback-safe: if everything is filtered, still return first candidate
    // and let runtime fail with explicit diagnostics from the ask path.
    return {
        selectedModel: chain[0],
        mode,
        chain,
        skipped,
        staleQuota,
    };
}
//# sourceMappingURL=quota-policy.js.map