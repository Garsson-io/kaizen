import { gh as defaultGh } from './gh-exec.js';

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

export interface QueryBranchPrStateOptions {
  repo: string;
  branch: string;
  /** Injectable gh runner for tests and callers that already own gh wiring. */
  gh?: GhRunner;
}

export function emptyBranchPrQueryResult(): BranchPrQueryResult {
  return { mostRecent: null, hasOpen: false };
}

export function parseFirstPrUrl(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output || '[]') as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const url = (parsed[0] as { url?: unknown } | undefined)?.url;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
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
  try {
    const parsed = JSON.parse(output || '[]') as unknown;
    if (!Array.isArray(parsed)) return emptyBranchPrQueryResult();
    const prs = parsed
      .map((item) => normalizeBranchPrSummary(item))
      .filter((item): item is BranchPrSummary => item != null);
    if (prs.length === 0) return emptyBranchPrQueryResult();

    const open = prs.find((pr) => pr.state === 'OPEN');
    return {
      mostRecent: prs[0],
      hasOpen: open != null,
      ...(open ? { openUrl: open.url } : {}),
    };
  } catch {
    return emptyBranchPrQueryResult();
  }
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
