import { readFileSync, readdirSync, statSync } from 'node:fs';

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
  producerSignatures: string[];
  sourceEvidence: SourceEvidence[];
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
  nonTerminalVerdictProducers: NonTerminalVerdictProducer[];
  terminalActions: TerminalActionBinding[];
}

export interface NonTerminalVerdictProducer {
  signature: string;
  label: string;
  rationale: string;
}

export interface FindInventoryViolationOptions {
  discoveredProducerSignatures?: string[];
}

export const VERDICT_BINDING_INVENTORY: VerdictBindingInventory = {
  computedVerdicts: [
    {
      id: 'review-round-verdict',
      label: 'Stored review round verdict',
      producer: 'src/structured-data.ts: deriveStoredRoundVerdict() from per-dimension findings',
      producerSignatures: [
        'src/review-finding-contract.ts:type:RoundVerdict',
        'src/structured-data.ts:function:deriveStoredRoundVerdict',
        'src/structured-data.ts:field:round_verdict',
      ],
      sourceEvidence: [
        { file: 'src/review-finding-contract.ts', tokens: ['export type RoundVerdict', 'deriveRoundVerdict'] },
        { file: 'src/structured-data.ts', tokens: ['deriveStoredRoundVerdict', 'round_verdict'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'review-battery-verdict',
      label: 'Auto-dent review/fix-loop verdict',
      producer: 'scripts/auto-dent-run.ts: runReviewWiring() records pass/fail/skipped',
      producerSignatures: [
        'scripts/auto-dent-events.ts:field:review_verdict',
        'scripts/auto-dent-run.ts:field:review_verdict',
      ],
      sourceEvidence: [
        { file: 'scripts/auto-dent-run.ts', tokens: ['runReviewWiring', 'review_verdict'] },
        { file: 'scripts/auto-dent-events.ts', tokens: ['review_verdict'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'process-evidence-verdict',
      label: 'Durable process-evidence verdict',
      producer: 'scripts/auto-dent-lifecycle.ts: validateProcessEvidence()',
      producerSignatures: [
        'scripts/auto-dent-events.ts:field:process_verdict',
        'scripts/auto-dent-lifecycle.ts:function:validateProcessEvidence',
        'scripts/auto-dent-lifecycle.ts:type:ProcessVerdict',
        'scripts/auto-dent-run.ts:field:process_verdict',
      ],
      sourceEvidence: [
        { file: 'scripts/auto-dent-lifecycle.ts', tokens: ['export type ProcessVerdict', 'validateProcessEvidence'] },
        { file: 'scripts/auto-dent-events.ts', tokens: ['process_verdict'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'lifecycle-health-verdict',
      label: 'Lifecycle health verdict',
      producer: 'scripts/auto-dent-lifecycle.ts: validateRunLifecycle()',
      producerSignatures: [
        'scripts/auto-dent-lifecycle.ts:function:validateRunLifecycle',
      ],
      sourceEvidence: [
        { file: 'scripts/auto-dent-lifecycle.ts', tokens: ['validateRunLifecycle', 'LifecycleHealth'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'pr-merge-state-verdict',
      label: 'PR merge-state verdict',
      producer: 'scripts/auto-dent-github.ts: classifyMergeView() / checkMergeStatus()',
      producerSignatures: [
        'scripts/auto-dent-github.ts:function:checkMergeStatus',
        'scripts/auto-dent-github.ts:function:classifyMergeView',
      ],
      sourceEvidence: [
        { file: 'scripts/auto-dent-github.ts', tokens: ['checkMergeStatus', 'classifyMergeView'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'issue-ref-verification-verdict',
      label: 'Reflection issue-ref verification verdict',
      producer: 'src/hooks/lib/issue-ref-verifier.ts: verifyIssueRef()',
      producerSignatures: [
        'src/hooks/lib/issue-ref-verifier.ts:function:verifyIssueRef',
      ],
      sourceEvidence: [
        { file: 'src/hooks/lib/issue-ref-verifier.ts', tokens: ['verifyIssueRef', 'RefStatus'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'batch-outcome-schema-verdict',
      label: 'Batch outcome schema verdict',
      producer: 'scripts/batch-outcome.ts: BatchOutcomeSchema.parse()',
      producerSignatures: [
        'scripts/batch-outcome.ts:const:BatchOutcomeSchema',
      ],
      sourceEvidence: [
        { file: 'scripts/batch-outcome.ts', tokens: ['BatchOutcomeSchema', 'parse'] },
      ],
      terminalCritical: true,
    },
    {
      id: 'hook-activation-verdict',
      label: 'Hook-activation verdict',
      producer: 'scripts/auto-dent-hook-activation.ts: evaluateHookActivation() from the session system.init event',
      terminalCritical: true,
    },
  ],
  nonTerminalVerdictProducers: [
    {
      signature: 'scripts/backlog-health.ts:function:classifyBacklogHealth',
      label: 'Backlog health report verdict',
      rationale: 'Advisory reporting signal; it does not directly authorize an irreversible terminal action.',
    },
    {
      signature: 'scripts/backlog-health.ts:type:HealthVerdict',
      label: 'Backlog health report verdict type',
      rationale: 'Advisory reporting signal; it does not directly authorize an irreversible terminal action.',
    },
    {
      signature: 'scripts/auto-dent-final-claim.ts:type:FinalClaimProcessVerdict',
      label: 'Final claim process verdict parser',
      rationale: 'Input normalization for durable process evidence; terminal binding is represented by process-evidence-verdict.',
    },
    {
      signature: 'scripts/auto-dent-hook-activation.ts:interface:HookActivationVerdict',
      label: 'Hook activation verdict',
      rationale: 'Operational observability signal tracked separately from #1227 terminal-action verdicts.',
    },
    {
      signature: 'scripts/auto-dent-hook-activation.ts:function:formatHookActivationBanner',
      label: 'Hook activation banner formatter',
      rationale: 'Presentation helper for the hook activation signal, not a new terminal-critical producer.',
    },
    {
      signature: 'scripts/auto-dent-provider-matrix.ts:function:validateProviderComparisonScenario',
      label: 'Provider matrix validation',
      rationale: 'Provider fitness validation used for planning/comparison, not an irreversible terminal action verdict.',
    },
    {
      signature: 'scripts/auto-dent-score.ts:field:review_verdict',
      label: 'Auto-dent score review verdict metric',
      rationale: 'Analytics copy of the review verdict; terminal binding is represented by review-battery-verdict.',
    },
    {
      signature: 'scripts/batch-summary.ts:field:process_verdict_distribution',
      label: 'Batch summary process verdict distribution',
      rationale: 'Aggregated reporting over process verdicts; terminal binding is represented by process-evidence-verdict.',
    },
    {
      signature: 'scripts/review-verdict-status.ts:interface:ReviewVerdictReaders',
      label: 'Review verdict status reader injection',
      rationale: 'Dependency-injection shape for reading stored verdicts, not a new verdict producer.',
    },
    {
      signature: 'scripts/review-verdict-status.ts:interface:ReviewVerdictStatus',
      label: 'Review verdict status check',
      rationale: 'GitHub check wrapper consuming the stored review verdict, not a new verdict producer.',
    },
    {
      signature: 'src/hooks/enforce-merge-verdict.ts:function:checkMergeVerdict',
      label: 'Merge verdict consumer check',
      rationale: 'Consumer of the stored review verdict at merge time, not a new verdict producer.',
    },
    {
      signature: 'src/hooks/enforce-merge-verdict.ts:interface:CheckMergeVerdictOptions',
      label: 'Merge verdict consumer options',
      rationale: 'Dependency-injection shape for the merge consumer, not a new verdict producer.',
    },
    {
      signature: 'src/hooks/enforce-merge-verdict.ts:type:MergeVerdict',
      label: 'Merge verdict consumer alias',
      rationale: 'Consumer-side alias for the stored review verdict, not a new verdict producer.',
    },
    {
      signature: 'src/hooks/enforce-merge-verdict.ts:type:VerdictReader',
      label: 'Merge verdict reader',
      rationale: 'Consumer-side reader for the stored review verdict, not a new verdict producer.',
    },
    {
      signature: 'src/review-battery.ts:function:deriveVerdictFromFindings',
      label: 'Review battery per-dimension verdict derivation',
      rationale: 'Intermediate review result rolled into the review-battery-verdict terminal-critical producer.',
    },
    {
      signature: 'src/review-finding-contract.ts:function:deriveVerdictFromFindings',
      label: 'Review finding verdict derivation',
      rationale: 'Shared derivation helper consumed by stored review round and review battery verdict producers.',
    },
    {
      signature: 'src/review-finding-contract.ts:function:deriveRoundVerdict',
      label: 'Review round derivation helper',
      rationale: 'Helper for the stored review round verdict; terminal binding is represented by review-round-verdict.',
    },
    {
      signature: 'src/review-finding-contract.ts:field:verdict',
      label: 'Review finding payload verdict field',
      rationale: 'Structured payload field that feeds review-round/review-battery verdicts, not a separate producer.',
    },
    {
      signature: 'src/structured-data.ts:field:verdict',
      label: 'Structured review metadata verdict field',
      rationale: 'Stored metadata field consumed by review-round-verdict, not a separate terminal-critical producer.',
    },
    {
      signature: 'src/verdict-binding-policy.ts:type:ProcessVerdict',
      label: 'Shared process verdict policy alias',
      rationale: 'Shared policy type for consuming the process verdict, not an independent producer.',
    },
    {
      signature: 'src/verdict-binding-policy.ts:interface:QualityVerdictPolicyOptions',
      label: 'Quality verdict policy options',
      rationale: 'Consumer policy configuration for existing verdicts, not an independent producer.',
    },
    {
      signature: 'src/verdict-binding-policy.ts:interface:QualityVerdictSignals',
      label: 'Quality verdict policy signals',
      rationale: 'Consumer policy input shape for existing verdicts, not an independent producer.',
    },
    {
      signature: 'src/verdict-binding-policy.ts:type:ReviewVerdict',
      label: 'Shared review verdict policy alias',
      rationale: 'Shared policy type for consuming the review verdict, not an independent producer.',
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
      consumedVerdicts: ['review-round-verdict', 'review-battery-verdict', 'process-evidence-verdict', 'lifecycle-health-verdict', 'hook-activation-verdict'],
      enforcingConsumer: 'enforce-merge-verdict blocks direct FAIL merges; decideAutoMergeSafety blocks unsafe auto-merge queueing, including degraded/unknown hook-activation (#1220)',
      failureModeBlocked: 'A PR with FAIL review/process/lifecycle verdicts — or a degraded run where kaizen hooks did not load (or no system.init was seen on a hook-expecting provider) — cannot be merged or queued by the normal paths.',
      sourceEvidence: [
        { file: 'src/hooks/enforce-merge-verdict.ts', tokens: ['deriveStoredRoundVerdict', "verdict === 'FAIL'", 'MERGE BLOCKED'] },
        { file: 'scripts/auto-dent-merge-policy.ts', tokens: ['qualityVerdictBlockReasons', 'decideAutoMergeSafety', 'hookActivationBlockReasons'] },
        { file: '.claude-plugin/plugin.json', tokens: ['kaizen-enforce-merge-verdict-ts.sh'] },
      ],
    },
  ],
};

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

const PRODUCER_SCAN_ROOTS = ['src', 'scripts'];

function listSourceFiles(dir: string): string[] {
  let entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      entries = entries.concat(listSourceFiles(path));
      continue;
    }
    if (path === 'src/verdict-binding-inventory.ts') continue;
    if (!path.endsWith('.ts')) continue;
    if (path.endsWith('.test.ts') || path.endsWith('.e2e.test.ts')) continue;
    entries.push(path);
  }
  return entries;
}

export function extractVerdictProducerSignatures(file: string, content: string): string[] {
  const signatures = new Set<string>();
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: 'type', regex: /^\s*export\s+type\s+([A-Za-z0-9_]*Verdict[A-Za-z0-9_]*)\b/gm },
    { kind: 'interface', regex: /^\s*export\s+interface\s+([A-Za-z0-9_]*Verdict[A-Za-z0-9_]*)\b/gm },
    { kind: 'const', regex: /^\s*export\s+const\s+([A-Za-z0-9_]*(?:VerdictSchema|OutcomeSchema))\b/gm },
    { kind: 'function', regex: /^\s*export\s+function\s+((?:derive|classify|validate|check|verify)[A-Za-z0-9_]*Verdict[A-Za-z0-9_]*)\b/gm },
    { kind: 'field', regex: /^\s*([A-Za-z0-9_]*verdict[A-Za-z0-9_]*)\??:/gm },
  ];

  for (const { kind, regex } of patterns) {
    for (const match of content.matchAll(regex)) {
      if (kind === 'field' && match[1] === 'verdict') continue;
      signatures.add(`${file}:${kind}:${match[1]}`);
    }
  }
  return [...signatures].sort();
}

export function discoverVerdictProducerSignatures(
  readFile: (path: string) => string = defaultReadFile,
  files: string[] = PRODUCER_SCAN_ROOTS.flatMap(listSourceFiles),
): string[] {
  return files.flatMap((file) =>
    extractVerdictProducerSignatures(file, readFile(file)),
  ).sort();
}

function validateEvidence(
  owner: string,
  evidenceItems: SourceEvidence[],
  readFile: (path: string) => string,
): string[] {
  const violations: string[] = [];
  for (const evidence of evidenceItems) {
    let content = '';
    try {
      content = readFile(evidence.file);
    } catch {
      violations.push(`${owner} evidence file missing: ${evidence.file}`);
      continue;
    }
    for (const token of evidence.tokens) {
      if (!content.includes(token)) {
        violations.push(`${owner} evidence token missing in ${evidence.file}: ${token}`);
      }
    }
  }
  return violations;
}

export function findInventoryViolations(
  inventory: VerdictBindingInventory,
  readFile: (path: string) => string = defaultReadFile,
  options: FindInventoryViolationOptions = {},
): string[] {
  const violations: string[] = [];
  const discoveredProducerSignatures = options.discoveredProducerSignatures
    ?? (readFile === defaultReadFile ? discoverVerdictProducerSignatures(readFile) : []);
  const classifiedProducerSignatures = new Set([
    ...inventory.computedVerdicts.flatMap((verdict) => verdict.producerSignatures ?? []),
    ...(inventory.nonTerminalVerdictProducers ?? []).map((producer) => producer.signature),
  ]);

  for (const signature of discoveredProducerSignatures) {
    if (!classifiedProducerSignatures.has(signature)) {
      violations.push(`verdict producer "${signature}" is not classified in the inventory`);
    }
  }

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
    violations.push(...validateEvidence(`terminal action "${action.id}"`, action.sourceEvidence, readFile));
  }

  for (const verdict of inventory.computedVerdicts) {
    if ((verdict.producerSignatures ?? []).length === 0) {
      violations.push(`computed verdict "${verdict.id}" has no producer signatures`);
    }
    if ((verdict.sourceEvidence ?? []).length === 0) {
      violations.push(`computed verdict "${verdict.id}" has no producer source evidence`);
    }
    violations.push(...validateEvidence(`computed verdict "${verdict.id}" producer`, verdict.sourceEvidence ?? [], readFile));
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
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
}

export function renderVerdictBindingInventoryMarkdown(
  inventory: VerdictBindingInventory,
): string {
  const lines = [
    '| Computed verdict | Producer | Producer signatures | Terminal-critical |',
    '|---|---|---|---|',
  ];

  for (const verdict of inventory.computedVerdicts) {
    lines.push([
      verdict.label,
      verdict.producer,
      (verdict.producerSignatures ?? []).join('<br>'),
      verdict.terminalCritical ? 'yes' : 'no',
    ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    '| Terminal action | Computed verdicts consumed | Enforcing consumer | Failure mode blocked |',
    '|---|---|---|---|',
  );

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
