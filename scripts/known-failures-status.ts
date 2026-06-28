#!/usr/bin/env tsx
/**
 * known-failures-status.ts — the provider-agnostic enforcement of #1518.
 *
 * Two modes (one classifier, `src/known-failures.ts`, shared by both):
 *
 *   --validate (default): the `known-failures` CI gate. The registry must be
 *     schema-valid AND every entry's owning issue must be OPEN. A closed/missing
 *     owner means the failure is no longer tracked — exit 1 to force a fix or a
 *     re-filed owner. This is the L3, non-Claude backstop: it holds even outside
 *     an interactive session and for providers (e.g. Codex) with no hook runtime.
 *
 *   --classify: read failing test ids (from --failures-file <path> or stdin, one
 *     per line) and split them into owned (logged, tolerated) vs unowned. Exit 1
 *     iff any failure is unowned. `run-all-tests.sh` calls this so the test
 *     runner — the single choke point both providers share — refuses to report
 *     green while an unowned failure exists.
 */
import { readFileSync } from 'node:fs';
import { ghResult, type GhResult } from '../src/lib/gh-exec.js';
import {
  loadKnownFailures,
  findOwnershipProblems,
  unownedFailures,
  isKnownFailure,
  type IssueState,
  type KnownFailure,
  type KnownFailuresValidation,
} from '../src/known-failures.js';

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** Map a `gh issue view --json state` result to an IssueState (pure, testable). */
export function parseIssueState(res: GhResult): IssueState {
  if (res.status !== 0) return 'missing';
  try {
    const state = String((JSON.parse(res.stdout) as { state?: string }).state ?? '').toLowerCase();
    return state === 'open' ? 'open' : state === 'closed' ? 'closed' : 'missing';
  } catch {
    return 'missing';
  }
}

/** Resolve a GitHub issue's state via `gh`, mapping a not-found to `missing`. */
export function ghIssueState(
  repo: string | undefined,
  run: (args: string[]) => GhResult = ghResult,
): (issue: number) => IssueState {
  return (issue: number): IssueState => {
    const args = ['issue', 'view', String(issue), '--json', 'state'];
    if (repo) args.push('--repo', repo);
    return parseIssueState(run(args));
  };
}

export function runValidate(
  repo: string | undefined,
  stateOf: (issue: number) => IssueState,
  load: () => KnownFailuresValidation = loadKnownFailures,
): number {
  const reg = load();
  if (!reg.ok) {
    console.error('known-failures: registry is invalid:');
    reg.errors.forEach(e => console.error(`  - ${e}`));
    return 1;
  }
  if (reg.entries.length === 0) {
    console.log('known-failures: registry is empty — the tree must be fully green. OK.');
    return 0;
  }
  const problems = findOwnershipProblems(reg.entries, stateOf);
  if (problems.length > 0) {
    console.error('known-failures: these entries no longer have an OPEN owning issue (fix the test or re-file an owner):');
    for (const p of problems) {
      console.error(`  - issue #${p.issue} is ${p.state}; owns: ${p.tests.join(', ')}`);
    }
    return 1;
  }
  console.log(`known-failures: ${reg.entries.length} entr${reg.entries.length === 1 ? 'y' : 'ies'}, all owned by OPEN issues. OK.`);
  return 0;
}

function readFailingIds(): string[] {
  const file = readArg('--failures-file');
  const raw = file ? readFileSync(file, 'utf8') : (() => {
    try { return readFileSync(0, 'utf8'); } catch { return ''; }
  })();
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

export function runClassify(failingIds: string[], entries: KnownFailure[]): number {
  if (failingIds.length === 0) {
    console.log('known-failures: no failing tests reported. OK.');
    return 0;
  }
  for (const id of failingIds) {
    const owner = isKnownFailure(id, entries);
    if (owner) console.log(`  KNOWN-OWNED (#${owner.issue}): ${id}`);
  }
  const unowned = unownedFailures(failingIds, entries);
  if (unowned.length > 0) {
    console.error('known-failures: UNOWNED failing tests (fix before merge, or register with an owning open issue per #1518):');
    unowned.forEach(id => console.error(`  - ${id}`));
    return 1;
  }
  console.log(`known-failures: all ${failingIds.length} failing test(s) are owned by tracked issues. Tolerated.`);
  return 0;
}

function main(): void {
  const repo = readArg('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'Garsson-io/kaizen';
  const mode = process.argv.includes('--classify') ? 'classify' : 'validate';
  if (mode === 'classify') {
    const reg = loadKnownFailures();
    if (!reg.ok) {
      console.error('known-failures: registry is invalid; cannot classify failures:');
      reg.errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
    process.exit(runClassify(readFailingIds(), reg.entries));
  }
  process.exit(runValidate(repo, ghIssueState(repo)));
}

if (process.argv[1]?.endsWith('known-failures-status.ts') || process.argv[1]?.endsWith('known-failures-status.js')) {
  main();
}
