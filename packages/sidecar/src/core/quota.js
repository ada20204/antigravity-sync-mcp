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

function formatModelIdAsLabel(modelId) {
    if (!modelId) return '';
    let s = modelId.replace(/^MODEL_/, '');
    // PLACEHOLDER_M18 → Model M18（先处理，避免被后续逻辑破坏）
    if (/^PLACEHOLDER_M\d+$/.test(s)) {
        return 'Model ' + s.replace('PLACEHOLDER_', '');
    }
    // 去掉 OPENAI_ 前缀，_OSS_ 噪音
    s = s.replace(/^OPENAI_/, '').replace(/_OSS_/, '_');
    const ACRONYMS = new Set(['GPT', 'API']);
    s = s.split('_').map((w) => {
        if (!w) return '';
        if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
        // 纯数字或数字+字母（120B、4、5）保持原样
        if (/^\d+[A-Za-z]*$/.test(w)) return w.toUpperCase();
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
    return s;
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
                const displayName = String(m.displayName || '');
                const label = displayName || String(m.label || '') || formatModelIdAsLabel(modelId);
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

// Official grouping (IDE settings page): models share a weekly + a 5-hour limit
// per group. The wire only exposes the BINDING window's remaining fraction and
// its reset time per model, so the group view infers the window from the reset
// distance: a rolling 5-hour window always resets within 5 hours.
const FIVE_HOUR_WINDOW_MS = 5.25 * 60 * 60 * 1000;

function quotaGroupName(label) {
    if (/^gemini/i.test(label)) return 'Gemini models';
    if (/^(claude|gpt)/i.test(label)) return 'Claude/GPT models';
    return 'Other models';
}

function groupQuotaModels(models) {
    const groups = new Map();
    for (const model of models || []) {
        if (!model) continue;
        const label = model.label || model.modelId || 'unknown';
        const name = quotaGroupName(label);
        let group = groups.get(name);
        if (!group) {
            group = { name, remainingPercentage: null, resetTime: '', resetInMs: undefined, window: 'unknown', models: [] };
            groups.set(name, group);
        }
        group.models.push(label);
        const remaining = typeof model.remainingPercentage === 'number' ? model.remainingPercentage : null;
        if (remaining !== null && (group.remainingPercentage === null || remaining < group.remainingPercentage)) {
            group.remainingPercentage = remaining;
            group.resetTime = model.resetTime || '';
            group.resetInMs = typeof model.resetInMs === 'number' ? model.resetInMs : undefined;
            group.window = typeof model.resetInMs === 'number'
                ? (model.resetInMs <= FIVE_HOUR_WINDOW_MS ? '5-hour limit' : 'weekly limit')
                : 'unknown';
        }
    }
    for (const group of groups.values()) group.models.sort();
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// 10-slot remaining bar: 99.9% -> "██████████", 0.3% -> "░░░░░░░░░░".
function renderQuotaBar(percent, slots = 10) {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return '░'.repeat(slots);
    const filled = Math.max(0, Math.min(slots, Math.round((percent / 100) * slots)));
    return '█'.repeat(filled) + '░'.repeat(slots - filled);
}

// "7h49m" / "12m" / "now" — human-readable reset distance.
function formatResetIn(resetInMs) {
    if (typeof resetInMs !== 'number' || !Number.isFinite(resetInMs)) return '';
    if (resetInMs <= 0) return 'now';
    const totalMinutes = Math.round(resetInMs / 60000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
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
    // Models share group quota, so "lowest" is really a group's remaining —
    // name the group so alerts read as the settings page does.
    const groups = groupQuotaModels(models);
    const lowestGroup = groups.reduce(
        (min, g) => (typeof g.remainingPercentage === 'number' && (min === null || g.remainingPercentage < min.remainingPercentage) ? g : min),
        null
    );
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
        : (lowestGroup ? `${lowestGroup.name} · ${lowestGroup.window}` : (minModelRemaining !== null ? 'lowest model quota' : 'prompt credits'));

    return {
        primaryPercent,
        primaryLabel,
        promptRemaining,
        minModelRemaining,
        lowestGroupName: lowestGroup ? lowestGroup.name : null,
        lowestGroupWindow: lowestGroup ? lowestGroup.window : null,
        activeModelName,
        activeModelRemaining,
        modelCount: models.length,
        exhaustedCount,
    };
}

module.exports = {
    formatResetIn,
    renderQuotaBar,
    normalizeModelKey,
    modelIdMatches,
    collectStringByKeys,
    extractActiveModelId,
    normalizeQuotaSnapshot,
    groupQuotaModels,
    summarizeQuota,
};
