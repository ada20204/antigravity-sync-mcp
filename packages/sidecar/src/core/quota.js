function normalizeModelKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s_()-]+/g, '');
}

function modelIdMatches(a, b) {
    const left = normalizeModelKey(a);
    const right = normalizeModelKey(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function collectStringByKeys(value, keysLowerSet) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = collectStringByKeys(item, keysLowerSet);
            if (found) return found;
        }
        return null;
    }
    const obj = value;
    for (const [key, raw] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (keysLowerSet.has(keyLower) && typeof raw === 'string' && raw.trim()) {
            return raw.trim();
        }
        const nested = collectStringByKeys(raw, keysLowerSet);
        if (nested) return nested;
    }
    return null;
}

function extractActiveModelId(conversation) {
    const candidate = collectStringByKeys(conversation, new Set([
        'model',
        'modelid',
        'selectedmodel',
        'activemodel',
        'modelalias',
    ]));
    return candidate || null;
}

function normalizeQuotaSnapshot(data, activeModelId) {
    const userStatus = (data && data.userStatus) || {};
    const planStatus = userStatus.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const availablePromptCredits = planStatus.availablePromptCredits;
    let promptCredits;
    if (typeof availablePromptCredits === 'number' && typeof planInfo.monthlyPromptCredits === 'number' && planInfo.monthlyPromptCredits > 0) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availablePromptCredits);
        promptCredits = {
            available,
            monthly,
            usedPercentage: ((monthly - available) / monthly) * 100,
            remainingPercentage: (available / monthly) * 100,
        };
    }

    const models = Array.isArray(userStatus.cascadeModelConfigData && userStatus.cascadeModelConfigData.clientModelConfigs)
        ? userStatus.cascadeModelConfigData.clientModelConfigs
        : [];

    const now = Date.now();
    return {
        timestamp: now,
        source: 'GetUserStatus',
        promptCredits,
        models: models
            .filter((m) => m && m.quotaInfo)
            .map((m) => {
                const resetTime = String(m.quotaInfo.resetTime || '');
                const resetMs = resetTime ? Date.parse(resetTime) : NaN;
                const modelId = String((m.modelOrAlias && m.modelOrAlias.model) || m.model || '');
                const label = String(m.label || '');
                const selectedHint = m.isSelected === true || m.selected === true || m.current === true || m.isCurrent === true;
                const selectedByActiveId = !!activeModelId && (modelIdMatches(modelId, activeModelId) || modelIdMatches(label, activeModelId));
                return {
                    label,
                    modelId,
                    remainingFraction: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : undefined,
                    remainingPercentage: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction * 100 : undefined,
                    isExhausted: m.quotaInfo.remainingFraction === 0,
                    isSelected: selectedHint || selectedByActiveId,
                    resetTime,
                    resetInMs: Number.isFinite(resetMs) ? resetMs - now : undefined,
                };
            }),
        activeModelId: activeModelId || undefined,
    };
}

function summarizeQuota(quota) {
    if (!quota || typeof quota !== 'object') return null;

    const prompt = quota.promptCredits && typeof quota.promptCredits === 'object'
        ? quota.promptCredits
        : null;
    const models = Array.isArray(quota.models) ? quota.models : [];

    const modelPercents = models
        .map((m) => (m && typeof m.remainingPercentage === 'number' ? m.remainingPercentage : null))
        .filter((v) => typeof v === 'number');
    const exhaustedCount = models.filter((m) => m && m.isExhausted === true).length;
    const activeModel = models.find((m) => m && m.isSelected) || models.find((m) => modelIdMatches((m && m.modelId) || (m && m.label), quota.activeModelId));

    const promptRemaining = prompt && typeof prompt.remainingPercentage === 'number'
        ? prompt.remainingPercentage
        : null;
    const minModelRemaining = modelPercents.length > 0 ? Math.min(...modelPercents) : null;
    const activeModelRemaining = activeModel && typeof activeModel.remainingPercentage === 'number'
        ? activeModel.remainingPercentage
        : null;
    const activeModelName = activeModel
        ? (activeModel.label || activeModel.modelId || quota.activeModelId || null)
        : (quota.activeModelId || null);

    const primaryPercent = activeModelRemaining !== null
        ? activeModelRemaining
        : (minModelRemaining !== null ? minModelRemaining : promptRemaining);
    const primaryLabel = activeModelName
        ? `model ${activeModelName}`
        : (minModelRemaining !== null ? 'lowest model quota' : 'prompt credits');

    return {
        primaryPercent,
        primaryLabel,
        promptRemaining,
        minModelRemaining,
        activeModelName,
        activeModelRemaining,
        modelCount: models.length,
        exhaustedCount,
    };
}

module.exports = {
    normalizeModelKey,
    modelIdMatches,
    collectStringByKeys,
    extractActiveModelId,
    normalizeQuotaSnapshot,
    summarizeQuota,
};
