/**
 * pr-kaizen-clear.ts — Clears the PR kaizen gate on valid impediment declarations.
 *
 * PostToolUse hook on Bash — always exits 0 (state management, not blocking).
 *
 * Triggers:
 *   1. echo "KAIZEN_IMPEDIMENTS: [...]" — structured impediment declaration
 *   2. echo "KAIZEN_NO_ACTION [category]: <reason>" — restricted bypass
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type HookInput, readHookInput, writeHookOutput } from './hook-io.js';
import { stripHeredocBody } from './parse-command.js';
import {
  buildReflectionRecord,
  persistReflection,
} from './reflection-persistence.js';
import {
  DEFAULT_AUDIT_DIR,
  DEFAULT_STATE_DIR,
  clearAllStatesWithStatus,
  clearStateWithStatusAnyBranch,
  findNewestStateWithStatusAnyBranch,
  markReflectionDone,
  prUrlToStateKey,
} from './state-utils.js';
import { handleUnfinishedEscape } from './lib/gate-manager.js';

// ── Types ────────────────────────────────────────────────────────────

interface Impediment {
  impediment?: string;
  finding?: string;
  type?: string;
  disposition?: string;
  ref?: string;
  reason?: string;
  impact_minutes?: number;
}

// ── Audit logging ────────────────────────────────────────────────────

// Read AUDIT_DIR on each call so tests can override via env var (kaizen #438).
function getAuditDir(): string {
  return process.env.AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
}

function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function logAudit(file: string, line: string): void {
  try {
    const auditDir = getAuditDir();
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(join(auditDir, file), line);
  } catch {}
}

function logNoAction(category: string, reason: string, prUrl: string): void {
  const ts = new Date().toISOString();
  logAudit(
    'no-action.log',
    `${ts} | branch=${currentBranch()} | category=${category} | pr=${prUrl} | reason=${reason}\n`,
  );
}

function logWaiver(
  desc: string,
  reason: string,
  type: string,
  prUrl: string,
): void {
  const ts = new Date().toISOString();
  logAudit(
    'waiver.log',
    `${ts} | branch=${currentBranch()} | type=${type} | pr=${prUrl} | desc=${desc} | reason=${reason}\n`,
  );
}

// ── Waiver quality (kaizen #446) ─────────────────────────────────────

// Re-export for test imports; single source of truth in src/lib/waiver-blocklist.ts
export { matchesWaiverBlocklist } from '../lib/waiver-blocklist.js';
import { matchesWaiverBlocklist } from '../lib/waiver-blocklist.js';

// ── Validation ───────────────────────────────────────────────────────

/** Dispositions valid per finding type (kaizen #198: waived eliminated). */
const META_DISPOSITIONS = new Set(['filed', 'fixed-in-pr']);
const POSITIVE_DISPOSITIONS = new Set([
  'filed',
  'incident',
  'fixed-in-pr',
  'no-action',
]);
const STANDARD_DISPOSITIONS = new Set(['filed', 'incident', 'fixed-in-pr']);

function validateImpediments(items: Impediment[]): string[] {
  const errors: string[] = [];
  for (const item of items) {
    const desc = item.impediment || item.finding || '';
    const disposition = item.disposition ?? '';
    const type = item.type ?? '';

    if (!desc) {
      errors.push('missing "impediment" or "finding" field');
      continue;
    }
    if (!disposition) {
      errors.push(`missing "disposition" for: ${desc}`);
      continue;
    }

    // Waived eliminated (kaizen #198)
    if (disposition === 'waived') {
      errors.push(
        `disposition "waived" is no longer accepted (kaizen #198). If "${desc}" is real friction, file it. If not, reclassify as {"type": "positive", "disposition": "no-action", "reason": "..."}.`,
      );
      continue;
    }

    if (type === 'meta' && !META_DISPOSITIONS.has(disposition)) {
      errors.push(
        `meta-finding "${desc}" has disposition "${disposition}" \u2014 must be "filed" or "fixed-in-pr". Reclassify as "positive" with "no-action" if not actionable.`,
      );
      continue;
    }
    if (type === 'positive' && !POSITIVE_DISPOSITIONS.has(disposition)) {
      errors.push(
        `invalid disposition "${disposition}" for: ${desc} (must be filed|incident|fixed-in-pr|no-action)`,
      );
      continue;
    }
    if (
      type !== 'meta' &&
      type !== 'positive' &&
      !STANDARD_DISPOSITIONS.has(disposition)
    ) {
      errors.push(
        `invalid disposition "${disposition}" for impediment: ${desc} (must be filed|incident|fixed-in-pr). File it or reclassify as "positive" if not real friction.`,
      );
      continue;
    }

    if ((disposition === 'filed' || disposition === 'incident') && !item.ref) {
      errors.push(
        `disposition "${disposition}" requires "ref" field for: ${desc}`,
      );
    }
    if (disposition === 'no-action' && !item.reason) {
      errors.push(
        `disposition "no-action" requires "reason" field for: ${desc}`,
      );
    }

    // Waiver quality check (kaizen #446): reject generic no-action reasons
    if (disposition === 'no-action' && item.reason) {
      const blocked = matchesWaiverBlocklist(item.reason);
      if (blocked) {
        errors.push(
          `no-action reason for "${desc}" matches blocklist ("${blocked}"). Generic waivers mask real friction — provide a specific, quantified reason or reclassify.`,
        );
      }
    }
  }
  return errors;
}

// ── Fixable-filed detection (kaizen #401) ─────────────────────────────

const FIXABLE_PATTERNS = [
  'hand-rolled',
  'fragile',
  'could use',
  'should use',
  'acceptable for now',
  'could be',
  'should be',
  'todo',
  'hack',
  'workaround',
  'hardcoded',
  'hard-coded',
  'duplicated',
  'copy-paste',
];

/** Detect filed impediments that look fixable in the current PR. Advisory only. */
export function detectFixableFiledImpediments(items: Impediment[]): string[] {
  const advisories: string[] = [];
  for (const item of items) {
    if (item.disposition !== 'filed') continue;
    const desc = (item.impediment || item.finding || '').toLowerCase();
    for (const pattern of FIXABLE_PATTERNS) {
      if (desc.includes(pattern)) {
        const original = item.impediment || item.finding || '';
        advisories.push(
          `Advisory: "${original}" looks fixable in the current PR (matched "${pattern}"). Consider disposition: "fixed-in-pr" instead of filing for later.`,
        );
        break;
      }
    }
  }
  return advisories;
}

// ── JSON extraction ──────────────────────────────────────────────────

function extractImpedimentsJson(
  stdout: string,
  cmdLine: string,
  fullCommand: string,
): { json: unknown[] | null; emptyReason: string } {
  let raw = '';

  // Try stdout
  if (stdout) {
    const m = stdout.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (m) raw = m[1].replace(/\n/g, ' ').trim();
  }

  // Fallback: stdout as raw JSON array (kaizen #313)
  if (!raw && stdout) {
    const trimmed = stdout.replace(/\n/g, ' ').trim();
    try {
      if (Array.isArray(JSON.parse(trimmed))) raw = trimmed;
    } catch {}
  }

  // Fallback: heredoc body from full command (kaizen #313)
  if (!raw && fullCommand) {
    const heredocMatch = fullCommand.match(
      /<<.*?IMPEDIMENTS\n([\s\S]*?)\nIMPEDIMENTS/,
    );
    if (heredocMatch) {
      const body = heredocMatch[1].replace(/\n/g, ' ').trim();
      try {
        if (Array.isArray(JSON.parse(body))) raw = body;
      } catch {}
    }
  }

  // Fallback: cmdLine inline
  if (!raw) {
    const m = cmdLine.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (m) raw = m[1].replace(/\n/g, ' ').trim();
  }

  if (!raw) return { json: null, emptyReason: '' };

  // Try full parse
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { json: parsed, emptyReason: '' };
  } catch {}

  // "[] reason" format
  const emptyMatch = raw.match(/^\[\]\s*(.*)/);
  if (emptyMatch) {
    const reason = emptyMatch[1]
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .trim();
    return { json: [], emptyReason: reason };
  }

  return { json: null, emptyReason: '' };
}

// ── KAIZEN_BG_RESULTS extraction (kaizen #794) ──────────────────────

/**
 * Extract structured impediments from KAIZEN_BG_RESULTS output.
 *
 * The kaizen-bg agent outputs results as JSON (same format as KAIZEN_IMPEDIMENTS):
 *   KAIZEN_BG_RESULTS: [{"impediment": "...", "disposition": "filed", "ref": "#NNN"}]
 *
 * This reuses the same JSON extraction logic as KAIZEN_IMPEDIMENTS, just
 * with a different marker tag. The hook validates and persists identically.
 */
export function extractBgResults(
  stdout: string,
  cmdLine: string,
): { json: unknown[] | null; emptyReason: string } {
  // Rewrite KAIZEN_BG_RESULTS → KAIZEN_IMPEDIMENTS and reuse existing extraction
  const retagged = (text: string) =>
    text.replace(/KAIZEN_BG_RESULTS:/g, 'KAIZEN_IMPEDIMENTS:');

  return extractImpedimentsJson(
    stdout ? retagged(stdout) : '',
    cmdLine ? retagged(cmdLine) : '',
    '',
  );
}

// ── KAIZEN_NO_ACTION ─────────────────────────────────────────────────

const VALID_NO_ACTION_CATEGORIES = new Set([
  'docs-only',
  'formatting',
  'typo',
  'config-only',
  'test-only',
  'trivial-refactor',
]);

function extractNoAction(
  stdout: string,
  cmdLine: string,
): { category: string; reason: string } | null {
  for (const src of [stdout, cmdLine].filter(Boolean)) {
    const m = src.match(/KAIZEN_NO_ACTION\s*\[([a-z-]+)\]\s*:\s*(.*)/);
    if (m) {
      return {
        category: m[1],
        reason: m[2].trim().replace(/^['"]/, '').replace(/['"]$/, '').trim(),
      };
    }
  }
  return null;
}

// ── Reflection persistence (kaizen #388) ─────────────────────────────

/** Classify reflection quality based on disposition distribution. */
export function classifyReflectionQuality(
  items: Impediment[],
): 'high' | 'medium' | 'low' | 'empty' {
  if (items.length === 0) return 'empty';

  const filed = items.filter(
    (i) => (i.disposition === 'filed' || i.disposition === 'incident') && i.ref,
  ).length;
  const fixedInPr = items.filter(
    (i) => i.disposition === 'fixed-in-pr',
  ).length;
  const actionable = filed + fixedInPr;

  if (actionable >= 2) return 'high';
  if (actionable >= 1) return 'medium';
  return 'low';
}

const QUALITY_LABELS: Record<string, string> = {
  high: 'High quality',
  medium: 'Medium quality',
  low: 'Low quality',
  empty: 'No findings',
};

/** Format impediments as a markdown PR comment for audit trail. */
export function formatReflectionComment(
  items: Impediment[],
  clearReason: string,
  isNoAction: boolean,
): string {
  const lines: string[] = ['## Kaizen Reflection', ''];

  if (isNoAction) {
    lines.push(`**No action needed:** ${clearReason}`, '');
  } else if (items.length === 0) {
    lines.push(`**No impediments:** ${clearReason}`, '');
  } else {
    const quality = classifyReflectionQuality(items);
    lines.push(
      `**${items.length} finding(s) addressed** (${QUALITY_LABELS[quality]}):`,
      '',
      '| Finding | Type | Disposition | Ref |',
      '|---------|------|-------------|-----|',
    );
    for (const item of items) {
      const desc = item.impediment || item.finding || '';
      const type = item.type || 'standard';
      const disposition = item.disposition || '';
      const ref = item.ref || '\u2014';
      lines.push(`| ${desc} | ${type} | ${disposition} | ${ref} |`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '*Posted by pr-kaizen-clear hook for audit trail (kaizen #388)*',
  );
  return lines.join('\n');
}

/** Post reflection as a PR comment (best-effort). */
function defaultPostComment(prUrl: string, comment: string): void {
  const prNum = prUrl.match(/(\d+)$/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
  if (!prNum || !repo) return;
  execSync(`gh pr comment ${prNum} --repo "${repo}" --body-file -`, {
    input: comment,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  });
}

// ── PRD detection (kaizen #694) ───────────────────────────────────────

/** List changed files in a PR (best-effort). */
function defaultGetPrFiles(prUrl: string): string[] {
  const prNum = prUrl.match(/(\d+)$/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
  if (!prNum || !repo) return [];
  try {
    const out = execSync(
      `gh pr diff ${prNum} --repo "${repo}" --name-only`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    ).trim();
    return out ? out.split('\n').map(f => f.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Check if PR contains new PRD files. */
export function hasPrdFiles(files: string[]): boolean {
  return files.some(f => /^docs\/prd[/-].*\.md$/i.test(f));
}

/** Block gate clearing when a PRD is created but no issues were filed (kaizen #683). */
export function detectPrdWithoutFiledIssues(
  files: string[],
  items: Impediment[],
  isNoAction: boolean,
): string | null {
  if (!hasPrdFiles(files)) return null;
  const filedCount = items.filter(
    i => i.disposition === 'filed' || i.disposition === 'incident',
  ).length;
  if (!isNoAction && filedCount > 0) return null;
  return (
    'BLOCKED: You created a PRD but filed no actionable issues. ' +
    'PRDs without filed issues are "reflection without action" (kaizen #683). ' +
    'File at least one P0/P1 item as a GitHub issue, then resubmit your reflection with it as a "filed" disposition.'
  );
}

// ── Core logic (extracted for testability) ───────────────────────────

export function processHookInput(
  input: HookInput,
  options: {
    stateDir?: string;
    postComment?: (prUrl: string, comment: string) => void;
    getPrFiles?: (prUrl: string) => string[];
  } = {},
): string | null {
  if (input.tool_name !== 'Bash') return null;

  const exitCode = String(input.tool_response?.exit_code ?? '0');
  if (exitCode !== '0') return null;

  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';
  const cmdLine = stripHeredocBody(command);
  const stateDir =
    options.stateDir ?? process.env.STATE_DIR ?? DEFAULT_STATE_DIR;

  // ── Trigger 0: KAIZEN_UNFINISHED (kaizen #775) ────────────────
  // Check BEFORE the kaizen gate check — KAIZEN_UNFINISHED clears ALL gates
  // (review, reflection, post-merge), even if no kaizen reflection gate exists.
  //
  // Only check stdout — not cmdLine — to prevent false positives when the agent
  // runs `grep "KAIZEN_UNFINISHED:" logs.txt`. The search pattern itself would
  // match the cmdLine regex but is not an agent declaration. Since any legitimate
  // KAIZEN_UNFINISHED declaration (e.g., `echo "KAIZEN_UNFINISHED: reason"`)
  // produces stdout, checking stdout is sufficient. (kaizen #928)
  if (/KAIZEN_UNFINISHED:/.test(stdout)) {
    const reasonMatch = stdout.match(/KAIZEN_UNFINISHED:\s*(.*)/);
    const reason = reasonMatch?.[1]?.trim().replace(/^['"]/, '').replace(/['"]$/, '').trim() || 'no reason given';

    const branch = currentBranch();
    const cleared = handleUnfinishedEscape(reason, branch, stateDir);

    // Also clear any-branch kaizen gates in case of cross-worktree state
    clearAllStatesWithStatus('needs_review', branch, stateDir);
    clearAllStatesWithStatus('needs_pr_kaizen', branch, stateDir);
    clearAllStatesWithStatus('needs_post_merge', branch, stateDir);

    const itemList = cleared.map((g) => `  - ${g.label}`).join('\n');
    const deferredMsg = cleared.length > 0
      ? `\nDeferred ${cleared.length} item(s) — will show in next SessionStart:\n${itemList}\n`
      : '';

    logNoAction('unfinished-escape', reason, 'all-gates');

    return `\nKAIZEN_UNFINISHED: All gates cleared. Reason: ${reason}${deferredMsg}\nYou may now stop.\n`;
  }

  // Check for active kaizen gate
  const gateState = findNewestStateWithStatusAnyBranch(
    'needs_pr_kaizen',
    stateDir,
  );
  if (!gateState) return null;

  const gatePrUrl = gateState.prUrl;
  let shouldClear = false;
  let clearReason = '';
  let allPassive = false;
  let isNoAction = false;
  let validatedItems: Impediment[] = [];
  const output: string[] = [];

  // ── Trigger 1: KAIZEN_IMPEDIMENTS ──────────────────────────────
  if (
    /KAIZEN_IMPEDIMENTS:/.test(cmdLine) ||
    /KAIZEN_IMPEDIMENTS:/.test(stdout)
  ) {
    const { json, emptyReason } = extractImpedimentsJson(
      stdout,
      cmdLine,
      command,
    );

    if (json === null) {
      return '\nKAIZEN_IMPEDIMENTS: Invalid JSON. Expected a JSON array.\n';
    }

    if (json.length === 0) {
      if (!emptyReason) {
        return "\nKAIZEN_IMPEDIMENTS: Empty array requires a reason.\n  echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix'\n";
      }
      logNoAction('empty-array', emptyReason, gatePrUrl);
      shouldClear = true;
      clearReason = `no impediments identified (${emptyReason})`;
    } else {
      const items = json as Impediment[];
      const errors = validateImpediments(items);
      if (errors.length > 0) {
        return `\nKAIZEN_IMPEDIMENTS: Validation failed:\n${errors.join('\n')}\n\nFix the issues and resubmit.\n`;
      }

      validatedItems = items;
      allPassive = items.every((i) => i.disposition === 'no-action');
      shouldClear = true;
      clearReason = `${items.length} finding(s) addressed`;
    }
  }

  // ── Trigger 1b: KAIZEN_BG_RESULTS (kaizen #794) ────────────────
  // The kaizen-bg background agent outputs structured JSON results. If we
  // detect them, clear the gate without requiring the main agent to relay.
  if (
    !shouldClear &&
    (/KAIZEN_BG_RESULTS:/.test(cmdLine) || /KAIZEN_BG_RESULTS:/.test(stdout))
  ) {
    const { json: bgJson, emptyReason: bgEmptyReason } = extractBgResults(stdout, cmdLine);

    if (bgJson !== null) {
      if (bgJson.length === 0) {
        if (!bgEmptyReason) {
          return "\nKAIZEN_BG_RESULTS: Empty array requires a reason.\n  echo 'KAIZEN_BG_RESULTS: [] straightforward bug fix'\n";
        }
        logNoAction('bg-empty-array', bgEmptyReason, gatePrUrl);
        shouldClear = true;
        clearReason = `no impediments from kaizen-bg (${bgEmptyReason})`;
      } else {
        const bgItems = bgJson as Impediment[];
        const errors = validateImpediments(bgItems);
        if (errors.length > 0) {
          return `\nKAIZEN_BG_RESULTS: Validation failed:\n${errors.join('\n')}\n\nThe background agent produced invalid results. Fix and resubmit.\n`;
        }
        validatedItems = bgItems;
        allPassive = bgItems.every((i) => i.disposition === 'no-action');
        shouldClear = true;
        clearReason = `${bgItems.length} finding(s) from kaizen-bg agent`;
      }
    }
  }

  // ── Trigger 2: KAIZEN_NO_ACTION ────────────────────────────────
  if (
    !shouldClear &&
    (/KAIZEN_NO_ACTION/.test(cmdLine) || /KAIZEN_NO_ACTION/.test(stdout))
  ) {
    const noAction = extractNoAction(stdout, cmdLine);

    if (!noAction?.category) {
      return `\nKAIZEN_NO_ACTION: Missing category.\n  Valid: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}\n`;
    }
    if (!VALID_NO_ACTION_CATEGORIES.has(noAction.category)) {
      return `\nKAIZEN_NO_ACTION: Invalid category "${noAction.category}".\n  Valid: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}\n`;
    }
    if (!noAction.reason) {
      return `\nKAIZEN_NO_ACTION: Missing reason.\n  Format: KAIZEN_NO_ACTION [${noAction.category}]: your reason\n`;
    }

    logNoAction(noAction.category, noAction.reason, gatePrUrl);
    shouldClear = true;
    isNoAction = true;
    clearReason = `no action needed [${noAction.category}]: ${noAction.reason}`;
  }

  // ── Clear gate ─────────────────────────────────────────────────
  if (shouldClear) {
    if (allPassive) {
      output.push(
        '\nAll findings classified as no-action \u2014 none filed or fixed-in-pr.\n"Every failure is a gift \u2014 if you file the issue."\n',
      );
    }

    // Quality scoring advisory (kaizen #446)
    if (validatedItems.length > 0) {
      const quality = classifyReflectionQuality(validatedItems);
      if (quality === 'low') {
        output.push(
          '\nReflection quality: LOW \u2014 no findings filed or fixed-in-pr. Consider whether real friction is being overlooked.\n',
        );
      }
    }

    // Fixable-filed advisory (kaizen #401)
    if (validatedItems.length > 0) {
      const fixableAdvisories = detectFixableFiledImpediments(validatedItems);
      if (fixableAdvisories.length > 0) {
        output.push(`\n${fixableAdvisories.join('\n')}\n`);
      }
    }

    // PRD-without-issues BLOCKING check (kaizen #683, upgraded from #694 advisory)
    const getPrFiles = options.getPrFiles ?? defaultGetPrFiles;
    try {
      const files = getPrFiles(gatePrUrl);
      const prdBlock = detectPrdWithoutFiledIssues(
        files,
        validatedItems,
        isNoAction,
      );
      if (prdBlock) return `\n${prdBlock}\n`;
    } catch {}

    clearStateWithStatusAnyBranch(
      'needs_pr_kaizen',
      stateDir,
      undefined,
      gatePrUrl,
    );
    markReflectionDone(gatePrUrl, currentBranch(), stateDir);

    // Post reflection as PR comment for audit trail (kaizen #388, best-effort)
    const postComment = options.postComment ?? defaultPostComment;
    try {
      const comment = formatReflectionComment(
        validatedItems,
        clearReason,
        isNoAction,
      );
      postComment(gatePrUrl, comment);
    } catch {}

    // Persist reflection to searchable JSONL (kaizen #272, best-effort)
    try {
      const clearType = isNoAction
        ? 'no-action' as const
        : validatedItems.length === 0
          ? 'empty-array' as const
          : 'impediments' as const;
      const quality = classifyReflectionQuality(validatedItems);
      const record = buildReflectionRecord({
        prUrl: gatePrUrl,
        branch: currentBranch(),
        clearType,
        clearReason,
        quality,
        impediments: validatedItems,
      });
      persistReflection(record);
    } catch {}

    // Auto-close kaizen issues (best-effort)
    try {
      autoCloseKaizenIssues(gatePrUrl);
    } catch {}

    output.push(
      `\nPR kaizen gate cleared (${clearReason}). You may proceed with other work.\n`,
    );
    return output.join('');
  }

  return null;
}

/** Auto-close kaizen issues referenced in a merged PR body. */
function autoCloseKaizenIssues(prUrl: string): void {
  const prNum = prUrl.match(/(\d+)$/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
  if (!prNum || !repo) return;

  let prState: string;
  try {
    prState = execSync(
      `gh pr view ${prNum} --repo "${repo}" --json state --jq .state`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return;
  }
  if (prState !== 'MERGED') return;

  let prBody: string;
  try {
    prBody = execSync(
      `gh pr view ${prNum} --repo "${repo}" --json body --jq .body`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return;
  }

  const issueNums = new Set<string>();
  for (const m of prBody.matchAll(/Garsson-io\/kaizen[#/issues/]*(\d+)/g))
    issueNums.add(m[1]);
  for (const m of prBody.matchAll(
    /github\.com\/Garsson-io\/kaizen\/issues\/(\d+)/g,
  ))
    issueNums.add(m[1]);

  for (const num of issueNums) {
    try {
      const state = execSync(
        `gh issue view ${num} --repo Garsson-io/kaizen --json state --jq .state`,
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim();
      if (state === 'OPEN') {
        execSync(
          `gh issue close ${num} --repo Garsson-io/kaizen --comment "Auto-closed: PR merged (${prUrl})"`,
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      }
    } catch {}
  }
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const output = processHookInput(input);
  if (output) writeHookOutput(output);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-kaizen-clear.ts') ||
  process.argv[1]?.endsWith('pr-kaizen-clear.js')
) {
  main().catch(() => process.exit(0));
}
