const vscode = require('vscode');
const { formatAgeMs } = require('../common/runtime');
const { groupQuotaModels, formatResetIn, renderQuotaBar } = require('../core/quota');

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
        const target = summary.lowestGroupName
            ? `${summary.lowestGroupName} · ${summary.lowestGroupWindow || 'quota'}`
            : 'lowest model quota';
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
        // Official-style group view: models share a weekly + 5-hour limit per
        // group; remaining reflects whichever window is currently binding.
        const active = models.find((m) => m && m.isSelected);
        // Collect rows first so every column (name, percent, reset, window) can
        // be padded to the width of its widest value.
        const rows = groupQuotaModels(models).map((group) => ({
            group,
            remaining: typeof group.remainingPercentage === 'number'
                ? `${group.remainingPercentage.toFixed(1)}%`
                : 'n/a',
            resetIn: formatResetIn(group.resetInMs),
            windowShort: group.window === '5-hour limit' ? '5h' : group.window === 'weekly limit' ? 'weekly' : '?',
        }));
        const w = {
            name: Math.max(...rows.map((r) => r.group.name.length)),
            remaining: Math.max(...rows.map((r) => r.remaining.length)),
            resetIn: Math.max(...rows.map((r) => r.resetIn.length)),
        };
        for (const row of rows) {
            lines.push('');
            const bar = renderQuotaBar(row.group.remainingPercentage);
            const tail = row.resetIn ? ` (${row.resetIn.padStart(w.resetIn)} / ${row.windowShort})` : '';
            lines.push(`${row.group.name.padEnd(w.name)} — ${bar} ${row.remaining.padStart(w.remaining)} left${tail}`);
            for (const name of row.group.models) {
                const activeMark = active && (active.label || active.modelId) === name ? ' [active]' : '';
                lines.push(`  - ${name}${activeMark}`);
            }
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
    // No percentage in the pill: models share GROUP quota, so any single number
    // (lowest model, prompt credits) misleads — e.g. "0%" while another group
    // sits at 99%. The pill is a click entry; details live in tooltip + report,
    // and low-quota alerting is handled by the getQuotaLevel notifications.
    if (summary) {
        quotaStatusBarItem.text = `${isStale ? '$(history)' : '$(graph)'} Quota`;
    } else if (latestQuotaError) {
        quotaStatusBarItem.text = '$(warning) Quota';
    } else {
        quotaStatusBarItem.text = '$(sync~spin) Quota';
    }
    quotaStatusBarItem.backgroundColor = undefined;
    quotaStatusBarItem.tooltip = formatQuotaTooltip(latestQuota, latestQuotaError, summarizeQuota);
    quotaStatusBarItem.show();
}

module.exports = {
    getQuotaLevel,
    updateQuotaStatusBar,
    formatQuotaTooltip,
    formatQuotaReport,
};
