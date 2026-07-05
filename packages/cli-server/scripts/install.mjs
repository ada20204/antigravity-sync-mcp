#!/usr/bin/env node

/**
 * Install the CLI MCP server as a standalone global copy, decoupled from this
 * repo checkout. Layout mirrors the sidecar-generated CDP launcher:
 *   ~/.config/antigravity-mcp/cli-server/{dist,node_modules}
 *   ~/.config/antigravity-mcp/bin/antigravity-mcp-cli
 *
 * Requires a prior `npm run build`. The server only needs node + the agy
 * binary (resolved via AGY_BIN / PATH / ~/.local/bin at runtime), so no env
 * is baked into the launcher.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const workspaceRoot = join(packageRoot, '../..');
const hoistedNodeModules = join(workspaceRoot, 'node_modules');
const sourceDist = join(packageRoot, 'build', 'dist');

const mcpHome = join(homedir(), '.config', 'antigravity-mcp');
const installRoot = join(mcpHome, 'cli-server');
const targetDist = join(installRoot, 'dist');
const targetNodeModules = join(installRoot, 'node_modules');
const launcherPath = join(mcpHome, 'bin', 'antigravity-mcp-cli');

const SDK_PACKAGE = '@modelcontextprotocol/sdk';

if (!existsSync(sourceDist)) {
    console.error(`Build output not found: ${sourceDist}\nRun \`npm run build\` in packages/cli-server first.`);
    process.exit(1);
}

function copyPackageWithDependencies(dep, visited = new Set()) {
    if (visited.has(dep)) return;
    visited.add(dep);

    const source = join(hoistedNodeModules, dep);
    if (!existsSync(source)) {
        console.error(`Dependency not found in workspace node_modules: ${dep}`);
        process.exit(1);
    }
    console.log(`  Copying ${dep}...`);
    cpSync(source, join(targetNodeModules, dep), { recursive: true });

    const packageJson = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const transitive of Object.keys(packageJson.dependencies ?? {})) {
        copyPackageWithDependencies(transitive, visited);
    }
}

console.log(`Installing antigravity-cli MCP server to ${installRoot}...`);

rmSync(installRoot, { recursive: true, force: true });
mkdirSync(targetNodeModules, { recursive: true });
mkdirSync(dirname(launcherPath), { recursive: true });

console.log('  Copying server build output...');
cpSync(sourceDist, targetDist, { recursive: true });
writeFileSync(join(installRoot, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');

copyPackageWithDependencies(SDK_PACKAGE);

writeFileSync(
    launcherPath,
    `#!/usr/bin/env bash\nset -euo pipefail\nexec node "${join(targetDist, 'index.js')}" "$@"\n`,
    'utf8'
);
chmodSync(launcherPath, 0o755);

console.log('Installed successfully.');
console.log(`  Launcher: ${launcherPath}`);
console.log('\nMCP client config:');
console.log(JSON.stringify({
    mcpServers: {
        'antigravity-cli': { command: launcherPath, args: [] },
    },
}, null, 2));
