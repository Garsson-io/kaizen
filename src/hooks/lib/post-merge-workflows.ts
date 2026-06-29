import { parseGithubPrUrl } from '../../lib/github-pr.js';

function repoArg(prUrl: string): string {
  const parsed = parseGithubPrUrl(prUrl);
  return parsed ? `--repo ${parsed.repo} ` : '';
}

/**
 * Instructions for checking workflows that run only after the merge commit
 * lands on main. The hook cannot know the merge SHA synchronously, so it gives
 * the agent the exact command shape and a placeholder to fill after merge.
 */
export function postMergeWorkflowVerificationLines(prUrl: string): string {
  const repo = repoArg(prUrl);
  return [
    '**Verify workflows on main** — check runs triggered by the merge commit:',
    `   - Merge SHA: \`gh pr view ${repo}--json mergeCommit --jq '.mergeCommit.oid'\``,
    `   - Workflow runs: \`gh run list ${repo}--branch main --commit <merge-sha>\``,
    '   - If any run failed, investigate and report or fix it before declaring the work done.',
  ].join('\n');
}
