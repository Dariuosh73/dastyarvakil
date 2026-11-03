import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
const root = process.cwd(), out = join(root, "www");
await mkdir(out, { recursive: true });
const excluded = new Set([".git", ".github", "node_modules", "android", "www", ".gradle"]);
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (excluded.has(entry.name) || ["package.json", "package-lock.json", "capacitor.config.json"].includes(entry.name)) continue;
  await cp(join(root, entry.name), join(out, entry.name), { recursive: true, force: true });
}
console.log("Web assets copied to www/");
