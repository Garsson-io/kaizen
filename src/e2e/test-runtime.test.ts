import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTypeScriptHookRunner, resolveTsxBin } from "./test-runtime.js";

describe("E2E test runtime helpers", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  function executableTsx(path: string): void {
    writeFileSync(path, "#!/bin/bash\nexit 0\n");
    chmodSync(path, 0o755);
  }

  function executableFile(path: string): void {
    writeFileSync(path, "#!/bin/bash\nexit 0\n");
    chmodSync(path, 0o755);
  }

  it("resolves tsx from the repo root first", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-runtime-"));
    const binDir = join(tmpRoot, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const tsx = join(binDir, "tsx");
    executableTsx(tsx);

    expect(resolveTsxBin(tmpRoot)).toBe(tsx);
  });

  it("falls back to parent node_modules for worktree-style checkouts", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-runtime-"));
    const repoRoot = join(tmpRoot, "worktrees", "case-123");
    const binDir = join(tmpRoot, "worktrees", "node_modules", ".bin");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const tsx = join(binDir, "tsx");
    executableTsx(tsx);

    expect(resolveTsxBin(repoRoot)).toBe(tsx);
  });

  it("prefers Bun for hook-wrapper TypeScript execution", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-runtime-"));
    const binDir = join(tmpRoot, "bin");
    const repoBinDir = join(tmpRoot, "repo", "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoBinDir, { recursive: true });
    const bun = join(binDir, "bun");
    const tsx = join(repoBinDir, "tsx");
    executableFile(bun);
    executableTsx(tsx);

    expect(resolveTypeScriptHookRunner({
      repoRoot: join(tmpRoot, "repo"),
      env: { PATH: binDir },
    })).toEqual({ command: bun, runtime: "bun" });
  });

  it("falls back to tsx for hook-wrapper TypeScript execution when Bun is unavailable", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-runtime-"));
    const repoRoot = join(tmpRoot, "repo");
    const binDir = join(repoRoot, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const tsx = join(binDir, "tsx");
    executableTsx(tsx);

    expect(resolveTypeScriptHookRunner({
      repoRoot,
      env: { PATH: "" },
    })).toEqual({ command: tsx, runtime: "tsx" });
  });
});
