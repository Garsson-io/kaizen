#!/usr/bin/env node
/**
 * claude-wt.ts — Launch Claude Code in an isolated git worktree.
 *
 * Usage:
 *   npx tsx src/claude-wt.ts [claude args...]
 *   npx tsx src/claude-wt.ts -p "fix the bug"
 *   npx tsx src/claude-wt.ts --safe
 */

import { spawn } from "child_process";
import { resolveProjectPaths } from "./lib/resolve-project-root.js";
import { analyzeWorktrees, defaultDeps } from "./worktree-du.js";

// ── Arg parsing (exported for tests) ──

export interface ParsedArgs {
  skipPermissions: boolean;
  claudeArgs: string[];
}

export function parseArgs(argv: string[]): ParsedArgs | "help" {
  let skipPermissions = true;
  const claudeArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--help") return "help";
    if (arg === "--safe") {
      skipPermissions = false;
    } else {
      claudeArgs.push(arg);
    }
  }

  const finalArgs = skipPermissions
    ? ["--dangerously-skip-permissions", ...claudeArgs]
    : claudeArgs;

  return { skipPermissions, claudeArgs: finalArgs };
}

export function generateNonce(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${yy}${mm}${dd}-${hh}${min}-${rand}`;
}

export const HELP_TEXT = `claude-wt — Launch Claude Code in an isolated git worktree

Usage: claude-wt [options] [claude args...]

Options:
  --safe            Don't skip permissions (ask for each tool)
  --help            Show this help

All other arguments are passed through to claude.
By default, --dangerously-skip-permissions is added (safe: worktree is isolated).
Uses claude's built-in -w flag for worktree management.

Examples:
  claude-wt                          # interactive session
  claude-wt -p "fix the bug"        # headless with prompt
  claude-wt --safe                   # with permission prompts`;

// ── Main ──

export function main(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
) {
  const parsed = parseArgs(argv);
  if (parsed === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const paths = resolveProjectPaths(cwd);

  // Advisory disk usage report (fast mode — skip slow checks)
  try {
    const deps = defaultDeps();
    const { summary } = analyzeWorktrees(paths, deps, true);
    if (summary.count > 0) {
      console.log(`Worktrees: ${summary.count} (${summary.activeLocks} active, ${summary.merged} merged, ${summary.dirty} dirty)`);
    }
  } catch {
    // du is advisory — don't block on failure
  }

  const nonce = generateNonce();
  console.log(`Starting Claude with worktree: ${nonce}`);
  console.log("");

  const child = spawn("claude", ["-w", nonce, ...parsed.claudeArgs], {
    cwd,
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

// Run when executed directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("claude-wt.ts") ||
    process.argv[1].endsWith("claude-wt.js"));
if (isMain) {
  main();
}
