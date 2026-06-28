import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

export const KAIZEN_ROOT = resolve(typeof __dirname !== "undefined" ? __dirname : __dirname_esm, "../..");

export function resolveTsxBin(repoRoot = KAIZEN_ROOT): string | undefined {
  const candidates: string[] = [join(repoRoot, "node_modules", ".bin", "tsx")];

  let dir = dirname(repoRoot);
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, "node_modules", ".bin", "tsx"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    const gitCommonDir = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const mainRoot = dirname(resolve(repoRoot, gitCommonDir));
    candidates.push(join(mainRoot, "node_modules", ".bin", "tsx"));
  } catch {
    // Not every synthetic fixture is a git worktree.
  }

  return candidates.find(existsSync);
}
