const vscode = require('vscode');

function updateStatusBar(params) {
    const { statusBarItem, cdpTarget, isEnabled } = params;
    if (!cdpTarget) {
        statusBarItem.text = '$(warning) Sidecar: No CDP';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'CDP port not found — auto-accept unavailable';
        statusBarItem.show();
        return;
    }

    if (isEnabled) {
        statusBarItem.text = '$(zap) Sidecar: ON';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip = 'Auto-accept is ACTIVE — click to disable';
        statusBarItem.show();
        return;
    }

    statusBarItem.text = '$(circle-slash) Sidecar: OFF';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = 'Auto-accept is OFF — click to enable';
    statusBarItem.show();
}

module.exports = {
    updateStatusBar,
};
