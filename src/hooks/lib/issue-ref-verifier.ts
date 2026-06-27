/**
 * issue-ref-verifier.ts — Outcome-verification predicate for issue/PR references.
 *
 * Part of the Outcome Verification Contract (docs/hooks-design.md): a clearing
 * gate must verify the *outcome* a declaration claims, not merely that the
 * declaration was made. The reflection gate (pr-kaizen-clear.ts) accepts
 * `{"disposition":"filed","ref":"#N"}` to clear — this module checks that `#N`
 * actually exists, so a fabricated ref cannot clear the gate (kaizen #950, #943).
 *
 * Design (meet reality):
 *   - exists       → the referenced issue/PR resolves in a candidate repo.
 *   - missing      → gh resolved cleanly but the number does not exist anywhere
 *                    we looked. The gate fails CLOSED on this.
 *   - unverifiable → we could not get a definitive answer (parse failure, no
 *                    candidate repo, network/auth error). The gate fails OPEN —
 *                    a flaky network must never deadlock a run.
 */

import { ghResult } from '../../lib/gh-exec.js';

export type RefStatus = 'exists' | 'missing' | 'unverifiable';

export interface ParsedRef {
  /** owner/repo if the ref carried one (URL or owner/repo#N form). */
  repo?: string;
  number: number;
}

export type GhRunner = (args: string[]) => {
  status: number;
  stdout: string;
  stderr: string;
};

const defaultRunner: GhRunner = (args) => ghResult(args, 15_000);

/**
 * Parse an issue/PR reference. Accepts: a full github URL, `owner/repo#N`,
 * `#N`, or a bare number (optionally followed by other text). Returns null
 * when no issue number can be found.
 */
export function parseIssueRef(ref: string): ParsedRef | null {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(
    /github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/,
  );
  if (urlMatch) {
    return { repo: urlMatch[1], number: parseInt(urlMatch[2], 10) };
  }

  const ownerRepoHash = trimmed.match(/^([^/\s]+\/[^/\s#]+)#(\d+)\b/);
  if (ownerRepoHash) {
    return { repo: ownerRepoHash[1], number: parseInt(ownerRepoHash[2], 10) };
  }

  const numMatch = trimmed.match(/^#?(\d+)\b/);
  if (numMatch) {
    return { number: parseInt(numMatch[1], 10) };
  }

  return null;
}

/** True when stderr indicates gh resolved cleanly but found no such issue/PR. */
function isDefinitiveNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('could not resolve to') ||
    s.includes('no issue found') ||
    s.includes('no pull request found') ||
    s.includes('not found')
  );
}

/**
 * Verify that `ref` points to an issue or PR that exists.
 *
 * If the ref embeds a repo (URL / owner-repo form) that repo is authoritative;
 * otherwise every repo in `candidateRepos` is tried (covers self-dogfood where
 * issues.repo == host repo, and host mode where meta-kaizen issues live in the
 * kaizen repo). A number that is a PR rather than an issue still counts as
 * `exists` — refs legitimately point at PRs.
 */
export function verifyIssueRef(
  ref: string,
  candidateRepos: string[],
  runner: GhRunner = defaultRunner,
): RefStatus {
  const parsed = parseIssueRef(ref);
  if (!parsed) return 'unverifiable';

  const repos = parsed.repo
    ? [parsed.repo]
    : candidateRepos.filter((r) => !!r);
  if (repos.length === 0) return 'unverifiable';

  const num = String(parsed.number);
  let sawDefinitiveMissing = false;

  for (const repo of repos) {
    for (const kind of ['issue', 'pr'] as const) {
      const r = runner([kind, 'view', num, '--repo', repo, '--json', 'number']);
      if (r.status === 0) return 'exists';
      if (!isDefinitiveNotFound(r.stderr)) {
        // Network / auth / unexpected error — cannot conclude. Fail open.
        return 'unverifiable';
      }
      sawDefinitiveMissing = true;
    }
  }

  return sawDefinitiveMissing ? 'missing' : 'unverifiable';
}
