#!/usr/bin/env npx tsx
/**
 * cli-plan-store.ts — CLI for mechanistic plan/metadata storage on GitHub issues.
 *
 * Usage:
 *   npx tsx src/cli-plan-store.ts store-plan --issue 904 --repo Garsson-io/kaizen --text "## Plan\n..."
 *   npx tsx src/cli-plan-store.ts store-plan --issue 904 --repo Garsson-io/kaizen --file plan.md
 *   npx tsx src/cli-plan-store.ts retrieve-plan --issue 904 --repo Garsson-io/kaizen
 *   npx tsx src/cli-plan-store.ts store-metadata --issue 904 --repo Garsson-io/kaizen --file metadata.yaml
 *   npx tsx src/cli-plan-store.ts retrieve-metadata --issue 904 --repo Garsson-io/kaizen
 *   npx tsx src/cli-plan-store.ts query-connected --issue 904 --repo Garsson-io/kaizen
 *   npx tsx src/cli-plan-store.ts query-pr --issue 904 --repo Garsson-io/kaizen
 *
 * Part of kaizen issue #902, #905.
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  storePlan,
  storeTestPlan,
  storeMetadata,
  retrievePlan,
  retrieveTestPlan,
  retrieveMetadata,
  queryConnectedIssues,
  queryPrNumber,
} from './plan-store.js';

function usage(): never {
  console.error(`Usage: npx tsx src/cli-plan-store.ts <command> --issue <N> --repo <owner/repo> [options]

Commands:
  store-plan        Store plan text on a GitHub issue
  store-testplan    Store test plan text on a GitHub issue
  store-metadata    Store YAML metadata on a GitHub issue
  retrieve-plan     Retrieve plan text from a GitHub issue
  retrieve-testplan Retrieve test plan text from a GitHub issue
  retrieve-metadata Retrieve YAML metadata from a GitHub issue
  query-connected   List connected issues from stored metadata
  query-pr          Get PR number from stored metadata

Options:
  --issue <N>         GitHub issue number (required)
  --repo <owner/repo> GitHub repo (required)
  --text <string>     Text to store (for store-plan/store-testplan)
  --file <path>       File to read text from (for store-plan/store-testplan/store-metadata)
`);
  process.exit(1);
}

function parseArgs(): { command: string; issue: string; repo: string; text?: string; file?: string } {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) usage();

  let issue = '';
  let repo = '';
  let text: string | undefined;
  let file: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--issue' && args[i + 1]) { issue = args[++i]; continue; }
    if (args[i] === '--repo' && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === '--text' && args[i + 1]) { text = args[++i]; continue; }
    if (args[i] === '--file' && args[i + 1]) { file = args[++i]; continue; }
  }

  if (!issue || !repo) usage();
  return { command, issue, repo, text, file };
}

function main(): void {
  const { command, issue, repo, text, file } = parseArgs();
  const opts = { issueNum: issue, repo };

  switch (command) {
    case 'store-plan': {
      const content = file ? readFileSync(file, 'utf8') : text;
      if (!content) { console.error('Error: --text or --file required'); process.exit(1); }
      const url = storePlan(opts, content);
      console.log(`Plan stored: ${url}`);
      break;
    }
    case 'store-testplan': {
      const content = file ? readFileSync(file, 'utf8') : text;
      if (!content) { console.error('Error: --text or --file required'); process.exit(1); }
      const url = storeTestPlan(opts, content);
      console.log(`Test plan stored: ${url}`);
      break;
    }
    case 'store-metadata': {
      if (!file) { console.error('Error: --file required for metadata'); process.exit(1); }
      const raw = readFileSync(file, 'utf8');
      const data = YAML.parse(raw) as Record<string, unknown>;
      const url = storeMetadata(opts, data);
      console.log(`Metadata stored: ${url}`);
      break;
    }
    case 'retrieve-plan': {
      const plan = retrievePlan(opts);
      if (!plan) { console.log('No plan found.'); process.exit(1); }
      console.log(plan.planText);
      break;
    }
    case 'retrieve-testplan': {
      const plan = retrieveTestPlan(opts);
      if (!plan) { console.log('No test plan found.'); process.exit(1); }
      console.log(plan.planText);
      break;
    }
    case 'retrieve-metadata': {
      const meta = retrieveMetadata(opts);
      if (!meta) { console.log('No metadata found.'); process.exit(1); }
      console.log(YAML.stringify(meta.data));
      break;
    }
    case 'query-connected': {
      const issues = queryConnectedIssues(opts);
      if (issues.length === 0) { console.log('No connected issues found.'); process.exit(0); }
      for (const i of issues) {
        console.log(`#${i.number} [${i.role}] ${i.title}`);
      }
      break;
    }
    case 'query-pr': {
      const pr = queryPrNumber(opts);
      if (!pr) { console.log('No PR number found.'); process.exit(1); }
      console.log(pr);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main();
