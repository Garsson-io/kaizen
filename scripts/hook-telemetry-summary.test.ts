/**
 * Tests for scripts/hook-telemetry-summary.sh
 *
 * Validates JSONL telemetry parsing, summary statistics, and output formats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';

const SCRIPT_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  'hook-telemetry-summary.sh',
);

interface TelemetryEntry {
  timestamp: string;
  hook: string;
  duration_ms: number;
  exit_code: number;
}

function makeTelemetryEntry(overrides: Partial<TelemetryEntry> = {}): TelemetryEntry {
  return {
    timestamp: new Date().toISOString(),
    hook: 'kaizen-stop-gate',
    duration_ms: 150,
    exit_code: 0,
    ...overrides,
  };
}

function writeJsonl(dir: string, entries: TelemetryEntry[]): string {
  const telemetryDir = join(dir, '.kaizen', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  const filePath = join(telemetryDir, 'hooks.jsonl');
  writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return filePath;
}

function runScript(
  projectRoot: string,
  args: string[] = [],
): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KAIZEN_TELEMETRY_DIR: join(projectRoot, '.kaizen', 'telemetry'),
      },
      cwd: projectRoot,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

describe('hook-telemetry-summary.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hook-telemetry-'));
  });

  describe('missing telemetry file', () => {
    it('exits 0 with informative message when no telemetry file exists', () => {
      const { stdout, exitCode } = runScript(tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No telemetry data found');
    });
  });

  describe('unknown options', () => {
    it('exits 1 for unknown flags', () => {
      const { exitCode } = runScript(tmpDir, ['--bogus']);
      expect(exitCode).toBe(1);
    });
  });

  describe('table output (default)', () => {
    it('produces table with header and hook rows', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 100, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 200, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'kaizen-verify', duration_ms: 50, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Hook Telemetry Summary');
      expect(stdout).toContain('Total invocations: 3');
      expect(stdout).toContain('kaizen-stop-gate');
      expect(stdout).toContain('kaizen-verify');
    });

    it('shows error count for hooks with non-zero exit codes', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 100, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 200, exit_code: 1 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir);
      expect(exitCode).toBe(0);
      // Table row for kaizen-stop-gate should show 1 error
      // Format: hook\tcount\terrors\t...
      const lines = stdout.split('\n');
      const hookLine = lines.find(l => l.includes('kaizen-stop-gate'));
      expect(hookLine).toBeDefined();
      // count=2, errors=1
      expect(hookLine).toMatch(/2\t1/);
    });
  });

  describe('JSON output (--json)', () => {
    it('produces valid JSON with summary and hooks keys', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 120, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'kaizen-stop-gate', duration_ms: 80, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'kaizen-verify', duration_ms: 30, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir, ['--json']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('hooks');
      expect(result.summary.total_invocations).toBe(3);
      expect(result.summary.hooks_measured).toBe(2);
      expect(result.summary.total_time_ms).toBe(230);
    });

    it('computes correct per-hook statistics', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 100, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 200, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 300, exit_code: 1 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir, ['--json']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      const hookA = result.hooks.find((h: Record<string, unknown>) => h.hook === 'hook-a');
      expect(hookA).toBeDefined();
      expect(hookA.count).toBe(3);
      expect(hookA.errors).toBe(1);
      expect(hookA.avg_ms).toBe(200); // (100+200+300)/3 = 200
      expect(hookA.max_ms).toBe(300);
      expect(hookA.total_ms).toBe(600);
    });

    it('sorts hooks by total_ms descending', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'fast-hook', duration_ms: 10, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'slow-hook', duration_ms: 500, exit_code: 0 }),
        makeTelemetryEntry({ hook: 'mid-hook', duration_ms: 100, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout } = runScript(tmpDir, ['--json']);
      const result = JSON.parse(stdout);
      const hookNames = result.hooks.map((h: Record<string, unknown>) => h.hook);
      expect(hookNames).toEqual(['slow-hook', 'mid-hook', 'fast-hook']);
    });
  });

  describe('edge cases', () => {
    it('handles single entry', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'solo-hook', duration_ms: 42, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir, ['--json']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.summary.total_invocations).toBe(1);
      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].avg_ms).toBe(42);
      expect(result.hooks[0].p50_ms).toBe(42);
      expect(result.hooks[0].p95_ms).toBe(42);
      expect(result.hooks[0].max_ms).toBe(42);
    });

    it('handles entries with null timestamps gracefully', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 100, exit_code: 0 }),
      ];
      // Add an entry with null timestamp
      const telemetryDir = join(tmpDir, '.kaizen', 'telemetry');
      mkdirSync(telemetryDir, { recursive: true });
      const filePath = join(telemetryDir, 'hooks.jsonl');
      const lines = [
        JSON.stringify({ hook: 'hook-a', duration_ms: 50, exit_code: 0, timestamp: null }),
        ...entries.map(e => JSON.stringify(e)),
      ];
      writeFileSync(filePath, lines.join('\n') + '\n');

      const { exitCode } = runScript(tmpDir, ['--json']);
      // Should not crash — null timestamps are filtered
      expect(exitCode).toBe(0);
    });

    it('handles all errors (100% error rate)', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'bad-hook', duration_ms: 100, exit_code: 1 }),
        makeTelemetryEntry({ hook: 'bad-hook', duration_ms: 200, exit_code: 2 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir, ['--json']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.hooks[0].errors).toBe(2);
      expect(result.hooks[0].count).toBe(2);
    });
  });

  describe('--since flag', () => {
    it('passes since_hours to jq filter', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 100, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout, exitCode } = runScript(tmpDir, ['--since', '1']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('last 1h');
    });

    it('uses 24h default when --since is not specified', () => {
      const entries = [
        makeTelemetryEntry({ hook: 'hook-a', duration_ms: 100, exit_code: 0 }),
      ];
      writeJsonl(tmpDir, entries);

      const { stdout } = runScript(tmpDir);
      expect(stdout).toContain('last 24h');
    });
  });
});
