import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendHookAuditLog,
  currentHookBranch,
} from './audit-log.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('appendHookAuditLog', () => {
  it('creates the audit directory and appends the named log file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-audit-test-'));
    const auditDir = join(tempDir, 'audit');

    appendHookAuditLog('example.log', 'first\n', { auditDir });
    appendHookAuditLog('example.log', 'second\n', { auditDir });

    expect(readFileSync(join(auditDir, 'example.log'), 'utf-8')).toBe(
      'first\nsecond\n',
    );
  });

  it('swallows append failures', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-audit-test-'));
    const auditDir = join(tempDir, 'audit-file');
    writeFileSync(auditDir, 'not a directory');

    expect(() => {
      appendHookAuditLog('example.log', 'line\n', { auditDir });
    }).not.toThrow();
  });
});

describe('currentHookBranch', () => {
  it('uses the injected branch reader when it returns a branch', () => {
    expect(currentHookBranch({ readBranch: () => 'feature/refactor\n' })).toBe(
      'feature/refactor',
    );
  });

  it('falls back to unknown when branch lookup returns empty output', () => {
    expect(currentHookBranch({ readBranch: () => '' })).toBe('unknown');
  });

  it('falls back to unknown when branch lookup throws', () => {
    expect(
      currentHookBranch({
        readBranch: () => {
          throw new Error('git failed');
        },
      }),
    ).toBe('unknown');
  });
});
