import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { appendHookAuditLog } from './audit-log.js';

const AUDIT_LOG_SOURCE = readFileSync(new URL('./audit-log.ts', import.meta.url), 'utf-8');

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

describe('branch helper source invariant', () => {
  it('delegates branch fallback to current-branch helper', () => {
    expect(AUDIT_LOG_SOURCE).toContain("from './current-branch.js'");
    expect(AUDIT_LOG_SOURCE).not.toContain("from '../hook-io.js'");
    expect(AUDIT_LOG_SOURCE).not.toContain('export function currentHookBranch');
    expect(AUDIT_LOG_SOURCE).not.toContain('readBranch');
  });
});
