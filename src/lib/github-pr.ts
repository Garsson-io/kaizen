import { gh as defaultGh } from './gh-exec.js';
import { parseJsonArray, parseJsonObject } from './json-value.js';

export type GhRunner = (args: string[]) => string;

export interface FindOpenPrUrlForBranchOptions {
  branch: string;
  /** Optional repo (`owner/name`). Omit to let gh infer the current repo. */
  repo?: string;
  /** Injectable gh runner for tests and callers that already own gh wiring. */
  gh?: GhRunner;
}

export type BranchPrState = 'MERGED' | 'CLOSED' | 'OPEN';

export interface BranchPrSummary {
  number: number;
  state: BranchPrState;
  url: string;
}

export interface BranchPrQueryResult {
  mostRecent: BranchPrSummary | null;
  hasOpen: boolean;
  openUrl?: string;
}

export interface GithubPrUrl {
  repo: string;
  number: number;
}

export interface GithubIssueUrl {
  repo: string;
  number: number;
}

export interface QueryBranchPrStateOptions {
  repo: string;
  branch: string;
  /** Injectable gh runner for tests and callers that already own gh wiring. */
  gh?: GhRunner;
}

export function emptyBranchPrQueryResult(): BranchPrQueryResult {
  return { mostRecent: null, hasOpen: false };
}

export function parseGithubPrUrl(prUrl: string | undefined | null): GithubPrUrl | null {
  if (!prUrl) return null;
  const match = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo: match[1], number };
}

export function parseGithubIssueUrl(issueUrl: string | undefined | null): GithubIssueUrl | null {
  if (!issueUrl) return null;
  const match = issueUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo: match[1], number };
}

export function extractPrUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+/)?.[0];
}

export function parseFirstPrUrl(output: string): string | undefined {
  const parsed = parseJsonArray(output);
  const url = (parsed[0] as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

function normalizeBranchPrSummary(input: unknown): BranchPrSummary | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const state = raw.state;
  if (state !== 'MERGED' && state !== 'CLOSED' && state !== 'OPEN') return undefined;
  if (typeof raw.number !== 'number' || !Number.isFinite(raw.number)) return undefined;
  if (typeof raw.url !== 'string' || raw.url.length === 0) return undefined;
  return { number: raw.number, state, url: raw.url };
}

export function parseBranchPrQueryResult(output: string): BranchPrQueryResult {
  const prs = parseJsonArray(output)
    .map((item) => normalizeBranchPrSummary(item))
    .filter((item): item is BranchPrSummary => item != null);
  if (prs.length === 0) return emptyBranchPrQueryResult();

  const open = prs.find((pr) => pr.state === 'OPEN');
  return {
    mostRecent: prs[0],
    hasOpen: open != null,
    ...(open ? { openUrl: open.url } : {}),
  };
}

export function findOpenPrUrlForBranch(options: FindOpenPrUrlForBranchOptions): string | undefined {
  const runGh = options.gh ?? defaultGh;
  const args = ['pr', 'list'];
  if (options.repo) args.push('--repo', options.repo);
  args.push('--head', options.branch, '--state', 'open', '--json', 'url', '--limit', '1');

  try {
    return parseFirstPrUrl(runGh(args));
  } catch {
    return undefined;
  }
}

export function queryBranchPrState(options: QueryBranchPrStateOptions): BranchPrQueryResult {
  if (!options.repo || !options.branch) return emptyBranchPrQueryResult();

  const runGh = options.gh ?? defaultGh;
  try {
    return parseBranchPrQueryResult(runGh([
      'pr', 'list',
      '--repo', options.repo,
      '--head', options.branch,
      '--state', 'all',
      '--json', 'number,state,url',
      '--limit', '5',
    ]));
  } catch {
    return emptyBranchPrQueryResult();
  }
}

export type IssueState = 'OPEN' | 'CLOSED';

/**
 * Extract a GitHub issue number from a loose token — `#1225`, `1225`, or a
 * URL like `https://github.com/o/r/issues/1225`. Returns the first run of
 * digits as a number, or null when the token carries none. Deliberately
 * permissive: callers pass values pulled from phase markers / config where the
 * `#` prefix and URL form both occur.
 */
export function parseIssueNumber(token: string | undefined | null): number | null {
  if (!token) return null;
  const match = /(\d+)/.exec(token);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an issue's state from `gh issue view --json state` output. Returns
 * 'OPEN'/'CLOSED', or null for malformed/empty/unexpected output. Fail-open by
 * design: a null result means "state unknown", which callers must treat as
 * "do not block" — never as "closed".
 */
export function parseIssueState(output: string): IssueState | null {
  const parsed = parseJsonObject(output);
  const raw = typeof parsed?.state === 'string' ? parsed.state.toUpperCase() : null;
  return raw === 'OPEN' || raw === 'CLOSED' ? raw : null;
}

export interface QueryIssueStateOptions {
  repo: string;
  issue: number;
  /** Injectable gh runner for tests and callers that already own gh wiring. */
  gh?: GhRunner;
}

/**
 * Query a single issue's state via gh. Sibling of {@link queryBranchPrState} —
 * one DRY boundary for gh issue-state lookups, no second gh wrapper. Returns
 * null on any failure (missing repo/issue, gh throw, malformed output) so the
 * caller fails open: an unknown state must never be mistaken for CLOSED.
 */
export function queryIssueState(options: QueryIssueStateOptions): IssueState | null {
  if (!options.repo || !Number.isFinite(options.issue)) return null;
  const runGh = options.gh ?? defaultGh;
  try {
    return parseIssueState(runGh([
      'issue', 'view', String(options.issue),
      '--repo', options.repo,
      '--json', 'state',
    ]));
  } catch {
    return null;
  }
}
