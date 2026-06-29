import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const gateWorkflow = readFileSync(join(process.cwd(), '.github/workflows/review-verdict-gate.yml'), 'utf8');
const rerunWorkflowPath = join(process.cwd(), '.github/workflows/review-verdict-rerun.yml');
const rerunWorkflow = readFileSync(rerunWorkflowPath, 'utf8');

describe('Review verdict gate workflow', () => {
  it('keeps the PR-attached verdict workflow free of issue_comment helper jobs', () => {
    expect(gateWorkflow).toContain('pull_request:');
    expect(gateWorkflow).toContain('workflow_dispatch:');
    expect(gateWorkflow).not.toContain('issue_comment:');
    expect(gateWorkflow).not.toContain('rerun-after-review-summary');
  });

  it('reruns the PR-attached verdict gate from a separate comment-only workflow', () => {
    expect(existsSync(rerunWorkflowPath)).toBe(true);
    expect(rerunWorkflow).toContain('issue_comment:');
    expect(rerunWorkflow).toContain('types: [created, edited]');
    expect(rerunWorkflow).toContain('actions: write');
    expect(rerunWorkflow).toContain('github.event.issue.pull_request');
    expect(rerunWorkflow).toContain('kaizen:review/r');
    expect(rerunWorkflow).toContain('/summary -->');
    expect(rerunWorkflow).toContain('scripts/rerun-review-verdict-gate.ts');
  });
});
