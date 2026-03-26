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
import YAML from 'yaml';
import {
  prTarget,
  issueTarget,
  storeReviewFinding,
  storeReviewSummary,
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
  const content = () => a.file ? readFileSync(a.file, 'utf8') : a.text ?? '';

  switch (a.command) {
    // Reviews
    case 'store-review-finding': {
      const pr = prTarget(a.pr, repo);
      const round = parseInt(a.round ?? '1', 10);
      const dim = a.dimension ?? 'unknown';
      const text = content();
      // If content is JSON, parse it; otherwise store as-is
      let finding: ReviewFindingData;
      try {
        finding = JSON.parse(text);
      } catch {
        finding = { dimension: dim, verdict: 'fail', summary: text.slice(0, 100), findings: [] };
      }
      finding.dimension = dim;
      const url = storeReviewFinding(pr, round, finding);
      console.log(`Review finding stored: ${url}`);
      break;
    }
    case 'store-review-summary': {
      const text = a.file ? readFileSync(a.file, 'utf8') : a.text;
      const url = storeReviewSummary(prTarget(a.pr, repo), parseInt(a.round ?? '1', 10), text || undefined);
      console.log(`Review summary stored: ${url}`);
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
