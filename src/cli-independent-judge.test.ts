/**
 * cli-independent-judge.test.ts — CLI surface for the judge primitive (#1231), injected spawn.
 *
 * Verifies the CLI a gate (#1220/#1224/#1230) shells out to: artifact from file, charter
 * parsing, JSON output, and the exit-code → verdict mapping a gate branches on (0 pass / 1 fail).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdJudge, parseArgs } from './cli-independent-judge.js';
import type { SpawnClaudeFn } from './spawn-claude.js';

const PASS = '```yaml\nverdict: pass\nconfidence: high\ncounterexample: null\nreasoning: ok\n```';
const FAIL = '```yaml\nverdict: fail\nconfidence: high\ncounterexample: |\n  empty diff\nreasoning: bad\n```';

function spawnReturning(text: string): SpawnClaudeFn {
  return async () => ({ text, costUsd: 0, durationMs: 1, exitCode: 0 });
}

let dir: string;
let artifactFile: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-cli-'));
  artifactFile = join(dir, 'diff.patch');
  writeFileSync(artifactFile, 'some diff body');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('cmdJudge exit codes (what a gate branches on)', () => {
  it('returns 0 when the panel passes', async () => {
    const code = await cmdJudge(
      ['node', 'cli', 'judge', '--charter', 'red-team', '--artifact-file', artifactFile],
      spawnReturning(PASS),
    );
    expect(code).toBe(0);
  });

  it('returns 1 when the panel fails', async () => {
    const code = await cmdJudge(
      ['node', 'cli', 'judge', '--charter', 'mock-defeat', '--artifact-file', artifactFile],
      spawnReturning(FAIL),
    );
    expect(code).toBe(1);
  });

  it('emits structured JSON with --json', async () => {
    await cmdJudge(
      ['node', 'cli', 'judge', '--charter', 'red-team', '--artifact-file', artifactFile, '--json'],
      spawnReturning(PASS),
    );
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(printed);
    expect(parsed.verdict).toBe('pass');
    expect(parsed.votes).toHaveLength(1);
  });

  it('a diverse comma panel runs one judge per lens', async () => {
    await cmdJudge(
      ['node', 'cli', 'judge', '--charter', 'red-team,mock-defeat', '--artifact-file', artifactFile, '--json'],
      spawnReturning(PASS),
    );
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(JSON.parse(printed).votes).toHaveLength(2);
  });
});

describe('parseArgs dispatch', () => {
  it('charters command lists the whole library', async () => {
    const code = await parseArgs(['node', 'cli', 'charters']);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    for (const name of ['red-team', 'staff-engineer', 'mock-defeat', 'verdict-honesty', 'scope-skeptic']) {
      expect(printed).toContain(name);
    }
  });

  it('unknown command returns exit code 2', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await parseArgs(['node', 'cli', 'frobnicate']);
    expect(code).toBe(2);
    errSpy.mockRestore();
  });
});
