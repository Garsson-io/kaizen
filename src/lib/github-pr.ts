import { gh as defaultGh } from './gh-exec.js';

export type GhRunner = (args: string[]) => string;

export interface FindOpenPrUrlForBranchOptions {
  branch: string;
  /** Optional repo (`owner/name`). Omit to let gh infer the current repo. */
  repo?: string;
  /** Injectable gh runner for tests and callers that already own gh wiring. */
  gh?: GhRunner;
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
