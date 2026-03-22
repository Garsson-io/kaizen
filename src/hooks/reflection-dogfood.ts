#!/usr/bin/env npx tsx
/**
 * reflection-dogfood.ts — Run a synthetic session through the reflection
 * pipeline and show what the subagent would find.
 *
 * NOT a CI test. This is a dogfooding tool: run it whenever you change
 * the transcript analysis or kaizen-bg agent definition to see if the
 * improvements actually improve signal detection.
 *
 * Usage:
 *   npx tsx src/hooks/reflection-dogfood.ts                    # run all scenarios
 *   npx tsx src/hooks/reflection-dogfood.ts --scenario mixed   # run one scenario
 *   npx tsx src/hooks/reflection-dogfood.ts --transcript /path/to/real.jsonl  # analyze a real session
 *
 * Part of kaizen #438 — Reflection subagent transcript analysis.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SyntheticSession,
  sessionWithCorrections,
  sessionWithFailures,
  sessionWithHookDenials,
  sessionWithRepeatedRequests,
  sessionWithMixedSignals,
  sessionClean,
} from './synthetic-transcript.js';
import {
  analyzeTranscriptFile,
  formatAnalysisSummary,
} from './transcript-analysis.js';
import {
  generateCreateReflection,
} from './kaizen-reflect.js';

// ── Scenario registry ──

const scenarios: Record<string, () => SyntheticSession> = {
  corrections: sessionWithCorrections,
  failures: sessionWithFailures,
  'hook-denials': sessionWithHookDenials,
  'repeated-requests': sessionWithRepeatedRequests,
  mixed: sessionWithMixedSignals,
  clean: sessionClean,
};

// ── CLI ──

function main(): void {
  const args = process.argv.slice(2);
  const scenarioArg = args.find((a, i) => args[i - 1] === '--scenario');
  const transcriptArg = args.find((a, i) => args[i - 1] === '--transcript');

  if (transcriptArg) {
    // Analyze a real transcript
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Analyzing real transcript: ${transcriptArg}`);
    console.log('='.repeat(60));

    const analysis = analyzeTranscriptFile(transcriptArg);
    console.log(formatAnalysisSummary(analysis));

    // Show what the hook prompt would look like
    console.log(`\n${'─'.repeat(60)}`);
    console.log('Hook prompt that would be generated:');
    console.log('─'.repeat(60));
    const prompt = generateCreateReflection(
      'https://github.com/example/repo/pull/1',
      'feat-branch',
      'file1.ts\nfile2.ts',
      transcriptArg,
    );
    // Show just the transcript-related lines
    const transcriptLines = prompt
      .split('\n')
      .filter(
        (l) =>
          l.includes('transcript') ||
          l.includes('Scan for') ||
          l.includes('corrections') ||
          l.includes('IMPORTANT: Read'),
      );
    for (const line of transcriptLines) {
      console.log(line);
    }

    return;
  }

  const scenariosToRun = scenarioArg
    ? { [scenarioArg]: scenarios[scenarioArg] }
    : scenarios;

  if (scenarioArg && !scenarios[scenarioArg]) {
    console.error(
      `Unknown scenario: ${scenarioArg}. Available: ${Object.keys(scenarios).join(', ')}`,
    );
    process.exit(1);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'kaizen-dogfood-'));

  try {
    for (const [name, factory] of Object.entries(scenariosToRun)) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Scenario: ${name}`);
      console.log('='.repeat(60));

      const session = factory();
      const filePath = join(tmpDir, `${name}.jsonl`);
      session.writeToFile(filePath);

      const analysis = analyzeTranscriptFile(filePath);
      console.log(formatAnalysisSummary(analysis));

      // Show signal counts as a quick summary
      const { summary } = analysis;
      console.log('Quick stats:');
      console.log(`  User corrections: ${summary.userCorrections}`);
      console.log(`  Failed tool calls: ${summary.failedToolCalls}`);
      console.log(`  Hook denials: ${summary.hookDenials}`);
      console.log(`  Retries: ${summary.retries}`);
      console.log(`  Repeated requests: ${summary.repeatedRequests}`);
      console.log(
        `  Total signals: ${analysis.signals.length}`,
      );
    }

    // Summary table
    console.log(`\n${'='.repeat(60)}`);
    console.log('Summary across all scenarios');
    console.log('='.repeat(60));
    console.log(
      'Scenario'.padEnd(20),
      'Signals'.padEnd(10),
      'Corrections'.padEnd(13),
      'Failures'.padEnd(10),
      'Hooks'.padEnd(8),
      'Retries'.padEnd(9),
      'Repeated',
    );
    console.log('-'.repeat(80));

    for (const [name, factory] of Object.entries(scenariosToRun)) {
      const session = factory();
      const filePath = join(tmpDir, `${name}.jsonl`);
      session.writeToFile(filePath);
      const analysis = analyzeTranscriptFile(filePath);
      const { summary } = analysis;
      console.log(
        name.padEnd(20),
        String(analysis.signals.length).padEnd(10),
        String(summary.userCorrections).padEnd(13),
        String(summary.failedToolCalls).padEnd(10),
        String(summary.hookDenials).padEnd(8),
        String(summary.retries).padEnd(9),
        String(summary.repeatedRequests),
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

main();
