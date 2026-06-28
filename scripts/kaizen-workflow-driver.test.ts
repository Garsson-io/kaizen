import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  FULL_KAIZEN_GATE_LABELS,
  buildManualGoalDirective,
  buildWorkflowStatus,
  mergeWorkflowEvidence,
  parseCliEvidenceOverrides,
  renderWorkflowStatusMarkdown,
  renderAutoDentGoalContract,
} from './kaizen-workflow-driver.js';

describe('kaizen workflow forcing driver', () => {
  it('manual driver starts with a literal /goal and names the ticket identity', () => {
    const directive = buildManualGoalDirective({
      task: 'Package the /goal forcing-function as the kaizen workflow driver',
      issue: {
        number: 1507,
        title: '[Meta] Package the /goal forcing-function as the kaizen workflow driver',
        url: 'https://github.com/Garsson-io/kaizen/issues/1507',
      },
    });

    expect(directive).toMatch(/^\/goal /);
    expect(directive).toContain('#1507');
    expect(directive).toContain('[Meta] Package the /goal forcing-function as the kaizen workflow driver');
    expect(directive).toContain('https://github.com/Garsson-io/kaizen/issues/1507');
  });

  it('manual driver carries the full kaizen gate list, DRY pass, and meet-reality proof', () => {
    const directive = buildManualGoalDirective({ task: 'ship #1507' });

    for (const label of FULL_KAIZEN_GATE_LABELS) {
      expect(directive).toContain(label);
    }
    expect(directive).toContain('related-area DRY/refactor pass');
    expect(directive).toContain('reduce competing mechanisms, schemas, and drift');
    expect(directive).toContain('meet reality');
    expect(directive).toContain('observe outputs and side effects');
  });

  it('auto-dent headless contract mirrors /goal pressure without requiring a slash command', () => {
    const contract = renderAutoDentGoalContract('exploit');

    expect(contract).toContain('Headless /goal Equivalent');
    expect(contract).toContain('same forcing function as /goal');
    expect(contract).toContain('Do not finish this run');
    expect(contract).toContain('review/requirements/impact gates');
    expect(contract).toContain('related-area DRY/refactor pass');
    expect(contract).toContain('meet reality');
  });

  it('auto-dent contract is mode-aware so non-PR modes have valid terminal evidence', () => {
    expect(renderAutoDentGoalContract('explore')).toContain('issues filed');
    expect(renderAutoDentGoalContract('reflect')).toContain('REFLECTION_INSIGHT');
    expect(renderAutoDentGoalContract('subtract')).toContain('lines deleted');
    expect(renderAutoDentGoalContract('exploit')).toContain('PR URL');
  });

  it('builds reusable workflow status with stable stage states and evidence', () => {
    const status = buildWorkflowStatus({
      mode: 'exploit',
      evidence: {
        issueIdentity: 'Issue #1507 title/url loaded',
        plan: 'stored plan and test plan found',
        implementation: 'branch has commits',
        dryRefactor: 'pending related-area DRY pass',
      },
    });

    expect(status.stages.map((stage) => stage.id)).toEqual([
      'issue-identity',
      'plan-testplan',
      'worktree-case',
      'implementation-tests',
      'dry-refactor',
      'meet-reality',
      'review-requirements-impact',
      'reflection',
      'pr-ci-merge-cleanup',
    ]);
    expect(status.stages.find((stage) => stage.id === 'plan-testplan')?.state).toBe('done');
    expect(status.stages.find((stage) => stage.id === 'dry-refactor')?.state).toBe('in_progress');
    expect(status.stages.find((stage) => stage.id === 'meet-reality')?.state).toBe('pending');
  });

  it('renders status markdown suitable for /goal, skills, and auto-dent status calls', () => {
    const status = buildWorkflowStatus({
      mode: 'exploit',
      issue: {
        number: 1507,
        title: 'Package /goal as the workflow driver',
        url: 'https://github.com/Garsson-io/kaizen/issues/1507',
      },
      evidence: {
        issueIdentity: 'Issue #1507 loaded',
        plan: 'stored plan and test plan found',
      },
    });

    const markdown = renderWorkflowStatusMarkdown(status);
    expect(markdown).toContain('## Kaizen Workflow Status');
    expect(markdown).toContain('#1507');
    expect(markdown).toContain('Package /goal as the workflow driver');
    expect(markdown).toContain('done');
    expect(markdown).toContain('pending');
  });

  it('merges explicit stage evidence over collected evidence for reusable status calls', () => {
    const evidence = mergeWorkflowEvidence(
      { implementation: 'branch has commits ahead of origin/main', meetReality: 'pending dogfood run' },
      { meetReality: 'done: CLI output inspected', dryRefactor: 'done: shared workflow schema reused' },
    );
    const status = buildWorkflowStatus({ mode: 'manual', evidence });

    expect(status.stages.find((stage) => stage.id === 'implementation-tests')?.state).toBe('done');
    expect(status.stages.find((stage) => stage.id === 'meet-reality')?.state).toBe('done');
    expect(status.stages.find((stage) => stage.id === 'dry-refactor')?.state).toBe('done');
  });

  it('parses CLI evidence flags into the same reusable evidence schema', () => {
    const evidence = parseCliEvidenceOverrides({
      'dry-refactor': 'done: duplicate schemas removed',
      'meet-reality': 'done: status output inspected',
      review: 'blocked: waiting on PR review',
    });

    expect(evidence).toEqual({
      dryRefactor: 'done: duplicate schemas removed',
      meetReality: 'done: status output inspected',
      review: 'blocked: waiting on PR review',
    });
  });

  it('CLI exposes workflow status for operators and agents with explicit gate evidence', () => {
    const result = spawnSync('npx', [
      'tsx',
      'scripts/kaizen-workflow-driver.ts',
      'status',
      '--mode',
      'exploit',
      '--dry-refactor',
      'done: shared workflow driver reused',
      '--meet-reality',
      'done: CLI output inspected',
    ], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Kaizen Workflow Status');
    expect(result.stdout).toContain('plan/test-plan gate');
    expect(result.stdout).toContain('shared workflow driver reused');
    expect(result.stdout).toContain('CLI output inspected');
    expect(result.stdout).toContain('| meet reality | done |');
    expect(result.stdout).toContain('pending');
  });

  it('CLI status resolves repo evidence from the script location, not process cwd', () => {
    const args = [
      'tsx',
      'scripts/kaizen-workflow-driver.ts',
      'status',
      '--mode',
      'manual',
      '--dry-refactor',
      'done: cwd invariant',
      '--meet-reality',
      'done: cwd invariant',
    ];
    const fromRoot = spawnSync('npx', args, { encoding: 'utf8' });
    const fromTmp = spawnSync('npx', ['tsx', resolve('scripts/kaizen-workflow-driver.ts'), ...args.slice(2)], {
      cwd: '/tmp',
      encoding: 'utf8',
    });

    expect(fromRoot.status).toBe(0);
    expect(fromTmp.status).toBe(0);
    expect(fromTmp.stdout).toBe(fromRoot.stdout);
    expect(fromTmp.stdout).toContain('worktree/case gate');
    expect(fromTmp.stdout).toContain('implementation with tests');
  });
});
