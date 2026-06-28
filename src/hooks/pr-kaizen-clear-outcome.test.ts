/**
 * pr-kaizen-clear-outcome.test.ts — Categorical prevention test for the
 * Outcome Verification Contract (kaizen #950, #943, #921's 3-case spec).
 *
 * The reflection gate must clear on a *verified outcome*, not on a
 * command-shaped declaration. A "filed"/"incident" disposition whose ref does
 * not resolve to a real issue/PR must NOT clear the gate.
 *
 *   1. trigger + real outcome (ref exists)        → gate clears
 *   2. trigger + fabricated outcome (ref missing) → gate stays, clear message
 *   3. trigger + infra error (unverifiable)       → fail open, gate clears
 *   4. no trigger                                 → state unchanged
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { processHookInput } from './pr-kaizen-clear.js';
import type { RefStatus } from './lib/issue-ref-verifier.js';
import type { HookInput } from './hook-io.js';

type HookOptions = NonNullable<Parameters<typeof processHookInput>[1]>;

function stateExists(stateDir: string): boolean {
  return fs
    .readdirSync(stateDir)
    .some((f) =>
      fs
        .readFileSync(path.join(stateDir, f), 'utf-8')
        .includes('STATUS=needs_pr_kaizen'),
    );
}

describe('processHookInput: outcome verification (kaizen #950)', () => {
  let stateDir: string;
  let auditDir: string;

  const filed = (ref: string) =>
    `KAIZEN_IMPEDIMENTS: [{"impediment":"real bug","disposition":"filed","ref":"${ref}"}]`;

  const inputFor = (ref: string) => ({
    tool_name: 'Bash',
    tool_input: { command: `echo '${filed(ref)}'` },
    tool_response: { stdout: filed(ref), exit_code: 0 },
  }) satisfies HookInput;

  function processWithOutcomeOptions(
    input: HookInput,
    verifyRef: (ref: string) => RefStatus = () => 'exists',
  ): string | null {
    const options: HookOptions = {
      stateDir,
      verifyRef,
      postComment: () => {},
      getPrFiles: () => [],
      gh: (args: string[]) => {
        if (args.join(' ') === 'pr view 42 --repo Garsson-io/kaizen --json state --jq .state') {
          return 'OPEN';
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    };
    return processHookInput(input, options);
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-outcome-'));
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-outcome-audit-'));
    process.env.AUDIT_DIR = auditDir;
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(stateDir, 'pr-kaizen-Garsson-io_kaizen_42'),
      `PR_URL=https://github.com/Garsson-io/kaizen/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
    delete process.env.AUDIT_DIR;
  });

  it('CASE 1: ref that exists → gate clears', () => {
    const verifyRef = vi.fn<(ref: string) => RefStatus>(() => 'exists');
    const result = processWithOutcomeOptions(inputFor('#950'), verifyRef);
    expect(verifyRef).toHaveBeenCalledWith('#950');
    expect(result).toContain('PR kaizen gate cleared');
    expect(stateExists(stateDir)).toBe(false);
  });

  it('CASE 2: fabricated ref (missing) → gate stays, explains why', () => {
    const verifyRef = vi.fn<(ref: string) => RefStatus>(() => 'missing');
    const result = processWithOutcomeOptions(inputFor('#99999'), verifyRef);
    expect(result).toContain('Outcome verification failed');
    expect(result).toContain('#99999');
    // Gate must NOT have cleared.
    expect(stateExists(stateDir)).toBe(true);
    // And the rejection is audited.
    const log = fs.readFileSync(path.join(auditDir, 'no-action.log'), 'utf-8');
    expect(log).toContain('unverified-ref');
  });

  it('CASE 3: unverifiable (infra/network) → fail open, gate clears', () => {
    const verifyRef = vi.fn<(ref: string) => RefStatus>(() => 'unverifiable');
    const result = processWithOutcomeOptions(inputFor('#950'), verifyRef);
    expect(result).toContain('PR kaizen gate cleared');
    expect(stateExists(stateDir)).toBe(false);
  });

  it('CASE 4: no impediment trigger → state unchanged', () => {
    const verifyRef = vi.fn<(ref: string) => RefStatus>(() => 'missing');
    const result = processWithOutcomeOptions(
      {
        tool_name: 'Bash',
        tool_input: { command: `echo "hello world"` },
        tool_response: { stdout: 'hello world', exit_code: 0 },
      },
      verifyRef,
    );
    expect(result).toBeNull();
    expect(verifyRef).not.toHaveBeenCalled();
    expect(stateExists(stateDir)).toBe(true);
  });

  it('does not block when the failed-to-resolve item is no-action (no ref to verify)', () => {
    const verifyRef = vi.fn<(ref: string) => RefStatus>(() => 'missing');
    const cmd =
      'KAIZEN_IMPEDIMENTS: [{"type":"positive","impediment":"smooth run","disposition":"no-action","reason":"genuinely frictionless, well-scoped 30-line change"}]';
    const result = processWithOutcomeOptions(
      {
        tool_name: 'Bash',
        tool_input: { command: `echo '${cmd}'` },
        tool_response: { stdout: cmd, exit_code: 0 },
      },
      verifyRef,
    );
    expect(verifyRef).not.toHaveBeenCalled();
    expect(result).toContain('PR kaizen gate cleared');
    expect(stateExists(stateDir)).toBe(false);
  });
});
