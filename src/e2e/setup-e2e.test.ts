/**
 * setup-e2e.test.ts — E2E tests for kaizen plugin setup on host projects.
 *
 * Uses SyntheticProject to create isolated host projects of various types
 * (Python, Node, Rust, Go, bare) and verifies the full setup flow works.
 *
 * These tests would have caught every bug in #756:
 *   - Config written to wrong dir → test verifies file is in project root
 *   - Detect returns "none" for plugins → test checks detect returns "plugin"
 *   - Verify checks wrong dir → test runs verify against project root
 */

import { describe, it, expect, afterEach } from "vitest";
import { SyntheticProject, type ProjectLanguage } from "./synthetic-project.js";

describe("Setup E2E", () => {
  let project: SyntheticProject;

  afterEach(() => {
    project?.cleanup();
  });

  const CONFIG = {
    name: "test-project",
    repo: "org/test-project",
    description: "A test project for kaizen setup",
  };

  describe("detection", () => {
    it("detects plugin install via CLAUDE_PLUGIN_ROOT", () => {
      project = new SyntheticProject({ language: "python" });
      const result = project.runDetect();
      expect(result.method).toBe("plugin");
      expect(result.root).toBeTruthy();
    });
  });

  describe("full setup on different project types", () => {
    const languages: ProjectLanguage[] = ["python", "node", "rust", "go", "bare"];

    for (const lang of languages) {
      it(`completes setup on a ${lang} project`, () => {
        project = new SyntheticProject({ language: lang });

        const verify = project.fullSetup(CONFIG);
        expect(verify.status).toBe("ok");
        expect(verify.failed).toBe(0);
      });
    }
  });

  describe("config generation", () => {
    it("writes kaizen.config.json to project root", () => {
      project = new SyntheticProject();
      project.runConfig(CONFIG);

      expect(project.fileExists("kaizen.config.json")).toBe(true);
      const config = JSON.parse(project.readFile("kaizen.config.json"));
      expect(config.host.name).toBe("test-project");
      expect(config.host.repo).toBe("org/test-project");
      expect(config.kaizen.repo).toBe("Garsson-io/kaizen");
    });

    it("does not write to plugin cache directory", () => {
      project = new SyntheticProject();
      project.runConfig(CONFIG);

      // The config should be in the project root, not the kaizen repo root
      const configPath = project.readFile("kaizen.config.json");
      expect(configPath).not.toContain("plugins/cache");
    });
  });

  describe("scaffold", () => {
    it("creates policies-local.md in project .claude/kaizen/", () => {
      project = new SyntheticProject();
      project.runScaffold();

      expect(project.fileExists(".claude/kaizen/policies-local.md")).toBe(true);
      const content = project.readFile(".claude/kaizen/policies-local.md");
      expect(content).toContain("Host-Specific Kaizen Policies");
    });

    it("is idempotent — re-running does not overwrite", () => {
      project = new SyntheticProject();
      project.runScaffold();
      project.writeFile(".claude/kaizen/policies-local.md", "custom policies");
      project.runScaffold();

      expect(project.readFile(".claude/kaizen/policies-local.md")).toBe("custom policies");
    });
  });

  describe("verification", () => {
    it("fails for unconfigured project", () => {
      project = new SyntheticProject();
      const result = project.runVerify();
      expect(result.status).toBe("failed");
    });

    it("passes after full setup", () => {
      project = new SyntheticProject();
      const result = project.fullSetup(CONFIG);
      expect(result.status).toBe("ok");
      expect(result.checks.every(c => c.ok)).toBe(true);
    });

    it("detects missing CLAUDE.md plugin section", () => {
      project = new SyntheticProject({ claudeMdContent: "# Project\nJust a plain project." });
      project.runConfig(CONFIG);
      project.runScaffold();

      const result = project.runVerify();
      const check = result.checks.find(c => c.name === "claudemd-kaizen");
      expect(check?.ok).toBe(false);
    });
  });

  describe("session bridge", () => {
    it("creates a working session simulator", () => {
      project = new SyntheticProject({ language: "python" });
      project.fullSetup(CONFIG);

      const session = project.createSession();
      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.timeoutCount).toBe(0);
      expect(session.totalHooksRun).toBeGreaterThan(0);

      session.cleanup();
    });
  });
});
