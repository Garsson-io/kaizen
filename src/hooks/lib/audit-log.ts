import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentBranch } from '../hook-io.js';
import { DEFAULT_AUDIT_DIR } from '../state-utils.js';

export interface HookAuditOptions {
  auditDir?: string;
  readBranch?: () => string;
}

export function hookAuditDir(options: HookAuditOptions = {}): string {
  return options.auditDir ?? process.env.AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
}

export function currentHookBranch(options: HookAuditOptions = {}): string {
  try {
    const branch = (options.readBranch ?? getCurrentBranch)().trim();
    return branch || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function appendHookAuditLog(
  file: string,
  line: string,
  options: HookAuditOptions = {},
): void {
  try {
    const auditDir = hookAuditDir(options);
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(join(auditDir, file), line);
  } catch {
    // Audit logging must never block hook gate transitions.
  }
}
