import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot, resolveProjectPaths } from "./resolve-project-root.js";

describe("resolveProjectRoot", () => {
  it("routes default git lookup through an argv runner", () => {
    const source = readFileSync(fileURLToPath(new URL("./resolve-project-root.ts", import.meta.url)), "utf-8");

    expect(source).not.toContain("execSync");
    expect(source).not.toContain('git -C "${dir}" rev-parse --show-toplevel');
    expect(source).toContain("spawnSync('git', args");
    expect(source).toContain("['-C', dir, 'rev-parse', '--show-toplevel']");
  });

  it("returns git toplevel when in a repo", () => {
    const git = (args: readonly string[]) => {
      expect(args).toEqual(["-C", "/home/user/project/src", "rev-parse", "--show-toplevel"]);
      return "/home/user/project";
    };
    expect(resolveProjectRoot("/home/user/project/src", git)).toBe("/home/user/project");
  });

  it("falls back to parent dir when git fails", () => {
    const git = () => { throw new Error("not a git repo"); };
    expect(resolveProjectRoot("/some/dir", git)).toMatch(/\/some$/);
  });

  it("falls back when exec returns empty", () => {
    const git = () => "";
    const result = resolveProjectRoot("/some/dir", git);
    expect(result).toMatch(/\/some$/);
  });
});

describe("resolveProjectPaths", () => {
  it("derives all paths from project root", () => {
    const git = () => "/repo";
    const paths = resolveProjectPaths("/repo/src", git);
    expect(paths.projectRoot).toBe("/repo");
    expect(paths.scriptDir).toBe("/repo/scripts");
    expect(paths.worktreesDir).toBe("/repo/.claude/worktrees");
  });
});
