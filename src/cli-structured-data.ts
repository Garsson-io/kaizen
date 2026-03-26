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

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
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

export type CliArgs = Record<string, string> & { command: string };
type Handler = (a: CliArgs) => Promise<void>;

export function parseArgs(argv?: string[]): CliArgs {
  const args = argv ?? process.argv.slice(2);
  const command = args[0] ?? '';
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      flags[args[i].slice(2)] = args[++i];
    }
  }
  return { command, ...flags } as CliArgs;
}

/** Read content from --file, --text, or stdin (--stdin flag). */
export function resolveContent(a: CliArgs): string {
  if (a.file) return readFileSync(a.file, 'utf8');
  if (a.text) return a.text;
  if (a.stdin === 'true' || a.stdin === '') {
    try { return execSync('cat', { encoding: 'utf8', timeout: 5000 }); } catch { return ''; }
  }
  return '';
}

/** Get round number: --round N, or auto via next-round. */
export function resolveRound(a: CliArgs): number {
  if (a.round) return parseInt(a.round, 10);
  if (a.pr) return nextReviewRound(prTarget(a.pr, a.repo));
  return 1;
}

// Review handlers

async function handleNextRound(a: CliArgs): Promise<void> {
  console.log(nextReviewRound(prTarget(a.pr, a.repo)));
}

async function handleStoreReviewFinding(a: CliArgs): Promise<void> {
  const pr = prTarget(a.pr, a.repo);
  const r = resolveRound(a);
  const dim = a.dimension ?? 'unknown';
  const text = resolveContent(a);
  let finding: ReviewFindingData;
  try {
    finding = JSON.parse(text);
  } catch {
    finding = { dimension: dim, verdict: 'fail', summary: text.slice(0, 100), findings: [] };
  }
  if (!finding.dimension || finding.dimension === 'unknown') finding.dimension = dim;
  const url = storeReviewFinding(pr, r, finding);
  console.log(`Review finding stored (round ${r}): ${url}`);
}

async function handleStoreReviewBatch(a: CliArgs): Promise<void> {
  const pr = prTarget(a.pr, a.repo);
  const r = resolveRound(a);
  const findings: ReviewFindingData[] = JSON.parse(resolveContent(a));
  const result = storeReviewBatch(pr, r, findings);
  console.log(`Batch stored: ${result.urls.length} findings + summary (round ${r})`);
  console.log(`Summary: ${result.summaryUrl}`);
}

async function handleQuickPass(a: CliArgs): Promise<void> {
  const pr = prTarget(a.pr, a.repo);
  const r = resolveRound(a);
  const reqs = (a.requirements ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const url = storeQuickPass(pr, r, a.dimension ?? 'unknown', a.summary ?? 'All requirements met', reqs);
  console.log(`Quick pass stored (round ${r}): ${url}`);
}

async function handleStoreReviewSummary(a: CliArgs): Promise<void> {
  const text = resolveContent(a);
  const r = resolveRound(a);
  const url = storeReviewSummary(prTarget(a.pr, a.repo), r, text || undefined);
  // #920: Write review sentinel so pr-review-loop.ts can verify outcome
  try {
    const stateDir = process.env.STATE_DIR ?? '/tmp/.pr-review-state';
    const stateKey = `${a.repo.replace('/', '_')}_${a.pr ?? ''}`;
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(`${stateDir}/${stateKey}.reviewed-r${r}`, `reviewed_at=${new Date().toISOString()}\n`);
  } catch { /* best effort — sentinel is advisory */ }
  console.log(`Review summary stored (round ${r}): ${url}`);
}

async function handleListReviewRounds(a: CliArgs): Promise<void> {
  const rounds = listReviewRounds(prTarget(a.pr, a.repo));
  if (rounds.length === 0) { console.log('No review rounds found.'); return; }
  console.log(`${rounds.length} round(s): ${rounds.join(', ')}`);
}

async function handleListReviewDims(a: CliArgs): Promise<void> {
  const dims = listReviewDimensions(prTarget(a.pr, a.repo), parseInt(a.round ?? '1', 10));
  if (dims.length === 0) { console.log('No dimensions found.'); return; }
  for (const d of dims) console.log(d);
}

async function handleReadReviewFinding(a: CliArgs): Promise<void> {
  const text = readReviewFinding(prTarget(a.pr, a.repo), parseInt(a.round ?? '1', 10), a.dimension ?? '');
  if (!text) { console.error('Finding not found.'); process.exit(1); }
  console.log(text);
}

async function handleReadReviewSummary(a: CliArgs): Promise<void> {
  const text = readReviewSummary(prTarget(a.pr, a.repo), parseInt(a.round ?? '1', 10));
  if (!text) { console.error('Summary not found.'); process.exit(1); }
  console.log(text);
}

// Plan handlers

async function handleStorePlan(a: CliArgs): Promise<void> {
  const url = storePlan(issueTarget(a.issue, a.repo), resolveContent(a));
  console.log(`Plan stored: ${url}`);
}

async function handleRetrievePlan(a: CliArgs): Promise<void> {
  const text = retrievePlan(issueTarget(a.issue, a.repo));
  if (!text) { console.error('No plan found.'); process.exit(1); }
  console.log(text);
}

async function handleStoreTestplan(a: CliArgs): Promise<void> {
  const url = storeTestPlan(issueTarget(a.issue, a.repo), resolveContent(a));
  console.log(`Test plan stored: ${url}`);
}

async function handleRetrieveTestplan(a: CliArgs): Promise<void> {
  const text = retrieveTestPlan(issueTarget(a.issue, a.repo));
  if (!text) { console.error('No test plan found.'); process.exit(1); }
  console.log(text);
}

// Metadata handlers

async function handleStoreMetadata(a: CliArgs): Promise<void> {
  const data = YAML.parse(resolveContent(a)) as Record<string, unknown>;
  const url = storeMetadata(issueTarget(a.issue, a.repo), data);
  console.log(`Metadata stored: ${url}`);
}

async function handleRetrieveMetadata(a: CliArgs): Promise<void> {
  const data = retrieveMetadata(issueTarget(a.issue, a.repo));
  if (!data) { console.error('No metadata found.'); process.exit(1); }
  console.log(YAML.stringify(data));
}

async function handleQueryConnected(a: CliArgs): Promise<void> {
  const issues = queryConnectedIssues(issueTarget(a.issue, a.repo));
  if (issues.length === 0) { console.log('No connected issues.'); return; }
  for (const i of issues) console.log(`#${i.number} [${i.role}] ${i.title}`);
}

async function handleQueryPr(a: CliArgs): Promise<void> {
  const pr = queryPrNumber(issueTarget(a.issue, a.repo));
  if (!pr) { console.error('No PR number found.'); process.exit(1); }
  console.log(pr);
}

// PR section handlers

async function handleUpdatePrSection(a: CliArgs): Promise<void> {
  updatePrSection(prTarget(a.pr, a.repo), a.name ?? a.section ?? '', resolveContent(a));
  console.log(`Section "${a.name ?? a.section}" updated.`);
}

// Iteration handlers

async function handleStoreIteration(a: CliArgs): Promise<void> {
  const state = JSON.parse(resolveContent(a));
  const url = storeIterationState(
    a.pr ? prTarget(a.pr, a.repo) : issueTarget(a.issue, a.repo),
    state,
  );
  console.log(`Iteration state stored: ${url}`);
}

async function handleRetrieveIteration(a: CliArgs): Promise<void> {
  const state = retrieveIterationState(
    a.pr ? prTarget(a.pr, a.repo) : issueTarget(a.issue, a.repo),
  );
  if (!state) { console.error('No iteration state found.'); process.exit(1); }
  console.log(JSON.stringify(state, null, 2));
}

// Handler registry

export const handlers: Record<string, Handler> = {
  'next-round': handleNextRound,
  'store-review-finding': handleStoreReviewFinding,
  'store-review-batch': handleStoreReviewBatch,
  'quick-pass': handleQuickPass,
  'store-review-summary': handleStoreReviewSummary,
  'list-review-rounds': handleListReviewRounds,
  'list-review-dims': handleListReviewDims,
  'read-review-finding': handleReadReviewFinding,
  'read-review-summary': handleReadReviewSummary,
  'store-plan': handleStorePlan,
  'retrieve-plan': handleRetrievePlan,
  'store-testplan': handleStoreTestplan,
  'retrieve-testplan': handleRetrieveTestplan,
  'store-metadata': handleStoreMetadata,
  'retrieve-metadata': handleRetrieveMetadata,
  'query-connected': handleQueryConnected,
  'query-pr': handleQueryPr,
  'update-pr-section': handleUpdatePrSection,
  'store-iteration': handleStoreIteration,
  'retrieve-iteration': handleRetrieveIteration,
};

async function main(): Promise<void> {
  const a = parseArgs();
  const repo = a.repo as string;
  if (!a.command || !repo) {
    console.error('Usage: npx tsx src/cli-structured-data.ts <command> --repo <owner/repo> [options]');
    process.exit(1);
  }

  const handler = handlers[a.command];
  if (!handler) {
    console.error(`Unknown command: ${a.command}`);
    process.exit(1);
  }

  await handler(a);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun = typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('cli-structured-data.ts') || process.argv[1].endsWith('cli-structured-data.js'));

if (isDirectRun) {
  main();
}
