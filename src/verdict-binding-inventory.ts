import { readFileSync } from 'node:fs';

export const REQUIRED_TERMINAL_ACTIONS = [
  'run-success-stamp',
  'issue-close',
  'batch-finalize',
  'gate-clear',
  'merge',
] as const;

export type RequiredTerminalAction = typeof REQUIRED_TERMINAL_ACTIONS[number];

export interface ComputedVerdict {
  id: string;
  label: string;
  producer: string;
  terminalCritical: boolean;
}

export interface SourceEvidence {
  file: string;
  tokens: string[];
}

export interface TerminalActionBinding {
  id: RequiredTerminalAction | string;
  label: string;
  terminalAction: string;
  consumedVerdicts: string[];
  enforcingConsumer: string;
  failureModeBlocked: string;
  sourceEvidence: SourceEvidence[];
}

export interface VerdictBindingInventory {
  computedVerdicts: ComputedVerdict[];
  terminalActions: TerminalActionBinding[];
}

export const VERDICT_BINDING_INVENTORY: VerdictBindingInventory = {
  computedVerdicts: [
    {
      id: 'review-round-verdict',
      label: 'Stored review round verdict',
      producer: 'src/structured-data.ts: deriveStoredRoundVerdict() from per-dimension findings',
      terminalCritical: true,
    },
    {
      id: 'review-battery-verdict',
      label: 'Auto-dent review/fix-loop verdict',
      producer: 'scripts/auto-dent-run.ts: runReviewWiring() records pass/fail/skipped',
      terminalCritical: true,
    },
    {
      id: 'process-evidence-verdict',
      label: 'Durable process-evidence verdict',
      producer: 'scripts/auto-dent-lifecycle.ts: validateProcessEvidence()',
      terminalCritical: true,
    },
    {
      id: 'lifecycle-health-verdict',
      label: 'Lifecycle health verdict',
      producer: 'scripts/auto-dent-lifecycle.ts: validateRunLifecycle()',
      terminalCritical: true,
    },
    {
      id: 'pr-merge-state-verdict',
      label: 'PR merge-state verdict',
      producer: 'scripts/auto-dent-github.ts: classifyMergeView() / checkMergeStatus()',
      terminalCritical: true,
    },
    {
      id: 'issue-ref-verification-verdict',
      label: 'Reflection issue-ref verification verdict',
      producer: 'src/hooks/lib/issue-ref-verifier.ts: verifyIssueRef()',
      terminalCritical: true,
    },
    {
      id: 'batch-outcome-schema-verdict',
      label: 'Batch outcome schema verdict',
      producer: 'scripts/batch-outcome.ts: BatchOutcomeSchema.parse()',
      terminalCritical: true,
    },
  ],
  terminalActions: [
    {
      id: 'run-success-stamp',
      label: 'Run-success stamp',
      terminalAction: 'Emit run.complete outcome=success/empty_success/failure/stop',
      consumedVerdicts: ['review-battery-verdict', 'process-evidence-verdict', 'lifecycle-health-verdict'],
      enforcingConsumer: 'deriveRunOutcome() consumes hasHardQualityFailure() before success is stamped',
      failureModeBlocked: 'A run with review FAIL, process-incomplete, or critical lifecycle gaps cannot be recorded as success.',
      sourceEvidence: [
        { file: 'scripts/auto-dent-run.ts', tokens: ['deriveRunOutcome', 'hasHardQualityFailure'] },
        { file: 'src/verdict-binding-policy.ts', tokens: ['qualityVerdictBlockReasons', 'hasHardQualityFailure'] },
      ],
    },
    {
      id: 'issue-close',
      label: 'Issue close',
      terminalAction: 'Close issues referenced by merged PRs and reconcile status labels',
      consumedVerdicts: ['pr-merge-state-verdict', 'review-battery-verdict', 'process-evidence-verdict', 'lifecycle-health-verdict'],
      enforcingConsumer: 'verifyIssuesClosed()/autoCloseKaizenIssues() require merged PR state and route closure through the configured issues repo; merge itself is gated by quality verdicts',
      failureModeBlocked: 'Issue closure only follows a merged PR, auto-merge is denied when quality verdicts are red, and host-mode closures cannot silently target the kaizen repo.',
      sourceEvidence: [
        { file: 'scripts/auto-dent-github.ts', tokens: ['verifyIssuesClosed', "data.state !== 'MERGED'", 'gh issue close'] },
        { file: 'src/hooks/pr-kaizen-clear.ts', tokens: ['autoCloseKaizenIssues', 'getConfiguredIssueRepo', "prState !== 'MERGED'", 'reconcileClosedIssueStatusLabels'] },
        { file: 'scripts/auto-dent-merge-policy.ts', tokens: ['qualityVerdictBlockReasons', 'reviewRequired'] },
      ],
    },
    {
      id: 'batch-finalize',
      label: 'Batch finalize',
      terminalAction: 'Close the auto-dent progress issue and write durable batch outcome',
      consumedVerdicts: ['batch-outcome-schema-verdict', 'pr-merge-state-verdict'],
      enforcingConsumer: 'closeBatchProgressIssue() reconciles merged PR outcomes, then buildBatchOutcome()/BatchOutcomeSchema validate the durable record',
      failureModeBlocked: 'Final batch metrics do not rely only on scraped narration; malformed outcome records are rejected on read.',
      sourceEvidence: [
        { file: 'scripts/auto-dent-run.ts', tokens: ['closeBatchProgressIssue', 'reconcileBatchClosedIssues', 'writeBatchOutcomeAttachment'] },
        { file: 'scripts/batch-outcome.ts', tokens: ['BatchOutcomeSchema', 'buildBatchOutcome', 'readBatchOutcome'] },
      ],
    },
    {
      id: 'gate-clear',
      label: 'Gate clear',
      terminalAction: 'Clear needs_pr_kaizen / reflection gate',
      consumedVerdicts: ['issue-ref-verification-verdict'],
      enforcingConsumer: 'processHookInput() validates filed/incident refs before clearing the gate state',
      failureModeBlocked: 'A fabricated filed issue/incident ref cannot clear the reflection gate.',
      sourceEvidence: [
        { file: 'src/hooks/pr-kaizen-clear.ts', tokens: ['verifyIssueRef', 'Outcome verification failed', 'clearStateWithStatusAnyBranch'] },
        { file: 'src/hooks/lib/issue-ref-verifier.ts', tokens: ['verifyIssueRef', "'missing'", "'exists'"] },
      ],
    },
    {
      id: 'merge',
      label: 'Merge',
      terminalAction: 'Direct gh pr merge and auto-dent auto-merge queueing',
      consumedVerdicts: ['review-round-verdict', 'review-battery-verdict', 'process-evidence-verdict', 'lifecycle-health-verdict'],
      enforcingConsumer: 'enforce-merge-verdict blocks direct FAIL merges; decideAutoMergeSafety blocks unsafe auto-merge queueing',
      failureModeBlocked: 'A PR with FAIL review/process/lifecycle verdicts cannot be merged or queued by the normal paths.',
      sourceEvidence: [
        { file: 'src/hooks/enforce-merge-verdict.ts', tokens: ['deriveStoredRoundVerdict', "verdict === 'FAIL'", 'MERGE BLOCKED'] },
        { file: 'scripts/auto-dent-merge-policy.ts', tokens: ['qualityVerdictBlockReasons', 'decideAutoMergeSafety'] },
        { file: '.claude-plugin/plugin.json', tokens: ['kaizen-enforce-merge-verdict-ts.sh'] },
      ],
    },
  ],
};

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function findInventoryViolations(
  inventory: VerdictBindingInventory,
  readFile: (path: string) => string = defaultReadFile,
): string[] {
  const violations: string[] = [];
  const actionIds = new Set(inventory.terminalActions.map((action) => action.id));
  for (const required of REQUIRED_TERMINAL_ACTIONS) {
    if (!actionIds.has(required)) {
      violations.push(`required terminal action "${required}" is missing from the inventory`);
    }
  }

  for (const action of inventory.terminalActions) {
    if (action.consumedVerdicts.length === 0) {
      violations.push(`terminal action "${action.id}" consumes no computed verdicts`);
    }
    for (const evidence of action.sourceEvidence) {
      let content = '';
      try {
        content = readFile(evidence.file);
      } catch {
        violations.push(`terminal action "${action.id}" evidence file missing: ${evidence.file}`);
        continue;
      }
      for (const token of evidence.tokens) {
        if (!content.includes(token)) {
          violations.push(`terminal action "${action.id}" evidence token missing in ${evidence.file}: ${token}`);
        }
      }
    }
  }

  for (const verdict of inventory.computedVerdicts) {
    if (!verdict.terminalCritical) continue;
    const consumers = inventory.terminalActions.filter((action) =>
      action.consumedVerdicts.includes(verdict.id),
    );
    if (consumers.length === 0) {
      violations.push(`computed verdict "${verdict.id}" has no enforcing terminal consumer`);
    }
  }

  return violations;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function renderVerdictBindingInventoryMarkdown(
  inventory: VerdictBindingInventory,
): string {
  const lines = [
    '| Terminal action | Computed verdicts consumed | Enforcing consumer | Failure mode blocked |',
    '|---|---|---|---|',
  ];

  for (const action of inventory.terminalActions) {
    const verdictLabels = action.consumedVerdicts.map((id) => {
      const verdict = inventory.computedVerdicts.find((v) => v.id === id);
      return verdict ? verdict.label : id;
    }).join('<br>');
    lines.push([
      action.label,
      verdictLabels,
      action.enforcingConsumer,
      action.failureModeBlocked,
    ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  return lines.join('\n');
}
