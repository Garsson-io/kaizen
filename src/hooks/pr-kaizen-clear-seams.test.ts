/**
 * Seam/boundary tests for pr-kaizen-clear.ts and state-utils.ts.
 *
 * These tests cover interaction boundaries that unit tests miss —
 * places where two components exchange data and format assumptions can break.
 *
 * INVARIANTS:
 *   1. KAIZEN_UNFINISHED in a grep search pattern MUST NOT trigger gate clearing
 *   2. KAIZEN_UNFINISHED declaration in stdout MUST trigger gate clearing
 *   3. Non-array KAIZEN_IMPEDIMENTS JSON returns explicit error, not silent failure
 *   4. State files without BRANCH field are silently skipped by listStateFilesAnyBranch
 *   5. State files with empty BRANCH are silently skipped
 *
 * (kaizen #928 — category-level prevention for hooks boundary failures)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processHookInput } from './pr-kaizen-clear.js';
import { listStateFilesAnyBranch } from './state-utils.js';

let testStateDir: string;
let testAuditDir: string;

const GATE_FILE = 'pr-kaizen-Garsson-io_kaizen_99';
const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/99';
const BRANCH = 'test-seam-branch';

beforeEach(() => {
  testStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kaizen-seam-test-'),
  );
  testAuditDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kaizen-seam-audit-'),
  );
  process.env.AUDIT_DIR = testAuditDir;
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  fs.rmSync(testAuditDir, { recursive: true, force: true });
  delete process.env.AUDIT_DIR;
});

function writeGate(status = 'needs_pr_kaizen'): void {
  fs.writeFileSync(
    path.join(testStateDir, GATE_FILE),
    `PR_URL=${PR_URL}\nSTATUS=${status}\nBRANCH=${BRANCH}\n`,
    { mode: 0o600 },
  );
}

function gateStatus(): string | null {
  const filepath = path.join(testStateDir, GATE_FILE);
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf-8');
  const m = content.match(/STATUS=(\S+)/);
  return m ? m[1] : null;
}

// ── KAIZEN_UNFINISHED seam ────────────────────────────────────────────

describe('KAIZEN_UNFINISHED seam: grep pattern false-positive prevention', () => {
  it('INVARIANT: grep command containing KAIZEN_UNFINISHED: as search term does NOT trigger gate clearing', () => {
    writeGate();
    // Simulate: `grep "KAIZEN_UNFINISHED:" logs.txt` with no matches (stdout empty)
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: 'grep "KAIZEN_UNFINISHED:" logs.txt' },
        tool_response: { stdout: '', stderr: '', exit_code: '0' },
      },
      { stateDir: testStateDir },
    );
    // Must NOT clear the gate — it's just a grep search, not a declaration
    expect(result).toBeNull();
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });

  it('INVARIANT: git log piped to grep containing KAIZEN_UNFINISHED: does NOT trigger clearing', () => {
    writeGate();
    // Simulate: `git log --oneline | grep KAIZEN_UNFINISHED:` with no matches
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: 'git log --oneline | grep KAIZEN_UNFINISHED:' },
        tool_response: { stdout: '', stderr: '', exit_code: '0' },
      },
      { stateDir: testStateDir },
    );
    expect(result).toBeNull();
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });

  it('INVARIANT: echo KAIZEN_UNFINISHED: in stdout DOES trigger all-gates clear', () => {
    writeGate();
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo "KAIZEN_UNFINISHED: session ended"' },
        tool_response: {
          stdout: 'KAIZEN_UNFINISHED: session ended',
          stderr: '',
          exit_code: '0',
        },
      },
      { stateDir: testStateDir },
    );
    // Must clear the gate and return a message
    expect(result).not.toBeNull();
    expect(result).toContain('KAIZEN_UNFINISHED');
  });
});

// ── Piped KAIZEN_IMPEDIMENTS seam ────────────────────────────────────

describe('KAIZEN_IMPEDIMENTS seam: piped command extraction', () => {
  it('INVARIANT: KAIZEN_IMPEDIMENTS declaration piped through cat reaches extraction', () => {
    writeGate();
    // When stdout contains the declaration (even if piped through commands), it must be extracted
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'filed', ref: '#1' },
    ]);
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: ${json}' | cat` },
        tool_response: {
          stdout: `KAIZEN_IMPEDIMENTS: ${json}`,
          stderr: '',
          exit_code: '0',
        },
      },
      { stateDir: testStateDir },
    );
    // Declaration in stdout must succeed regardless of how the command was structured
    expect(result).not.toBeNull();
    expect(result).toContain('gate cleared');
  });
});

// ── Non-array JSON seam ───────────────────────────────────────────────

describe('KAIZEN_IMPEDIMENTS seam: non-array JSON', () => {
  it('INVARIANT: object JSON (not array) returns explicit error, does not silently fail', () => {
    writeGate();
    const singleObject = JSON.stringify({
      impediment: 'test item',
      disposition: 'filed',
      ref: '#1',
    });
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: ${singleObject}'` },
        tool_response: {
          stdout: `KAIZEN_IMPEDIMENTS: ${singleObject}`,
          stderr: '',
          exit_code: '0',
        },
      },
      { stateDir: testStateDir },
    );
    // Must return an explicit error, not null (silent failure)
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid JSON');
    // Gate must remain active
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });

  it('INVARIANT: string value returns explicit error', () => {
    writeGate();
    const result = processHookInput(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'echo \'KAIZEN_IMPEDIMENTS: "just a string"\'',
        },
        tool_response: {
          stdout: 'KAIZEN_IMPEDIMENTS: "just a string"',
          stderr: '',
          exit_code: '0',
        },
      },
      { stateDir: testStateDir },
    );
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid JSON');
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });
});

// ── State file corruption seam ────────────────────────────────────────

describe('state-utils seam: corrupted / legacy state files', () => {
  it('INVARIANT: state file without BRANCH field is silently skipped by listStateFilesAnyBranch', () => {
    // Write a legacy state file missing the BRANCH field
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-legacy-file'),
      `PR_URL=${PR_URL}\nSTATUS=needs_pr_kaizen\n`,
      { mode: 0o600 },
    );
    // Also write a valid file with BRANCH
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-valid-file'),
      `PR_URL=${PR_URL}\nSTATUS=needs_pr_kaizen\nBRANCH=main\n`,
      { mode: 0o600 },
    );

    const files = listStateFilesAnyBranch(testStateDir);

    // Only the valid file should be included
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('valid-file');
    expect(files.some((f) => f.includes('legacy-file'))).toBe(false);
  });

  it('INVARIANT: state file with empty BRANCH field is silently skipped', () => {
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-empty-branch'),
      `PR_URL=${PR_URL}\nSTATUS=needs_pr_kaizen\nBRANCH=\n`,
      { mode: 0o600 },
    );

    const files = listStateFilesAnyBranch(testStateDir);
    expect(files).toHaveLength(0);
  });

  it('INVARIANT: completely empty state file is silently skipped', () => {
    fs.writeFileSync(path.join(testStateDir, 'pr-kaizen-empty'), '', {
      mode: 0o600,
    });

    const files = listStateFilesAnyBranch(testStateDir);
    expect(files).toHaveLength(0);
  });
});
