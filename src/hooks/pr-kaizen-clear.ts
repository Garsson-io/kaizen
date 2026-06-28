/**
 * pr-kaizen-clear.ts — Clears the PR kaizen gate on valid impediment declarations.
 *
 * @enforces I6  — Gates cleared by mechanism (validates JSON shape; `rm` bypass impossible).
 * @enforces I16 — Gate-clear path for reflection requirement.
 *                 Canonical: docs/kaizen-invariants.md.
 *
 * PostToolUse hook on Bash — always exits 0 (state management, not blocking).
 *
 * Triggers:
 *   1. echo "KAIZEN_IMPEDIMENTS: [...]" — structured impediment declaration
 *   2. echo "KAIZEN_NO_ACTION [category]: <reason>" — restricted bypass
 *
 * Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh } from '../lib/gh-exec.js';
import { type HookInput, readHookInput, writeHookOutput, traceNullInput, traceHookEvent } from './hook-io.js';
import { formatGateSignal } from './lib/gate-signal.js';
import { gitStdout } from './lib/git-state.js';
import { verifyIssueRef, type RefStatus } from './lib/issue-ref-verifier.js';
import { parseGithubPrUrl } from '../lib/github-pr.js';
import { resolveProjectRoot } from '../lib/resolve-project-root.js';
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

type GhRunner = (args: string[]) => string;

// ── Audit logging ────────────────────────────────────────────────────

// Read AUDIT_DIR on each call so tests can override via env var (kaizen #438).
function getAuditDir(): string {
  return process.env.AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
}

function currentBranch(): string {
  return gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown');
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

// logWaiver removed — was unused (CodeQL js/unused-local-variable)

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

// ── Outcome verification (kaizen #950, #943) ─────────────────────────
// A "filed"/"incident" disposition is only honored if its ref points to a
// real issue/PR. Candidate repos: the PR's own repo plus whatever the host
// config declares (self-dogfood → one repo; host mode → host + kaizen repo).

function getCandidateRepos(gatePrUrl: string): string[] {
  const repos: string[] = [];
  const parsedPrUrl = parseGithubPrUrl(gatePrUrl);
  if (parsedPrUrl) repos.push(parsedPrUrl.repo);
  try {
    const root = resolveProjectRoot(process.cwd());
    const cfg = JSON.parse(
      readFileSync(join(root, 'kaizen.config.json'), 'utf-8'),
    );
    for (const r of [cfg?.issues?.repo, cfg?.host?.repo, cfg?.kaizen?.repo]) {
      if (typeof r === 'string' && r) repos.push(r);
    }
  } catch {
    // No config / unreadable → fall back to whatever the PR URL gave us.
  }
  return [...new Set(repos)];
}

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
export function defaultPostComment(prUrl: string, comment: string): void {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) return;
  // Route through the shared gh-exec argv boundary (no shell-string interpolation
  // of prNum/repo); the comment body is fed on stdin via `--body-file -`.
  gh(['pr', 'comment', String(parsed.number), '--repo', parsed.repo, '--body-file', '-'], 15000, comment);
}

// ── PRD detection (kaizen #694) ───────────────────────────────────────

/** List changed files in a PR (best-effort). */
function defaultGetPrFiles(prUrl: string, ghRun: GhRunner = gh): string[] {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) return [];
  try {
    const out = ghRun(['pr', 'diff', String(parsed.number), '--repo', parsed.repo, '--name-only']).trim();
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
    gh?: GhRunner;
    /** Outcome predicate for filed/incident refs (injected in tests). */
    verifyRef?: (ref: string) => RefStatus;
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
  const ghRun = options.gh ?? gh;

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

  // ── Outcome verification (kaizen #950, #943) ──────────────────
  // Before clearing, confirm every "filed"/"incident" ref points to a real
  // issue/PR. A fabricated ref (e.g. {"disposition":"filed","ref":"#9999"})
  // declares an outcome that never happened — the gate must NOT clear on it.
  // Network/parse failures return 'unverifiable' → fail open (never deadlock
  // a run on a flaky network).
  if (shouldClear && validatedItems.length > 0) {
    const verifyRef =
      options.verifyRef ??
      ((ref: string) => verifyIssueRef(ref, getCandidateRepos(gatePrUrl)));
    const missingRefs: string[] = [];
    for (const item of validatedItems) {
      if (
        (item.disposition === 'filed' || item.disposition === 'incident') &&
        item.ref &&
        verifyRef(item.ref) === 'missing'
      ) {
        const desc = item.impediment || item.finding || 'impediment';
        missingRefs.push(`${item.ref} (${desc})`);
      }
    }
    if (missingRefs.length > 0) {
      logNoAction('unverified-ref', missingRefs.join('; '), gatePrUrl);
      return (
        '\nKAIZEN_IMPEDIMENTS: Outcome verification failed.\n' +
        'These "filed"/"incident" refs do not resolve to a real issue or PR:\n' +
        missingRefs.map((m) => `  - ${m}`).join('\n') +
        '\n\nFile the issue for real (or correct the ref), then resubmit.\n' +
        '(A gate clears on the verified outcome, not the declaration — kaizen #950.)\n'
      );
    }
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
    const getPrFiles =
      options.getPrFiles ?? ((prUrl: string) => defaultGetPrFiles(prUrl, ghRun));
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
      autoCloseKaizenIssues(gatePrUrl, ghRun);
    } catch {}

    output.push(
      `\nPR kaizen gate cleared (${clearReason}). You may proceed with other work.\n`,
    );
    return formatGateSignal({ hook: 'pr-kaizen-clear', type: 'gate-clear', gate: 'needs_pr_kaizen', reason: clearReason }) + output.join('');
  }

  return null;
}

/** Auto-close kaizen issues referenced in a merged PR body. */
export function autoCloseKaizenIssues(prUrl: string, ghRun: GhRunner = gh): void {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) return;

  let prState: string;
  try {
    prState = ghRun([
      'pr',
      'view',
      String(parsed.number),
      '--repo',
      parsed.repo,
      '--json',
      'state',
      '--jq',
      '.state',
    ]).trim();
  } catch {
    return;
  }
  if (prState !== 'MERGED') return;

  let prBody: string;
  try {
    prBody = ghRun([
      'pr',
      'view',
      String(parsed.number),
      '--repo',
      parsed.repo,
      '--json',
      'body',
      '--jq',
      '.body',
    ]).trim();
  } catch {
    return;
  }

  const issueNums = new Set<string>();
  for (const m of prBody.matchAll(/Garsson-io\/kaizen(?:[#/]|\/issues\/)*(\d+)/g))
    issueNums.add(m[1]);
  for (const m of prBody.matchAll(
    /github\.com\/Garsson-io\/kaizen\/issues\/(\d+)/g,
  ))
    issueNums.add(m[1]);

  for (const num of issueNums) {
    try {
      // Route through the injected ghRun argv boundary (no shell strings). The
      // issue refs are extracted by a kaizen-scoped regex above, so these calls
      // stay pinned to the kaizen repo (NOT the PR-derived repo, which differs
      // in host-project mode) — behavior-preserving with the pre-migration code.
      const state = ghRun([
        'issue',
        'view',
        num,
        '--repo',
        'Garsson-io/kaizen',
        '--json',
        'state',
        '--jq',
        '.state',
      ]).trim();
      if (state === 'OPEN') {
        ghRun([
          'issue',
          'close',
          num,
          '--repo',
          'Garsson-io/kaizen',
          '--comment',
          `Auto-closed: PR merged (${prUrl})`,
        ]);
      }
    } catch {}
  }

  // Reconcile workflow status labels for issues this PR actually CLOSES (#1229).
  // GitHub auto-closes the linked issue on squash-merge before this hook runs, so
  // the close loop above may find it already CLOSED and leave its in-progress
  // status label (status:has-pr/active/...) stale. Strip those and stamp
  // status:done so a PR-closed issue can't retain an in-progress status.
  try {
    reconcileClosedIssueStatusLabels(prBody, ghRun);
  } catch {}
}

/** In-progress kaizen workflow status labels that must not survive issue closure. */
export const IN_PROGRESS_STATUS_LABELS = [
  'status:has-pr',
  'status:active',
  'status:backlog',
  'status:blocked',
] as const;

/**
 * Issue numbers a PR body CLOSES via a GitHub closing keyword
 * (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved), with or
 * without the `Garsson-io/kaizen` repo prefix. Narrower than the mention-regex
 * used for auto-close: `Parent:`/`Refs:` mentions are intentionally excluded so
 * only genuinely-closed issues get their status labels reconciled.
 */
export function extractClosingIssues(prBody: string): string[] {
  const nums = new Set<string>();
  // Leading \b anchors the keyword to a word start so substrings like
  // "disclosed"/"prefixed"/"hotfixes" don't false-match; optional `:` accepts
  // the "Closes: #N" form GitHub also honors.
  const re =
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+(?:Garsson-io\/kaizen)?#(\d+)/gi;
  for (const m of prBody.matchAll(re)) nums.add(m[1]);
  return [...nums];
}

/**
 * For each issue the PR closes, if it is now CLOSED and still carries an
 * in-progress status label, remove those labels (one `gh issue edit`) and then
 * add `status:done` (a separate best-effort edit), both routed through the
 * injected ghRun boundary and pinned to the kaizen repo. Conservative: acts ONLY
 * when an in-progress label is actually present — issues closed as
 * not-planned/duplicate with no status label are left untouched (never blindly
 * stamped `status:done`).
 */
export function reconcileClosedIssueStatusLabels(
  prBody: string,
  ghRun: GhRunner = gh,
): void {
  for (const num of extractClosingIssues(prBody)) {
    try {
      const state = ghRun([
        'issue',
        'view',
        num,
        '--repo',
        'Garsson-io/kaizen',
        '--json',
        'state',
        '--jq',
        '.state',
      ]).trim();
      if (state !== 'CLOSED') continue;

      const labelsRaw = ghRun([
        'issue',
        'view',
        num,
        '--repo',
        'Garsson-io/kaizen',
        '--json',
        'labels',
        '--jq',
        '[.labels[].name]',
      ]).trim();
      const labels: string[] = JSON.parse(labelsRaw);
      const toRemove = IN_PROGRESS_STATUS_LABELS.filter(l =>
        labels.includes(l),
      );
      if (toRemove.length === 0) continue; // no divergence → nothing to do

      // Remove the stale in-progress label(s) FIRST, in their own call. This is
      // the #1229 invariant ("a PR-closed issue can't stay in-progress") and the
      // labels are known-present on the issue, so it can't fail on a missing one.
      const removeArgs = ['issue', 'edit', num, '--repo', 'Garsson-io/kaizen'];
      for (const l of toRemove) removeArgs.push('--remove-label', l);
      ghRun(removeArgs);

      // Stamp status:done in a SEPARATE best-effort call. `gh issue edit` applies
      // a label set atomically, so fusing --add-label into the removal above would
      // abort the whole edit (and the removal) if status:done is absent — which
      // can happen in a host repo that never defined it.
      if (!labels.includes('status:done')) {
        try {
          ghRun([
            'issue',
            'edit',
            num,
            '--repo',
            'Garsson-io/kaizen',
            '--add-label',
            'status:done',
          ]);
        } catch {}
      }
      traceHookEvent('pr-kaizen-clear', {
        action: 'reconcile-status',
        issue: num,
        removed: toRemove,
      });
    } catch (err) {
      // Best-effort, but leave a durable signal so a failed reconcile isn't
      // silent (the #1229 symptom would otherwise recur invisibly).
      traceHookEvent('pr-kaizen-clear', {
        action: 'reconcile-status',
        issue: num,
        error: String(err),
      });
    }
  }
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput("pr-kaizen-clear"); process.exit(0); }

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
