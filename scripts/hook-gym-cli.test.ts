/**
 * hook-gym-cli.test.ts — Integration tests for the hook-gym CLI entry point.
 *
 * Behaviors covered (from issue #1034 test plan):
 *   B8 — `--list` emits formatted scenario summary with severity weights
 *   B9 — `--run <name> --dry-run` renders prompt with template vars substituted
 *
 * These are Integration level: they spawn a real project-local `tsx` subprocess,
 * exercise the full CLI pipeline (arg parsing → scenario lookup → template
 * rendering → stdout), and assert on the composed output. Mocking stdout
 * would always pass — this is why the level is Integration not Unit.
 */

import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTypeScriptSubprocess } from './test-typescript-runner.js';

const REPO_ROOT = resolve(__dirname, '..');
const CLI = resolve(REPO_ROOT, 'scripts/hook-gym.ts');
const CLI_RUNNER = buildTypeScriptSubprocess(CLI, { startDir: __dirname });

type CliResult = { stdout: string; stderr: string; status: number };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(CLI_RUNNER.command, [...CLI_RUNNER.args, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function fakeClaudePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-gym-fake-claude-'));
  tempDirs.push(dir);
  const script = join(dir, 'claude');
  writeFileSync(script, `#!/usr/bin/env bash
cat <<'JSON'
{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"u1","session_id":"s1"}
{"type":"system","subtype":"hook_response","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"u1","session_id":"s1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"fake claude completed"}]}}
JSON
`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return dir;
}

describe('hook-gym CLI — --list (B8)', () => {
  let result: CliResult;

  beforeAll(() => {
    result = runCli(['--list']);
  });

  it('exits 0 and lists all three scenarios', () => {
    const { stdout, status } = result;
    expect(status).toBe(0);
    expect(stdout).toContain('probe-hooks');
    expect(stdout).toContain('lifecycle-gates');
    expect(stdout).toContain('full-clear');
  });

  it('shows total count', () => {
    const { stdout } = result;
    expect(stdout).toMatch(/Total: \d+ scenarios/);
  });

  it('includes model, budget, and timeout columns', () => {
    const { stdout } = result;
    // probe-hooks uses haiku
    expect(stdout).toMatch(/probe-hooks\s+haiku/);
    // full-clear uses sonnet
    expect(stdout).toMatch(/full-clear\s+sonnet/);
    // At least one scenario has a dollar budget
    expect(stdout).toMatch(/\$\d+\.\d{2}/);
    // At least one scenario has a seconds timeout
    expect(stdout).toMatch(/\d+s\b/);
  });

  it('includes weighted severity total per scenario', () => {
    const { stdout } = result;
    // Severity weight is printed as weight=NN
    expect(stdout).toMatch(/weight=\d+/);
  });

  it('shows description for each scenario', () => {
    const { stdout } = result;
    expect(stdout).toContain('Full workflow');
    expect(stdout).toContain('Gate lifecycle');
    expect(stdout).toContain('Full lifecycle');
  });
});

describe('hook-gym CLI — --run <name> --dry-run (B9)', () => {
  let result: CliResult;

  beforeAll(() => {
    result = runCli(['--run', 'probe-hooks', '--dry-run']);
  });

  it('exits 0 for a valid scenario', () => {
    const { status } = result;
    expect(status).toBe(0);
  });

  it('substitutes the {{timestamp}} template variable', () => {
    const { stdout } = result;
    // The placeholder must be gone
    expect(stdout).not.toContain('{{timestamp}}');
    // And a real timestamp (14-digit YYYYMMDDHHMMSS) should appear
    expect(stdout).toMatch(/\d{14}/);
  });

  it('substitutes the {{host_repo}} template variable', () => {
    const { stdout } = result;
    expect(stdout).not.toContain('{{host_repo}}');
    // Host repo read from kaizen.config.json — kaizen self-dogfoods
    expect(stdout).toContain('Garsson-io/kaizen');
  });

  it('prints the scenario header block with model + budget + timeout', () => {
    const { stdout } = result;
    expect(stdout).toContain('=== Scenario: probe-hooks ===');
    expect(stdout).toContain('haiku');
    expect(stdout).toMatch(/\$\d+\.\d{2}/);
    expect(stdout).toMatch(/\d+s/);
  });

  it('prints the expected-hooks section with severity and weight', () => {
    const { stdout } = result;
    expect(stdout).toContain('--- Expected hooks ---');
    // Severity and weight annotation appears on every expected hook
    expect(stdout).toMatch(/\[sev=\d\]/);
  });

  it('prints the expected-gates section', () => {
    const { stdout } = result;
    expect(stdout).toContain('--- Expected gates ---');
    expect(stdout).toContain('needs_review');
    expect(stdout).toContain('needs_pr_kaizen');
  });

  it('prints the rendered prompt section', () => {
    const { stdout } = result;
    expect(stdout).toContain('--- Rendered prompt ---');
    // The probe-hooks scenario instructs creating hook-gym-probe.md
    expect(stdout).toContain('hook-gym-probe.md');
  });

  it('exits non-zero for an unknown scenario', () => {
    const { stderr, status } = runCli(['--run', 'no-such-scenario', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Unknown scenario');
  });
});

describe('hook-gym CLI — implemented commands reject bad input', () => {
  it('--run with unknown scenario exits non-zero', () => {
    const { stderr, status } = runCli(['--run', 'no-such-scenario']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Unknown scenario');
  });
});

describe('hook-gym CLI — self-dogfood live dispatch (#1179)', () => {
  it('default self --run reaches the runner instead of the unsupported self-mode exit', () => {
    const fakeBin = fakeClaudePath();
    const { stdout, stderr } = runCli(
      ['--run', 'probe-hooks', '--model', 'haiku'],
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(stderr).not.toContain('Self-dogfood mode not yet supported');
    expect(stdout).toContain('[run] probe-hooks');
    expect(stdout).toContain(`cwd=${REPO_ROOT}`);
  });

  it('default self --run-all reaches scenario execution instead of the unsupported self-mode exit', () => {
    const fakeBin = fakeClaudePath();
    const { stdout, stderr } = runCli(
      ['--run-all', '--model', 'haiku'],
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(stderr).not.toContain('Self-dogfood mode not yet supported');
    expect(stdout).toContain('[run] Running');
    expect(stdout).toContain(`cwd=${REPO_ROOT}`);
  });
});

describe('hook-gym CLI — --help', () => {
  it('prints usage and exits 0', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('hook-gym');
    expect(stdout).toContain('--list');
    expect(stdout).toContain('--run');
    expect(stdout).toContain('--validate-fixture');
    expect(stdout).toContain('[--host-repo');
  });
});
