/**
 * resolve-project-root.ts — Resolve PROJECT_ROOT and SCRIPT_DIR from a directory.
 *
 * Pure functions with injectable git runner for testability.
 */

import { spawnSync } from "node:child_process";
import { join } from "path";

export interface ProjectPaths {
  projectRoot: string;
  scriptDir: string;
  worktreesDir: string;
}

export type GitRunner = (args: readonly string[]) => string;

function defaultGit(args: readonly string[]): string {
  const result = spawnSync('git', args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git command failed");
  }
  return (result.stdout || "").trim();
}

/**
 * Resolve the git toplevel from a directory.
 * Falls back to parent dir if not in a git repo.
 */
export function resolveProjectRoot(
  dir: string,
  git: GitRunner = defaultGit,
): string {
  try {
    const root = git(['-C', dir, 'rev-parse', '--show-toplevel']);
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
  git?: GitRunner,
): ProjectPaths {
  const projectRoot = resolveProjectRoot(dir, git);
  return {
    projectRoot,
    scriptDir: join(projectRoot, "scripts"),
    worktreesDir: join(projectRoot, ".claude", "worktrees"),
  };
}
