import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  detectInstall,
  generateConfig,
  scaffoldPolicies,
  verifySetup,
} from "./kaizen-setup.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kaizen-setup-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("detectInstall", () => {
  it("detects plugin install via CLAUDE_PLUGIN_ROOT", () => {
    const result = detectInstall({ cwd: tempDir, env: { CLAUDE_PLUGIN_ROOT: "/plugins/kaizen" } });
    expect(result).toEqual({ step: "detect", status: "ok", method: "plugin", root: "/plugins/kaizen", needsInstall: true });
  });

  it("reports needsInstall=false when node_modules exists", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: { CLAUDE_PLUGIN_ROOT: pluginRoot } });
    expect(result.needsInstall).toBe(false);
  });

  it("returns none when CLAUDE_PLUGIN_ROOT is not set", () => {
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result).toEqual({ step: "detect", status: "ok", method: "none", root: "" });
  });
});

describe("generateConfig", () => {
  it("generates valid JSON config", () => {
    const result = generateConfig({ name: "my-project", repo: "org/my-project", description: "A test project" }, tempDir);
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.name).toBe("my-project");
    expect(config.host.repo).toBe("org/my-project");
    expect(config.kaizen.repo).toBe("Garsson-io/kaizen");
    expect(config.notifications.channel).toBe("none");
  });

  it("handles special characters in name", () => {
    const result = generateConfig({ name: 'project "with quotes"', repo: "org/repo", description: "has 'quotes' and \"doubles\"" }, tempDir);
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.name).toBe('project "with quotes"');
  });

  it("includes caseCli when provided", () => {
    generateConfig({ name: "p", repo: "o/r", description: "d", caseCli: "npx tsx src/cli.ts" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.caseCli).toBe("npx tsx src/cli.ts");
  });

  it("omits caseCli when not provided", () => {
    generateConfig({ name: "p", repo: "o/r", description: "d" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host).not.toHaveProperty("caseCli");
  });

  it("errors on missing required fields", () => {
    const result = generateConfig({ name: "", repo: "o/r", description: "d" }, tempDir);
    expect(result.status).toBe("error");
  });

  it("uses custom kaizen repo", () => {
    generateConfig({ name: "p", repo: "o/r", description: "d", kaizenRepo: "other/kaizen" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.kaizen.repo).toBe("other/kaizen");
  });
});

describe("scaffoldPolicies", () => {
  it("creates policies-local.md", () => {
    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("ok");
    expect(existsSync(join(tempDir, ".claude", "kaizen", "policies-local.md"))).toBe(true);
  });

  it("skips if already exists", () => {
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "existing content");

    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("skipped");

    const content = readFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "utf-8");
    expect(content).toBe("existing content");
  });
});

describe("verifySetup", () => {
  it("reports all failures for empty project", () => {
    const result = verifySetup(tempDir);
    expect(result.status).toBe("failed");
    expect(result.failed).toBeGreaterThan(0);
  });

  it("passes for complete plugin setup", () => {
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Project\n\n## Kaizen\nkaizen stuff");

    const result = verifySetup(tempDir);
    expect(result.status).toBe("ok");
    expect(result.failed).toBe(0);
  });

  it("detects missing config", () => {
    const result = verifySetup(tempDir);
    const configCheck = result.checks.find(c => c.name === "config-exists");
    expect(configCheck?.ok).toBe(false);
  });

  it("detects invalid config JSON", () => {
    writeFileSync(join(tempDir, "kaizen.config.json"), "not json");
    const result = verifySetup(tempDir);
    const configCheck = result.checks.find(c => c.name === "config-valid");
    expect(configCheck?.ok).toBe(false);
  });

  it("detects missing CLAUDE.md", () => {
    const result = verifySetup(tempDir);
    const check = result.checks.find(c => c.name === "claudemd-exists");
    expect(check?.ok).toBe(false);
  });

  it("detects CLAUDE.md without kaizen content", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Project\nNo plugin content here.");
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    const result = verifySetup(tempDir);
    const check = result.checks.find(c => c.name === "claudemd-kaizen");
    expect(check?.ok).toBe(false);
  });
});
