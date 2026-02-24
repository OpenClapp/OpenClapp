import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const from = path.join(root, "public");
const to = path.join(root, "dist");

if (!existsSync(from) || !existsSync(to)) {
  process.exit(0);
}

const entries = [
  "SKILL.md",
  "skill.json",
  "HEARTBEAT.md",
  "openclapp-logo.png",
  "openclapp-logo-tight.png",
  "x-logo.png",
  "github-logo.webp",
  "jeb",
  "pies",
];

for (const entry of entries) {
  const src = path.join(from, entry);
  const dst = path.join(to, entry);
  if (!existsSync(src)) continue;
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, force: true });
}

console.log("postbuild-copy: copied static public assets into dist");
