const vscode = require('vscode');
const { formatAgeMs } = require('../common/runtime');

function getQuotaLevel(summary, thresholds) {
    const {
        quotaWarnThresholdPercent,
        quotaCriticalThresholdPercent,
    } = thresholds;

    if (!summary) return { level: 'none', watchedPercent: null, target: 'quota' };

    if (summary.activeModelRemaining !== null) {
        const percent = summary.activeModelRemaining;
        const target = summary.activeModelName ? `model ${summary.activeModelName}` : 'active model';
        if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
        if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
        return { level: 'none', watchedPercent: percent, target };
    }
    if (summary.minModelRemaining !== null) {
        const percent = summary.minModelRemaining;
        const target = 'lowest model quota';
        if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
        if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
        return { level: 'none', watchedPercent: percent, target };
    }
    if (summary.promptRemaining !== null) {
        const percent = summary.promptRemaining;
        const target = 'prompt credits';
        if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
        if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
        return { level: 'none', watchedPercent: percent, target };
    }
    return { level: 'none', watchedPercent: null, target: 'quota' };
}

function formatQuotaTooltip(quota, quotaError, summarizeQuota) {
    const lines = ['Quota snapshot (click to view details)'];
    if (quotaError) {
        lines.push(`Last error: ${quotaError}`);
    }
    const summary = summarizeQuota(quota);
    if (!summary) {
        lines.push('No snapshot yet.');
        return lines.join('\n');
    }
    if (quota && quota.timestamp) {
        lines.push(`Snapshot age: ${formatAgeMs(Date.now() - Number(quota.timestamp))}`);
    }
    if (summary.promptRemaining !== null) {
        lines.push(`Prompt credits remaining: ${summary.promptRemaining.toFixed(1)}%`);
    }
    if (summary.activeModelName) {
        lines.push(`Active model: ${summary.activeModelName}`);
    }
    if (summary.activeModelRemaining !== null) {
        lines.push(`Active model remaining: ${summary.activeModelRemaining.toFixed(1)}%`);
    }
    if (summary.minModelRemaining !== null) {
        lines.push(`Lowest model remaining: ${summary.minModelRemaining.toFixed(1)}%`);
    }
    lines.push(`Models tracked: ${summary.modelCount}, exhausted: ${summary.exhaustedCount}`);
    return lines.join('\n');
}

function formatQuotaReport(quota, quotaError) {
    const lines = ['=== Antigravity Quota Snapshot ==='];
    if (quotaError) lines.push(`lastError: ${quotaError}`);
    if (!quota || typeof quota !== 'object') {
        lines.push('No quota snapshot available yet.');
        return lines.join('\n');
    }

    if (quota.timestamp) {
        lines.push(`timestamp: ${new Date(quota.timestamp).toISOString()}`);
        lines.push(`snapshotAge: ${formatAgeMs(Date.now() - Number(quota.timestamp))}`);
    }
    if (quota.source) {
        lines.push(`source: ${quota.source}`);
    }
    if (quota.activeModelId) {
        lines.push(`activeModelId: ${quota.activeModelId}`);
    }
    const prompt = quota.promptCredits;
    if (prompt && typeof prompt === 'object') {
        lines.push(
            `promptCredits: available=${prompt.available ?? 'n/a'} ` +
            `monthly=${prompt.monthly ?? 'n/a'} ` +
            `remaining=${typeof prompt.remainingPercentage === 'number' ? prompt.remainingPercentage.toFixed(1) + '%' : 'n/a'}`
        );
    }

    const models = Array.isArray(quota.models) ? quota.models : [];
    if (models.length > 0) {
        lines.push('models:');
        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || ''))
        );
        for (const model of sorted) {
            const id = model.modelId || model.label || 'unknown';
            const remaining = typeof model.remainingPercentage === 'number'
                ? `${model.remainingPercentage.toFixed(1)}%`
                : 'n/a';
            const selected = model.isSelected ? ', selected=yes' : '';
            lines.push(`- ${id}: remaining=${remaining}, exhausted=${model.isExhausted ? 'yes' : 'no'}${selected}`);
        }
    } else {
        lines.push('models: none');
    }

    return lines.join('\n');
}

function updateQuotaStatusBar(params) {
    const {
        quotaStatusBarItem,
        cdpTarget,
        latestQuota,
        latestQuotaError,
        quotaStaleMinutes,
        summarizeQuota,
        quotaWarnThresholdPercent,
        quotaCriticalThresholdPercent,
    } = params;

    if (!cdpTarget) {
        quotaStatusBarItem.hide();
        return;
    }

    const summary = summarizeQuota(latestQuota);
    const snapshotAgeMs = latestQuota && latestQuota.timestamp
        ? Date.now() - Number(latestQuota.timestamp)
        : Number.POSITIVE_INFINITY;
    const isStale = !Number.isFinite(snapshotAgeMs) || snapshotAgeMs > quotaStaleMinutes * 60_000;
    const level = getQuotaLevel(summary, {
        quotaWarnThresholdPercent,
        quotaCriticalThresholdPercent,
    }).level;
    if (summary && summary.activeModelName && summary.activeModelRemaining !== null) {
        const modelShort = summary.activeModelName.replace(/^.*\//, '').slice(0, 16);
        quotaStatusBarItem.text = `${isStale ? '$(history)' : '$(graph)'} ${modelShort} ${Math.max(0, summary.activeModelRemaining).toFixed(0)}%`;
    } else if (summary && summary.primaryPercent !== null) {
        quotaStatusBarItem.text = `${isStale ? '$(history)' : '$(graph)'} Quota ${Math.max(0, summary.primaryPercent).toFixed(0)}%`;
    } else if (latestQuotaError) {
        quotaStatusBarItem.text = '$(warning) Quota N/A';
    } else {
        quotaStatusBarItem.text = '$(sync~spin) Quota ...';
    }
    if (level === 'critical') {
        quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (level === 'warning') {
        quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        quotaStatusBarItem.backgroundColor = undefined;
    }
    quotaStatusBarItem.tooltip = formatQuotaTooltip(latestQuota, latestQuotaError, summarizeQuota);
    quotaStatusBarItem.show();
}

module.exports = {
    getQuotaLevel,
    updateQuotaStatusBar,
    formatQuotaTooltip,
    formatQuotaReport,
};
