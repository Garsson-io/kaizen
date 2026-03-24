#!/usr/bin/env node
/**
 * worktree-du.ts — Disk usage analysis and cleanup for worktrees, branches, and Docker images.
 *
 * Usage:
 *   npx tsx src/worktree-du.ts [analyze|cleanup] [--fast] [--dry-run]
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { resolveProjectPaths, type ProjectPaths } from "./lib/resolve-project-root.js";

// ── Types ──

type LockClass = "active" | "stale" | "orphaned" | "none";
export type MergeStatus = "merged" | "squash-merged" | "at-main" | "unmerged";

export interface LockFile {
  pid?: number;
  heartbeat?: string;
  started_at?: string;
}

interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  lockClass: LockClass;
  lockAge: string | null;
  mergeStatus: MergeStatus;
  dirtyFiles: number;
  unpushedCommits: number;
  sizeBytes: number | null;
  caseInfo: string | null;
}

interface AnalyzeSummary {
  count: number;
  totalSize: number;
  activeLocks: number;
  staleLocks: number;
  merged: number;
  dirty: number;
}

interface BranchSummary {
  total: number;
  merged: number;
  unmerged: number;
  localOnly: number;
}

// ── Deps (injectable for testing) ──

export interface Deps {
  exec: (cmd: string) => string;
  pidAlive: (pid: number) => boolean;
  now: () => number;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  readdir: (path: string) => string[];
  isDir: (path: string) => boolean;
  dirSize: (path: string) => number;
  unlink: (path: string) => void;
}

export function defaultDeps(): Deps {
  return {
    exec: (cmd) => execSync(cmd, { encoding: "utf8" }).trim(),
    pidAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    now: () => Date.now(),
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    readdir: (p) => {
      try { return readdirSync(p); } catch { return []; }
    },
    isDir: (p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    },
    dirSize: (p) => {
      try {
        return parseInt(execSync(`du -sb "${p}" 2>/dev/null | cut -f1`, { encoding: "utf8" }).trim(), 10) || 0;
      } catch { return 0; }
    },
    unlink: (p) => unlinkSync(p),
  };
}

// ── Lock functions ──

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function readLockFile(wtPath: string, deps: Deps): LockFile | null {
  const lockPath = join(wtPath, ".worktree-lock.json");
  if (!deps.exists(lockPath)) return null;
  try {
    return JSON.parse(deps.readFile(lockPath));
  } catch {
    return {};
  }
}

function classifyLockFromData(lock: LockFile | null, deps: Deps): LockClass {
  if (!lock) return "none";

  const pid = lock.pid;
  const pidAlive = pid ? deps.pidAlive(pid) : false;

  if (!pidAlive) return "orphaned";

  const hb = lock.heartbeat || lock.started_at;
  if (!hb) return "stale";

  const hbTime = new Date(hb).getTime();
  const age = deps.now() - hbTime;
  return age < STALE_THRESHOLD_MS ? "active" : "stale";
}

export function classifyLock(wtPath: string, deps: Deps): LockClass {
  return classifyLockFromData(readLockFile(wtPath, deps), deps);
}

export function lockAge(lock: LockFile | null, deps: Deps): string | null {
  if (!lock) return null;

  const hb = lock.heartbeat || lock.started_at;
  if (!hb) return "?";

  const mins = Math.round((deps.now() - new Date(hb).getTime()) / 60000);
  if (mins < 60) return `${mins}min`;
  if (mins < 1440) return `${Math.round(mins / 60)}hr`;
  return `${Math.round(mins / 1440)}d`;
}

// ── Helpers ──

/** Reject branch names with shell metacharacters to prevent injection. */
function safeBranch(branch: string): string {
  if (/[;&|`$()'"\\<>!]/.test(branch)) {
    throw new Error(`Unsafe branch name: ${branch}`);
  }
  return branch;
}

// ── Branch functions ──

export function getMergedBranches(projectRoot: string, deps: Deps): Set<string> {
  try {
    const raw = deps.exec(`git -C "${projectRoot}" branch --merged main`);
    return new Set(
      raw.split("\n").map((b) => b.replace(/^[* +]*/, "").trim()).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function branchMergeStatus(
  branch: string,
  projectRoot: string,
  mergedBranches: Set<string>,
  deps: Deps,
): MergeStatus {
  const safe = safeBranch(branch);
  if (mergedBranches.has(branch)) {
    try {
      const ahead = parseInt(
        deps.exec(`git -C "${projectRoot}" rev-list --count "main..${safe}"`),
        10,
      );
      return ahead === 0 ? "at-main" : "merged";
    } catch {
      return "merged";
    }
  }

  // Squash-merge detection
  try {
    const diffStat = deps.exec(`git -C "${projectRoot}" diff --stat "main..${safe}"`);
    if (!diffStat) return "squash-merged";
  } catch {
    // diff failed — treat as unmerged
  }

  return "unmerged";
}

// ── Git helpers ──

function getWorktreeBranch(wtPath: string, deps: Deps): string {
  try {
    return deps.exec(`git -C "${wtPath}" rev-parse --abbrev-ref HEAD`);
  } catch {
    return "?";
  }
}

function getDirtyFileCount(wtPath: string, deps: Deps): number {
  try {
    const lines = deps.exec(`git -C "${wtPath}" status --porcelain`);
    if (!lines) return 0;
    return lines.split("\n").filter((l) => !l.includes(".worktree-lock.json")).length;
  } catch {
    return 0;
  }
}

function getUnpushedCount(wtPath: string, deps: Deps): number {
  try {
    const lines = deps.exec(`git -C "${wtPath}" log --oneline @{u}..HEAD`);
    return lines ? lines.split("\n").length : 0;
  } catch {
    return 0;
  }
}

function shortenBranch(branch: string): string {
  return branch
    .replace(/^(case|worktree|wt|feat|fix|docs)\//, "")
    .slice(0, 18);
}

// ── Analyze ──

export function analyzeWorktrees(
  paths: ProjectPaths,
  deps: Deps,
  fast: boolean,
): { worktrees: WorktreeInfo[]; summary: AnalyzeSummary } {
  const dirs = deps.readdir(paths.worktreesDir);
  const merged = getMergedBranches(paths.projectRoot, deps);
  const worktrees: WorktreeInfo[] = [];
  const summary: AnalyzeSummary = {
    count: 0,
    totalSize: 0,
    activeLocks: 0,
    staleLocks: 0,
    merged: 0,
    dirty: 0,
  };

  for (const name of dirs) {
    const wtPath = join(paths.worktreesDir, name);
    if (!deps.isDir(wtPath)) continue;
    summary.count++;

    const branch = getWorktreeBranch(wtPath, deps);
    const lock = readLockFile(wtPath, deps);
    const lc = classifyLockFromData(lock, deps);
    const la = lockAge(lock, deps);
    const ms = branchMergeStatus(branch, paths.projectRoot, merged, deps);
    const dirty = getDirtyFileCount(wtPath, deps);
    const unpushed = getUnpushedCount(wtPath, deps);
    const size = fast ? null : deps.dirSize(wtPath);

    if (lc === "active") summary.activeLocks++;
    if (lc === "stale" || lc === "orphaned") summary.staleLocks++;
    if (ms === "merged" || ms === "squash-merged") summary.merged++;
    if (dirty > 0) summary.dirty++;
    if (size !== null) summary.totalSize += size;

    worktrees.push({
      name,
      path: wtPath,
      branch,
      lockClass: lc,
      lockAge: la,
      mergeStatus: ms,
      dirtyFiles: dirty,
      unpushedCommits: unpushed,
      sizeBytes: size,
      caseInfo: null, // populated by caller if CLI_KAIZEN available
    });
  }

  return { worktrees, summary };
}

export function analyzeBranches(
  projectRoot: string,
  deps: Deps,
): BranchSummary {
  const merged = getMergedBranches(projectRoot, deps);
  let mergedCount = 0;
  for (const b of merged) {
    if (b !== "main") mergedCount++;
  }

  let unmerged = 0;
  try {
    const raw = deps.exec(`git -C "${projectRoot}" branch --no-merged main`);
    unmerged = raw ? raw.split("\n").filter(Boolean).length : 0;
  } catch {
    // no unmerged branches
  }

  let localOnly = 0;
  try {
    const allBranches = deps.exec(`git -C "${projectRoot}" branch`);
    for (const line of allBranches.split("\n")) {
      const branch = line.replace(/^[* +]*/, "").trim();
      if (!branch || branch === "main") continue;
      try {
        deps.exec(`git -C "${projectRoot}" config "branch.${branch}.remote"`);
      } catch {
        localOnly++;
      }
    }
  } catch {
    // no branches
  }

  return {
    total: mergedCount + unmerged + 1,
    merged: mergedCount,
    unmerged,
    localOnly,
  };
}

// ── Cleanup ──

export interface CleanupResult {
  removedWorktrees: number;
  removedBranches: number;
  skipped: number;
  actions: CleanupAction[];
}

interface CleanupAction {
  type: "skip" | "remove" | "remove-lock" | "fail";
  target: string;
  reason: string;
}

export function cleanupWorktrees(
  paths: ProjectPaths,
  deps: Deps,
  dryRun: boolean,
): CleanupResult {
  const merged = getMergedBranches(paths.projectRoot, deps);
  const dirs = deps.readdir(paths.worktreesDir);
  const result: CleanupResult = {
    removedWorktrees: 0,
    removedBranches: 0,
    skipped: 0,
    actions: [],
  };

  // Phase 1: Worktrees
  for (const name of dirs) {
    const wtPath = join(paths.worktreesDir, name);
    if (!deps.isDir(wtPath)) continue;

    const branch = getWorktreeBranch(wtPath, deps);
    const lock = readLockFile(wtPath, deps);
    const lc = classifyLockFromData(lock, deps);

    // Lock safety gate
    if (lc === "active" || lc === "stale") {
      const age = lockAge(lock, deps);
      result.actions.push({
        type: "skip",
        target: name,
        reason: `lock (${lc}, heartbeat: ${age})`,
      });
      result.skipped++;
      continue;
    }

    if (lc === "orphaned") {
      const age = lockAge(lock, deps);
      result.actions.push({
        type: "remove-lock",
        target: name,
        reason: `PID dead, heartbeat: ${age}`,
      });
      if (!dryRun) {
        try { deps.unlink(join(wtPath, ".worktree-lock.json")); } catch { /* ignore */ }
      }
    }

    const ms = branchMergeStatus(branch, paths.projectRoot, merged, deps);
    if (ms === "unmerged") continue;

    const dirty = getDirtyFileCount(wtPath, deps);
    if (dirty > 0) {
      result.actions.push({
        type: "skip",
        target: name,
        reason: `dirty files (${dirty})`,
      });
      result.skipped++;
      continue;
    }

    if (ms !== "at-main") {
      const unpushed = getUnpushedCount(wtPath, deps);
      if (unpushed > 0) {
        result.actions.push({
          type: "skip",
          target: name,
          reason: "unpushed commits",
        });
        result.skipped++;
        continue;
      }
    }

    if (!dryRun) {
      try {
        deps.exec(`git -C "${paths.projectRoot}" worktree remove "${wtPath}" --force`);
        result.actions.push({ type: "remove", target: name, reason: ms });
      } catch {
        result.actions.push({ type: "fail", target: name, reason: ms });
      }
    } else {
      result.actions.push({ type: "remove", target: name, reason: `${branch}, ${ms}` });
    }
    result.removedWorktrees++;
  }

  // Phase 2: Merged branches with no worktree
  try {
    const allBranches = deps.exec(`git -C "${paths.projectRoot}" branch`);
    let wtList: string;
    try {
      wtList = deps.exec(`git -C "${paths.projectRoot}" worktree list`);
    } catch {
      wtList = "";
    }

    for (const line of allBranches.split("\n")) {
      const branch = line.replace(/^[* +]*/, "").trim();
      if (!branch || branch === "main") continue;
      if (wtList.includes(`[${branch}]`)) continue;

      let safe: string;
      try { safe = safeBranch(branch); } catch { continue; }

      const ms = branchMergeStatus(branch, paths.projectRoot, merged, deps);
      // -d works for regular merges; squash-merged needs -D (git doesn't see it as merged)
      const deleteFlag = ms === "squash-merged" ? "-D" : "-d";
      if (ms === "merged" || ms === "at-main" || ms === "squash-merged") {
        if (!dryRun) {
          try {
            deps.exec(`git -C "${paths.projectRoot}" branch ${deleteFlag} "${safe}"`);
            result.actions.push({ type: "remove", target: branch, reason: ms });
          } catch { /* skip */ }
        } else {
          result.actions.push({ type: "remove", target: branch, reason: ms });
        }
        result.removedBranches++;
      }
    }
  } catch {
    // no branches to clean
  }

  return result;
}

// ── Formatting / output ──

const isTTY = process.stdout.isTTY;
const RED = isTTY ? "\x1b[0;31m" : "";
const GREEN = isTTY ? "\x1b[0;32m" : "";
const YELLOW = isTTY ? "\x1b[0;33m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const DIM = isTTY ? "\x1b[2m" : "";
const NC = isTTY ? "\x1b[0m" : "";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

function printWorktrees(worktrees: WorktreeInfo[], summary: AnalyzeSummary, fast: boolean) {
  console.log(`${BOLD}Worktrees${NC}`);
  console.log("");

  console.log(
    `  ${DIM}${"NAME".padEnd(42)} ${"SIZE".padStart(7)}  ${"BRANCH".padEnd(18)} ${"LOCK".padEnd(14)} ${"STATE".padEnd(20)} CASE${NC}`,
  );

  for (const wt of worktrees) {
    const size = wt.sizeBytes !== null ? humanSize(wt.sizeBytes) : "-";
    const branchShort = shortenBranch(wt.branch);

    let lockStr: string;
    switch (wt.lockClass) {
      case "active":   lockStr = `${RED}ACTIVE${NC}`; break;
      case "stale":    lockStr = `${YELLOW}stale(${wt.lockAge})${NC}`; break;
      case "orphaned": lockStr = `${YELLOW}orphan(${wt.lockAge})${NC}`; break;
      default:         lockStr = `${DIM}none${NC}`;
    }

    let state = "";
    switch (wt.mergeStatus) {
      case "merged":        state = `${GREEN}merged${NC}`; break;
      case "squash-merged": state = `${GREEN}squash-merged${NC}`; break;
      case "at-main":       state = `${DIM}at-main${NC}`; break;
      default:              state = "unmerged";
    }
    if (wt.dirtyFiles > 0) state += ` ${YELLOW}dirty(${wt.dirtyFiles})${NC}`;
    if (wt.unpushedCommits > 0) state += ` ${YELLOW}unpush(${wt.unpushedCommits})${NC}`;

    const caseStr = wt.caseInfo ?? `${DIM}none${NC}`;

    console.log(
      `  ${wt.name.padEnd(42)} ${size.padStart(7)}  ${branchShort.padEnd(18)} ${lockStr.padEnd(14 + (lockStr.length - lockStr.replace(/\x1b\[[^m]*m/g, "").length))} ${state.padEnd(20 + (state.length - state.replace(/\x1b\[[^m]*m/g, "").length))} ${caseStr}`,
    );
  }

  console.log("");
  console.log(`  ${BOLD}Total:${NC} ${summary.count} worktrees`);
  if (!fast) console.log(`  ${BOLD}Disk:${NC} ${humanSize(summary.totalSize)}`);
  console.log(
    `  Locks: ${RED}${summary.activeLocks} active${NC}, ${YELLOW}${summary.staleLocks} stale/orphaned${NC}  |  Merged: ${GREEN}${summary.merged}${NC}  Dirty: ${YELLOW}${summary.dirty}${NC}`,
  );
}

function printBranches(bs: BranchSummary) {
  console.log("");
  console.log(`${BOLD}Branches${NC}`);
  console.log("");
  console.log(
    `  Total: ${bs.total}  |  Unmerged: ${bs.unmerged}  |  Merged (deletable): ${GREEN}${bs.merged}${NC}`,
  );
  console.log(`  Local-only (never pushed): ${YELLOW}${bs.localOnly}${NC}`);
}

function printCleanup(result: CleanupResult, dryRun: boolean) {
  console.log(`${BOLD}Cleanup${NC}${dryRun ? ` ${YELLOW}(DRY RUN)${NC}` : ""}`);
  console.log("");

  for (const action of result.actions) {
    switch (action.type) {
      case "skip":
        console.log(`    ${YELLOW}SKIP${NC} ${action.target} — ${action.reason}`);
        break;
      case "remove-lock":
        console.log(`    ${DIM}Removing orphaned lock${NC} ${action.target} (${action.reason})`);
        break;
      case "remove":
        if (dryRun) {
          console.log(`    ${GREEN}would remove${NC}: ${action.target} (${action.reason})`);
        } else {
          console.log(`    ${GREEN}REMOVED${NC} ${action.target} (${action.reason})`);
        }
        break;
      case "fail":
        console.log(`    ${RED}FAILED${NC} ${action.target}`);
        break;
    }
  }

  console.log("");
  console.log(
    `  ${BOLD}Summary:${NC} ${result.removedWorktrees} worktrees, ${result.removedBranches} branches cleaned. ${result.skipped} skipped (protected).`,
  );
  if (dryRun) console.log(`  ${YELLOW}Dry run — run without --dry-run to apply.${NC}`);
}

// ── CLI ──

interface CliOptions {
  mode: "analyze" | "cleanup";
  fast: boolean;
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions | "help" | { error: string } {
  const opts: CliOptions = { mode: "analyze", fast: false, dryRun: false };
  for (const arg of argv) {
    switch (arg) {
      case "analyze":   opts.mode = "analyze"; break;
      case "cleanup":   opts.mode = "cleanup"; break;
      case "--fast":    opts.fast = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--help":
      case "-h":
        return "help";
      default:
        return { error: `Unknown arg: ${arg}` };
    }
  }
  return opts;
}

export function main(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
) {
  const opts = parseCliArgs(argv);
  if (typeof opts === "object" && "error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  if (opts === "help") {
    console.log(`worktree-du — Disk usage analysis and cleanup

Usage: worktree-du [analyze|cleanup] [--fast] [--dry-run]

Modes:
  analyze  (default)  Show full disk usage report
  cleanup             Remove stale worktrees, merged branches, dangling Docker images

Flags:
  --fast              Skip slow checks (PR status, Docker, disk usage)
  --dry-run           Show what cleanup would do without doing it`);
    process.exit(0);
  }

  const paths = resolveProjectPaths(cwd);
  const deps = defaultDeps();

  console.log("");
  console.log(`${BOLD}Kaizen Worktree DU${NC}${opts.fast ? " (fast)" : ""}`);
  console.log(`${DIM}${paths.projectRoot}${NC}`);
  console.log("");

  if (opts.mode === "analyze") {
    const { worktrees, summary } = analyzeWorktrees(paths, deps, opts.fast);
    printWorktrees(worktrees, summary, opts.fast);
    printBranches(analyzeBranches(paths.projectRoot, deps));
    // Cases, PRs, Docker, Disk — these shell out to external tools.
    // Keeping them as exec calls for now; they can be extracted later.
    if (!opts.fast) {
      printExternalAnalysis(paths, deps);
    }
  } else {
    const result = cleanupWorktrees(paths, deps, opts.dryRun);
    printCleanup(result, opts.dryRun);

    // Docker cleanup
    if (!opts.dryRun) {
      console.log("");
      console.log(`  ${BOLD}Docker prune${NC}`);
      try {
        const docker = dockerCmd(deps);
        console.log("    Pruning dangling images...");
        try { console.log("    " + deps.exec(`${docker} image prune -f 2>/dev/null | tail -1`)); } catch { console.log("    (skipped)"); }
        console.log("    Pruning build cache...");
        try { console.log("    " + deps.exec(`${docker} builder prune -f 2>/dev/null | tail -1`)); } catch { console.log("    (skipped)"); }
      } catch { /* docker not available */ }
    }

    // Git worktree prune
    console.log("");
    console.log(`  ${BOLD}Git worktree prune${NC}`);
    try {
      const flag = opts.dryRun ? "--dry-run -v" : "-v";
      const out = deps.exec(`git -C "${paths.projectRoot}" worktree prune ${flag}`);
      if (out) console.log("    " + out.split("\n").join("\n    "));
    } catch { /* nothing to prune */ }
  }

  console.log("");
}

function dockerCmd(deps: Deps): string {
  try {
    deps.exec("which docker.exe");
    return "docker.exe";
  } catch {
    return "docker";
  }
}

function printExternalAnalysis(paths: ProjectPaths, deps: Deps) {
  // PRs
  console.log("");
  console.log(`${BOLD}Open PRs${NC}`);
  console.log("");
  try {
    let repo: string;
    try {
      repo = JSON.parse(deps.readFile(join(paths.projectRoot, "kaizen.config.json"))).host?.repo ?? "";
    } catch {
      repo = deps.exec(`git -C "${paths.projectRoot}" remote get-url origin`)
        .replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
    }
    const prs = deps.exec(
      `gh pr list --repo "${repo}" --state open --json number,title,headBranch --jq '.[] | "  #\\(.number)  \\(.headBranch)  \\(.title)"'`,
    );
    console.log(prs || "  (none)");
  } catch {
    console.log("  (none)");
  }

  // Docker
  console.log("");
  console.log(`${BOLD}Docker${NC}`);
  console.log("");
  try {
    const docker = dockerCmd(deps);
    const df = deps.exec(`${docker} system df 2>&1`);
    console.log(df.split("\n").map((l) => `  ${l}`).join("\n"));
  } catch {
    console.log("  (Docker not available)");
  }

  // Disk
  console.log("");
  console.log(`${BOLD}Disk${NC}`);
  console.log("");
  const duSafe = (p: string, extra = "") => {
    try { return deps.exec(`du -sh ${extra} "${p}" 2>/dev/null | cut -f1`); } catch { return "?"; }
  };
  console.log(`  Worktrees:        ${duSafe(paths.worktreesDir)}`);
  console.log(`  Project (ex-wt):  ${duSafe(paths.projectRoot, '--exclude=".claude/worktrees"')}`);
  console.log(`  Store (DB+data):  ${duSafe(join(paths.projectRoot, "store"))}`);
}

// Run when executed directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("worktree-du.ts") ||
    process.argv[1].endsWith("worktree-du.js"));
if (isMain) {
  main();
}
