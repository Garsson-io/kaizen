import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractPlanJson,
  validatePlan,
  readPlan,
  claimNextItem,
  markItem,
  formatPlanSummary,
  buildPlanPrompt,
  type BatchPlan,
  type PlanItem,
} from './auto-dent-plan.js';

function makePlan(overrides: Partial<BatchPlan> = {}): BatchPlan {
  return {
    created_at: '2026-03-23T00:00:00Z',
    guidance: 'improve hooks reliability',
    items: [
      { issue: '#302', title: 'Planning pre-pass MVP', score: 8, approach: 'Add plan phase before loop', status: 'pending' },
      { issue: '#451', title: 'Hook performance observability', score: 7, approach: 'Add timing instrumentation', status: 'pending' },
      { issue: '#407', title: 'Engineering techniques', score: 6, approach: 'Apply patterns repo-wide', status: 'pending' },
    ],
    wip_excluded: ['#374 (active case)'],
    epics_scanned: ['#506 Auto-Dent Experimentation Framework'],
    ...overrides,
  };
}

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
});
