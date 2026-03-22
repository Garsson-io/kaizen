import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readIssueConfig,
  createIssueBackend,
  GitHubBackend,
  CustomCliBackend,
  type IssueBackendConfig,
} from "./issue-backend.js";

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
