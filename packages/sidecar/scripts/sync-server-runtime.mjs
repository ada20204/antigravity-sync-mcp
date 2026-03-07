#!/usr/bin/env node

/**
 * Sync server runtime dependencies
 *
 * Copies ws and @modelcontextprotocol/sdk from sidecar root node_modules
 * to server-runtime/node_modules/ so they're bundled in the VSIX.
 *
 * This keeps the git repo clean (no committed node_modules) while ensuring
 * the VSIX is self-contained.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const serverRuntimeDir = join(rootDir, 'server-runtime');
const targetNodeModules = join(serverRuntimeDir, 'node_modules');

const DEPS_TO_COPY = ['ws', '@modelcontextprotocol'];

console.log('🔄 Syncing server runtime dependencies...');

// Clean target directory
if (existsSync(targetNodeModules)) {
    console.log('  Cleaning existing server-runtime/node_modules/');
    rmSync(targetNodeModules, { recursive: true, force: true });
}

mkdirSync(targetNodeModules, { recursive: true });

// Copy each dependency
for (const dep of DEPS_TO_COPY) {
    const sourcePath = join(rootDir, 'node_modules', dep);
    const targetPath = join(targetNodeModules, dep);

    if (!existsSync(sourcePath)) {
        console.error(`  ❌ Source not found: ${dep}`);
        console.error(`     Expected at: ${sourcePath}`);
        console.error(`     Run 'npm install' first.`);
        process.exit(1);
    }

    console.log(`  Copying ${dep}...`);
    cpSync(sourcePath, targetPath, { recursive: true });
}

console.log('✅ Server runtime dependencies synced successfully');
console.log(`   Target: ${targetNodeModules}`);
