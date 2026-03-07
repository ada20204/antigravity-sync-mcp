import type { DiscoveredCDP, RegistryQuotaModel, RegistryQuotaSnapshot } from "./cdp.js";
import { callLsJson } from "./ls-client.js";

function normalizeToken(value: string): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function modelIdMatches(left?: string, right?: string): boolean {
    const l = normalizeToken(left || "");
    const r = normalizeToken(right || "");
    if (!l || !r) return false;
    return l === r || l.includes(r) || r.includes(l);
}

function collectStringByKeys(value: unknown, keysLowerSet: Set<string>): string | null {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = collectStringByKeys(item, keysLowerSet);
            if (found) return found;
        }
        return null;
    }

    const obj = value as Record<string, unknown>;
    for (const [key, raw] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (keysLowerSet.has(keyLower) && typeof raw === "string" && raw.trim()) {
            return raw.trim();
        }
        const nested = collectStringByKeys(raw, keysLowerSet);
        if (nested) return nested;
    }
    return null;
}

export function extractActiveModelId(conversation: unknown): string | null {
    const candidate = collectStringByKeys(
        conversation,
        new Set([
            "model",
            "modelid",
            "modelname",
            "selectedmodel",
            "selectedmodelid",
            "selected_model",
            "active_model",
            "activemodel",
            "activemodelid",
            "modelalias",
            "modelversion",
        ])
    );
    return candidate || null;
}

function normalizeQuotaSnapshot(data: unknown, activeModelId: string | null): RegistryQuotaSnapshot {
    const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const userStatus = (root.userStatus && typeof root.userStatus === "object" ? root.userStatus : {}) as Record<string, unknown>;
    const planStatus = (userStatus.planStatus && typeof userStatus.planStatus === "object" ? userStatus.planStatus : {}) as Record<string, unknown>;
    const planInfo = (planStatus.planInfo && typeof planStatus.planInfo === "object" ? planStatus.planInfo : {}) as Record<string, unknown>;
    const availablePromptCredits = typeof planStatus.availablePromptCredits === "number" ? planStatus.availablePromptCredits : undefined;
    const monthlyPromptCredits = typeof planInfo.monthlyPromptCredits === "number" ? planInfo.monthlyPromptCredits : undefined;

    let promptCredits: RegistryQuotaSnapshot["promptCredits"] | undefined;
    if (typeof availablePromptCredits === "number" && typeof monthlyPromptCredits === "number" && monthlyPromptCredits > 0) {
        const monthly = Number(monthlyPromptCredits);
        const available = Number(availablePromptCredits);
        promptCredits = {
            available,
            monthly,
            usedPercentage: ((monthly - available) / monthly) * 100,
            remainingPercentage: (available / monthly) * 100,
        };
    }

    const cascadeModelConfigData =
        userStatus.cascadeModelConfigData && typeof userStatus.cascadeModelConfigData === "object"
            ? (userStatus.cascadeModelConfigData as Record<string, unknown>)
            : {};
    const clientModelConfigs = Array.isArray(cascadeModelConfigData.clientModelConfigs)
        ? cascadeModelConfigData.clientModelConfigs
        : [];

    const now = Date.now();
    const models: RegistryQuotaModel[] = clientModelConfigs
        .filter((item) => item && typeof item === "object")
        .map((item) => item as Record<string, unknown>)
        .filter((item) => item.quotaInfo && typeof item.quotaInfo === "object")
        .map((item) => {
            const quotaInfo = item.quotaInfo as Record<string, unknown>;
            const resetTime = typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : "";
            const resetMs = resetTime ? Date.parse(resetTime) : NaN;
            const modelOrAlias =
                item.modelOrAlias && typeof item.modelOrAlias === "object"
                    ? (item.modelOrAlias as Record<string, unknown>)
                    : {};
            const modelId = String(
                (typeof modelOrAlias.model === "string" && modelOrAlias.model) ||
                    (typeof item.model === "string" && item.model) ||
                    ""
            );
            const label = String((typeof item.label === "string" && item.label) || "");
            const remainingFraction = typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : undefined;
            const selectedHint =
                item.isSelected === true ||
                item.selected === true ||
                item.current === true ||
                item.isCurrent === true;
            const selectedByActiveId =
                !!activeModelId && (modelIdMatches(modelId, activeModelId) || modelIdMatches(label, activeModelId));

            return {
                label,
                modelId,
                remainingFraction,
                remainingPercentage: typeof remainingFraction === "number" ? remainingFraction * 100 : undefined,
                isExhausted: remainingFraction === 0,
                isSelected: selectedHint || selectedByActiveId,
                resetTime,
                resetInMs: Number.isFinite(resetMs) ? resetMs - now : undefined,
            };
        });

    return {
        timestamp: now,
        source: "GetUserStatus",
        promptCredits,
        models,
        activeModelId: activeModelId || undefined,
    };
}

export async function fetchLiveQuotaSnapshot(discovered: DiscoveredCDP): Promise<RegistryQuotaSnapshot> {
    const userStatus = await callLsJson(discovered, "GetUserStatus", {
        metadata: {
            ideName: "antigravity",
            extensionName: "antigravity",
            locale: "en",
        },
    });

    let activeModelId: string | null = null;
    try {
        const conversation = await callLsJson(discovered, "GetBrowserOpenConversation", {});
        activeModelId = extractActiveModelId(conversation);
    } catch {
        // Best effort only; quota query should still succeed.
    }

    return normalizeQuotaSnapshot(userStatus, activeModelId);
}

export interface QuotaSummary {
    activeModelName: string | null;
    activeModelRemaining: number | null;
    promptRemaining: number | null;
    minModelRemaining: number | null;
    modelCount: number;
    exhaustedCount: number;
}

export function summarizeQuota(quota: RegistryQuotaSnapshot | undefined): QuotaSummary | null {
    if (!quota || typeof quota !== "object") return null;
    const models = Array.isArray(quota.models) ? quota.models : [];
    const promptRemaining =
        quota.promptCredits && typeof quota.promptCredits.remainingPercentage === "number"
            ? quota.promptCredits.remainingPercentage
            : null;

    const activeModel =
        models.find((item) => item && item.isSelected) ||
        models.find((item) => modelIdMatches(item?.modelId, quota.activeModelId) || modelIdMatches(item?.label, quota.activeModelId));
    const activeModelRemaining =
        activeModel && typeof activeModel.remainingPercentage === "number" ? activeModel.remainingPercentage : null;
    const activeModelName = activeModel
        ? activeModel.label || activeModel.modelId || quota.activeModelId || null
        : quota.activeModelId || null;

    const modelPercents = models
        .map((item) => (item && typeof item.remainingPercentage === "number" ? item.remainingPercentage : null))
        .filter((value): value is number => typeof value === "number");
    const minModelRemaining = modelPercents.length > 0 ? Math.min(...modelPercents) : null;
    const exhaustedCount = models.filter((item) => item && item.isExhausted === true).length;

    return {
        activeModelName,
        activeModelRemaining,
        promptRemaining,
        minModelRemaining,
        modelCount: models.length,
        exhaustedCount,
    };
}

function formatPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${Math.max(0, value).toFixed(1)}%`;
}

export function formatQuotaReport(params: {
    quota: RegistryQuotaSnapshot | undefined;
    source: string;
    targetDir?: string;
    liveError?: string;
}): string {
    const { quota, source, targetDir, liveError } = params;
    const lines: string[] = ["=== Antigravity Quota ==="];
    if (targetDir) lines.push(`targetDir: ${targetDir}`);
    lines.push(`source: ${source}`);

    if (!quota) {
        lines.push("quota: unavailable");
        if (liveError) lines.push(`liveError: ${liveError}`);
        return lines.join("\n");
    }

    if (quota.timestamp) {
        lines.push(`timestamp: ${new Date(Number(quota.timestamp)).toISOString()}`);
        lines.push(`snapshotAgeSec: ${Math.round((Date.now() - Number(quota.timestamp)) / 1000)}`);
    }
    if (quota.activeModelId) {
        lines.push(`activeModelId: ${quota.activeModelId}`);
    }
    if (liveError) {
        lines.push(`liveError: ${liveError}`);
    }

    const summary = summarizeQuota(quota);
    if (summary) {
        lines.push(`activeModel: ${summary.activeModelName || "unknown"} (${formatPercent(summary.activeModelRemaining)})`);
        lines.push(`promptCreditsRemaining: ${formatPercent(summary.promptRemaining)}`);
        lines.push(`lowestModelRemaining: ${formatPercent(summary.minModelRemaining)}`);
        lines.push(`modelsTracked: ${summary.modelCount}, exhausted: ${summary.exhaustedCount}`);
    }

    const models = Array.isArray(quota.models) ? quota.models : [];
    if (models.length > 0) {
        lines.push("models:");
        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || "").localeCompare(String(b.modelId || b.label || ""))
        );
        for (const model of sorted) {
            const id = model.modelId || model.label || "unknown";
            const selected = model.isSelected ? " [active]" : "";
            const remaining = typeof model.remainingPercentage === "number" ? `${model.remainingPercentage.toFixed(1)}%` : "n/a";
            const reset = model.resetTime || "n/a";
            lines.push(`- ${id}${selected}: remaining=${remaining}, reset=${reset}`);
        }
    } else {
        lines.push("models: none");
    }

    return lines.join("\n");
}
