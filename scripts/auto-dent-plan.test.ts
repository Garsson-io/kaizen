import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractPlanJson,
  validatePlan,
  validateThemes,
  readPlan,
  claimNextItem,
  selectNextItem,
  markItem,
  resetAssignedItems,
  formatPlanSummary,
  buildPlanPrompt,
  buildPlanningCommand,
  buildPlanningSchemaFile,
  titleTokens,
  deriveThemes,
  ensureThemes,
  extractPlanningText,
  formatPlanningProgress,
  formatPlanningFailure,
  planningRawOutputFile,
  selectPlanningProvider,
  summarizePlanningActivity,
  validatePlanningOutputContract,
  withPlanningProvider,
  themeProgress,
  type BatchPlan,
  type PlanItem,
} from './auto-dent-plan.js';
import { readState, type BatchState } from './auto-dent-run.js';
import { makeBatchState } from './auto-dent-test-utils.js';

function mkItem(overrides: Partial<PlanItem> & { issue: string; title: string }): PlanItem {
  return {
    score: 5,
    approach: '',
    status: 'pending',
    item_type: 'leaf',
    ...overrides,
  };
}

function makePlan(overrides: Partial<BatchPlan> = {}): BatchPlan {
  return {
    created_at: '2026-03-23T00:00:00Z',
    guidance: 'improve hooks reliability',
    items: [
      { issue: '#302', title: 'Planning pre-pass MVP', score: 8, approach: 'Add plan phase before loop', status: 'pending', item_type: 'leaf' },
      { issue: '#451', title: 'Hook performance observability', score: 7, approach: 'Add timing instrumentation', status: 'pending', item_type: 'leaf' },
      { issue: '#407', title: 'Engineering techniques', score: 6, approach: 'Apply patterns repo-wide', status: 'pending', item_type: 'leaf' },
    ],
    wip_excluded: ['#374 (active case)'],
    epics_scanned: ['#506 Auto-Dent Experimentation Framework'],
    ...overrides,
  };
}

function makePlanWithDecompose(): BatchPlan {
  return {
    created_at: '2026-03-23T00:00:00Z',
    guidance: 'move forward on epics and observability',
    items: [
      { issue: '#302', title: 'Planning pre-pass MVP', score: 8, approach: 'Add plan phase before loop', status: 'pending', item_type: 'leaf' },
      { issue: '#506', title: 'decompose: Auto-Dent Experimentation Framework', score: 7, approach: 'File 2 concrete issues from epic, implement first', status: 'pending', item_type: 'decompose', parent_epic: '#506' },
      { issue: '#451', title: 'Hook performance observability', score: 6, approach: 'Add timing instrumentation', status: 'pending', item_type: 'leaf' },
    ],
    wip_excluded: [],
    epics_scanned: ['#506 Auto-Dent Experimentation Framework', '#548 Cognitive Modes'],
    decomposition_candidates: ['#506 Auto-Dent Experimentation Framework — no child issues filed'],
  };
}

function makeState(overrides: Partial<BatchState> = {}): BatchState {
  return makeBatchState({
    batch_id: 'batch-260627-1608-k1146',
    batch_start: 0,
    guidance: 'provider-aware planning',
    ...overrides,
  });
}

describe('provider-aware planning (#1146)', () => {
  it('defaults planning to Claude under subscription billing', () => {
    expect(selectPlanningProvider(makeState())).toEqual({
      provider: 'claude',
      billing: 'subscription-cli',
    });
  });

  it('selects Codex planning for explicit Codex batches', () => {
    expect(selectPlanningProvider(makeState({ provider: 'codex', test_task: true }))).toEqual({
      provider: 'codex',
      billing: 'subscription-cli',
    });
    expect(selectPlanningProvider(makeState({ provider: 'codex', test_task: false }))).toEqual({
      provider: 'codex',
      billing: 'subscription-cli',
    });
  });

  it('builds the existing Claude planning command shape', () => {
    const command = buildPlanningCommand(
      { provider: 'claude', billing: 'subscription-cli' },
      'plan prompt',
      makeState({ budget: '3.00' }),
      '/repo',
    );

    expect(command.command).toBe('claude');
    expect(command.args).toEqual([
      '-p',
      'plan prompt',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--max-turns',
      '5',
      '--max-budget-usd',
      '1.00',
    ]);
    expect(command.stdin).toBeUndefined();
  });

  it('builds a Codex exec planning command with prompt on stdin', () => {
    const schemaFile = '/tmp/auto-dent-plan-schema.json';
    const command = buildPlanningCommand(
      { provider: 'codex', billing: 'subscription-cli' },
      'plan prompt',
      makeState(),
      '/repo',
      schemaFile,
    );

    expect(command.command).toBe('codex');
    expect(command.args).toEqual([
      'exec',
      '--json',
      '--cd',
      '/repo',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--output-schema',
      schemaFile,
      '-',
    ]);
    expect(command.stdin).toBe('plan prompt');
  });

  it('writes a Codex planning schema file derived from the plan contract', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-schema-test-'));
    try {
      const schemaFile = buildPlanningSchemaFile(tmpDir);
      const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));

      expect(schema.type).toBe('object');
      expect(schema.required).toContain('items');
      expect(schema.properties.items.type).toBe('array');
      expect(schema.properties.items.items.required).toEqual(
        expect.arrayContaining(['issue', 'title']),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts provider output text from Claude stream-json and Codex JSONL', () => {
    const planJson = '{"items":[{"issue":"#1146","title":"Plan","score":5,"approach":"do","status":"pending"}]}';
    const claudeText = extractPlanningText('claude', [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'prefix ' }] } }),
      JSON.stringify({ type: 'result', result: `\n${planJson}` }),
    ].join('\n'));
    const codexText = extractPlanningText('codex', JSON.stringify({
      type: 'final_message',
      message: `prefix\n${planJson}`,
    }));

    expect(validatePlan(extractPlanJson(claudeText))).not.toBeNull();
    expect(validatePlan(extractPlanJson(codexText))).not.toBeNull();
  });

  it('extracts Claude planning text from CRLF stream-json while skipping blank and malformed rows', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'prefix ' }] } }),
      '',
      'not-json',
      JSON.stringify({ type: 'result', result: 'result text' }),
    ].join('\r\n');

    expect(extractPlanningText('claude', raw)).toBe('prefix \nresult text');
  });

  it('delegates Claude stream-json decoding to the shared JSONL parser', () => {
    const source = readFileSync('scripts/auto-dent-plan.ts', 'utf8');
    const extractorSource = source.slice(
      source.indexOf('export function extractPlanningText'),
      source.indexOf('export function extractPlanJson'),
    );

    expect(extractorSource).not.toMatch(/JSON\.parse\(line\)/);
  });

  it('validates schema-constrained Codex JSONL into a Codex-attributed plan (#1215)', () => {
    const providerPlan = {
      created_at: '2026-06-27T22:20:00Z',
      guidance: 'codex planning',
      items: [
        {
          issue: '#1215',
          title: 'Codex planning pre-pass JSON validation fallback',
          score: 9.25,
          approach: 'Harden the Codex planning boundary with schema output.',
          status: 'pending',
          item_type: 'leaf',
          parent_epic: null,
          theme: null,
        },
      ],
      themes: [],
      wip_excluded: [],
      epics_scanned: ['#1134 Enable Codex as an auto-dent agent'],
      decomposition_candidates: [],
    };
    const codexJsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: JSON.stringify(providerPlan),
        },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n');

    const parsed = extractPlanJson(extractPlanningText('codex', codexJsonl));
    expect(validatePlanningOutputContract(parsed)).toBe(true);

    const plan = validatePlan(parsed);

    expect(withPlanningProvider(plan!, { provider: 'codex', billing: 'subscription-cli' })).toMatchObject({
      planning_provider: { provider: 'codex', billing: 'subscription-cli' },
      items: [{ issue: '#1215', status: 'pending', item_type: 'leaf' }],
    });
  });

  it('rejects Codex provider payloads that omit required nullable schema fields (#1215)', () => {
    expect(validatePlanningOutputContract({
      created_at: '2026-06-27T22:20:00Z',
      guidance: 'codex planning',
      items: [
        {
          issue: '#1215',
          title: 'Codex planning pre-pass JSON validation fallback',
          score: 9.25,
          approach: 'Harden the Codex planning boundary with schema output.',
          status: 'pending',
          item_type: 'leaf',
        },
      ],
      wip_excluded: [],
      epics_scanned: ['#1134 Enable Codex as an auto-dent agent'],
      decomposition_candidates: [],
    })).toBe(false);
  });

  it('attaches planning provider metadata to created plans', () => {
    const plan = withPlanningProvider(makePlan(), { provider: 'codex', billing: 'subscription-cli' });

    expect(plan.planning_provider).toEqual({
      provider: 'codex',
      billing: 'subscription-cli',
    });
  });

  it('formats planning failure messages with provider identity', () => {
    expect(formatPlanningFailure({ provider: 'codex', billing: 'subscription-cli' }, 'could not extract plan JSON')).toBe(
      '  [plan:codex] could not extract plan JSON',
    );
  });

  it('summarizes Codex planning activity into operator-readable labels', () => {
    const issueList = summarizePlanningActivity('codex', JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'gh issue list --repo Garsson-io/kaizen --label epic --state open',
      },
    }));
    const fileRead = summarizePlanningActivity('codex', JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'rg -n "dashboard" docs scripts src',
      },
    }));

    expect(issueList).toBe('reading GitHub issues');
    expect(fileRead).toBe('inspecting files');
  });

  it('formats bounded planning progress with elapsed time, activity, counts, and raw log path', () => {
    expect(formatPlanningProgress({
      provider: { provider: 'codex', billing: 'subscription-cli' },
      elapsedMs: 45_000,
      stdoutLines: 12,
      stdoutBytes: 2048,
      stderrBytes: 140,
      lastActivity: 'checking worktrees',
      rawOutputFile: '/tmp/plan-codex.jsonl',
    })).toBe('  [plan:codex] still planning (45s elapsed; checking worktrees; stdout 12 lines/2.0 KB; stderr 140 B; raw /tmp/plan-codex.jsonl)');
  });

  it('uses a stable raw planning output path per provider', () => {
    expect(planningRawOutputFile('/tmp/batch', 'codex')).toBe('/tmp/batch/plan-codex.jsonl');
    expect(planningRawOutputFile('/tmp/batch', 'claude')).toBe('/tmp/batch/plan-claude-stream.jsonl');
  });

  it('captures raw planning output and starts progress inside the provider wait path', () => {
    const source = readFileSync(new URL('./auto-dent-plan.ts', import.meta.url), 'utf8');
    const runPlanningStart = source.indexOf('async function runPlanning');
    const runPlanningEnd = source.indexOf('/**\n * Read plan.json', runPlanningStart);
    const runPlanningSection = source.slice(runPlanningStart, runPlanningEnd);

    expect(runPlanningSection).toContain('planningRawOutputFile');
    expect(runPlanningSection).toContain('appendFileSync(rawOutputFile');
    expect(runPlanningSection).toContain('formatPlanningProgress');
    expect(runPlanningSection).toContain('setInterval');
  });
});

describe('state reading', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plan-state-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the canonical auto-dent state reader with backup fallback (#1262)', () => {
    const stateFile = join(tmpDir, 'state.json');
    const fallback = makeState({ guidance: 'fallback state' });
    writeFileSync(stateFile, '{corrupt json');
    writeFileSync(`${stateFile}.bak`, JSON.stringify(fallback));

    expect(readState(stateFile).guidance).toBe('fallback state');

    const source = readFileSync(
      new URL('./auto-dent-plan.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/function readState\(/);
    expect(source).toMatch(/readState,/);
    expect(source).toContain("from './auto-dent-run.js'");
  });
});

describe('extractPlanJson', () => {
  it('extracts JSON from fenced code block', () => {
    const text = 'Some text\n```json\n{"created_at":"2026-03-23","guidance":"test","items":[{"issue":"#1","title":"t","score":5,"approach":"a","status":"pending"}],"wip_excluded":[],"epics_scanned":[]}\n```\nMore text';
    const result = extractPlanJson(text);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].issue).toBe('#1');
  });

  it('extracts JSON from bare object', () => {
    const text = '{"created_at":"now","guidance":"g","items":[{"issue":"#2","title":"two","score":3,"approach":"b","status":"pending"}],"wip_excluded":[],"epics_scanned":[]}';
    const result = extractPlanJson(text);
    expect(result).not.toBeNull();
    expect(result!.items[0].issue).toBe('#2');
  });

  it('returns null for non-JSON text', () => {
    expect(extractPlanJson('no json here')).toBeNull();
  });

  it('handles fenced block without json label', () => {
    const text = '```\n{"items":[{"issue":"#3","title":"three","score":1,"approach":"c","status":"pending"}]}\n```';
    const result = extractPlanJson(text);
    expect(result).not.toBeNull();
    expect(result!.items[0].issue).toBe('#3');
  });
});

describe('validatePlan', () => {
  it('validates a well-formed plan', () => {
    const raw = {
      created_at: '2026-03-23',
      guidance: 'test',
      items: [
        { issue: '#1', title: 'First', score: 8, approach: 'do it', status: 'pending' },
      ],
      wip_excluded: [],
      epics_scanned: [],
    };
    const plan = validatePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.items).toHaveLength(1);
    expect(plan!.items[0].status).toBe('pending');
  });

  it('rejects plan with no items array', () => {
    expect(validatePlan({ guidance: 'test' })).toBeNull();
    expect(validatePlan(null)).toBeNull();
  });

  it('filters out items missing issue or title', () => {
    const raw = {
      items: [
        { issue: '#1', title: 'Good' },
        { title: 'No issue' },
        { issue: '#3' },
      ],
    };
    const plan = validatePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.items).toHaveLength(1);
    expect(plan!.items[0].issue).toBe('#1');
  });

  it('returns null when all items are invalid', () => {
    const raw = {
      items: [
        { title: 'No issue' },
        { score: 5 },
      ],
    };
    expect(validatePlan(raw)).toBeNull();
  });

  it('defaults missing fields', () => {
    const raw = {
      items: [{ issue: '#1', title: 'Minimal' }],
    };
    const plan = validatePlan(raw);
    expect(plan!.items[0].score).toBe(0);
    expect(plan!.items[0].approach).toBe('');
    expect(plan!.wip_excluded).toEqual([]);
    expect(plan!.epics_scanned).toEqual([]);
  });
});

describe('plan file operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readPlan returns null when no plan exists', () => {
    expect(readPlan(tmpDir)).toBeNull();
  });

  it('readPlan reads a valid plan.json', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));
    const result = readPlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(3);
  });

  it('claimNextItem returns first pending item and marks it assigned', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const item = claimNextItem(tmpDir);
    expect(item).not.toBeNull();
    expect(item!.issue).toBe('#302');
    expect(item!.status).toBe('assigned');

    // Verify it was persisted
    const updated = readPlan(tmpDir);
    expect(updated!.items[0].status).toBe('assigned');
    expect(updated!.items[1].status).toBe('pending');
  });

  it('claimNextItem skips assigned items', () => {
    const plan = makePlan();
    plan.items[0].status = 'assigned';
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const item = claimNextItem(tmpDir);
    expect(item!.issue).toBe('#451');
  });

  it('claimNextItem honors a forced target issue before normal ranking', () => {
    const plan = makePlan({
      items: [
        { issue: '#302', title: 'High score unrelated', score: 10, approach: 'Do unrelated work', status: 'pending', item_type: 'leaf' },
        { issue: '#451', title: 'Manifest target', score: 1, approach: 'Do forced work', status: 'pending', item_type: 'leaf' },
      ],
    });
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const item = claimNextItem(tmpDir, { targetIssue: '#451' });

    expect(item).toMatchObject({
      issue: '#451',
      title: 'Manifest target',
      status: 'assigned',
    });
    const updated = readPlan(tmpDir);
    expect(updated!.items[0].status).toBe('pending');
    expect(updated!.items[1].status).toBe('assigned');
  });

  it('claimNextItem creates a synthetic assignment when a forced target is missing from the plan', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const item = claimNextItem(tmpDir, { targetIssue: '#999' });

    expect(item).toMatchObject({
      issue: '#999',
      status: 'assigned',
      item_type: 'leaf',
    });
    const updated = readPlan(tmpDir);
    expect(updated!.items[0]).toMatchObject({ issue: '#999', status: 'assigned' });
  });

  it('claimNextItem returns null when all items are done', () => {
    const plan = makePlan();
    plan.items.forEach((i) => (i.status = 'done'));
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    expect(claimNextItem(tmpDir)).toBeNull();
  });

  it('markItem updates status correctly', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    markItem(tmpDir, '#302', 'done');
    const updated = readPlan(tmpDir);
    expect(updated!.items[0].status).toBe('done');
  });

  it('markItem handles non-existent issue gracefully', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    markItem(tmpDir, '#999', 'skipped');
    const updated = readPlan(tmpDir);
    // Nothing changed
    expect(updated!.items.every((i) => i.status === 'pending')).toBe(true);
  });
});

describe('formatPlanSummary', () => {
  it('shows item count and top items', () => {
    const plan = makePlan();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('3 items');
    expect(summary).toContain('#302');
    expect(summary).toContain('Planning pre-pass');
    expect(summary).toContain('#451');
  });

  it('shows WIP exclusions', () => {
    const plan = makePlan();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('#374 (active case)');
  });

  it('shows epics scanned count', () => {
    const plan = makePlan();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('Epics scanned: 1');
  });
});

describe('validatePlan with item_type', () => {
  it('preserves item_type=decompose and parent_epic', () => {
    const raw = {
      items: [
        { issue: '#506', title: 'decompose: Epic', score: 7, approach: 'break it down', item_type: 'decompose', parent_epic: '#506' },
        { issue: '#302', title: 'Leaf issue', score: 8, approach: 'implement it', item_type: 'leaf' },
      ],
    };
    const plan = validatePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.items[0].item_type).toBe('decompose');
    expect(plan!.items[0].parent_epic).toBe('#506');
    expect(plan!.items[1].item_type).toBe('leaf');
    expect(plan!.items[1].parent_epic).toBeUndefined();
  });

  it('defaults item_type to leaf when not specified', () => {
    const raw = {
      items: [{ issue: '#1', title: 'No type', score: 5 }],
    };
    const plan = validatePlan(raw);
    expect(plan!.items[0].item_type).toBe('leaf');
  });

  it('preserves decomposition_candidates array', () => {
    const raw = {
      items: [{ issue: '#1', title: 'Test', score: 5 }],
      decomposition_candidates: ['#506 Epic — no children'],
    };
    const plan = validatePlan(raw);
    expect(plan!.decomposition_candidates).toEqual(['#506 Epic — no children']);
  });

  it('defaults decomposition_candidates to empty array', () => {
    const raw = {
      items: [{ issue: '#1', title: 'Test', score: 5 }],
    };
    const plan = validatePlan(raw);
    expect(plan!.decomposition_candidates).toEqual([]);
  });
});

describe('formatPlanSummary with decompose items', () => {
  it('shows leaf and decompose counts', () => {
    const plan = makePlanWithDecompose();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('2 leaf');
    expect(summary).toContain('1 decompose');
  });

  it('tags decompose items with [DECOMPOSE]', () => {
    const plan = makePlanWithDecompose();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('[DECOMPOSE]');
  });

  it('shows decomposition candidates count', () => {
    const plan = makePlanWithDecompose();
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('Decomposition candidates: 1');
  });
});

describe('claimNextItem with decompose items', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plan-decompose-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claims decompose items and preserves item_type', () => {
    const plan = makePlanWithDecompose();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const first = claimNextItem(tmpDir);
    expect(first!.item_type).toBe('leaf');

    const second = claimNextItem(tmpDir);
    expect(second!.item_type).toBe('decompose');
    expect(second!.parent_epic).toBe('#506');
  });
});

describe('resetAssignedItems', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plan-reset-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resets assigned items to pending', () => {
    const plan = makePlan();
    plan.items[0].status = 'assigned';
    plan.items[1].status = 'assigned';
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const count = resetAssignedItems(tmpDir);
    expect(count).toBe(2);

    const updated = readPlan(tmpDir);
    expect(updated!.items[0].status).toBe('pending');
    expect(updated!.items[1].status).toBe('pending');
    expect(updated!.items[2].status).toBe('pending');
  });

  it('does not touch done or skipped items', () => {
    const plan = makePlan();
    plan.items[0].status = 'done';
    plan.items[1].status = 'skipped';
    plan.items[2].status = 'assigned';
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const count = resetAssignedItems(tmpDir);
    expect(count).toBe(1);

    const updated = readPlan(tmpDir);
    expect(updated!.items[0].status).toBe('done');
    expect(updated!.items[1].status).toBe('skipped');
    expect(updated!.items[2].status).toBe('pending');
  });

  it('returns 0 when no assigned items exist', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const count = resetAssignedItems(tmpDir);
    expect(count).toBe(0);
  });

  it('returns 0 when no plan exists', () => {
    const count = resetAssignedItems(tmpDir);
    expect(count).toBe(0);
  });
});

describe('claim → mark lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plan-lifecycle-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: claim, mark done, claim next', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    // Claim first item
    const first = claimNextItem(tmpDir);
    expect(first!.issue).toBe('#302');
    expect(first!.status).toBe('assigned');

    // Mark it done
    markItem(tmpDir, '#302', 'done');
    const afterDone = readPlan(tmpDir);
    expect(afterDone!.items[0].status).toBe('done');

    // Claim next — should get #451
    const second = claimNextItem(tmpDir);
    expect(second!.issue).toBe('#451');

    // Mark it skipped
    markItem(tmpDir, '#451', 'skipped');
    const afterSkip = readPlan(tmpDir);
    expect(afterSkip!.items[1].status).toBe('skipped');

    // Claim next — should get #407
    const third = claimNextItem(tmpDir);
    expect(third!.issue).toBe('#407');
  });

  it('interrupted run: claim, crash, reset, re-claim same item', () => {
    const plan = makePlan();
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    // Claim first item (simulating a run start)
    claimNextItem(tmpDir);
    const afterClaim = readPlan(tmpDir);
    expect(afterClaim!.items[0].status).toBe('assigned');

    // Simulate crash — item stays assigned
    // On resume, reset assigned items
    const resetCount = resetAssignedItems(tmpDir);
    expect(resetCount).toBe(1);

    // Re-claim — should get the same item again
    const retried = claimNextItem(tmpDir);
    expect(retried!.issue).toBe('#302');
  });
});

describe('buildPlanPrompt', () => {
  it('includes guidance in plan prompt', () => {
    const state = {
      batch_id: 'batch-test',
      batch_start: 0,
      guidance: 'focus on observability',
      max_runs: 10,
      cooldown: 30,
      budget: '3.00',
      max_failures: 3,
      kaizen_repo: 'Garsson-io/kaizen',
      host_repo: 'Garsson-io/kaizen',
      run: 0,
      prs: [],
      issues_filed: [],
      issues_closed: [],
      cases: [],
      consecutive_failures: 0,
      current_cooldown: 30,
      stop_reason: '',
      last_issue: '',
      last_pr: '',
      last_case: '',
      last_branch: '',
      last_worktree: '',
    };
    const prompt = buildPlanPrompt(state);
    expect(prompt).toContain('focus on observability');
    expect(prompt).toContain('Garsson-io/kaizen');
  });

  it('includes decomposition instructions in plan prompt', () => {
    const state = {
      batch_id: 'batch-test',
      batch_start: 0,
      guidance: 'move forward on epics',
      max_runs: 10,
      cooldown: 30,
      budget: '3.00',
      max_failures: 3,
      kaizen_repo: 'Garsson-io/kaizen',
      host_repo: 'Garsson-io/kaizen',
      run: 0,
      prs: [],
      issues_filed: [],
      issues_closed: [],
      cases: [],
      consecutive_failures: 0,
      current_cooldown: 30,
      stop_reason: '',
      last_issue: '',
      last_pr: '',
      last_case: '',
      last_branch: '',
      last_worktree: '',
    };
    const prompt = buildPlanPrompt(state);
    expect(prompt).toContain('decomposition');
    expect(prompt).toContain('item_type');
  });
});

// ---------------------------------------------------------------------------
// Thematic plan coordination (#941)
// ---------------------------------------------------------------------------

describe('titleTokens', () => {
  it('lowercases, splits, and drops short/stopwords', () => {
    const t = titleTokens('Fix the L2 hook performance observability');
    expect(t.has('hook')).toBe(true);
    expect(t.has('performance')).toBe(true);
    expect(t.has('observability')).toBe(true);
    // stopwords / domain noise removed
    expect(t.has('the')).toBe(false);
    expect(t.has('fix')).toBe(false);
    expect(t.has('l2')).toBe(false);
  });

  it('splits on hyphens', () => {
    const t = titleTokens('cross-batch steering');
    expect(t.has('cross')).toBe(true);
    expect(t.has('batch')).toBe(true);
    expect(t.has('steering')).toBe(true);
  });
});

describe('deriveThemes', () => {
  it('groups items sharing a parent_epic into one theme', () => {
    const items = [
      mkItem({ issue: '#1', title: 'alpha widget', parent_epic: '#900' }),
      mkItem({ issue: '#2', title: 'beta gadget', parent_epic: '#900' }),
      mkItem({ issue: '#3', title: 'lone thing', parent_epic: '#999' }),
    ];
    const themes = deriveThemes(items);
    expect(themes).toHaveLength(1);
    expect(themes[0].issues.sort()).toEqual(['#1', '#2']);
    expect(themes[0].title).toContain('#900');
  });

  it('groups items sharing >=2 significant title tokens', () => {
    const items = [
      mkItem({ issue: '#1', title: 'hook performance observability' }),
      mkItem({ issue: '#2', title: 'hook performance timing instrumentation' }),
      mkItem({ issue: '#3', title: 'worktree cleanup logic' }),
    ];
    const themes = deriveThemes(items);
    expect(themes).toHaveLength(1);
    expect(themes[0].issues.sort()).toEqual(['#1', '#2']);
  });

  it('does NOT group on a single shared token', () => {
    const items = [
      mkItem({ issue: '#1', title: 'hook reliability gate' }),
      mkItem({ issue: '#2', title: 'hook is unrelated entirely otherwise distinct' }),
    ];
    // only "hook" is shared (1 token) → not related
    const themes = deriveThemes(items);
    expect(themes).toHaveLength(0);
  });

  it('leaves singletons themeless (no theme produced)', () => {
    const items = [
      mkItem({ issue: '#1', title: 'alpha unique words' }),
      mkItem({ issue: '#2', title: 'beta different terms' }),
    ];
    expect(deriveThemes(items)).toHaveLength(0);
  });

  it('clusters transitively via union-find (A~B, B~C => one theme)', () => {
    const items = [
      mkItem({ issue: '#1', title: 'batch steering recommendations' }),
      mkItem({ issue: '#2', title: 'batch steering memory' }), // shares batch+steering with #1
      mkItem({ issue: '#3', title: 'batch memory observability' }), // shares batch+memory with #2
    ];
    const themes = deriveThemes(items);
    expect(themes).toHaveLength(1);
    expect(themes[0].issues.sort()).toEqual(['#1', '#2', '#3']);
  });

  it('is deterministic — same input yields same ids/order', () => {
    const build = () => [
      mkItem({ issue: '#1', title: 'hook performance observability' }),
      mkItem({ issue: '#2', title: 'hook performance timing' }),
    ];
    expect(deriveThemes(build())).toEqual(deriveThemes(build()));
  });

  it('produces unique theme ids when labels collide', () => {
    const items = [
      mkItem({ issue: '#1', title: 'review battery dimension', parent_epic: '#100' }),
      mkItem({ issue: '#2', title: 'review battery loop', parent_epic: '#100' }),
      mkItem({ issue: '#3', title: 'review battery coverage', parent_epic: '#200' }),
      mkItem({ issue: '#4', title: 'review battery fix', parent_epic: '#200' }),
    ];
    const themes = deriveThemes(items);
    const ids = themes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ensureThemes', () => {
  it('derives themes and stamps item.theme when absent', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [
        mkItem({ issue: '#1', title: 'hook performance observability' }),
        mkItem({ issue: '#2', title: 'hook performance timing' }),
        mkItem({ issue: '#3', title: 'unrelated singleton work' }),
      ],
    };
    ensureThemes(plan);
    expect(plan.themes!.length).toBe(1);
    expect(plan.items[0].theme).toBe(plan.themes![0].id);
    expect(plan.items[1].theme).toBe(plan.themes![0].id);
    expect(plan.items[2].theme).toBeUndefined();
  });

  it('is idempotent', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [
        mkItem({ issue: '#1', title: 'batch steering memory' }),
        mkItem({ issue: '#2', title: 'batch steering recommendations' }),
      ],
    };
    ensureThemes(plan);
    const first = JSON.stringify(plan);
    ensureThemes(plan);
    expect(JSON.stringify(plan)).toBe(first);
  });

  it('respects LLM-provided themes instead of overwriting', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [{ id: 'llm-theme', title: 'LLM Theme', rationale: 'r', issues: ['#1', '#2'] }],
      items: [
        mkItem({ issue: '#1', title: 'totally unrelated alpha' }),
        mkItem({ issue: '#2', title: 'totally unrelated beta' }),
      ],
    };
    ensureThemes(plan);
    expect(plan.themes!.map((t) => t.id)).toEqual(['llm-theme']);
    expect(plan.items[0].theme).toBe('llm-theme');
    expect(plan.items[1].theme).toBe('llm-theme');
  });
});

describe('validateThemes', () => {
  it('keeps well-formed themes', () => {
    const themes = validateThemes([
      { id: 't1', title: 'T1', rationale: 'r', issues: ['#1', '#2'] },
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0].issues).toEqual(['#1', '#2']);
  });

  it('drops malformed themes (missing fields / empty issues)', () => {
    const themes = validateThemes([
      { id: 't1', title: 'ok', issues: ['#1'] },
      { id: 't2', issues: ['#3'] }, // missing title
      { id: 't3', title: 'empty', issues: [] }, // empty issues
      null,
    ]);
    expect(themes.map((t) => t.id)).toEqual(['t1']);
  });

  it('returns [] for non-array', () => {
    expect(validateThemes(undefined)).toEqual([]);
    expect(validateThemes('nope')).toEqual([]);
  });

  it('de-duplicates an issue appearing in multiple themes (first wins)', () => {
    const themes = validateThemes([
      { id: 't1', title: 'T1', rationale: '', issues: ['#1', '#2'] },
      { id: 't2', title: 'T2', rationale: '', issues: ['#2', '#3'] },
    ]);
    expect(themes.find((t) => t.id === 't1')!.issues).toEqual(['#1', '#2']);
    expect(themes.find((t) => t.id === 't2')!.issues).toEqual(['#3']);
  });

  it('drops a theme that becomes empty after dedup', () => {
    const themes = validateThemes([
      { id: 't1', title: 'T1', rationale: '', issues: ['#1'] },
      { id: 't2', title: 'T2', rationale: '', issues: ['#1'] },
    ]);
    expect(themes.map((t) => t.id)).toEqual(['t1']);
  });
});

describe('validatePlan with themes', () => {
  it('preserves per-item theme and a validated themes array', () => {
    const raw = {
      items: [
        { issue: '#1', title: 'one', score: 5, theme: 'alpha' },
        { issue: '#2', title: 'two', score: 4, theme: 'alpha' },
      ],
      themes: [{ id: 'alpha', title: 'Alpha', rationale: 'r', issues: ['#1', '#2'] }],
    };
    const plan = validatePlan(raw);
    expect(plan!.items[0].theme).toBe('alpha');
    expect(plan!.themes).toHaveLength(1);
    expect(plan!.themes![0].id).toBe('alpha');
  });

  it('omits themes when none provided (no themes key)', () => {
    const plan = validatePlan({ items: [{ issue: '#1', title: 'one', score: 5 }] });
    expect(plan!.themes).toBeUndefined();
  });
});

describe('selectNextItem — coordination', () => {
  it('theme-less plan: returns first pending (legacy behavior)', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 3 }),
        mkItem({ issue: '#2', title: 'b', score: 9 }),
      ],
    };
    // Even though #2 has higher score, legacy behavior takes first pending.
    expect(selectNextItem(plan)!.issue).toBe('#1');
  });

  it('continues an in-progress theme even when a higher-score item exists elsewhere', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [
        { id: 'T1', title: 'T1', rationale: '', issues: ['#1', '#2'] },
        { id: 'T2', title: 'T2', rationale: '', issues: ['#3'] },
      ],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 5, theme: 'T1', status: 'done' }),
        mkItem({ issue: '#2', title: 'b', score: 4, theme: 'T1', status: 'pending' }),
        mkItem({ issue: '#3', title: 'c', score: 9, theme: 'T2', status: 'pending' }),
      ],
    };
    // T1 is in progress (#1 done) and has pending #2 → claim #2, not higher-score #3.
    expect(selectNextItem(plan)!.issue).toBe('#2');
  });

  it('within an in-progress theme, picks the highest-score pending', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [{ id: 'T1', title: 'T1', rationale: '', issues: ['#1', '#2', '#3'] }],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 5, theme: 'T1', status: 'assigned' }),
        mkItem({ issue: '#2', title: 'b', score: 4, theme: 'T1', status: 'pending' }),
        mkItem({ issue: '#3', title: 'c', score: 7, theme: 'T1', status: 'pending' }),
      ],
    };
    expect(selectNextItem(plan)!.issue).toBe('#3');
  });

  it('with no theme in progress, starts the strongest theme (highest-score item)', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [
        { id: 'T1', title: 'T1', rationale: '', issues: ['#1'] },
        { id: 'T2', title: 'T2', rationale: '', issues: ['#2'] },
      ],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 5, theme: 'T1', status: 'pending' }),
        mkItem({ issue: '#2', title: 'b', score: 9, theme: 'T2', status: 'pending' }),
      ],
    };
    expect(selectNextItem(plan)!.issue).toBe('#2');
  });

  it('moves to a fresh theme once the in-progress one is exhausted', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [
        { id: 'T1', title: 'T1', rationale: '', issues: ['#1'] },
        { id: 'T2', title: 'T2', rationale: '', issues: ['#2'] },
      ],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 5, theme: 'T1', status: 'done' }),
        mkItem({ issue: '#2', title: 'b', score: 9, theme: 'T2', status: 'pending' }),
      ],
    };
    // T1 done & exhausted → fall to strongest fresh pending = #2
    expect(selectNextItem(plan)!.issue).toBe('#2');
  });

  it('returns null when nothing is pending', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [mkItem({ issue: '#1', title: 'a', status: 'done' })],
    };
    expect(selectNextItem(plan)).toBeNull();
  });
});

describe('claimNextItem theme-aware persistence', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'plan-theme-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('claims the continuation of an in-progress theme and persists assigned', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [
        { id: 'T1', title: 'T1', rationale: '', issues: ['#1', '#2'] },
        { id: 'T2', title: 'T2', rationale: '', issues: ['#3'] },
      ],
      items: [
        mkItem({ issue: '#1', title: 'a', score: 5, theme: 'T1', status: 'done' }),
        mkItem({ issue: '#2', title: 'b', score: 4, theme: 'T1', status: 'pending' }),
        mkItem({ issue: '#3', title: 'c', score: 9, theme: 'T2', status: 'pending' }),
      ],
    };
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));
    const claimed = claimNextItem(tmpDir);
    expect(claimed!.issue).toBe('#2');
    const updated = readPlan(tmpDir)!;
    expect(updated.items.find((i) => i.issue === '#2')!.status).toBe('assigned');
    expect(updated.items.find((i) => i.issue === '#3')!.status).toBe('pending');
  });
});

describe('themeProgress', () => {
  it('counts statuses per theme', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [{ id: 'T1', title: 'Hooks', rationale: '', issues: ['#1', '#2', '#3'] }],
      items: [
        mkItem({ issue: '#1', title: 'a', theme: 'T1', status: 'done' }),
        mkItem({ issue: '#2', title: 'b', theme: 'T1', status: 'pending' }),
        mkItem({ issue: '#3', title: 'c', theme: 'T1', status: 'assigned' }),
      ],
    };
    const tp = themeProgress(plan);
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ id: 'T1', total: 3, done: 1, pending: 1, assigned: 1, skipped: 0 });
  });

  it('returns [] when no themes', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [mkItem({ issue: '#1', title: 'a' })],
    };
    expect(themeProgress(plan)).toEqual([]);
  });
});

describe('formatPlanSummary with themes', () => {
  it('renders a Themes section with done/total markers', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      themes: [{ id: 'hooks', title: 'Hooks', rationale: '', issues: ['#1', '#2'] }],
      items: [
        mkItem({ issue: '#1', title: 'a', theme: 'hooks', status: 'done' }),
        mkItem({ issue: '#2', title: 'b', theme: 'hooks', status: 'pending' }),
      ],
    };
    const summary = formatPlanSummary(plan);
    expect(summary).toContain('Themes (1 coordinated bundle)');
    expect(summary).toContain('Hooks [1/2]');
  });

  it('omits the Themes section when there are no themes', () => {
    const plan: BatchPlan = {
      created_at: 'x', guidance: 'g', wip_excluded: [], epics_scanned: [],
      items: [mkItem({ issue: '#1', title: 'a' })],
    };
    expect(formatPlanSummary(plan)).not.toContain('Themes (');
  });
});

describe('plan-prepass template includes theme instructions', () => {
  it('buildPlanPrompt mentions themes', () => {
    const state = {
      batch_id: 'b', batch_start: 0, guidance: 'g', max_runs: 10, cooldown: 30,
      budget: '3.00', max_failures: 3, kaizen_repo: 'Garsson-io/kaizen',
      host_repo: 'Garsson-io/kaizen', run: 0, prs: [], issues_filed: [],
      issues_closed: [], cases: [], consecutive_failures: 0, current_cooldown: 30,
      stop_reason: '', last_issue: '', last_pr: '', last_case: '', last_branch: '',
      last_worktree: '',
    };
    const prompt = buildPlanPrompt(state);
    expect(prompt.toLowerCase()).toContain('theme');
  });

  it('buildPlanPrompt surfaces explore-sourced issues and candidate manifests', () => {
    const state = {
      batch_id: 'b', batch_start: 0, guidance: 'g', max_runs: 10, cooldown: 30,
      budget: '3.00', max_failures: 3, kaizen_repo: 'Garsson-io/kaizen',
      host_repo: 'Garsson-io/kaizen', run: 0, prs: [], issues_filed: [],
      issues_closed: [], cases: [], consecutive_failures: 0, current_cooldown: 30,
      stop_reason: '', last_issue: '', last_pr: '', last_case: '', last_branch: '',
      last_worktree: '',
    };

    const prompt = buildPlanPrompt(state);

    expect(prompt).toContain('source:auto-dent-explore');
    expect(prompt).toContain('source:ecosystem-research');
    expect(prompt).toContain('run-*-candidate-tasks-manifest.json');
    expect(prompt).toContain('candidate-task manifest');
  });
});
