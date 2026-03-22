/**
 * resolve-project-root.ts — Resolve PROJECT_ROOT and SCRIPT_DIR from a directory.
 *
 * Pure functions with injectable exec for testability.
 */

import { execSync } from "child_process";
import { join } from "path";

export interface ProjectPaths {
  projectRoot: string;
  scriptDir: string;
  worktreesDir: string;
}

/**
 * Resolve the git toplevel from a directory.
 * Falls back to parent dir if not in a git repo.
 */
export function resolveProjectRoot(
  dir: string,
  exec: (cmd: string) => string = (cmd) =>
    execSync(cmd, { encoding: "utf8" }).trim(),
): string {
  try {
    const root = exec(`git -C "${dir}" rev-parse --show-toplevel`);
    if (root) return root;
  } catch {
    // not a git repo
  }
  return join(dir, "..");
}

/**
 * Resolve all standard project paths from a directory.
 */
export function resolveProjectPaths(
  dir: string,
  exec?: (cmd: string) => string,
): ProjectPaths {
  const projectRoot = resolveProjectRoot(dir, exec);
  return {
    projectRoot,
    scriptDir: join(projectRoot, "scripts"),
    worktreesDir: join(projectRoot, ".claude", "worktrees"),
  };
}
