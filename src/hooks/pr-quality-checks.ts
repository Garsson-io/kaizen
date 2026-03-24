/**
 * pr-quality-checks.ts — Consolidated PreToolUse advisory checks for PR quality.
 *
 * Replaces 4 independent bash hooks that all parsed the same JSON, sourced the same
 * libraries, and triggered on overlapping commands:
 *   - kaizen-check-test-coverage.sh
 *   - kaizen-check-verification.sh
 *   - kaizen-check-practices.sh
 *   - kaizen-warn-code-quality.sh
 *
 * All checks are advisory-only (exit 0, never blocks).
 *
 * Part of kAIzen Agent Control Flow — consolidation from #800
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readHookInput } from './hook-io.js';
import {
  isGhPrCommand,
  isGitCommand,
  stripHeredocBody,
} from './parse-command.js';

export type CommandType = 'pr_create' | 'pr_merge' | 'git_commit' | 'none';

export function detectCommandType(cmdLine: string): CommandType {
  if (isGhPrCommand(cmdLine, 'create')) return 'pr_create';
  if (isGhPrCommand(cmdLine, 'merge')) return 'pr_merge';
  if (isGitCommand(cmdLine, 'commit')) return 'git_commit';
  return 'none';
}

export interface RunnerOptions {
  exec?: (cmd: string) => string;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  hookDir?: string;
}

const defaultExec = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
};

/** Get changed files for the current PR/branch. */
export function getChangedFiles(
  cmdLine: string,
  isMerge: boolean,
  exec: (cmd: string) => string,
): string[] {
  let raw: string;
  if (isMerge) {
    // Try gh pr diff first for merge commands
    const prNumMatch = cmdLine.match(/gh\s+pr\s+merge\s+(\d+)/);
    const prArg = prNumMatch?.[1] ?? '';
    const repoMatch = cmdLine.match(/--repo\s+(\S+)/);
    const repoFlag = repoMatch ? `--repo ${repoMatch[1]}` : '';
    raw = exec(`gh pr diff ${prArg} --name-only ${repoFlag}`.trim());
    if (!raw) {
      raw = exec('git diff --name-only main...HEAD');
    }
  } else {
    raw = exec('git diff --name-only main...HEAD');
  }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Check 1: Test coverage
export interface TestCoverageResult {
  srcCount: number;
  testCount: number;
  uncoveredFiles: string[];
}

export function checkTestCoverage(
  changedFiles: string[],
  opts: RunnerOptions = {},
): TestCoverageResult {
  const fileExists = opts.fileExists ?? existsSync;
  const readFile = opts.readFile ?? ((p: string) => {
    try { return readFileSync(p, 'utf-8'); } catch { return ''; }
  });

  // Source files (exclude tests, config, docs, hooks, container agent-runner)
  const sourceFiles = changedFiles.filter((f) =>
    /\.(ts|js|tsx|jsx)$/.test(f) &&
    !/\.(test|spec)\.|test-util\.|__tests__|\.config\.|vitest\.|CLAUDE\.md|\.claude\/|container\/agent-runner\//.test(f),
  );

  // Test files
  const testFiles = changedFiles.filter((f) =>
    /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f),
  );

  if (sourceFiles.length === 0) {
    return { srcCount: 0, testCount: testFiles.length, uncoveredFiles: [] };
  }

  const uncovered: string[] = [];
  for (const srcFile of sourceFiles) {
    const basename = srcFile.replace(/^.*\//, '').replace(/\.(ts|js|tsx|jsx)$/, '');
    const dir = srcFile.replace(/\/[^/]+$/, '');

    // Check for matching test in changed tests
    const hasMatchingTest = testFiles.some((t) => {
      // Exact or prefixed match
      const testBase = t.replace(/^.*\//, '');
      if (new RegExp(`${basename}[.-](test|spec)\\.`).test(testBase)) return true;
      if (new RegExp(`${basename}-[a-z0-9-]+\\.(test|spec)\\.`).test(testBase)) return true;
      // Directory match
      if (t.includes(`${dir}/__tests__/`)) return true;
      return false;
    });

    if (hasMatchingTest) continue;

    // Check if any changed test imports from this source file
    const hasImportingTest = testFiles.some((t) => {
      if (!fileExists(t)) return false;
      const content = readFile(t);
      return new RegExp(`from ['"].*/${basename}(\\.js)?['"]`).test(content);
    });

    if (!hasImportingTest) {
      uncovered.push(srcFile);
    }
  }

  return { srcCount: sourceFiles.length, testCount: testFiles.length, uncoveredFiles: uncovered };
}

export function formatTestCoverageWarning(result: TestCoverageResult, isMerge: boolean): string {
  if (result.uncoveredFiles.length === 0) {
    if (result.srcCount > 0) {
      return `\u2705 Test coverage check: ${result.srcCount} source file(s) changed, ${result.testCount} test file(s) updated.`;
    }
    return '';
  }

  const uncoveredList = result.uncoveredFiles.map((f) => `  - ${f}`).join('\n');
  const exceptionLines = result.uncoveredFiles
    .map((f) => `${f}:  <reason why no tests needed>`)
    .join('\n');

  let msg = `\u26a0\ufe0f  Test coverage policy (CLAUDE.md rule #7):

${result.srcCount} source file(s) changed but these have NO corresponding test changes:
${uncoveredList}
${result.testCount} test file(s) were modified.

Before proceeding, ensure:
1. Unit tests cover the actual changes (not just pass pre-existing tests)
2. A smoke test plan exists for integration-level changes
3. If no tests exist for a module, write them

This check prevents the 'all tests pass but none test the fix' pattern.

If these files genuinely don't need test changes, add this to the PR body:

\`\`\`test-exceptions
${exceptionLines}
\`\`\`

Replace <reason> with a specific justification (e.g., "constant change", "covered by existing X tests").
`;

  if (isMerge) {
    msg += '\n\u26a0\ufe0f  CI pr-policy check will block merge if tests are missing.';
  } else {
    msg += '\n\ud83d\udca1 Consider adding tests before creating the PR. CI will check this.';
  }

  return msg;
}

// Check 2: Verification section
export function checkVerification(
  command: string,
  cmdType: CommandType,
  exec: (cmd: string) => string,
): string {
  if (cmdType === 'pr_create') {
    // Check for verification markers in the command (heredoc body)
    if (/##\s*Verification|##\s*Test\s+plan|Success\s+criteria|verify|verification/i.test(command)) {
      return '';
    }
    return `\u26a0\ufe0f  Missing Verification section in PR body (CLAUDE.md post-merge policy).

Every PR must include a Verification section with:
1. Concrete success criteria
2. How to verify (commands or steps)
3. Expected outcome

CI pr-policy check will block merge if this is missing.`;
  }

  if (cmdType === 'pr_merge') {
    // For merge: fetch PR body and show verification steps
    const cmdLine = stripHeredocBody(command);
    const prNumMatch = cmdLine.match(/gh\s+pr\s+merge\s+(\d+)/);
    let prBody: string;
    if (prNumMatch) {
      prBody = exec(`gh pr view ${prNumMatch[1]} --json body --jq '.body'`);
    } else {
      prBody = exec("gh pr view --json body --jq '.body'");
    }

    if (!prBody) return '';

    // Extract verification section — find the header and content until next ## or end
    const lines = prBody.split('\n');
    let inVerification = false;
    const verificationLines: string[] = [];
    for (const line of lines) {
      if (/^##\s*.*[Vv]erification/.test(line)) {
        inVerification = true;
        verificationLines.push(line);
        continue;
      }
      if (inVerification && /^##/.test(line)) break;
      if (inVerification) verificationLines.push(line);
    }
    if (verificationLines.length > 0) {
      const verification = verificationLines.slice(0, 20).join('\n');
      return `\n\ud83d\udccb POST-MERGE VERIFICATION REQUIRED

After merge, you MUST run these verification steps:

${verification}

Follow the Post-Merge deployment procedure in CLAUDE.md.`;
    }

    return '\u26a0\ufe0f  This PR has no Verification section. After merge, manually verify the change works as expected.';
  }

  return '';
}

// Check 3: Practices checklist
export function checkPractices(
  changedFiles: string[],
  hookDir?: string,
): string {
  if (changedFiles.length === 0) return '';

  const hasShell = changedFiles.some((f) => /\.sh$/.test(f));
  const hasTs = changedFiles.some((f) =>
    /\.(ts|js|tsx|jsx)$/.test(f) && !/\.(test|spec)\./.test(f),
  );
  const hasTests = changedFiles.some((f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f));
  const hasHooks = changedFiles.some((f) => /\.claude\/hooks\/|kaizen\/hooks\//.test(f));
  const hasContainer = changedFiles.some((f) => /container\//.test(f));

  const practices: string[] = [
    'DRY \u2014 Any duplicated patterns that should be extracted?',
    'Display URLs \u2014 All links (PRs, issues, CI) surfaced in text?',
    'Evidence over summaries \u2014 Actual data pasted, not descriptions?',
  ];

  if (hasShell || hasHooks) {
    practices.push('Error paths \u2014 Failure modes handled, not silently swallowed?');
  }
  if (hasTs) {
    practices.push('Minimal surface \u2014 Simplest possible interface for consumers?');
    practices.push('Dependencies declared \u2014 Every import has a package.json entry?');
  }
  if (hasTests || hasTs || hasShell) {
    practices.push('Test the interaction \u2014 Cross-component behavior verified?');
  }
  if (hasContainer) {
    practices.push('Test deployed artifact \u2014 Verified in actual container, not just source?');
    practices.push('Test fresh state \u2014 Works without cached artifacts or prior setup?');
  }
  if (hasHooks) {
    practices.push('Worktree isolation \u2014 No cross-worktree state reads or writes?');
  }
  if (hasTs) {
    practices.push('Harness or vertical \u2014 Code in the right repo?');
  }

  const list = practices.map((p) => `  * ${p}`).join('\n');
  return `
PRACTICES CHECKLIST

Which of these are relevant to your change?

${list}

Address relevant items or consciously skip.
Full checklist: .claude/kaizen/practices.md`;
}

// Check 4: Code quality warnings
export interface CodeQualityResult {
  warnings: string[];
}

export function checkCodeQuality(
  changedFiles: string[],
  cmdType: CommandType,
  opts: RunnerOptions = {},
): CodeQualityResult {
  const fileExists = opts.fileExists ?? existsSync;
  const readFile = opts.readFile ?? ((p: string) => {
    try { return readFileSync(p, 'utf-8'); } catch { return ''; }
  });
  const warnings: string[] = [];

  // Checks 1 & 2: commit-time only (fast, per-file)
  if (cmdType === 'git_commit') {
    const MOCK_THRESHOLD = 3;
    const LINE_THRESHOLD = 500;

    // Get staged files
    const exec = opts.exec ?? defaultExec;
    const stagedRaw = exec('git diff --cached --name-only');
    const stagedFiles = stagedRaw.split('\n').filter(Boolean);

    // Check 1: Mock count in test files
    const stagedTests = stagedFiles.filter((f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f));
    for (const testFile of stagedTests) {
      if (!fileExists(testFile)) continue;
      const content = readFile(testFile);
      const mockCount = (content.match(/vi\.mock|jest\.mock|vi\.spyOn.*mockImplementation/g) || []).length;
      if (mockCount > MOCK_THRESHOLD) {
        warnings.push(`  \ud83e\uddea ${testFile.replace(/^.*\//, '')}: ${mockCount} mocks (threshold: ${MOCK_THRESHOLD})`);
      }
    }

    // Check 2: File length for source files
    const sourceFiles = stagedFiles.filter(
      (f) => /\.(ts|js|tsx|jsx)$/.test(f) && !/\.(test|spec)\./.test(f),
    );
    for (const srcFile of sourceFiles) {
      if (!fileExists(srcFile)) continue;
      const content = readFile(srcFile);
      const lineCount = content.split('\n').length;
      if (lineCount > LINE_THRESHOLD) {
        warnings.push(`  \ud83d\udccf ${srcFile.replace(/^.*\//, '')}: ${lineCount} lines (threshold: ${LINE_THRESHOLD})`);
      }
    }
  }

  // Check 3: jscpd duplication (PR create/merge only) — delegated to bash/npx
  // We intentionally skip jscpd here since it requires npx and tmp dirs.
  // The duplication check is a nice-to-have that adds complexity.
  // It can be re-added if needed.

  return { warnings };
}

export function formatCodeQualityWarning(result: CodeQualityResult, cmdType: CommandType): string {
  if (result.warnings.length === 0) return '';
  const context = cmdType === 'git_commit' ? 'staged files' : 'PR changed files';
  return `\u26a0\ufe0f  Code quality warnings in ${context}:

${result.warnings.join('\n')}
See: Zen of Kaizen \u2014 "Avoiding overengineering is not a license to underengineer."`;
}

// Main orchestrator
export interface QualityCheckOutput {
  messages: string[];
}

export function runQualityChecks(
  command: string,
  opts: RunnerOptions = {},
): QualityCheckOutput {
  const exec = opts.exec ?? defaultExec;
  const cmdLine = stripHeredocBody(command);
  const cmdType = detectCommandType(cmdLine);

  if (cmdType === 'none') return { messages: [] };

  const messages: string[] = [];

  const isMerge = cmdType === 'pr_merge';
  const isPrCommand = cmdType === 'pr_create' || cmdType === 'pr_merge';

  if (isPrCommand) {
    const changedFiles = getChangedFiles(cmdLine, isMerge, exec);

    // Test coverage check (pr_create and pr_merge)
    const coverageResult = checkTestCoverage(changedFiles, opts);
    const coverageMsg = formatTestCoverageWarning(coverageResult, isMerge);
    if (coverageMsg) messages.push(coverageMsg);

    // Verification check
    const verificationMsg = checkVerification(command, cmdType, exec);
    if (verificationMsg) messages.push(verificationMsg);

    // Practices checklist (pr_create only)
    if (cmdType === 'pr_create') {
      const practicesMsg = checkPractices(changedFiles, opts.hookDir);
      if (practicesMsg) messages.push(practicesMsg);
    }
  }

  // Code quality (all command types)
  const qualityResult = checkCodeQuality(
    [], // changedFiles not needed for git_commit (it reads staged files itself)
    cmdType,
    opts,
  );
  const qualityMsg = formatCodeQualityWarning(qualityResult, cmdType);
  if (qualityMsg) messages.push(qualityMsg);

  return { messages };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const command = input.tool_input?.command ?? '';
  const result = runQualityChecks(command);

  if (result.messages.length > 0) {
    process.stderr.write('\n' + result.messages.join('\n\n') + '\n');
  }

  // Always advisory — never blocks
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-quality-checks.ts') ||
  process.argv[1]?.endsWith('pr-quality-checks.js')
) {
  main().catch(() => process.exit(0));
}
