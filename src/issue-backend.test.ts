import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readIssueConfig,
  createIssueBackend,
  GitHubBackend,
  CustomCliBackend,
  type IssueBackendConfig,
} from "./issue-backend.js";

const ISSUE_BACKEND_SOURCE = readFileSync(new URL("./issue-backend.ts", import.meta.url), "utf-8");

describe("config JSON helper source invariant", () => {
  it("routes kaizen.config.json reads through readJsonObjectFile", () => {
    expect(ISSUE_BACKEND_SOURCE).toContain("readJsonObjectFile");
    expect(ISSUE_BACKEND_SOURCE).not.toContain("JSON.parse(readFileSync(configPath");
  });
});

describe("readIssueConfig", () => {
  let tempDir: string;

  it("returns github default when no config file exists", () => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-be-test-"));
    const config = readIssueConfig(tempDir);
    expect(config.backend).toBe("github");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns github default when issues section is missing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-be-test-"));
    writeFileSync(
      join(tempDir, "kaizen.config.json"),
      JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }),
    );
    const config = readIssueConfig(tempDir);
    expect(config.backend).toBe("github");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads github backend from config", () => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-be-test-"));
    writeFileSync(
      join(tempDir, "kaizen.config.json"),
      JSON.stringify({ issues: { backend: "github" } }),
    );
    const config = readIssueConfig(tempDir);
    expect(config.backend).toBe("github");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads custom backend with CLI path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-be-test-"));
    writeFileSync(
      join(tempDir, "kaizen.config.json"),
      JSON.stringify({
        issues: {
          backend: "custom",
          config: { customCli: "linear-issue-cli" },
        },
      }),
    );
    const config = readIssueConfig(tempDir);
    expect(config.backend).toBe("custom");
    expect(config.config?.customCli).toBe("linear-issue-cli");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["malformed", "{not json"],
    ["blank", "   "],
    ["array", "[]"],
    ["primitive", "\"text\""],
  ])("returns github default when config file is %s", (_name, content) => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-be-test-"));
    writeFileSync(join(tempDir, "kaizen.config.json"), content);

    expect(readIssueConfig(tempDir).backend).toBe("github");

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("createIssueBackend", () => {
  it("creates GitHubBackend by default", () => {
    const backend = createIssueBackend({ backend: "github" });
    expect(backend).toBeInstanceOf(GitHubBackend);
    expect(backend.name).toBe("github");
  });

  it("creates CustomCliBackend when configured", () => {
    const backend = createIssueBackend({
      backend: "custom",
      config: { customCli: "my-issue-tool" },
    });
    expect(backend).toBeInstanceOf(CustomCliBackend);
    expect(backend.name).toBe("custom");
  });

  it("throws when custom backend has no CLI", () => {
    expect(() => createIssueBackend({ backend: "custom" })).toThrow(
      /customCli/,
    );
  });

  it("defaults to github for unknown backend", () => {
    const backend = createIssueBackend({ backend: "github" });
    expect(backend.name).toBe("github");
  });
});

describe("GitHubBackend gh execution", () => {
  it("passes GitHub issue create arguments through the shared argv-based gh helper", async () => {
    vi.resetModules();
    const spawnSync = vi.fn(() => ({
      status: 0,
      stdout: "https://github.com/Garsson-io/kaizen/issues/42\n",
      stderr: "",
    }));
    const execSync = vi.fn(() => "https://github.com/Garsson-io/kaizen/issues/42");
    vi.doMock("node:child_process", () => ({ spawnSync, execSync }));

    try {
      const { GitHubBackend: MockedGitHubBackend } = await import("./issue-backend.js");

      const result = new MockedGitHubBackend().create({
        repo: "Garsson-io/kaizen",
        title: "Title with spaces; $(touch nope)",
        body: "Body with `backticks` and \"quotes\"",
        labels: ["kaizen", "needs review"],
      });

      expect(result).toEqual({
        number: 42,
        url: "https://github.com/Garsson-io/kaizen/issues/42",
      });
      expect(spawnSync).toHaveBeenCalledWith("gh", [
        "issue",
        "create",
        "--repo",
        "Garsson-io/kaizen",
        "--title",
        "Title with spaces; $(touch nope)",
        "--body",
        "Body with `backticks` and \"quotes\"",
        "--label",
        "kaizen",
        "--label",
        "needs review",
      ], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(execSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("CustomCliBackend execution", () => {
  it("passes custom CLI create arguments as argv without shell flattening", async () => {
    vi.resetModules();
    const spawnSync = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        number: 77,
        url: "https://issues.example/custom/77",
      }),
      stderr: "",
    }));
    const execSync = vi.fn(() => JSON.stringify({
      number: 77,
      url: "https://issues.example/custom/77",
    }));
    vi.doMock("node:child_process", () => ({ spawnSync, execSync }));

    try {
      const { CustomCliBackend: MockedCustomCliBackend } = await import("./issue-backend.js");

      const result = new MockedCustomCliBackend("/opt/bin/custom-issues").create({
        repo: "Garsson-io/kaizen",
        title: "Title with spaces; $(touch nope)",
        body: "Body with `backticks` and \"quotes\"",
        labels: ["kaizen", "needs review"],
      });

      expect(result).toEqual({
        number: 77,
        url: "https://issues.example/custom/77",
      });
      expect(spawnSync).toHaveBeenCalledWith("/opt/bin/custom-issues", [
        "create",
        "--title",
        "Title with spaces; $(touch nope)",
        "--body",
        "Body with `backticks` and \"quotes\"",
        "--label",
        "kaizen",
        "--label",
        "needs review",
        "--repo",
        "Garsson-io/kaizen",
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(execSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
