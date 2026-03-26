/**
 * Tests for pr-kaizen-clear-fallback.ts — the zero-validation fallback path.
 *
 * INVARIANTS:
 *   1. Fallback clears needs_pr_kaizen gate when KAIZEN_IMPEDIMENTS/NO_ACTION present
 *   2. Fallback is a no-op when no active gate exists
 *   3. Fallback is idempotent: already-cleared gate is not re-cleared
 *   4. Fallback only clears needs_pr_kaizen — does not touch other gate types
 *   5. Non-Bash tool is ignored
 *
 * Previously untested (kaizen #928 — fallback hook test desert).
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK_PATH = path.resolve(
  __dirname,
  'pr-kaizen-clear-fallback.ts',
);

let testStateDir: string;
let testAuditDir: string;

const GATE_FILE = 'pr-kaizen-Garsson-io_kaizen_55';
const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/55';
const BRANCH = 'test-branch';

beforeEach(() => {
  testStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kaizen-fallback-test-'),
  );
  testAuditDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kaizen-fallback-audit-'),
  );
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  fs.rmSync(testAuditDir, { recursive: true, force: true });
});

function writeGate(status: string, filename = GATE_FILE): void {
  fs.writeFileSync(
    path.join(testStateDir, filename),
    `PR_URL=${PR_URL}\nSTATUS=${status}\nBRANCH=${BRANCH}\n`,
    { mode: 0o600 },
  );
}

function gateStatus(filename = GATE_FILE): string | null {
  const filepath = path.join(testStateDir, filename);
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf-8');
  const m = content.match(/STATUS=(\S+)/);
  return m ? m[1] : null;
}

function runFallback(input: object): void {
  const json = JSON.stringify(input);
  execSync(
    `echo '${json.replace(/'/g, "'\\''")}' | npx tsx "${HOOK_PATH}"`,
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        STATE_DIR: testStateDir,
        AUDIT_DIR: testAuditDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    },
  );
}

function bashInput(command: string, stdout: string): object {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', exit_code: '0' },
  };
}

describe('pr-kaizen-clear-fallback: clears gate', () => {
  it('INVARIANT: clears needs_pr_kaizen gate when KAIZEN_IMPEDIMENTS in stdout', () => {
    writeGate('needs_pr_kaizen');
    runFallback(
      bashInput(
        'echo KAIZEN_IMPEDIMENTS: []',
        'KAIZEN_IMPEDIMENTS: []',
      ),
    );
    expect(gateStatus()).toBe('kaizen_done');
  });

  it('INVARIANT: clears needs_pr_kaizen gate when KAIZEN_NO_ACTION in stdout', () => {
    writeGate('needs_pr_kaizen');
    runFallback(
      bashInput(
        'echo KAIZEN_NO_ACTION [docs-only]: no kaizen items',
        'KAIZEN_NO_ACTION [docs-only]: no kaizen items',
      ),
    );
    expect(gateStatus()).toBe('kaizen_done');
  });

  it('INVARIANT: clears needs_pr_kaizen gate when declaration in command (not stdout)', () => {
    writeGate('needs_pr_kaizen');
    runFallback(
      bashInput(
        'echo KAIZEN_IMPEDIMENTS: []',
        '',
      ),
    );
    expect(gateStatus()).toBe('kaizen_done');
  });
});

describe('pr-kaizen-clear-fallback: no-op cases', () => {
  it('INVARIANT: no-op when no active gate exists', () => {
    // No gate file written
    // Should run without error and create no files
    runFallback(
      bashInput(
        'echo KAIZEN_IMPEDIMENTS: []',
        'KAIZEN_IMPEDIMENTS: []',
      ),
    );
    expect(fs.readdirSync(testStateDir)).toHaveLength(0);
  });

  it('INVARIANT: no-op when gate status is not needs_pr_kaizen (already cleared)', () => {
    writeGate('kaizen_done');
    runFallback(
      bashInput(
        'echo KAIZEN_IMPEDIMENTS: []',
        'KAIZEN_IMPEDIMENTS: []',
      ),
    );
    // Should remain kaizen_done, not re-processed
    expect(gateStatus()).toBe('kaizen_done');
  });

  it('INVARIANT: no-op when command and stdout contain no kaizen declaration', () => {
    writeGate('needs_pr_kaizen');
    runFallback(bashInput('echo hello world', 'hello world'));
    // Gate should remain unchanged
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });

  it('INVARIANT: ignores non-Bash tool calls', () => {
    writeGate('needs_pr_kaizen');
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: 'KAIZEN_IMPEDIMENTS: []' },
      tool_response: { exit_code: '0' },
    };
    runFallback(input);
    // Gate should remain unchanged — Write tool is not Bash
    expect(gateStatus()).toBe('needs_pr_kaizen');
  });
});

describe('pr-kaizen-clear-fallback: does not touch other gate types', () => {
  it('INVARIANT: clears needs_pr_kaizen but not needs_review gate', () => {
    writeGate('needs_pr_kaizen', 'pr-kaizen-Garsson-io_kaizen_55');
    writeGate('needs_review', 'pr-review-Garsson-io_kaizen_55');

    runFallback(
      bashInput(
        'echo KAIZEN_IMPEDIMENTS: []',
        'KAIZEN_IMPEDIMENTS: []',
      ),
    );

    expect(gateStatus('pr-kaizen-Garsson-io_kaizen_55')).toBe('kaizen_done');
    expect(gateStatus('pr-review-Garsson-io_kaizen_55')).toBe('needs_review');
  });
});
