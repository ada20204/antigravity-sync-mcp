#!/usr/bin/env node

/**
 * Sync sidecar server runtime payload for VSIX packaging.
 *
 * In the monorepo layout the sidecar bundles:
 * - server build output into server-runtime/dist
 * - runtime npm dependencies into server-runtime/node_modules
 * - the workspace core package into server-runtime/node_modules/@antigravity-mcp/core
 *
 * This keeps the extension package self-contained without changing extension.js.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = join(__dirname, '..');
const workspaceRoot = join(sidecarRoot, '../..');
const serverRoot = join(workspaceRoot, 'packages', 'server');
const coreRoot = join(workspaceRoot, 'packages', 'core');
const serverRuntimeDir = join(sidecarRoot, 'server-runtime');
const targetDistDir = join(serverRuntimeDir, 'dist');
const targetNodeModules = join(serverRuntimeDir, 'node_modules');
const hoistedNodeModules = join(workspaceRoot, 'node_modules');

const RUNTIME_DEPS = ['ws'];
const SDK_RUNTIME_PACKAGE = '@modelcontextprotocol/sdk';
const SERVER_RUNTIME_PACKAGE_JSON = {
    type: 'module',
    dependencies: {
        '@antigravity-mcp/core': '*',
    },
};
const SOURCE_TO_TARGET_COPIES = [
    {
        label: 'server build output',
        source: join(serverRoot, 'build', 'dist'),
        target: targetDistDir,
    },
    {
        label: 'core package metadata',
        source: join(coreRoot, 'package.json'),
        target: join(targetNodeModules, '@antigravity-mcp', 'core', 'package.json'),
    },
    {
        label: 'core build output',
        source: join(coreRoot, 'dist'),
        target: join(targetNodeModules, '@antigravity-mcp', 'core', 'dist'),
    },
];

function ensureExists(path, label) {
    if (!existsSync(path)) {
        console.error(`Source not found for ${label}: ${path}`);
        process.exit(1);
    }
}

function copyPath(label, source, target) {
    ensureExists(source, label);
    console.log(`  Copying ${label}...`);
    cpSync(source, target, { recursive: true });
}

function copyRuntimeDependency(dep) {
    copyPath(`${dep} runtime dependency`, join(hoistedNodeModules, dep), join(targetNodeModules, dep));
}

function copySdkRuntimeDependencies(packageDir, visited = new Set()) {
    if (visited.has(packageDir)) {
        return;
    }
    visited.add(packageDir);

    const packageJsonPath = join(packageDir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const dependencies = Object.keys(packageJson.dependencies ?? {});

    for (const dep of dependencies) {
        const source = join(hoistedNodeModules, dep);
        const target = join(targetNodeModules, dep);

        if (existsSync(target)) {
            continue;
        }

        copyPath(`${dep} transitive runtime dependency`, source, target);
        copySdkRuntimeDependencies(source, visited);
    }
}

console.log('Syncing sidecar server runtime payload...');

if (existsSync(targetDistDir)) {
    console.log('  Cleaning existing server-runtime/dist/');
    rmSync(targetDistDir, { recursive: true, force: true });
}

if (existsSync(targetNodeModules)) {
    console.log('  Cleaning existing server-runtime/node_modules/');
    rmSync(targetNodeModules, { recursive: true, force: true });
}

mkdirSync(serverRuntimeDir, { recursive: true });
mkdirSync(targetNodeModules, { recursive: true });

for (const entry of SOURCE_TO_TARGET_COPIES) {
    copyPath(entry.label, entry.source, entry.target);
}

for (const dep of RUNTIME_DEPS) {
    copyRuntimeDependency(dep);
}

copyRuntimeDependency(SDK_RUNTIME_PACKAGE);
copySdkRuntimeDependencies(join(hoistedNodeModules, SDK_RUNTIME_PACKAGE));

writeFileSync(
    join(targetDistDir, 'package.json'),
    `${JSON.stringify(SERVER_RUNTIME_PACKAGE_JSON, null, 2)}\n`,
    'utf8'
);

console.log('Server runtime payload synced successfully');
console.log(`  Dist: ${targetDistDir}`);
console.log(`  Node modules: ${targetNodeModules}`);
