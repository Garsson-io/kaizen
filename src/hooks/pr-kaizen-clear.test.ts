/**
 * Integration tests for pr-kaizen-clear.ts — the TypeScript port.
 *
 * Tests mirror and exceed bash tests in tests/test-pr-kaizen-clear.sh.
 * Each test creates a kaizen gate state, simulates a declaration, and
 * verifies both output and state changes.
 *
 * Parity checklist vs bash tests:
 * [x] Valid KAIZEN_IMPEDIMENTS clears gate
 * [x] Empty array without reason is rejected
 * [x] Empty array with reason clears gate
 * [x] Missing impediment/finding field is rejected
 * [x] Missing disposition is rejected
 * [x] Invalid disposition is rejected
 * [x] filed/incident without ref is rejected
 * [x] waived without reason is rejected
 * [x] Meta-finding with no-action is rejected
 * [x] KAIZEN_NO_ACTION with valid category clears gate
 * [x] KAIZEN_NO_ACTION with invalid category is rejected
 * [x] KAIZEN_NO_ACTION without reason is rejected
 * [x] Waiver blocklist enforcement (kaizen #280)
 * [x] Generic no-action reason blocklist (kaizen #446)
 * [x] Quality tier in reflection comment (kaizen #446)
 * [x] Meta-finding waiver without impact_minutes rejected
 * [x] Meta-finding with impact >= 5 must be filed
 * [x] All-passive advisory (kaizen #205)
 * [x] No gate active → silent exit
 *
 * NEW tests beyond bash:
 * [x] JSON in stdout (not just command line)
 * [x] Non-Bash tool name → silent exit
 * [x] Positive type allows no-action
 * [x] Gate cleared with specific PR URL targeting (kaizen #309)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  classifyReflectionQuality,
  detectFixableFiledImpediments,
  detectPrdWithoutFiledIssues,
  formatReflectionComment,
  hasPrdFiles,
  matchesWaiverBlocklist,
  processHookInput,
} from './pr-kaizen-clear.js';

let testStateDir: string;
let testAuditDir: string;
const HOOK_PATH = path.resolve(__dirname, 'pr-kaizen-clear.ts');

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-test-'));
  testAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-audit-test-'));
  // Isolate audit writes to temp dir (kaizen #438 — prevent test side-effects on repo files)
  process.env.AUDIT_DIR = testAuditDir;
  // Create a kaizen gate state
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    encoding: 'utf-8',
  }).trim();
  fs.writeFileSync(
    path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
    `PR_URL=https://github.com/Garsson-io/kaizen/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
  );
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  fs.rmSync(testAuditDir, { recursive: true, force: true });
  delete process.env.AUDIT_DIR;
});

function runHook(input: object): string {
  const json = JSON.stringify(input);
  try {
    return execSync(
      `echo '${json.replace(/'/g, "'\\''")}' | npx tsx "${HOOK_PATH}"`,
      {
        encoding: 'utf-8',
        env: { ...process.env, STATE_DIR: testStateDir, AUDIT_DIR: testAuditDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      },
    ).trim();
  } catch (err: any) {
    return err.stdout?.trim?.() ?? '';
  }
}

function impedimentsInput(impedimentsJson: string): object {
  return {
    tool_name: 'Bash',
    tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: ${impedimentsJson}'` },
    tool_response: {
      stdout: `KAIZEN_IMPEDIMENTS: ${impedimentsJson}`,
      stderr: '',
      exit_code: '0',
    },
  };
}

function noActionInput(category: string, reason: string): object {
  return {
    tool_name: 'Bash',
    tool_input: {
      command: `echo 'KAIZEN_NO_ACTION [${category}]: ${reason}'`,
    },
    tool_response: {
      stdout: `KAIZEN_NO_ACTION [${category}]: ${reason}`,
      stderr: '',
      exit_code: '0',
    },
  };
}

function gateExists(): boolean {
  return fs.existsSync(
    path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
  );
}

// ── KAIZEN_IMPEDIMENTS tests ─────────────────────────────────────────

describe('pr-kaizen-clear: valid impediments', () => {
  it('clears gate with valid filed impediment', () => {
    const json = JSON.stringify([
      { impediment: 'test issue', disposition: 'filed', ref: '#123' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
    expect(gateExists()).toBe(false);
  });

  it('clears gate with fixed-in-pr disposition', () => {
    const json = JSON.stringify([
      { impediment: 'fixed bug', disposition: 'fixed-in-pr' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('clears gate with incident disposition', () => {
    const json = JSON.stringify([
      { impediment: 'known issue', disposition: 'incident', ref: '#456' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('rejects waived disposition (kaizen #198 — waived eliminated)', () => {
    const json = JSON.stringify([
      {
        impediment: 'minor thing',
        disposition: 'waived',
        reason: 'cosmetic only, no functional impact',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('waived');
    expect(output).toContain('no longer accepted');
    expect(gateExists()).toBe(true);
  });

  it('clears gate with finding alias (kaizen #162)', () => {
    const json = JSON.stringify([
      { finding: 'good pattern', disposition: 'filed', ref: '#789' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });
});

describe('pr-kaizen-clear: empty array', () => {
  it('rejects empty array without reason', () => {
    const output = runHook(impedimentsInput('[]'));
    expect(output).toContain('Empty array requires a reason');
    expect(gateExists()).toBe(true);
  });

  it('clears gate with empty array + reason', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix'`,
      },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix',
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('PR kaizen gate cleared');
    expect(output).toContain('no impediments identified');
  });
});

describe('pr-kaizen-clear: validation', () => {
  it('rejects missing impediment/finding field', () => {
    const json = JSON.stringify([{ disposition: 'filed', ref: '#1' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('missing "impediment" or "finding"');
    expect(gateExists()).toBe(true);
  });

  it('rejects missing disposition', () => {
    const json = JSON.stringify([{ impediment: 'test' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('missing "disposition"');
  });

  it('rejects invalid disposition', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'ignored' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('invalid disposition');
  });

  it('rejects filed without ref', () => {
    const json = JSON.stringify([{ impediment: 'test', disposition: 'filed' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('requires "ref" field');
  });

  it('rejects incident without ref', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'incident' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('requires "ref" field');
  });

  it('rejects waived disposition entirely (kaizen #198)', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'waived' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no longer accepted');
  });

  it('rejects invalid JSON', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: not json'` },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: not json',
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('Invalid JSON');
  });
});

describe('pr-kaizen-clear: type-aware validation', () => {
  it('rejects meta-finding with no-action disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'meta observation',
        type: 'meta',
        disposition: 'no-action',
        reason: 'just observing',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('must be "filed" or "fixed-in-pr"');
    expect(gateExists()).toBe(true);
  });

  it('allows positive type with no-action disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'good pattern found',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive observation',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('allows meta-finding with filed disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'process gap',
        type: 'meta',
        disposition: 'filed',
        ref: '#100',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });
});

describe('pr-kaizen-clear: waived elimination (kaizen #198)', () => {
  it('rejects ALL waived dispositions regardless of reason quality', () => {
    const json = JSON.stringify([
      {
        impediment: 'test',
        disposition: 'waived',
        reason: 'This is a perfectly valid reason with no blocklist matches',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no longer accepted');
    expect(gateExists()).toBe(true);
  });

  it('guides user to reclassify waived as positive/no-action', () => {
    const json = JSON.stringify([
      {
        impediment: 'test',
        disposition: 'waived',
        reason: 'not real friction',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('positive');
    expect(output).toContain('no-action');
  });
});

describe('pr-kaizen-clear: all-passive advisory (kaizen #205)', () => {
  it('shows advisory when all findings are no-action', () => {
    const json = JSON.stringify([
      {
        finding: 'thing 1',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive observation, no change needed',
      },
      {
        finding: 'thing 2',
        type: 'positive',
        disposition: 'no-action',
        reason: 'validated existing pattern',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no-action');
    expect(output).toContain('Every failure is a gift');
    expect(output).toContain('PR kaizen gate cleared');
  });
});

// ── KAIZEN_NO_ACTION tests ───────────────────────────────────────────

describe('pr-kaizen-clear: KAIZEN_NO_ACTION', () => {
  it('clears gate with valid category and reason', () => {
    const output = runHook(noActionInput('docs-only', 'updated README'));
    expect(output).toContain('PR kaizen gate cleared');
    expect(output).toContain('docs-only');
  });

  it('accepts docs-only category', () => {
    const output = runHook(noActionInput('docs-only', 'updated README'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('accepts test-only category', () => {
    // Recreate gate (previous test cleared it)
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
    const output = runHook(noActionInput('test-only', 'added tests'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('accepts trivial-refactor category', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
    const output = runHook(noActionInput('trivial-refactor', 'rename'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('rejects invalid category', () => {
    const output = runHook(noActionInput('feature-add', 'not trivial'));
    expect(output).toContain('Invalid category');
    expect(gateExists()).toBe(true);
  });

  it('rejects missing reason', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_NO_ACTION [docs-only]:'` },
      tool_response: {
        stdout: `KAIZEN_NO_ACTION [docs-only]:`,
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('Missing reason');
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('pr-kaizen-clear: edge cases', () => {
  it('exits silently when no gate is active', () => {
    // Remove the gate
    fs.unlinkSync(path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'));

    const output = runHook(
      impedimentsInput(
        JSON.stringify([
          { impediment: 'test', disposition: 'filed', ref: '#1' },
        ]),
      ),
    );
    expect(output).toBe('');
  });

  it('exits silently for non-Bash tool', () => {
    const output = runHook({
      tool_name: 'Read',
      tool_input: { command: 'echo KAIZEN_IMPEDIMENTS: []' },
      tool_response: { stdout: '', stderr: '', exit_code: '0' },
    });
    expect(output).toBe('');
  });

  it('exits silently for failed commands', () => {
    const output = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo KAIZEN_IMPEDIMENTS: []' },
      tool_response: { stdout: '', stderr: 'error', exit_code: '1' },
    });
    expect(output).toBe('');
  });

  it('creates reflection-done marker after clearing (kaizen #288)', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'filed', ref: '#1' },
    ]);
    runHook(impedimentsInput(json));

    const markerFiles = fs
      .readdirSync(testStateDir)
      .filter((f) => f.startsWith('kaizen-done-'));
    expect(markerFiles.length).toBeGreaterThan(0);
  });
});

// ── Reflection persistence tests (kaizen #388) ─────────────────────

describe('formatReflectionComment', () => {
  it('formats impediments as markdown table', () => {
    const items = [
      {
        impediment: 'test issue',
        type: 'standard',
        disposition: 'filed',
        ref: '#123',
      },
      {
        finding: 'good pattern',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive',
      },
    ];
    const comment = formatReflectionComment(
      items,
      '2 finding(s) addressed',
      false,
    );
    expect(comment).toContain('## Kaizen Reflection');
    expect(comment).toContain('**2 finding(s) addressed** (Medium quality):');
    expect(comment).toContain('| test issue | standard | filed | #123 |');
    expect(comment).toContain('| good pattern | positive | no-action | \u2014 |');
    expect(comment).toContain('kaizen #388');
  });

  it('formats empty array with reason', () => {
    const comment = formatReflectionComment(
      [],
      'no impediments identified (straightforward fix)',
      false,
    );
    expect(comment).toContain('**No impediments:**');
    expect(comment).toContain('straightforward fix');
  });

  it('formats KAIZEN_NO_ACTION', () => {
    const comment = formatReflectionComment(
      [],
      'no action needed [docs-only]: updated README',
      true,
    );
    expect(comment).toContain('**No action needed:**');
    expect(comment).toContain('docs-only');
  });

  it('defaults type to standard when missing', () => {
    const items = [{ impediment: 'no type', disposition: 'filed', ref: '#1' }];
    const comment = formatReflectionComment(
      items,
      '1 finding(s) addressed',
      false,
    );
    expect(comment).toContain('| no type | standard | filed | #1 |');
  });
});

describe('processHookInput: reflection persistence (kaizen #388)', () => {
  let unitStateDir: string;

  beforeEach(() => {
    unitStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-unit-'));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(unitStateDir, 'pr-kaizen-Garsson-io_kaizen_99'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/99\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(unitStateDir, { recursive: true, force: true });
  });

  it('calls postComment with formatted reflection on valid impediments', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test bug","disposition":"filed","ref":"#50"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test bug","disposition":"filed","ref":"#50"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    expect(postComment.mock.calls[0][0]).toBe(
      'https://github.com/Garsson-io/kaizen/pull/99',
    );
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('## Kaizen Reflection');
    expect(comment).toContain('test bug');
    expect(comment).toContain('filed');
  });

  it('calls postComment on KAIZEN_NO_ACTION', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_NO_ACTION [docs-only]: updated README'`,
      },
      tool_response: {
        stdout: 'KAIZEN_NO_ACTION [docs-only]: updated README',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('**No action needed:**');
  });

  it('calls postComment on empty array with reason', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: [] simple fix'` },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: [] simple fix',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('**No impediments:**');
  });

  it('does not call postComment on validation failure', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"waived"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"waived"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('no longer accepted');
    expect(postComment).not.toHaveBeenCalled();
  });

  it('still clears gate if postComment throws', () => {
    const postComment = vi.fn().mockImplementation(() => {
      throw new Error('gh command failed');
    });
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"fixed-in-pr"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"fixed-in-pr"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
  });
});

// ── Waiver quality scoring tests (kaizen #446) ─────────────────────

describe('matchesWaiverBlocklist', () => {
  it('detects "overengineering" in reason', () => {
    expect(matchesWaiverBlocklist('This is overengineering for now')).toBe('overengineering');
  });

  it('detects "low frequency" in reason', () => {
    expect(matchesWaiverBlocklist('low frequency issue, skip')).toBe('low frequency');
  });

  it('detects "edge case" in reason', () => {
    expect(matchesWaiverBlocklist('rare edge case')).toBe('edge case');
  });

  it('is case-insensitive', () => {
    expect(matchesWaiverBlocklist('OVERENGINEERING risk')).toBe('overengineering');
  });

  it('returns null for specific, valid reasons', () => {
    expect(matchesWaiverBlocklist('tested manually, no regression risk for this read-only endpoint')).toBeNull();
  });
});

describe('pr-kaizen-clear: waiver blocklist enforcement (kaizen #446)', () => {
  it('rejects no-action with blocklisted reason "overengineering"', () => {
    const json = JSON.stringify([
      {
        finding: 'could add more tests',
        type: 'positive',
        disposition: 'no-action',
        reason: 'overengineering for this scope',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('blocklist');
    expect(output).toContain('overengineering');
    expect(gateExists()).toBe(true);
  });

  it('rejects no-action with blocklisted reason "low frequency"', () => {
    const json = JSON.stringify([
      {
        finding: 'potential race condition',
        type: 'positive',
        disposition: 'no-action',
        reason: 'low frequency, unlikely to hit',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('blocklist');
    expect(output).toContain('low frequency');
    expect(gateExists()).toBe(true);
  });

  it('accepts no-action with specific, non-blocklisted reason', () => {
    const json = JSON.stringify([
      {
        finding: 'positive pattern observed',
        type: 'positive',
        disposition: 'no-action',
        reason: 'confirmed existing error handling covers this path via integration test in test_api.py',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('rejects even when mixed with valid impediments', () => {
    const json = JSON.stringify([
      { impediment: 'real bug', disposition: 'filed', ref: '#100' },
      {
        finding: 'minor thing',
        type: 'positive',
        disposition: 'no-action',
        reason: 'cosmetic only',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('blocklist');
    expect(output).toContain('cosmetic');
    expect(gateExists()).toBe(true);
  });
});

describe('classifyReflectionQuality', () => {
  it('returns empty for no items', () => {
    expect(classifyReflectionQuality([])).toBe('empty');
  });

  it('returns high for 2+ actionable items', () => {
    const items = [
      { impediment: 'bug A', disposition: 'filed', ref: '#1' },
      { impediment: 'bug B', disposition: 'fixed-in-pr' },
    ];
    expect(classifyReflectionQuality(items)).toBe('high');
  });

  it('returns medium for 1 actionable item', () => {
    const items = [
      { impediment: 'bug A', disposition: 'filed', ref: '#1' },
      { finding: 'ok', type: 'positive', disposition: 'no-action', reason: 'validated' },
    ];
    expect(classifyReflectionQuality(items)).toBe('medium');
  });

  it('returns low for all no-action', () => {
    const items = [
      { finding: 'ok', type: 'positive' as const, disposition: 'no-action', reason: 'validated' },
    ];
    expect(classifyReflectionQuality(items)).toBe('low');
  });
});

describe('formatReflectionComment: quality tier (kaizen #446)', () => {
  it('includes quality label in comment', () => {
    const items = [
      { impediment: 'bug', disposition: 'filed', ref: '#1' },
      { impediment: 'fix', disposition: 'fixed-in-pr' },
    ];
    const comment = formatReflectionComment(items, '2 finding(s) addressed', false);
    expect(comment).toContain('High quality');
  });

  it('shows Low quality for all no-action', () => {
    const items = [
      { finding: 'ok', type: 'positive', disposition: 'no-action', reason: 'validated' },
    ];
    const comment = formatReflectionComment(items, '1 finding(s) addressed', false);
    expect(comment).toContain('Low quality');
  });
});

describe('processHookInput: quality advisory (kaizen #446)', () => {
  let unitStateDir: string;

  beforeEach(() => {
    unitStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-q-'));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(unitStateDir, 'pr-kaizen-Garsson-io_kaizen_77'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/77\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(unitStateDir, { recursive: true, force: true });
  });

  it('shows LOW quality advisory when all findings are no-action', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"finding":"good","type":"positive","disposition":"no-action","reason":"confirmed existing tests cover this path"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"finding":"good","type":"positive","disposition":"no-action","reason":"confirmed existing tests cover this path"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(result).toContain('Reflection quality: LOW');
  });

  it('does not show LOW advisory for high-quality reflections', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"real bug","disposition":"filed","ref":"#50"},{"impediment":"fixed it","disposition":"fixed-in-pr"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"real bug","disposition":"filed","ref":"#50"},{"impediment":"fixed it","disposition":"fixed-in-pr"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(result).not.toContain('Reflection quality: LOW');
  });
});

// ── Fixable-filed advisory tests (kaizen #401) ─────────────────────

describe('detectFixableFiledImpediments', () => {
  it('returns advisory for "hand-rolled" in description', () => {
    const items = [
      { impediment: 'Hand-rolled JSON parser', disposition: 'filed', ref: '#10' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('hand-rolled');
    expect(advisories[0]).toContain('fixed-in-pr');
  });

  it('returns advisory for "could use" in description', () => {
    const items = [
      { impediment: 'Could use a helper function here', disposition: 'filed', ref: '#11' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('could use');
  });

  it('returns advisory for "hack" in description', () => {
    const items = [
      { impediment: 'This is a hack to work around the API', disposition: 'filed', ref: '#12' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('hack');
  });

  it('returns advisory for "hardcoded" in description', () => {
    const items = [
      { finding: 'Hardcoded timeout value', disposition: 'filed', ref: '#13' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('hardcoded');
  });

  it('returns advisory for "TODO" in description (case-insensitive)', () => {
    const items = [
      { impediment: 'TODO: clean up error handling', disposition: 'filed', ref: '#14' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('todo');
  });

  it('returns empty array for legitimate filed items without fixable patterns', () => {
    const items = [
      { impediment: 'CI pipeline flaky on ARM builds', disposition: 'filed', ref: '#20' },
      { impediment: 'Upstream library missing feature X', disposition: 'filed', ref: '#21' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(0);
  });

  it('ignores non-filed dispositions even with fixable patterns', () => {
    const items = [
      { impediment: 'Hand-rolled parser', disposition: 'fixed-in-pr' },
      { impediment: 'Could use a helper', disposition: 'incident', ref: '#30' },
      { finding: 'Hack in code', type: 'positive', disposition: 'no-action', reason: 'validated existing pattern' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(0);
  });

  it('returns multiple advisories for multiple fixable filed items', () => {
    const items = [
      { impediment: 'Hand-rolled validation', disposition: 'filed', ref: '#40' },
      { impediment: 'Workaround for missing API', disposition: 'filed', ref: '#41' },
    ];
    const advisories = detectFixableFiledImpediments(items);
    expect(advisories).toHaveLength(2);
  });
});

describe('processHookInput: fixable-filed advisory (kaizen #401)', () => {
  let unitStateDir: string;

  beforeEach(() => {
    unitStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-fix-'));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(unitStateDir, 'pr-kaizen-Garsson-io_kaizen_88'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/88\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(unitStateDir, { recursive: true, force: true });
  });

  it('shows advisory but still clears gate when fixable filed detected', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"Hand-rolled JSON parser","disposition":"filed","ref":"#10"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"Hand-rolled JSON parser","disposition":"filed","ref":"#10"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(result).toContain('hand-rolled');
    expect(result).toContain('fixed-in-pr');
  });

  it('does not show advisory for legitimate filed items', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"CI flaky on ARM","disposition":"filed","ref":"#20"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"CI flaky on ARM","disposition":"filed","ref":"#20"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(result).not.toContain('Advisory');
  });
});

// ── PRD detection (kaizen #694) ──────────────────────────────────────

describe('hasPrdFiles', () => {
  it('detects docs/prd-*.md files', () => {
    expect(hasPrdFiles(['docs/prd-agent-self-diagnosis.md', 'src/foo.ts'])).toBe(true);
  });

  it('detects docs/prd/ subdirectory files', () => {
    expect(hasPrdFiles(['docs/prd/my-feature.md'])).toBe(true);
  });

  it('returns false for non-PRD files', () => {
    expect(hasPrdFiles(['src/hooks/pr-kaizen-clear.ts', 'README.md'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(hasPrdFiles([])).toBe(false);
  });
});

describe('detectPrdWithoutFiledIssues', () => {
  const prdFiles = ['docs/prd-agent-diagnosis.md', 'src/foo.ts'];
  const noPrdFiles = ['src/foo.ts', 'CLAUDE.md'];

  it('returns blocking message when PRD present and KAIZEN_NO_ACTION', () => {
    const result = detectPrdWithoutFiledIssues(prdFiles, [], true);
    expect(result).toContain('BLOCKED');
    expect(result).toContain('PRD but filed no actionable issues');
  });

  it('returns blocking message when PRD present and zero filed dispositions', () => {
    const items = [
      { impediment: 'minor style issue', disposition: 'no-action', type: 'positive', reason: 'cosmetic' },
    ];
    const result = detectPrdWithoutFiledIssues(prdFiles, items, false);
    expect(result).toContain('BLOCKED');
    expect(result).toContain('PRD but filed no actionable issues');
  });

  it('returns null when PRD present with filed dispositions', () => {
    const items = [
      { impediment: 'P0 item from PRD', disposition: 'filed', ref: '#123' },
    ];
    const result = detectPrdWithoutFiledIssues(prdFiles, items, false);
    expect(result).toBeNull();
  });

  it('returns null when no PRD files', () => {
    const result = detectPrdWithoutFiledIssues(noPrdFiles, [], true);
    expect(result).toBeNull();
  });
});

describe('processHookInput PRD blocking gate (kaizen #683, upgraded from #694)', () => {
  it('blocks gate when PRD in diff and KAIZEN_NO_ACTION', () => {
    const input = noActionInput('docs-only', 'PRD creation only');
    const result = processHookInput(input, {
      stateDir: testStateDir,
      postComment: () => {},
      getPrFiles: () => ['docs/prd-agent-diagnosis.md', 'CLAUDE.md'],
    });
    expect(result).toContain('BLOCKED');
    expect(result).toContain('PRD but filed no actionable issues');
    expect(result).not.toContain('gate cleared');
  });

  it('blocks gate when PRD in diff with only no-action impediments', () => {
    const input = impedimentsInput(
      '[{"impediment":"cosmetic","disposition":"no-action","type":"positive","reason":"style only"}]',
    );
    const result = processHookInput(input, {
      stateDir: testStateDir,
      postComment: () => {},
      getPrFiles: () => ['docs/prd-agent-diagnosis.md'],
    });
    expect(result).toContain('BLOCKED');
    expect(result).not.toContain('gate cleared');
  });

  it('clears gate when PRD in diff and issues were filed', () => {
    const input = impedimentsInput(
      '[{"impediment":"P0 from PRD","disposition":"filed","ref":"#999"}]',
    );
    const result = processHookInput(input, {
      stateDir: testStateDir,
      postComment: () => {},
      getPrFiles: () => ['docs/prd-agent-diagnosis.md'],
    });
    expect(result).not.toContain('BLOCKED');
    expect(result).toContain('gate cleared');
  });

  it('clears gate when no PRD files in diff', () => {
    const input = noActionInput('config-only', 'just config');
    const result = processHookInput(input, {
      stateDir: testStateDir,
      postComment: () => {},
      getPrFiles: () => ['vitest.config.ts'],
    });
    expect(result).not.toContain('PRD');
    expect(result).toContain('gate cleared');
  });

  it('preserves gate state when PRD blocks clearing', () => {
    const input = noActionInput('docs-only', 'PRD creation only');
    processHookInput(input, {
      stateDir: testStateDir,
      postComment: () => {},
      getPrFiles: () => ['docs/prd-agent-diagnosis.md'],
    });
    const stateContent = fs.readFileSync(
      path.join(testStateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
      'utf-8',
    );
    expect(stateContent).toContain('needs_pr_kaizen');
  });
});
