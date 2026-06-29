/**
 * enforce-plan-stored.ts — PreToolUse gate: blocks code edits and PR creation
 * without a stored plan on the linked issue.
 *
 * @enforces I3  — Stored test plan.
 * @enforces I8  — Plan before implementation.
 *
 * Uses the Case FE (case-system.ts) as the single gateway — never calls
 * the GitHub BE (structured-data / section-editor) directly.
 *
 * Two trigger points:
 *   1. Edit/Write of source files in worktrees — blocks FIRST code edit
 *   2. Bash `gh pr create` — backstop with substance checks
 *
 * Part of kaizen #1055.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  realpathSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { readHookInput, traceNullInput } from './hook-io.js';
import { currentHookBranch } from './lib/current-branch.js';
import { gitStdout } from './lib/git-state.js';
import { isGhPrCommand, stripHeredocBody, extractRepoFlag, splitCommandSegments, effectiveCwdBeforeCommand } from './parse-command.js';
import { CaseSystem } from '../case-system.js';
import { extractCaseIssueFromBranch } from './lib/case-branch.js';
import { queryIssueState, type IssueState } from '../lib/github-pr.js';
import { parseSections } from '../section-editor.js';

// ── Types ───────────────────────────────────────────────────────────

export interface PlanCheckResult {
  allowed: boolean;
  reason?: string;
  missing?: string[];
}

export interface PlanCheckDeps {
  caseSystem: CaseSystem;
  getChangedFiles: () => string[];
  getCurrentBranch: () => string;
  detectRepo: () => string;
  isInWorktree: () => boolean;
  /** Absolute path of the current worktree root (or empty if not in one). */
  getWorktreeRoot: () => string;
  /** Absolute path of the main checkout. */
  getMainCheckout: () => string;
  /** Explicitly-declared issue for this worktree via `git config kaizen.issue`. */
  getDeclaredIssue: () => string | null;
  /**
   * Look up an issue's OPEN/CLOSED state. Returns null on any failure so the
   * caller fails open — an unknown state must never be mistaken for CLOSED.
   * Injectable for tests; defaults to {@link queryIssueState}.
   */
  getIssueState: (issue: number, repo: string) => IssueState | null;
}

// ── Defaults ────────────────────────────────────────────────────────

function currentGitBranch(): string {
  return currentHookBranch({ fallback: '' });
}

function gitCommonDir(): string {
  return gitStdout(['rev-parse', '--git-common-dir']);
}

const DEFAULT_DEPS: PlanCheckDeps = {
  caseSystem: new CaseSystem(),
  getChangedFiles: () => {
    const r = gitStdout(['diff', '--name-only', 'main...HEAD']);
    return r ? r.split('\n').filter(Boolean) : [];
  },
  getCurrentBranch: currentGitBranch,
  detectRepo: () => gitStdout(['remote', 'get-url', 'origin']).replace(/.*github\.com[:/]/, '').replace(/\.git$/, ''),
  isInWorktree: () => {
    const gitDir = gitStdout(['rev-parse', '--git-dir']);
    const gitCommon = gitCommonDir();
    return !!gitDir && !!gitCommon && gitDir !== gitCommon;
  },
  getWorktreeRoot: () => gitStdout(['rev-parse', '--show-toplevel']),
  getMainCheckout: () => {
    const gitCommon = gitCommonDir();
    if (!gitCommon) return '';
    // git-common-dir is typically <main>/.git, so parent is main checkout
    return gitCommon.replace(/\/\.git$/, '').replace(/\/\.git\/.*$/, '');
  },
  getDeclaredIssue: () => {
    const v = gitStdout(['config', '--get', 'kaizen.issue']);
    return v && /^\d+$/.test(v) ? v : null;
  },
  getIssueState: (issue: number, repo: string) => queryIssueState({ repo, issue }),
};

// ── Issue extraction ────────────────────────────────────────────────

export function extractIssueNumber(fullCommand: string): string | null {
  const match = fullCommand.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? match[1] : null;
}

// NOTE: Branch-name parsing was intentionally removed as a *primary* issue
// source. The issue binding is EXPLICIT via `git config kaizen.issue <N>` (set
// by the /kaizen-implement skill or the user). For PR creation, the canonical
// `Closes #N` syntax in the PR body is the fallback. Parsing arbitrary branch
// names was fragile — every naming convention we didn't anticipate was a bypass.
//
// extractCaseIssueFromBranch below is the ONE exception, and it is NOT a primary
// source — it is a *consistency cross-check*. It parses ONLY the canonical
// case-branch shape that the case system itself produces, so a match is
// trustworthy ground truth about which case this worktree is for. We use it to
// catch a stale/inherited `kaizen.issue` that points at a different issue than
// the worktree's branch (#1106) — the gate must verify "this work corresponds
// to #N", not merely "a plan exists for #N" (the #943/#950 category error).

// Canonical case-branch parsing now lives in hooks/lib/case-branch.ts so non-hook
// modules can reuse it without crossing the #923 boundary. Re-exported here to
// preserve this module's public surface (existing importers and tests).
export { extractCaseIssueFromBranch };

/**
 * Build the BLOCKED result shown when the worktree's case branch says issue M
 * but `git config kaizen.issue` says N (≠ M) — a stale/inherited config (#1106).
 */
function staleIssueResult(branchIssue: string, declaredIssue: string): PlanCheckResult {
  return {
    allowed: false,
    missing: ['issue-mismatch'],
    reason: `BLOCKED: Stale kaizen.issue — your worktree branch is for issue #${branchIssue}, but \`git config kaizen.issue\` says #${declaredIssue}.

This config was almost certainly inherited from another run/worktree. The plan gate would otherwise verify a plan for the WRONG issue (#${declaredIssue}) while you edit code for #${branchIssue}.

FIX IT NOW — bind THIS worktree (per-worktree scope, so it can't leak to or inherit from another run — #1111):
  git config extensions.worktreeConfig true && git config --worktree kaizen.issue ${branchIssue}

Then retry. (If you really intend to work on #${declaredIssue}, you are on the wrong branch — switch to that issue's case worktree instead.)`,
  };
}

// ── Source file detection ───────────────────────────────────────────
//
// Design: allowlist known NON-source (docs, config, assets). Everything
// else is treated as source. New languages then require no update — the
// default is "this is code" unless proven otherwise.

const NON_SOURCE_EXTENSIONS = new RegExp(
  '\\.(md|mdx|rst|txt|json|yml|yaml|toml|xml|html|htm|css|scss|sass|less|' +
  'svg|png|jpg|jpeg|gif|webp|ico|pdf|lock|lockb|sum|mod|csv|tsv)$',
  'i',
);

// Filenames (not extensions) that are considered docs/config, not source.
const NON_SOURCE_FILENAMES = new Set([
  'LICENSE', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS', 'CHANGELOG', 'VERSION',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore',
  '.env.example', '.nvmrc', '.node-version',
]);

/** True if the file is source code (default: yes, unless it's known docs/config). */
export function isSourceFile(filePath: string): boolean {
  const basename = filePath.replace(/^.*\//, '');
  if (NON_SOURCE_FILENAMES.has(basename)) return false;
  if (NON_SOURCE_EXTENSIONS.test(filePath)) return false;
  // Everything else: treat as source. Covers .ts, .py, .go, .rs, Makefile,
  // Dockerfile, .sh, unknown extensions, and anything future.
  return true;
}

export function isDocsOnly(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(f => !isSourceFile(f));
}

// NOTE: Bash-command inspection to detect source writes (`cat > file.ts`, `sed -i`,
// `tee`, etc.) was intentionally removed. Regex-based command parsing is fragile:
// agents can bypass by using any shell variant we didn't anticipate. The
// Edit/Write + NotebookEdit gate covers the natural path. A motivated bypass via
// raw shell is out of scope for this L2 hook — tracked as a follow-up if needed.

// ── Substance checks (PR backstop only) ─────────────────────────────

export function checkPlanSubstance(planText: string): string[] {
  const failures: string[] = [];
  if (planText.length < 200) failures.push(`Plan is too short (${planText.length} chars, need 200+)`);
  const headings = planText.match(/^#{1,4}\s+.+/gm) ?? [];
  if (headings.length < 2) failures.push(`Plan needs structured headings (${headings.length} found, need 2+)`);
  const listItems = planText.match(/^[\s]*[-*\d]+[.)]\s+.+/gm) ?? [];
  const headingItems = planText.match(/^#{3,4}\s+\S+/gm) ?? [];
  if (listItems.length + headingItems.length < 3) failures.push(`Plan has too few steps/items (${listItems.length + headingItems.length}, need 3+)`);
  return failures;
}

export function checkTestPlanSubstance(testPlanText: string): string[] {
  const failures: string[] = [];
  if (!/(?:## (?:Test Plan|Seam Map|Behaviors)|# Test Plan)/i.test(testPlanText)) failures.push('Missing test plan section header');
  const tableRows = testPlanText.match(/^\|.*\|.*\|/gm) ?? [];
  const behaviorHeadings = testPlanText.match(/^###\s+(?:L\d+|B\d+|\d+)\b/gm) ?? [];
  if (tableRows.length < 3 && behaviorHeadings.length < 2) failures.push('Test plan needs behaviors table or headings');
  if (!/\b(Unit|Integration|System|E2E|Agentic|Workflow)\b/i.test(testPlanText)) failures.push('Test plan must specify test levels');
  return failures;
}

type ImpactField = {
  name: string;
  pattern: string;
};

const IMPACT_FIELDS: ImpactField[] = [
  { name: 'Goal', pattern: String.raw`Goal(?:\s*\(#[0-9]+\))?` },
  { name: 'Acceptance signal', pattern: String.raw`Acceptance signal` },
  { name: 'BEFORE', pattern: String.raw`BEFORE` },
  { name: 'AFTER', pattern: String.raw`AFTER` },
  { name: 'Delta', pattern: String.raw`Delta` },
  { name: 'Goal met?', pattern: String.raw`Goal met\?` },
  { name: 'Residual scan', pattern: String.raw`Residual scan` },
];

const PLACEHOLDER_VALUE = /^(?:tbd|todo|pending|placeholder|n\/a|na|<[^>]+>|\.\.\.)$/i;
const MAX_PR_BODY_FILE_BYTES = 128 * 1024;

export function checkImpactProofSubstance(prBodyText: string): string[] {
  const section = parseSections(prBodyText).find(s => /^Impact\b/i.test(s.name))?.content ?? null;
  if (!section) return ['Missing ## Impact (goal -> before/after -> match) section'];

  const failures: string[] = [];
  for (const field of IMPACT_FIELDS) {
    const match = section.match(new RegExp(String.raw`(?:^|\n)\s*[-*]?\s*${field.pattern}\s*:\s*(.+)`, 'i'));
    const value = match?.[1]?.trim() ?? '';
    if (!value) {
      failures.push(`Missing Impact field: ${field.name}`);
    } else if (PLACEHOLDER_VALUE.test(value)) {
      failures.push(`Impact field uses placeholder value: ${field.name}`);
    }
  }
  return failures;
}

function extractBodyFilePath(cmdLine: string): string | null {
  const match = cmdLine.match(/(?:--body-file(?:=|\s+)|-F\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractGhPrCreateSegment(cmdLine: string): string | null {
  return splitCommandSegments(cmdLine).find(seg => /^gh\s+pr\s+create\b/.test(seg)) ?? null;
}

function countGhPrCreateSegments(cmdLine: string): number {
  return splitCommandSegments(cmdLine).filter(seg => /^gh\s+pr\s+create\b/.test(seg)).length;
}

function commandOnlyChangesDirectoryBeforeCreate(cmdLine: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  const createIndex = segments.findIndex(seg => /^gh\s+pr\s+create\b/.test(seg));
  if (createIndex < 0) return false;
  return segments.slice(0, createIndex).every(seg => /^cd\s+/.test(seg));
}

function effectiveCwdForPrCreate(cmdLine: string): string | null {
  return effectiveCwdBeforeCommand(cmdLine, /^gh\s+pr\s+create\b/) ?? null;
}

function isWithinDirectory(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function readSmallRegularFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_PR_BODY_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stats.size);
    const bytesRead = readSync(fd, buffer, 0, stats.size, 0);
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close failures */ }
    }
  }
}

function readPrBodyText(fullCommand: string, cmdLine: string): string {
  const prCreateSegment = extractGhPrCreateSegment(cmdLine);
  if (!prCreateSegment) return fullCommand;

  const bodyFile = extractBodyFilePath(prCreateSegment);
  if (!bodyFile || bodyFile === '-') {
    return countGhPrCreateSegments(cmdLine) === 1 && commandOnlyChangesDirectoryBeforeCreate(cmdLine)
      ? fullCommand
      : prCreateSegment;
  }

  try {
    const cwdForCreate = effectiveCwdForPrCreate(cmdLine);
    if (!cwdForCreate) return prCreateSegment;
    const effectiveCwd = realpathSync(cwdForCreate);
    const requestedPath = isAbsolute(bodyFile) ? bodyFile : resolve(effectiveCwd, bodyFile);
    const realPath = realpathSync(requestedPath);
    if (!isWithinDirectory(realPath, effectiveCwd)) return prCreateSegment;

    return readSmallRegularFile(realPath) ?? prCreateSegment;
  } catch {
    // Fail closed against the actual create segment. The full compound command
    // may contain unrelated Impact text from earlier commands.
    return prCreateSegment;
  }
}

function checkImpactProofBeforePr(prBodyText: string): PlanCheckResult | null {
  const failures = checkImpactProofSubstance(prBodyText);
  if (failures.length === 0) return null;
  return {
    allowed: false,
    missing: ['impact-proof'],
    reason: `BLOCKED: PR body lacks populated Impact proof for the linked issue (#1505).

${failures.map(f => `  - ${f}`).join('\n')}

Non-docs kaizen PRs must show goal impact, not just assert it. Use /kaizen-write-pr
and include a populated section:

## Impact (goal -> before/after -> match)
- Goal (#N): <observable outcome + direction>
- Acceptance signal: <what would prove it; chosen at plan time>
- BEFORE: <baseline sample or structural proof>
- AFTER: <same sample post-change>
- Delta: <eyeballable difference>
- Goal met?: yes | partial (deferred #M) | no
- Residual scan: <done-in-PR | filed #K | none>`,
  };
}

/**
 * Run the substance heuristic over the already-fetched gate text. Returns a
 * BLOCKED result if either the plan or the test plan is a rubber-stamp, else
 * null. Shared by BOTH choke points (first source edit AND `gh pr create`) so
 * there is ONE substance bar — the gates can never drift to different bars
 * (#1035). `planText`/`testPlanText` are guarded for null: existence is already
 * enforced upstream, so a null here means "nothing to substance-check" → no
 * failure, never a false denial.
 */
export function checkSubstance(
  issueNum: string,
  planText: string | null | undefined,
  testPlanText: string | null | undefined,
): PlanCheckResult | null {
  const planIssues = planText ? checkPlanSubstance(planText) : [];
  const testPlanIssues = testPlanText ? checkTestPlanSubstance(testPlanText) : [];
  if (planIssues.length === 0 && testPlanIssues.length === 0) return null;

  const parts: string[] = [];
  if (planIssues.length > 0) {
    parts.push(`Plan substance failures:\n${planIssues.map(i => `  - ${i}`).join('\n')}`);
  }
  if (testPlanIssues.length > 0) {
    parts.push(`Test plan substance failures:\n${testPlanIssues.map(i => `  - ${i}`).join('\n')}`);
  }
  return {
    allowed: false,
    missing: ['substance'],
    reason: `BLOCKED: Plan exists but is not substantive (rubber-stamp check).

${parts.join('\n\n')}

A one-sentence stub passes the existence gate but cannot guide implementation —
which is the whole point of writing it first (#1035). Fix it NOW, before the code:
Run /kaizen-write-plan to produce a proper plan with Success Criteria,
Design Alternatives, and a Seam Map & Test Plan with test levels.
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })`,
  };
}

// ── Gate 1: Edit/Write — block source edits without a plan ──────────

export function checkPlanBeforeEdit(
  filePath: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') return { allowed: true };
  if (!deps.isInWorktree()) return { allowed: true };
  if (!isSourceFile(filePath)) return { allowed: true };

  // Issue must be EXPLICITLY declared via `git config kaizen.issue <N>`.
  // This is the agent's binding contract: "I am working on #N".
  const issueNum = deps.getDeclaredIssue();

  // Ground truth from the canonical case branch (if any). Used to (a) suggest
  // the right issue when none is declared, and (b) catch a stale/inherited
  // config that names a DIFFERENT issue than this worktree's branch (#1106).
  const branchIssue = extractCaseIssueFromBranch(deps.getCurrentBranch());

  if (!issueNum) {
    const declareHint = branchIssue
      ? `This worktree's branch is for issue #${branchIssue}. Bind it (per-worktree, leak-proof — #1111):

  git config extensions.worktreeConfig true && git config --worktree kaizen.issue ${branchIssue}`
      : `Every source-code edit must be tied to an issue. Bind it explicitly (per-worktree, leak-proof — #1111):

  git config extensions.worktreeConfig true && git config --worktree kaizen.issue <N>

(where <N> is the issue number, e.g. 1055)`;
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: You have not declared which issue you are working on.

${declareHint}

Or use /kaizen-implement, which sets this for you.
This hook enforces I8: implementation must be tied to a planned issue.`,
    };
  }

  // Cross-check: a canonical case branch is trustworthy ground truth. If it
  // disagrees with the declared issue, the config is stale/inherited (#1106) —
  // fail closed before the plan gate verifies a plan for the wrong issue.
  if (branchIssue && branchIssue !== issueNum) {
    return staleIssueResult(branchIssue, issueNum);
  }

  const repo = deps.detectRepo();
  if (!repo) return { allowed: true };

  const gate = deps.caseSystem.checkPlanGate(parseInt(issueNum, 10), repo);
  if (!gate.passed) {
    // Detect if the agent is writing to main checkout while in a worktree.
    // If so, include path correction — the agent has BOTH a plan problem AND a path problem.
    const worktreeRoot = deps.getWorktreeRoot();
    const mainCheckout = deps.getMainCheckout();
    const wrongPath = !!mainCheckout && !!worktreeRoot && worktreeRoot !== mainCheckout
      && filePath.startsWith(mainCheckout + '/') && !filePath.startsWith(worktreeRoot + '/');
    const suggestedPath = wrongPath && worktreeRoot
      ? filePath.replace(mainCheckout, worktreeRoot)
      : null;

    const pathHint = suggestedPath
      ? `\n\n⚠ Also: you wrote to the main checkout. Your worktree is ${worktreeRoot}.\nUse this path instead: ${suggestedPath}`
      : '';

    // Name the ACTUAL missing artifact so the author doesn't burn a diagnostic
    // round (#1069). "No plan stored" was misleading when the plan existed and
    // only the test plan was missing.
    const scopeConflict = gate.problems.includes('scope-conflict');
    const missing = scopeConflict ? 'scope-conflict' : !gate.hasPlan ? 'plan' : 'testplan';
    let headline: string;
    if (scopeConflict) {
      headline = `BLOCKED: Stored plan for issue #${issueNum} conflicts with this issue scope.`;
    } else if (!gate.hasPlan && !gate.hasTestPlan) {
      headline = `BLOCKED: No plan or test plan stored for issue #${issueNum}.`;
    } else if (!gate.hasPlan) {
      headline = `BLOCKED: No implementation plan stored for issue #${issueNum} (a test plan exists, the plan does not).`;
    } else {
      headline = `BLOCKED: A plan is stored for issue #${issueNum}, but the test plan is missing.`;
    }

    return {
      allowed: false,
      missing: [missing],
      reason: `${headline} You MUST run /kaizen-write-plan before writing any code.

${scopeConflict && gate.reason ? `${gate.reason}\n` : ''}

DO THIS NOW:
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })

The skill creates and stores BOTH the implementation plan and the test plan correctly.
IMPORTANT: Wait for the skill to COMPLETE. Do not retry Write until the skill is done — intermediate retries will be denied again.${pathHint}`,
    };
  }

  // Existence passed — now enforce SUBSTANCE at the FIRST source edit, using the
  // already-fetched gate text (no refetch). This is the same heuristic the PR
  // gate applies, just earlier: a rubber-stamp plan is caught before any code is
  // written, not after (#1035). Same bar at both choke points → no new false
  // positives, only earlier feedback.
  const substanceResult = checkSubstance(issueNum, gate.planText, gate.testPlanText);
  if (substanceResult) return substanceResult;

  return { allowed: true };
}

// ── Superseded-issue guard (PR create only) ─────────────────────────

/**
 * Block `gh pr create` when the target issue is already CLOSED — almost always
 * because a sibling auto-dent run already shipped it (#318). Creating the PR
 * anyway produces an orphan duplicate that later needs a *manual rescue* (the
 * exact "work abandoned, requires a manual rescue PR" failure mode).
 *
 * Prevention over lossy cleanup: the original #318 proposal auto-closed such PRs
 * *after* creation, but the issue's own critique warns that is lossy — a
 * superseded PR may carry unique improvements. Blocking at create time loses
 * nothing (no PR exists yet) and, if the work is genuinely unique, the author
 * simply reopens the issue to lift the gate. This mirrors the rescue path's
 * closed-issue guard (`auto-dent-rescue.ts`, #1300/#1302) so BOTH PR-creation
 * moments (foreground create + background rescue draft) are covered by the same
 * `queryIssueState` primitive.
 *
 * Fails OPEN: a null/unknown state returns allowed — an unknown state must never
 * be mistaken for CLOSED, matching the rescue path's invariant.
 */
export function checkIssueNotSuperseded(
  issueNum: string,
  repo: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  const n = parseInt(issueNum, 10);
  if (!Number.isFinite(n)) return { allowed: true };

  const state = deps.getIssueState(n, repo);
  if (state !== 'CLOSED') return { allowed: true }; // OPEN or null (fail open)

  return {
    allowed: false,
    missing: ['superseded'],
    reason: `BLOCKED: issue #${issueNum} is already CLOSED — this PR would be superseded (#318).

A sibling run (or someone else) almost certainly already shipped #${issueNum}.
Creating this PR now produces an orphan duplicate that has to be rescued/closed by hand.

VERIFY before proceeding:
  gh issue view ${issueNum} --repo ${repo} --json state,title,closedAt
  gh pr list --repo ${repo} --search "${issueNum} in:body" --state merged --json number,title

THEN choose:
  - Duplicate work → abandon this branch (no PR). The issue is done.
  - Your work is genuinely unique / not covered by the merged PR → reopen the
    issue to lift this gate, then retry:
      gh issue reopen ${issueNum} --repo ${repo}
  - Wrong issue bound → fix the link:
      git config --worktree kaizen.issue <correct-N>

This gate prevents abandoned work that needs a manual rescue PR.`,
  };
}

// ── Gate 2: gh pr create — full check with substance ────────────────

export function checkPlanBeforePr(
  fullCommand: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  const cmdLine = stripHeredocBody(fullCommand);
  if (!isGhPrCommand(cmdLine, 'create')) return { allowed: true };
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') return { allowed: true };

  const repo = extractRepoFlag(cmdLine) || deps.detectRepo();
  if (!repo) return { allowed: true };

  const changedFiles = deps.getChangedFiles();
  if (isDocsOnly(changedFiles)) return { allowed: true };

  const prBodyText = readPrBodyText(fullCommand, cmdLine);

  // Priority: declared issue > PR body "Closes #N" (canonical GitHub syntax).
  // Arbitrary branch names are not a primary source — too fragile.
  const issueNum = deps.getDeclaredIssue() ?? extractIssueNumber(prBodyText) ?? extractIssueNumber(fullCommand);
  if (!issueNum) {
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: Cannot verify plan — no issue declared.

Bind the issue explicitly (per-worktree, leak-proof — #1111):
  git config extensions.worktreeConfig true && git config --worktree kaizen.issue <N>

Or include \`Closes #N\` in the PR body.
This hook enforces I3 (stored test plan) and I8 (plan before implementation).`,
    };
  }

  // Cross-check the declared issue against the canonical case branch (#1106):
  // a stale/inherited config that names a different issue than this worktree's
  // branch would otherwise verify a plan for the wrong issue at PR time.
  const branchIssue = extractCaseIssueFromBranch(deps.getCurrentBranch());
  if (branchIssue && branchIssue !== issueNum) {
    return staleIssueResult(branchIssue, issueNum);
  }

  // Superseded guard (#318): if the target issue is already CLOSED, a sibling run
  // shipped it — block before we manufacture an orphan PR that needs a manual
  // rescue. Checked before the plan gate so a closed issue is reported even when
  // no plan exists. Fails open on unknown state.
  const supersededResult = checkIssueNotSuperseded(issueNum, repo, deps);
  if (!supersededResult.allowed) return supersededResult;

  // Use Case FE for existence check
  const gate = deps.caseSystem.checkPlanGate(parseInt(issueNum, 10), repo);
  if (!gate.passed) {
    const scopeConflict = gate.problems.includes('scope-conflict');
    const headline = scopeConflict
      ? `BLOCKED: Stored plan for issue #${issueNum} conflicts with this PR scope.`
      : `BLOCKED: PR requires a stored plan and test plan on issue #${issueNum} (I3, I8).`;
    return {
      allowed: false,
      missing: [scopeConflict ? 'scope-conflict' : !gate.hasPlan ? 'plan' : 'testplan'],
      reason: `${headline}

${gate.reason}

Run /kaizen-write-plan — the skill knows how to create and store the plan correctly.
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })

If you already have a substantive plan file, store it directly and verify that
the embedded test plan is retrievable before creating the PR:
  npx tsx src/cli-structured-data.ts store-plan --issue ${issueNum} --repo ${repo} --file plan.md
  npx tsx src/cli-structured-data.ts retrieve-testplan --issue ${issueNum} --repo ${repo}`,
    };
  }

  // Substance check: plan must be substantive (not a rubber stamp). Reuse text
  // from gate (PlanGateResult carries it — no refetch). Same helper as the edit
  // gate → one substance bar at both choke points (#1035).
  const substanceResult = checkSubstance(issueNum, gate.planText, gate.testPlanText);
  if (substanceResult) return substanceResult;

  const impactProofResult = checkImpactProofBeforePr(prBodyText);
  if (impactProofResult) return impactProofResult;

  return { allowed: true };
}

// ── Accountability: log escape-hatch use ────────────────────────────

function logEscapeHatchUse(context: string): void {
  if (process.env.KAIZEN_SKIP_PLAN_CHECK !== '1') return;
  try {
    const logPath = process.env.KAIZEN_ESCAPE_LOG ?? '/tmp/.kaizen-escape-hatch.jsonl';
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      hook: 'enforce-plan-stored',
      context,
      branch: currentGitBranch(),
      cwd: process.cwd(),
    }) + '\n';
    // Append-only; never throw
    appendFileSync(logPath, entry);
  } catch { /* never fail on log */ }
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-plan-stored'); process.exit(0); }

  const toolName = input.tool_name ?? '';
  let result: PlanCheckResult;

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const filePath = (input.tool_input?.file_path as string)
      ?? (input.tool_input?.notebook_path as string)
      ?? '';
    result = checkPlanBeforeEdit(filePath);
  } else if (toolName === 'Bash') {
    const command = (input.tool_input?.command as string) ?? '';
    result = checkPlanBeforePr(command);
  } else {
    result = { allowed: true };
  }

  // Accountability: log when escape hatch is set (regardless of outcome)
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') {
    logEscapeHatchUse(`tool=${toolName}`);
  }

  if (!result.allowed) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    }));
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('enforce-plan-stored.ts') ||
  process.argv[1]?.endsWith('enforce-plan-stored.js')
) {
  main().catch(() => process.exit(0));
}
