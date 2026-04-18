/**
 * prehook-no-verify.ts — Deny `git push --no-verify` (epic #1059 acceptance).
 *
 * PreToolUse hook on Bash. Detects any `git push` invocation that includes
 * `--no-verify` or `-n`, denies the tool call, and instructs the agent
 * to use the `kaizen-force` push option for legitimate history-correction.
 *
 * Why this matters: `git push --no-verify` bypasses ALL git hooks, including
 * kaizen's pre-push merged-branch block and review-gate creation. With
 * agent-only gating, humans never hit kaizen's gate, so there's no legitimate
 * reason for an agent to use --no-verify.
 *
 * Escape hatch: push options (`-o kaizen-force`) go through the hook and
 * are recognized by `pre-push.ts` as an explicit override for merged-branch
 * correction.
 */

import { readHookInput, traceNullInput } from './hook-io.js';

export interface NoVerifyDecision {
  allow: boolean;
  reason: string;
  message?: string;
}

/**
 * Inspect a git-push command string for --no-verify / -n flags.
 *
 * Matches:
 *   git push --no-verify
 *   git push -n
 *   git push origin main --no-verify
 *
 * Does NOT match:
 *   git push origin --set-upstream  (no --no-verify)
 *   git push -n  ← wait, -n is --dry-run, not --no-verify in git push!
 *
 * Per `git push --help`:
 *   --no-verify        bypass pre-push hook
 *   -n, --dry-run      dry run
 *
 * `-n` is `--dry-run`, which is safe. We only block `--no-verify`.
 */
export function analyzeCommand(command: string): NoVerifyDecision {
  if (!command.trim()) {
    return { allow: true, reason: 'empty_command' };
  }

  // Split into segments on `;`, `|`, `&&`, `||`, newline, AND subshell
  // punctuation (`$(`, `)`, backticks) so wrappers like `$(git push
  // --no-verify)` and `` `git push --no-verify` `` land in their own
  // segment rather than hiding the git-push token behind `$`/`(`/`` ` ``.
  const segments = command.split(/;|\|\||\&\&|\||\n|\$\(|\)|`/);

  // Within each chained segment, look for both:
  //   1. `git push` (possibly path-prefixed or preceded by wrappers/env)
  //   2. `--no-verify` flag (at a word boundary, not inside a quoted string)
  //
  // If both appear in the same segment, deny. This is a deliberately loose
  // match — we accept that `echo 'git push --no-verify'` in a segment that
  // doesn't actually push would be flagged, but that's a degenerate case
  // (the agent isn't trying to push) and the deny is advisory.
  //
  // Handles prefixes that bypass a strict-start regex:
  //   KEY=val git push --no-verify
  //   sudo git push --no-verify
  //   time git push --no-verify
  //   ionice -c 3 git push --no-verify
  //   /usr/bin/git push --no-verify
  //   env KEY=val git push --no-verify

  // Leading boundary must include quotes (`'`, `"`) so `bash -c 'git push
  // --no-verify'` is caught — the `'` is non-space but non-word so we widen
  // `\s` to "any non-identifier char". Same for the flag check.
  const GIT_PUSH_ANYWHERE = /(^|[^A-Za-z0-9_])(?:\S+\/)?git\s+push\b/;
  const NO_VERIFY_FLAG = /(^|[^A-Za-z0-9_])--no-verify\b/;

  for (const seg of segments) {
    if (!GIT_PUSH_ANYWHERE.test(seg)) continue;
    if (NO_VERIFY_FLAG.test(seg)) {
      return {
        allow: false,
        reason: 'no_verify_flag',
        message: buildDenyMessage(),
      };
    }
  }

  return { allow: true, reason: 'no_trigger_match' };
}

function buildDenyMessage(): string {
  return [
    '`git push --no-verify` is blocked by kaizen policy.',
    '',
    'Kaizen hooks only fire for AI-agent sessions (see docs/git-hooks-design.md).',
    'Human developers are never gated, so there is no legitimate reason',
    'for an agent to bypass the pre-push hook.',
    '',
    'If you are correcting a merged branch\'s history, use the explicit',
    'override instead:',
    '',
    '  git push -o kaizen-force ...',
    '',
    'If the hook is failing with a bug, fix the hook — do not bypass it.',
  ].join('\n');
}

// ── CLI entry ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) {
    traceNullInput('prehook-no-verify');
    process.exit(0);
  }

  const command = input.tool_input?.command ?? '';
  const decision = analyzeCommand(command);

  if (decision.allow) {
    process.exit(0);
  }

  // Claude Code PreToolUse deny protocol.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.message ?? 'git push --no-verify is not allowed',
    },
  }));
  process.exit(0);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('prehook-no-verify.ts');
if (isMain) {
  main().catch(err => {
    process.stderr.write(`kaizen prehook-no-verify: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0); // fail-open on internal errors
  });
}
