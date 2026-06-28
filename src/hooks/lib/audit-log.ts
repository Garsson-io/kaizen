import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentHookBranch } from './current-branch.js';
import { DEFAULT_AUDIT_DIR } from '../state-utils.js';

export interface HookAuditOptions {
  auditDir?: string;
}

export function hookAuditDir(options: HookAuditOptions = {}): string {
  return options.auditDir ?? process.env.AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
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

export { currentHookBranch };
