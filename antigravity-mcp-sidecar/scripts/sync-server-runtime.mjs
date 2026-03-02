#!/usr/bin/env node
/**
 * Cross-platform replacement for the bash-based sync-server-runtime npm script.
 * Copies antigravity-mcp-server/build/dist → server-runtime/dist and writes
 * a package.json with "type": "module".
 */
import { cpSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarDir = resolve(__dirname, "..");
const rootDir = resolve(sidecarDir, "..");
const src = join(rootDir, "antigravity-mcp-server", "build", "dist");
const dest = join(sidecarDir, "server-runtime", "dist");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
writeFileSync(join(dest, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

console.log(`Synced ${src} → ${dest}`);
