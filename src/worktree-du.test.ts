import { describe, it, expect } from "vitest";
import {
  classifyLock,
  lockAge,
  branchMergeStatus,
  getMergedBranches,
  analyzeWorktrees,
  analyzeBranches,
  cleanupWorktrees,
  parseCliArgs,
  type Deps,
  type LockFile,
} from "./worktree-du.js";
import type { ProjectPaths } from "./lib/resolve-project-root.js";

// ── Test helpers ──

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    exec: () => "",
    pidAlive: () => false,
    now: () => Date.now(),
    readFile: () => "",
    exists: () => false,
    readdir: () => [],
    isDir: () => true,
    dirSize: () => 0,
    unlink: () => {},
    ...overrides,
  };
}

function makePaths(root = "/project"): ProjectPaths {
  return {
    projectRoot: root,
    scriptDir: `${root}/scripts`,
    worktreesDir: `${root}/.claude/worktrees`,
  };
}

function lockJson(lock: LockFile): string {
  return JSON.stringify(lock);
}

// ── Lock classification ──

describe("classifyLock", () => {
  it("returns 'none' when no lock file", () => {
    const deps = makeDeps({ exists: () => false });
    expect(classifyLock("/wt", deps)).toBe("none");
  });

  it("returns 'orphaned' when PID is dead", () => {
    const deps = makeDeps({
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 99999, heartbeat: new Date().toISOString() }),
      pidAlive: () => false,
    });
    expect(classifyLock("/wt", deps)).toBe("orphaned");
  });

  it("returns 'active' for live PID + fresh heartbeat", () => {
    const now = Date.now();
    const deps = makeDeps({
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 1, heartbeat: new Date(now - 60000).toISOString() }),
      pidAlive: () => true,
      now: () => now,
    });
    expect(classifyLock("/wt", deps)).toBe("active");
  });

  it("returns 'stale' for live PID + old heartbeat", () => {
    const now = Date.now();
    const deps = makeDeps({
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 1, heartbeat: new Date(now - 3600000).toISOString() }),
      pidAlive: () => true,
      now: () => now,
    });
    expect(classifyLock("/wt", deps)).toBe("stale");
  });

  it("returns 'stale' for live PID with no heartbeat", () => {
    const deps = makeDeps({
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 1 }),
      pidAlive: () => true,
    });
    expect(classifyLock("/wt", deps)).toBe("stale");
  });

  it("uses started_at as fallback for heartbeat", () => {
    const now = Date.now();
    const deps = makeDeps({
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 1, started_at: new Date(now - 60000).toISOString() }),
      pidAlive: () => true,
      now: () => now,
    });
    expect(classifyLock("/wt", deps)).toBe("active");
  });
});

describe("lockAge", () => {
  it("returns null when no lock", () => {
    const deps = makeDeps();
    expect(lockAge(null, deps)).toBeNull();
  });

  it("returns minutes for recent locks", () => {
    const now = Date.now();
    const deps = makeDeps({ now: () => now });
    expect(lockAge({ heartbeat: new Date(now - 5 * 60000).toISOString() }, deps)).toBe("5min");
  });

  it("returns hours for older locks", () => {
    const now = Date.now();
    const deps = makeDeps({ now: () => now });
    expect(lockAge({ heartbeat: new Date(now - 120 * 60000).toISOString() }, deps)).toBe("2hr");
  });

  it("returns days for old locks", () => {
    const now = Date.now();
    const deps = makeDeps({ now: () => now });
    expect(lockAge({ heartbeat: new Date(now - 2 * 1440 * 60000).toISOString() }, deps)).toBe("2d");
  });

  it("returns '?' when no heartbeat or started_at", () => {
    const deps = makeDeps();
    expect(lockAge({}, deps)).toBe("?");
  });
});

// ── Branch merge status ──

describe("branchMergeStatus", () => {
  it("returns 'at-main' for branch with 0 ahead", () => {
    const merged = new Set(["main", "my-branch"]);
    const deps = makeDeps({ exec: () => "0" });
    expect(branchMergeStatus("my-branch", "/repo", merged, deps)).toBe("at-main");
  });

  it("returns 'merged' for branch ahead > 0 in merged set", () => {
    const merged = new Set(["main", "my-branch"]);
    const deps = makeDeps({ exec: () => "3" });
    expect(branchMergeStatus("my-branch", "/repo", merged, deps)).toBe("merged");
  });

  it("returns 'squash-merged' when diff is empty", () => {
    const merged = new Set(["main"]);
    const deps = makeDeps({ exec: () => "" });
    expect(branchMergeStatus("my-branch", "/repo", merged, deps)).toBe("squash-merged");
  });

  it("returns 'unmerged' when diff has content", () => {
    const merged = new Set(["main"]);
    const deps = makeDeps({ exec: () => " src/foo.ts | 5 +++--" });
    expect(branchMergeStatus("my-branch", "/repo", merged, deps)).toBe("unmerged");
  });
});

describe("getMergedBranches", () => {
  it("parses git branch --merged output", () => {
    const deps = makeDeps({
      exec: () => "* main\n  feature-a\n  feature-b",
    });
    const result = getMergedBranches("/repo", deps);
    expect(result).toEqual(new Set(["main", "feature-a", "feature-b"]));
  });

  it("returns empty set on error", () => {
    const deps = makeDeps({
      exec: () => { throw new Error("fail"); },
    });
    expect(getMergedBranches("/repo", deps)).toEqual(new Set());
  });
});

// ── Analyze ──

describe("analyzeWorktrees", () => {
  it("returns empty for no worktrees", () => {
    const deps = makeDeps({ readdir: () => [] });
    const { worktrees, summary } = analyzeWorktrees(makePaths(), deps, true);
    expect(worktrees).toEqual([]);
    expect(summary.count).toBe(0);
  });

  it("collects worktree info", () => {
    const now = Date.now();
    const deps = makeDeps({
      readdir: () => ["wt-1", "wt-2"],
      isDir: () => true,
      exists: (p) => p.endsWith(".worktree-lock.json") && p.includes("wt-1"),
      readFile: () => lockJson({ pid: 1, heartbeat: new Date(now - 60000).toISOString() }),
      pidAlive: () => true,
      now: () => now,
      exec: (cmd) => {
        if (cmd.includes("rev-parse --abbrev-ref")) return "main";
        if (cmd.includes("branch --merged")) return "* main";
        if (cmd.includes("rev-list --count")) return "0";
        if (cmd.includes("status --porcelain")) return "";
        if (cmd.includes("log --oneline")) return "";
        return "";
      },
    });

    const { worktrees, summary } = analyzeWorktrees(makePaths(), deps, true);
    expect(worktrees).toHaveLength(2);
    expect(summary.count).toBe(2);
    expect(worktrees[0].lockClass).toBe("active");
    expect(worktrees[1].lockClass).toBe("none");
  });
});

describe("analyzeBranches", () => {
  it("counts branches correctly", () => {
    const deps = makeDeps({
      exec: (cmd) => {
        if (cmd.includes("config \"branch.")) throw new Error("no remote");
        if (cmd.includes("--merged")) return "* main\n  feat-a\n  feat-b";
        if (cmd.includes("--no-merged")) return "  feat-c";
        if (cmd.includes("branch")) return "* main\n  feat-a\n  feat-b\n  feat-c";
        return "";
      },
    });
    const result = analyzeBranches("/repo", deps);
    expect(result.total).toBe(4); // 2 merged + 1 unmerged + main
    expect(result.merged).toBe(2);
    expect(result.unmerged).toBe(1);
    expect(result.localOnly).toBe(3); // feat-a, feat-b, feat-c
  });
});

// ── Cleanup ──

describe("cleanupWorktrees", () => {
  it("skips active locks", () => {
    const now = Date.now();
    const deps = makeDeps({
      readdir: () => ["wt-locked"],
      isDir: () => true,
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 1, heartbeat: new Date(now - 60000).toISOString() }),
      pidAlive: () => true,
      now: () => now,
      exec: (cmd) => {
        if (cmd.includes("branch --merged")) return "* main";
        return "";
      },
    });

    const result = cleanupWorktrees(makePaths(), deps, false);
    expect(result.skipped).toBe(1);
    expect(result.actions[0].type).toBe("skip");
    expect(result.actions[0].reason).toContain("active");
  });

  it("removes orphaned lock then cleans merged worktree", () => {
    const now = Date.now();
    let unlinkCalled = false;
    const deps = makeDeps({
      readdir: () => ["wt-orphan"],
      isDir: () => true,
      exists: (p) => p.endsWith(".worktree-lock.json"),
      readFile: () => lockJson({ pid: 99999, heartbeat: new Date(now - 60000).toISOString() }),
      pidAlive: () => false,
      now: () => now,
      unlink: () => { unlinkCalled = true; },
      exec: (cmd) => {
        if (cmd.includes("rev-parse --abbrev-ref")) return "feat-done";
        if (cmd.includes("branch --merged")) return "* main\n  feat-done";
        if (cmd.includes("rev-list --count")) return "2";
        if (cmd.includes("status --porcelain")) return "";
        if (cmd.includes("log --oneline")) return "";
        if (cmd.includes("worktree remove")) return "";
        if (cmd.includes("worktree list")) return "";
        if (cmd.includes("branch\"") && !cmd.includes("--")) return "* main\n  feat-done";
        if (cmd.includes("branch -d")) return "";
        return "";
      },
    });

    const result = cleanupWorktrees(makePaths(), deps, false);
    expect(unlinkCalled).toBe(true);
    expect(result.removedWorktrees).toBe(1);
    expect(result.actions.some((a) => a.type === "remove-lock")).toBe(true);
  });

  it("skips dirty worktrees", () => {
    const deps = makeDeps({
      readdir: () => ["wt-dirty"],
      isDir: () => true,
      exists: () => false,
      exec: (cmd) => {
        if (cmd.includes("rev-parse --abbrev-ref")) return "feat-x";
        if (cmd.includes("branch --merged")) return "* main\n  feat-x";
        if (cmd.includes("rev-list --count")) return "1";
        if (cmd.includes("status --porcelain")) return "M src/foo.ts";
        return "";
      },
    });

    const result = cleanupWorktrees(makePaths(), deps, false);
    expect(result.skipped).toBe(1);
    expect(result.actions[0].reason).toContain("dirty");
  });

  it("skips unmerged worktrees silently", () => {
    const deps = makeDeps({
      readdir: () => ["wt-wip"],
      isDir: () => true,
      exists: () => false,
      exec: (cmd) => {
        if (cmd.includes("rev-parse --abbrev-ref")) return "feat-wip";
        if (cmd.includes("branch --merged")) return "* main";
        if (cmd.includes("diff --stat")) return " src/foo.ts | 3 +++";
        return "";
      },
    });

    const result = cleanupWorktrees(makePaths(), deps, false);
    expect(result.removedWorktrees).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("dry-run does not call unlink or exec remove", () => {
    let execCmds: string[] = [];
    const deps = makeDeps({
      readdir: () => ["wt-clean"],
      isDir: () => true,
      exists: () => false,
      exec: (cmd) => {
        execCmds.push(cmd);
        if (cmd.includes("rev-parse --abbrev-ref")) return "main";
        if (cmd.includes("branch --merged")) return "* main";
        if (cmd.includes("rev-list --count")) return "0";
        if (cmd.includes("status --porcelain")) return "";
        if (cmd.includes("worktree list")) return "";
        if (cmd.includes("branch\"") && !cmd.includes("--")) return "* main";
        return "";
      },
    });

    const result = cleanupWorktrees(makePaths(), deps, true);
    expect(result.removedWorktrees).toBe(1);
    expect(execCmds.some((c) => c.includes("worktree remove"))).toBe(false);
  });
});

// ── CLI arg parsing ──

describe("parseCliArgs", () => {
  it("defaults to analyze mode", () => {
    const opts = parseCliArgs([]);
    expect(opts).not.toBe("help");
    if (opts === "help") return;
    expect(opts.mode).toBe("analyze");
    expect(opts.fast).toBe(false);
    expect(opts.dryRun).toBe(false);
  });

  it("parses cleanup mode", () => {
    const opts = parseCliArgs(["cleanup", "--dry-run"]);
    expect(opts).not.toBe("help");
    if (opts === "help") return;
    expect(opts.mode).toBe("cleanup");
    expect(opts.dryRun).toBe(true);
  });

  it("parses --fast", () => {
    const opts = parseCliArgs(["--fast"]);
    expect(opts).not.toBe("help");
    if (opts === "help") return;
    expect(opts.fast).toBe(true);
  });

  it("returns help", () => {
    expect(parseCliArgs(["--help"])).toBe("help");
    expect(parseCliArgs(["-h"])).toBe("help");
  });
});
