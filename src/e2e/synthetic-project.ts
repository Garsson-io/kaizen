/**
 * synthetic-project.ts — Reusable synthetic host project for E2E testing.
 *
 * Creates an isolated temporary directory that looks like a real host project,
 * with configurable language, git repo, and CLAUDE.md. Runs kaizen setup
 * functions against it and bridges to SessionSimulator for hook testing.
 *
 * Usage:
 *   const project = new SyntheticProject({ language: "python" });
 *   project.setup({ name: "my-app", repo: "org/app", description: "test" });
 *   expect(project.verify().status).toBe("ok");
 *   const session = project.createSession();
 *   session.fireBashPre("echo hello");
 *   expect(session.timeoutCount).toBe(0);
 *   project.cleanup();
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  detectInstall,
  generateConfig,
  scaffoldPolicies,
  verifySetup,
  type DetectResult,
  type ConfigInput,
  type ConfigResult,
  type ScaffoldResult,
  type VerifyResult,
} from "../kaizen-setup.js";

import { SessionSimulator } from "./session-simulator.js";

// ── Types ──

export type ProjectLanguage = "python" | "node" | "rust" | "go" | "bare";

export interface SyntheticProjectOpts {
  language?: ProjectLanguage;
  hasGit?: boolean;
  hasClaudeMd?: boolean;
  claudeMdContent?: string;
}

// ── Constants ──

const KAIZEN_ROOT = resolve(__dirname, "../..");

// ── SyntheticProject ──

export class SyntheticProject {
  readonly projectRoot: string;
  readonly language: ProjectLanguage;
  private cleaned = false;

  constructor(opts?: SyntheticProjectOpts) {
    this.language = opts?.language ?? "bare";
    this.projectRoot = mkdtempSync(join(tmpdir(), `synth-${this.language}-`));

    // Initialize git repo (most real projects have one)
    if (opts?.hasGit !== false) {
      execSync("git init && git config user.name test && git config user.email test@test.com", {
        cwd: this.projectRoot,
        stdio: "ignore",
      });
    }

    // Create language-specific scaffolding
    this.scaffoldLanguage();

    // Create CLAUDE.md if requested (default: yes)
    if (opts?.hasClaudeMd !== false) {
      writeFileSync(
        join(this.projectRoot, "CLAUDE.md"),
        opts?.claudeMdContent ?? `# ${this.language} project\n\nA synthetic test project.\n`,
      );
    }
  }

  // ── Setup Operations ──

  runDetect(): DetectResult {
    return detectInstall({
      cwd: this.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: KAIZEN_ROOT },
    });
  }

  runConfig(input: ConfigInput): ConfigResult {
    return generateConfig(input, this.projectRoot);
  }

  runScaffold(): ScaffoldResult {
    return scaffoldPolicies(this.projectRoot);
  }

  runVerify(): VerifyResult {
    return verifySetup(this.projectRoot);
  }

  /**
   * Run the full setup flow: config → scaffold → inject CLAUDE.md section.
   * Mirrors what /kaizen-setup skill does interactively.
   */
  fullSetup(input: ConfigInput): VerifyResult {
    const configResult = this.runConfig(input);
    if (configResult.status !== "ok") {
      throw new Error(`Config failed: ${configResult.error}`);
    }

    this.runScaffold();

    // Inject kaizen section into CLAUDE.md (simulates what the skill does)
    this.injectClaudeMdKaizen();

    return this.runVerify();
  }

  // ── Session Simulator Bridge ──

  /**
   * Create a SessionSimulator configured for this synthetic project.
   * The session's HOME is clean (no kaizen@kaizen), and hooks fire
   * as they would in a real host project with kaizen installed as a plugin.
   */
  createSession(): SessionSimulator {
    const session = new SessionSimulator();
    session.setHome("clean");
    return session;
  }

  // ── File Inspection ──

  fileExists(relativePath: string): boolean {
    return existsSync(join(this.projectRoot, relativePath));
  }

  readFile(relativePath: string): string {
    return readFileSync(join(this.projectRoot, relativePath), "utf-8");
  }

  writeFile(relativePath: string, content: string): void {
    const fullPath = join(this.projectRoot, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // ── Cleanup ──

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    rmSync(this.projectRoot, { recursive: true, force: true });
  }

  // ── Internals ──

  private scaffoldLanguage(): void {
    switch (this.language) {
      case "python":
        writeFileSync(join(this.projectRoot, "pyproject.toml"), '[project]\nname = "synth"\nversion = "0.1.0"\n');
        mkdirSync(join(this.projectRoot, "src"), { recursive: true });
        writeFileSync(join(this.projectRoot, "src", "__init__.py"), "");
        break;
      case "node":
        writeFileSync(join(this.projectRoot, "package.json"), '{"name": "synth", "version": "0.1.0"}\n');
        mkdirSync(join(this.projectRoot, "src"), { recursive: true });
        writeFileSync(join(this.projectRoot, "src", "index.ts"), "export {};\n");
        break;
      case "rust":
        writeFileSync(join(this.projectRoot, "Cargo.toml"), '[package]\nname = "synth"\nversion = "0.1.0"\n');
        mkdirSync(join(this.projectRoot, "src"), { recursive: true });
        writeFileSync(join(this.projectRoot, "src", "main.rs"), 'fn main() {}\n');
        break;
      case "go":
        writeFileSync(join(this.projectRoot, "go.mod"), "module synth\n\ngo 1.21\n");
        writeFileSync(join(this.projectRoot, "main.go"), 'package main\n\nfunc main() {}\n');
        break;
      case "bare":
        break;
    }
  }

  private injectClaudeMdKaizen(): void {
    const claudeMdPath = join(this.projectRoot, "CLAUDE.md");
    let content = "";
    if (existsSync(claudeMdPath)) {
      content = readFileSync(claudeMdPath, "utf-8");
    }
    if (!content.toLowerCase().includes("kaizen")) {
      content += `\n## Kaizen\n\nKaizen continuous improvement is active for this project.\nSee kaizen.config.json for configuration.\n`;
      writeFileSync(claudeMdPath, content);
    }
  }
}
