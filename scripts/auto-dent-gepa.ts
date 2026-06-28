#!/usr/bin/env npx tsx
/**
 * auto-dent-gepa — deterministic GEPA-ready prompt-evolution bundle.
 *
 * This does not run GEPA. It creates the local contract a later GEPA runner can
 * consume: prompt target, trajectory examples, textual feedback, and Pareto
 * objectives. The dry-run path has no Python, API-key, or live LLM dependency.
 */

import { readFileSync } from 'fs';
import { modeSuccess, type RunMetrics } from './auto-dent-run.js';

export interface GepaPromptTarget {
  id: string;
  path: string;
  text?: string;
}

export interface GepaBundleInput {
  batchId: string;
  promptTarget: GepaPromptTarget;
  runs: RunMetrics[];
  textualFeedback?: string[];
  generatedAt?: string;
}

export interface GepaTraceExample {
  run: number;
  mode: string;
  promptHash?: string;
  promptTemplate?: string;
  reward: number;
  artifacts: {
    prs: string[];
    issuesFiled: string[];
    issuesClosed: string[];
  };
  qualitySignals: {
    reviewVerdict?: RunMetrics['review_verdict'];
    processVerdict?: RunMetrics['process_verdict'];
    lifecycleHealth?: RunMetrics['lifecycle_health'];
    failureClass?: string;
  };
}

export interface GepaParetoObjective {
  id: string;
  direction: 'maximize' | 'minimize';
  source: string;
  rationale: string;
}

export interface GepaPromptEvolutionBundle {
  version: 1;
  optimizer: 'GEPA';
  runtime: {
    mode: 'dry-run';
    externalDependency: 'optional';
  };
  batchId: string;
  generatedAt: string;
  promptTarget: GepaPromptTarget;
  textualFeedback: string[];
  traceExamples: GepaTraceExample[];
  paretoObjectives: GepaParetoObjective[];
}

export const DEFAULT_GEPA_OBJECTIVES: GepaParetoObjective[] = [
  {
    id: 'mode_reward',
    direction: 'maximize',
    source: 'scripts/auto-dent-run.ts:modeSuccess',
    rationale: 'Preserve the mode-aware reward signal auto-dent already records.',
  },
  {
    id: 'process_completeness',
    direction: 'maximize',
    source: 'RunMetrics.process_verdict',
    rationale: 'A prompt candidate that increases artifacts while skipping kaizen evidence is worse, not better.',
  },
  {
    id: 'review_pass_rate',
    direction: 'maximize',
    source: 'RunMetrics.review_verdict',
    rationale: 'GEPA candidates should improve reviewable work, not just raw output count.',
  },
  {
    id: 'cost_usd',
    direction: 'minimize',
    source: 'RunMetrics.cost_usd',
    rationale: 'GEPA is valuable to kaizen partly because it promises fewer rollouts for prompt improvement.',
  },
];

export function buildGepaPromptEvolutionBundle(input: GepaBundleInput): GepaPromptEvolutionBundle {
  return {
    version: 1,
    optimizer: 'GEPA',
    runtime: {
      mode: 'dry-run',
      externalDependency: 'optional',
    },
    batchId: input.batchId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    promptTarget: input.promptTarget,
    textualFeedback: input.textualFeedback ?? [],
    traceExamples: input.runs.map((run) => {
      const mode = run.mode ?? 'exploit';
      return {
        run: run.run,
        mode,
        promptHash: run.prompt_hash,
        promptTemplate: run.prompt_template,
        reward: modeSuccess(mode, run),
        artifacts: {
          prs: run.prs,
          issuesFiled: run.issues_filed,
          issuesClosed: run.issues_closed,
        },
        qualitySignals: {
          reviewVerdict: run.review_verdict,
          processVerdict: run.process_verdict,
          lifecycleHealth: run.lifecycle_health,
          failureClass: run.failure_class,
        },
      };
    }),
    paretoObjectives: DEFAULT_GEPA_OBJECTIVES,
  };
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/auto-dent-gepa.ts --input bundle-input.json [--prompt-file prompts/explore-gaps.md]');
  process.exit(1);
}

function readJson(path: string): GepaBundleInput {
  return JSON.parse(readFileSync(path, 'utf8')) as GepaBundleInput;
}

if (process.argv[1]?.endsWith('auto-dent-gepa.ts') || process.argv[1]?.endsWith('auto-dent-gepa.js')) {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = typeof args.input === 'string' ? args.input : '';
  if (!inputPath) usage();

  const input = readJson(inputPath);
  const promptFile = typeof args['prompt-file'] === 'string' ? args['prompt-file'] : '';
  if (promptFile) {
    input.promptTarget = {
      ...input.promptTarget,
      path: input.promptTarget.path || promptFile,
      text: readFileSync(promptFile, 'utf8'),
    };
  }

  process.stdout.write(`${JSON.stringify(buildGepaPromptEvolutionBundle(input), null, 2)}\n`);
}
