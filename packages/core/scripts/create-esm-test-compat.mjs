import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "..", "dist");
const esmDir = path.join(distDir, "esm");

for (const entry of ["control", "platform", "registry"]) {
  cpSync(path.join(esmDir, entry), path.join(distDir, entry), { recursive: true });
}

for (const entry of ["index.js", "index.js.map", "index.d.ts", "index.d.ts.map"]) {
  cpSync(path.join(esmDir, entry), path.join(distDir, entry));
}
