import { describe, it, expect } from "vitest";
import { resolveProjectRoot, resolveProjectPaths } from "./resolve-project-root.js";

describe("resolveProjectRoot", () => {
  it("returns git toplevel when in a repo", () => {
    const exec = () => "/home/user/project";
    expect(resolveProjectRoot("/home/user/project/src", exec)).toBe("/home/user/project");
  });

  it("falls back to parent dir when git fails", () => {
    const exec = () => { throw new Error("not a git repo"); };
    expect(resolveProjectRoot("/some/dir", exec)).toMatch(/\/some$/);
  });

  it("falls back when exec returns empty", () => {
    const exec = () => "";
    const result = resolveProjectRoot("/some/dir", exec);
    expect(result).toMatch(/\/some$/);
  });
});

describe("resolveProjectPaths", () => {
  it("derives all paths from project root", () => {
    const exec = () => "/repo";
    const paths = resolveProjectPaths("/repo/src", exec);
    expect(paths.projectRoot).toBe("/repo");
    expect(paths.scriptDir).toBe("/repo/scripts");
    expect(paths.worktreesDir).toBe("/repo/.claude/worktrees");
  });
});
