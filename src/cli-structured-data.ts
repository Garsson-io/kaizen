#!/usr/bin/env npx tsx
/**
 * cli-structured-data.ts — High-level CLI for kaizen structured data.
 *
 * Reviews:
 *   npx tsx src/cli-structured-data.ts store-review-finding --pr 903 --repo R --round 5 --dimension correctness --file findings.md
 *   npx tsx src/cli-structured-data.ts store-review-summary --pr 903 --repo R --round 5 --text "PASSED — 5 rounds"
 *   npx tsx src/cli-structured-data.ts list-review-rounds --pr 903 --repo R
 *   npx tsx src/cli-structured-data.ts list-review-dims --pr 903 --repo R --round 5
 *   npx tsx src/cli-structured-data.ts read-review-finding --pr 903 --repo R --round 5 --dimension correctness
 *   npx tsx src/cli-structured-data.ts read-review-summary --pr 903 --repo R --round 5
 *
 * Plans:
 *   npx tsx src/cli-structured-data.ts store-plan --issue 904 --repo R --file plan.md
 *   npx tsx src/cli-structured-data.ts retrieve-plan --issue 904 --repo R
 *   npx tsx src/cli-structured-data.ts store-testplan --issue 904 --repo R --file testplan.md
 *   npx tsx src/cli-structured-data.ts retrieve-testplan --issue 904 --repo R
 *
 * Metadata:
 *   npx tsx src/cli-structured-data.ts store-metadata --issue 904 --repo R --file metadata.yaml
 *   npx tsx src/cli-structured-data.ts retrieve-metadata --issue 904 --repo R
 *   npx tsx src/cli-structured-data.ts query-connected --issue 904 --repo R
 *   npx tsx src/cli-structured-data.ts query-pr --issue 904 --repo R
 *
 * PR sections:
 *   npx tsx src/cli-structured-data.ts update-pr-section --pr 903 --repo R --name "Validation" --text "..."
 *
 * Iteration:
 *   npx tsx src/cli-structured-data.ts store-iteration --pr 903 --repo R --file state.json
 *   npx tsx src/cli-structured-data.ts retrieve-iteration --pr 903 --repo R
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import YAML from 'yaml';
import {
  prTarget,
  issueTarget,
  storeReviewFinding,
  storeReviewSummary,
  storeReviewBatch,
  storeQuickPass,
  nextReviewRound,
  latestReviewRound,
  listReviewRounds,
  listReviewDimensions,
  readReviewFinding,
  readReviewSummary,
  storePlan,
  retrievePlan,
  storeTestPlan,
  retrieveTestPlan,
  storeMetadata,
  retrieveMetadata,
  queryConnectedIssues,
  queryPrNumber,
  updatePrSection,
  storeIterationState,
  retrieveIterationState,
  type ReviewFindingData,
} from './structured-data.js';

function parseArgs(): Record<string, string> & { command: string } {
  const args = process.argv.slice(2);
  const command = args[0] ?? '';
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      flags[args[i].slice(2)] = args[++i];
    }
  }
  return { command, ...flags };
}

function main(): void {
  const a = parseArgs();
  const repo = a.repo as string;
  if (!a.command || !repo) {
    console.error('Usage: npx tsx src/cli-structured-data.ts <command> --repo <owner/repo> [options]');
    process.exit(1);
  }
  /** Read content from --file, --text, or stdin (--stdin flag). */
  const content = (): string => {
    if (a.file) return readFileSync(a.file, 'utf8');
    if (a.text) return a.text;
    if (a.stdin === 'true' || a.stdin === '') {
      try { return execSync('cat', { encoding: 'utf8', timeout: 5000 }); } catch { return ''; }
    }
    return '';
  };

  /** Get round number: --round N, or auto via next-round. */
  const round = (): number => {
    if (a.round) return parseInt(a.round, 10);
    if (a.pr) return nextReviewRound(prTarget(a.pr, repo));
    return 1;
  };

  switch (a.command) {
    // Reviews
    case 'next-round': {
      console.log(nextReviewRound(prTarget(a.pr, repo)));
      break;
    }
    case 'store-review-finding': {
      const pr = prTarget(a.pr, repo);
      const r = round();
      const dim = a.dimension ?? 'unknown';
      const text = content();
      let finding: ReviewFindingData;
      try {
        finding = JSON.parse(text);
      } catch {
        finding = { dimension: dim, verdict: 'fail', summary: text.slice(0, 100), findings: [] };
      }
      if (!finding.dimension || finding.dimension === 'unknown') finding.dimension = dim;
      const url = storeReviewFinding(pr, r, finding);
      console.log(`Review finding stored (round ${r}): ${url}`);
      break;
    }
    case 'store-review-batch': {
      // Accepts JSON array of ReviewFindingData via --file or --stdin
      const pr = prTarget(a.pr, repo);
      const r = round();
      const findings: ReviewFindingData[] = JSON.parse(content());
      const result = storeReviewBatch(pr, r, findings);
      console.log(`Batch stored: ${result.urls.length} findings + summary (round ${r})`);
      console.log(`Summary: ${result.summaryUrl}`);
      break;
    }
    case 'quick-pass': {
      // Quick shorthand: --dimension correctness --summary "All good" --requirements "R1,R2,R3"
      const pr = prTarget(a.pr, repo);
      const r = round();
      const reqs = (a.requirements ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const url = storeQuickPass(pr, r, a.dimension ?? 'unknown', a.summary ?? 'All requirements met', reqs);
      console.log(`Quick pass stored (round ${r}): ${url}`);
      break;
    }
    case 'store-review-summary': {
      const text = a.file ? readFileSync(a.file, 'utf8') : a.text;
      const r = round();
      const url = storeReviewSummary(prTarget(a.pr, repo), r, text || undefined);
      console.log(`Review summary stored (round ${r}): ${url}`);
      break;
    }
    case 'list-review-rounds': {
      const rounds = listReviewRounds(prTarget(a.pr, repo));
      if (rounds.length === 0) { console.log('No review rounds found.'); break; }
      console.log(`${rounds.length} round(s): ${rounds.join(', ')}`);
      break;
    }
    case 'list-review-dims': {
      const dims = listReviewDimensions(prTarget(a.pr, repo), parseInt(a.round ?? '1', 10));
      if (dims.length === 0) { console.log('No dimensions found.'); break; }
      for (const d of dims) console.log(d);
      break;
    }
    case 'read-review-finding': {
      const text = readReviewFinding(prTarget(a.pr, repo), parseInt(a.round ?? '1', 10), a.dimension ?? '');
      if (!text) { console.error('Finding not found.'); process.exit(1); }
      console.log(text);
      break;
    }
    case 'read-review-summary': {
      const text = readReviewSummary(prTarget(a.pr, repo), parseInt(a.round ?? '1', 10));
      if (!text) { console.error('Summary not found.'); process.exit(1); }
      console.log(text);
      break;
    }
    // Plans
    case 'store-plan': {
      const url = storePlan(issueTarget(a.issue, repo), content());
      console.log(`Plan stored: ${url}`);
      break;
    }
    case 'retrieve-plan': {
      const text = retrievePlan(issueTarget(a.issue, repo));
      if (!text) { console.error('No plan found.'); process.exit(1); }
      console.log(text);
      break;
    }
    case 'store-testplan': {
      const url = storeTestPlan(issueTarget(a.issue, repo), content());
      console.log(`Test plan stored: ${url}`);
      break;
    }
    case 'retrieve-testplan': {
      const text = retrieveTestPlan(issueTarget(a.issue, repo));
      if (!text) { console.error('No test plan found.'); process.exit(1); }
      console.log(text);
      break;
    }
    // Metadata
    case 'store-metadata': {
      const data = YAML.parse(content()) as Record<string, unknown>;
      const url = storeMetadata(issueTarget(a.issue, repo), data);
      console.log(`Metadata stored: ${url}`);
      break;
    }
    case 'retrieve-metadata': {
      const data = retrieveMetadata(issueTarget(a.issue, repo));
      if (!data) { console.error('No metadata found.'); process.exit(1); }
      console.log(YAML.stringify(data));
      break;
    }
    case 'query-connected': {
      const issues = queryConnectedIssues(issueTarget(a.issue, repo));
      if (issues.length === 0) { console.log('No connected issues.'); break; }
      for (const i of issues) console.log(`#${i.number} [${i.role}] ${i.title}`);
      break;
    }
    case 'query-pr': {
      const pr = queryPrNumber(issueTarget(a.issue, repo));
      if (!pr) { console.error('No PR number found.'); process.exit(1); }
      console.log(pr);
      break;
    }
    // PR sections
    case 'update-pr-section': {
      updatePrSection(prTarget(a.pr, repo), a.name ?? a.section ?? '', content());
      console.log(`Section "${a.name ?? a.section}" updated.`);
      break;
    }
    // Iteration
    case 'store-iteration': {
      const state = JSON.parse(content());
      const url = storeIterationState(
        a.pr ? prTarget(a.pr, repo) : issueTarget(a.issue, repo),
        state,
      );
      console.log(`Iteration state stored: ${url}`);
      break;
    }
    case 'retrieve-iteration': {
      const state = retrieveIterationState(
        a.pr ? prTarget(a.pr, repo) : issueTarget(a.issue, repo),
      );
      if (!state) { console.error('No iteration state found.'); process.exit(1); }
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${a.command}`);
      process.exit(1);
  }
}

main();
