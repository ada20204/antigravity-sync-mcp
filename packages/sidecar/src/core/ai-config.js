function buildAiConfigPrompt(params) {
    const { launcherPath, entryPath, workspacePath } = params;
    const workspaceHint = workspacePath || '${workspaceFolder}';
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'node' : launcherPath;
    const args = isWindows
        ? [entryPath, '--target-dir', workspaceHint]
        : ['--target-dir', workspaceHint];
    const configJson = JSON.stringify(
        {
            mcpServers: {
                'antigravity-mcp': {
                    command: String(command || ''),
                    args: args.map((item) => String(item || '')),
                },
            },
        },
        null,
        2
    );
    return [
        '# Antigravity MCP Setup Prompt (for AI clients)',
        '',
        'Use the following MCP server config:',
        '',
        '```json',
        configJson,
        '```',
        '',
        isWindows
            ? 'Windows note: use `node + server-runtime/dist/index.js` to avoid extra cmd window popups.'
            : 'Unix note: use the generated launcher path under ~/.config/antigravity-mcp/bin.',
        '',
        'Recommended instruction to AI:',
        '- Prefer tool `ask-antigravity` for delegated coding tasks.',
        '- Pass `mode` as `fast` for quick loop and `plan` for deep tasks.',
        '- If response indicates `registry_not_ready`, ask user to open/restart Antigravity with sidecar enabled.',
    ].join('\n');
}

module.exports = {
    buildAiConfigPrompt,
};
