const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');

// ─── VS Code Commands ─────────────────────────────────────────────────
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
];

// ─── Webview-Isolated Permission Clicker ──────────────────────────────
function buildPermissionScript() {
    return `
(function() {
    var BUTTON_TEXTS = ['run', 'accept', 'always allow', 'allow this conversation', 'allow'];
    if (!document.querySelector('.react-app-container') && 
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }
    
    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }
    
    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (node.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || node.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    return node;
                }
            }
            var nodeText = (node.textContent || '').trim().toLowerCase();
            if (nodeText.length > 50) continue;
            var isMatch = nodeText === text || 
                (text.length >= 5 && nodeText.startsWith(text) && nodeText.length <= text.length * 3);
            if (isMatch) {
                var clickable = closestClickable(node);
                var tag2 = (clickable.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' || 
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                    text === 'expand' || text === 'requires input') {
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        return null;
                    }
                    var lastClickTime = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
                    if (lastClickTime && (Date.now() - lastClickTime < 5000)) {
                        return null;
                    }
                    return clickable;
                }
            }
        }
        return null;
    }
    
    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        var btn = findButton(document.body, BUTTON_TEXTS[t]);
        if (btn) {
            btn.setAttribute('data-aa-t', '' + Date.now());
            btn.click();
            return 'clicked:' + BUTTON_TEXTS[t];
        }
    }
    
    var expandTexts = ['expand', 'requires input'];
    for (var e = 0; e < expandTexts.length; e++) {
        var expBtn = findButton(document.body, expandTexts[e]);
        if (expBtn) {
            expBtn.setAttribute('data-aa-t', '' + Date.now());
            expBtn.click();
            return 'clicked:' + expandTexts[e];
        }
    }
    return 'no-permission-button';
})()
`;
}

function cdpGetBrowserWsUrl(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info.webSocketDebuggerUrl || null);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function multiplexCdpWebviews(port) {
    return new Promise(async (resolve) => {
        try {
            const browserWsUrl = await cdpGetBrowserWsUrl(port);
            if (!browserWsUrl) return resolve(false);

            const ws = new WebSocket(browserWsUrl);
            const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

            let msgId = 1;
            const pending = {};

            function send(method, params = {}, sessionId = null) {
                return new Promise((res, rej) => {
                    const id = msgId++;
                    const timer = setTimeout(() => { delete pending[id]; rej(new Error('timeout')); }, 2000);
                    pending[id] = { res: (v) => { clearTimeout(timer); res(v); }, rej };
                    const payload = { id, method, params };
                    if (sessionId) payload.sessionId = sessionId;
                    ws.send(JSON.stringify(payload));
                });
            }

            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.id && pending[msg.id]) {
                    pending[msg.id].res(msg);
                    delete pending[msg.id];
                }
            });

            ws.on('error', () => { clearTimeout(timeout); resolve(false); });

            ws.on('open', async () => {
                try {
                    await send('Target.setDiscoverTargets', { discover: true });
                    const targetsMsg = await send('Target.getTargets');
                    const allTargets = targetsMsg.result?.targetInfos || [];

                    const webviews = allTargets.filter(t =>
                        t.url && (
                            t.url.includes('vscode-webview://') ||
                            t.url.includes('webview') ||
                            t.type === 'iframe'
                        )
                    );
                    const pageTargets = allTargets.filter(t => t.type === 'page');

                    const allEvalTargets = [
                        ...webviews.map(t => ({ ...t, kind: 'Webview' })),
                        ...pageTargets.map(t => ({ ...t, kind: 'Page' }))
                    ];

                    const evalPromises = allEvalTargets.map(async (target) => {
                        try {
                            const targetId = target.targetId;
                            const attachMsg = await send('Target.attachToTarget', { targetId, flatten: true });
                            const sessionId = attachMsg.result?.sessionId;
                            if (!sessionId) return;

                            if (target.kind === 'Page') {
                                const domCheck = await send('Runtime.evaluate', {
                                    expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                                }, sessionId);
                                const domResult = domCheck.result?.result?.value;
                                if (!domResult || domResult === 'no-dom') {
                                    await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                                    return;
                                }
                            }

                            const dynamicScript = buildPermissionScript();
                            const evalMsg = await send('Runtime.evaluate', { expression: dynamicScript }, sessionId);

                            await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                        } catch (e) { }
                    });

                    await Promise.allSettled(evalPromises);

                    clearTimeout(timeout);
                    ws.close();
                    resolve(true);
                } catch (e) {
                    clearTimeout(timeout); ws.close(); resolve(false);
                }
            });
        } catch (e) { resolve(false); }
    });
}

let isAccepting = false;
let isCdpBusy = false;
let pollIntervalId = null;
let cdpIntervalId = null;
let logger = console.log;

function startAutoAccept(port, customLogger, nativeInterval = 500, cdpInterval = 1500) {
    if (pollIntervalId) return;
    if (customLogger) logger = customLogger;

    // Fast loop for native VS Code commands
    pollIntervalId = setInterval(async () => {
        if (isAccepting) return;
        isAccepting = true;
        const safetyTimer = setTimeout(() => { isAccepting = false; }, 3000);
        try {
            await Promise.allSettled(
                ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
            );
        } catch (e) { }
        finally {
            clearTimeout(safetyTimer);
            isAccepting = false;
        }
    }, nativeInterval);

    // Slower loop for CDP webview clicks
    cdpIntervalId = setInterval(async () => {
        if (isCdpBusy || !port) return;
        isCdpBusy = true;
        try {
            const connected = await multiplexCdpWebviews(port);
            if (!connected) logger("Failed to connect to CDP webview session");
        } catch (e) { }
        finally {
            isCdpBusy = false;
        }
    }, cdpInterval);
}

function stopAutoAccept() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    if (cdpIntervalId) { clearInterval(cdpIntervalId); cdpIntervalId = null; }
    isAccepting = false;
    isCdpBusy = false;
}

module.exports = {
    startAutoAccept,
    stopAutoAccept
};
