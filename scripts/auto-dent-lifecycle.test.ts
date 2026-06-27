import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateRunLifecycle,
  summarizeLifecycle,
  verifyLifecycleEvidence,
  validateProcessEvidence,
  foldEvidenceIntoHealth,
  summarizeEvidence,
  summarizeProcessValidation,
  LIFECYCLE_ORDER,
  REQUIRED_PREDECESSORS,
  type LifecycleValidation,
  type LifecycleEvidence,
  type ProcessEvidence,
} from './auto-dent-lifecycle.js';

/**
 * The lifecycle validator turns the agent's AUTO_DENT_PHASE claims into a
 * verified, classified signal. These tests are the category-prevention battery
 * for issue #1103: ordering (back-compat), critical gaps, phantom-test claims,
 * health classification, and the one-line summary.
 */
describe('validateRunLifecycle — back-compat (ordering + presence)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-bc-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function logWith(lines: string[]): string {
    const f = join(tmpDir, `${Math.abs(lines.join().length)}.log`);
    writeFileSync(f, lines.join('\n'));
    return f;
  }

  it('returns valid + clean for a correct full lifecycle', () => {
    const f = logWith([
      'AUTO_DENT_PHASE: PICK | issue=#1 | title=test',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=ok',
      'AUTO_DENT_PHASE: IMPLEMENT | case=test-case',
      'AUTO_DENT_PHASE: TEST | result=pass | count=5',
      'AUTO_DENT_PHASE: PR | url=https://example.com/pr/1',
      'AUTO_DENT_PHASE: MERGE | url=https://example.com/pr/1 | status=queued',
      'AUTO_DENT_PHASE: REFLECT | issues_filed=0',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.phasesMissing).toEqual([]);
    expect(r.criticalGaps).toEqual([]);
    expect(r.phantomPhases).toEqual([]);
    expect(r.health).toBe('clean');
    expect(r.phasesPresent).toEqual(LIFECYCLE_ORDER);
  });

  it('detects ordering violations (valid=false) and classifies degraded', () => {
    const f = logWith([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: IMPLEMENT | case=c',
      'AUTO_DENT_PHASE: TEST | result=pass | count=3',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: PR | url=u',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.valid).toBe(false);
    expect(r.violations).toContainEqual({ phase: 'EVALUATE', after: 'TEST' });
    // ordering-only problem (no gaps/phantoms) => degraded, not critical
    expect(r.criticalGaps).toEqual([]);
    expect(r.phantomPhases).toEqual([]);
    expect(r.health).toBe('degraded');
  });

  it('ignores floating phases (DECOMPOSE, STOP)', () => {
    const f = logWith([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: DECOMPOSE | epic=#100',
      'AUTO_DENT_PHASE: STOP | reason=done',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.valid).toBe(true);
    expect(r.phasesPresent).toContain('DECOMPOSE');
    expect(r.phasesPresent).toContain('STOP');
  });

  it('handles a log with no phases (all missing, but clean)', () => {
    const f = logWith(['just some log output', 'no phases here']);
    const r = validateRunLifecycle(f);
    expect(r.valid).toBe(true);
    expect(r.phasesPresent).toEqual([]);
    expect(r.phasesMissing).toEqual(LIFECYCLE_ORDER);
    expect(r.health).toBe('clean');
  });
});

describe('validateRunLifecycle — critical gaps (claim to ship without building)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-gap-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
  const write = (lines: string[]) => {
    const f = join(tmpDir, 'g.log');
    writeFileSync(f, lines.join('\n'));
    return f;
  };

  it('flags PR without IMPLEMENT as a critical gap', () => {
    const f = write([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: PR | url=u',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.criticalGaps).toContainEqual({ phase: 'PR', requires: 'IMPLEMENT' });
    expect(r.health).toBe('critical');
  });

  it('flags MERGE without PR as a critical gap', () => {
    const f = write([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: IMPLEMENT | case=c',
      'AUTO_DENT_PHASE: MERGE | url=u | status=queued',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.criticalGaps).toContainEqual({ phase: 'MERGE', requires: 'PR' });
    expect(r.health).toBe('critical');
  });

  it('does NOT flag a gap when the required predecessor is present', () => {
    const f = write([
      'AUTO_DENT_PHASE: IMPLEMENT | case=c',
      'AUTO_DENT_PHASE: TEST | result=pass | count=2',
      'AUTO_DENT_PHASE: PR | url=u',
      'AUTO_DENT_PHASE: MERGE | url=u | status=queued',
    ]);
    const r = validateRunLifecycle(f);
    expect(r.criticalGaps).toEqual([]);
  });

  it('REQUIRED_PREDECESSORS encodes PR<=IMPLEMENT and MERGE<=PR', () => {
    expect(REQUIRED_PREDECESSORS.PR).toBe('IMPLEMENT');
    expect(REQUIRED_PREDECESSORS.MERGE).toBe('PR');
  });
});

describe('validateRunLifecycle — phantom test claims (verify outcomes not claims)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-phantom-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
  const write = (lines: string[]) => {
    const f = join(tmpDir, 'p.log');
    writeFileSync(f, lines.join('\n'));
    return f;
  };
  const fullExcept = (testLine: string) => [
    'AUTO_DENT_PHASE: PICK | issue=#1',
    'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
    'AUTO_DENT_PHASE: IMPLEMENT | case=c',
    testLine,
    'AUTO_DENT_PHASE: PR | url=u',
  ];

  it('flags TEST result=pass count=0 as phantom', () => {
    const r = validateRunLifecycle(write(fullExcept('AUTO_DENT_PHASE: TEST | result=pass | count=0')));
    expect(r.phantomPhases).toHaveLength(1);
    expect(r.phantomPhases[0].phase).toBe('TEST');
    expect(r.health).toBe('critical');
  });

  it('flags TEST result=pass with missing count as phantom', () => {
    const r = validateRunLifecycle(write(fullExcept('AUTO_DENT_PHASE: TEST | result=pass')));
    expect(r.phantomPhases).toHaveLength(1);
    expect(r.health).toBe('critical');
  });

  it('does NOT flag TEST result=pass with positive count', () => {
    const r = validateRunLifecycle(write(fullExcept('AUTO_DENT_PHASE: TEST | result=pass | count=7')));
    expect(r.phantomPhases).toEqual([]);
    expect(r.health).toBe('clean');
  });

  it('does NOT flag an honest TEST result=fail (failing is not phantom)', () => {
    const r = validateRunLifecycle(write(fullExcept('AUTO_DENT_PHASE: TEST | result=fail | count=0')));
    expect(r.phantomPhases).toEqual([]);
  });
});

describe('summarizeLifecycle', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-sum-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
  const write = (lines: string[]) => {
    const f = join(tmpDir, 's.log');
    writeFileSync(f, lines.join('\n'));
    return f;
  };

  it('summarizes a clean run with the phase chain', () => {
    const r = validateRunLifecycle(write([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: IMPLEMENT | case=c',
    ]));
    const s = summarizeLifecycle(r);
    expect(s.toLowerCase()).toContain('clean');
  });

  it('names the critical findings in the summary', () => {
    const r = validateRunLifecycle(write([
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: TEST | result=pass | count=0',
      'AUTO_DENT_PHASE: PR | url=u',
    ]));
    const s = summarizeLifecycle(r);
    expect(s.toUpperCase()).toContain('CRITICAL');
    // mentions both the phantom test and the PR-without-IMPLEMENT gap
    expect(s).toMatch(/phantom|TEST/i);
    expect(s).toMatch(/IMPLEMENT/);
  });
});

/**
 * Evidence verification (#1138, epic #1134) is the "auto-dent is the judge" layer:
 * it cross-checks the agent's claimed phases against the outcomes the harness
 * extracted independently (PRs, cases, filed/closed issues, the review verdict).
 * A claimed phase with no corroborating external evidence is process-incomplete.
 * The verifier reads only phasesPresent + evidence, so it is provider-independent
 * by construction. Helper builds a minimal validation with a given phase set.
 */
describe('verifyLifecycleEvidence — claims vs external outcomes', () => {
  const validationWith = (phasesPresent: string[]): LifecycleValidation => ({
    valid: true,
    phasesPresent,
    phasesMissing: [],
    violations: [],
    criticalGaps: [],
    phantomPhases: [],
    health: 'clean',
  });

  const evidence = (over: Partial<LifecycleEvidence> = {}): LifecycleEvidence => ({
    prsCreated: 0,
    casesCreated: 0,
    issuesFiledOrClosed: 0,
    reviewVerdict: null,
    ...over,
  });

  it('flags PR claimed but zero PRs created', () => {
    const r = verifyLifecycleEvidence(validationWith(['IMPLEMENT', 'PR']), evidence());
    expect(r.processComplete).toBe(false);
    expect(r.processGaps.some((g) => g.phase === 'PR')).toBe(true);
  });

  it('flags MERGE claimed but zero PRs created', () => {
    const r = verifyLifecycleEvidence(validationWith(['IMPLEMENT', 'PR', 'MERGE']), evidence());
    expect(r.processGaps.some((g) => g.phase === 'MERGE')).toBe(true);
  });

  it('flags IMPLEMENT claimed but no case and no PR', () => {
    const r = verifyLifecycleEvidence(validationWith(['IMPLEMENT']), evidence());
    expect(r.processGaps.some((g) => g.phase === 'IMPLEMENT')).toBe(true);
  });

  it('does NOT flag IMPLEMENT when a case exists (work happened, PR may be next run)', () => {
    const r = verifyLifecycleEvidence(validationWith(['IMPLEMENT']), evidence({ casesCreated: 1 }));
    expect(r.processGaps.some((g) => g.phase === 'IMPLEMENT')).toBe(false);
  });

  it('flags REFLECT claimed but nothing filed or closed', () => {
    const r = verifyLifecycleEvidence(validationWith(['REFLECT']), evidence());
    expect(r.processGaps.some((g) => g.phase === 'REFLECT')).toBe(true);
  });

  it('does NOT flag REFLECT when an issue was closed (durable output)', () => {
    const r = verifyLifecycleEvidence(validationWith(['REFLECT']), evidence({ issuesFiledOrClosed: 1 }));
    expect(r.processGaps.some((g) => g.phase === 'REFLECT')).toBe(false);
  });

  it('flags a created PR with a missing review verdict', () => {
    const r = verifyLifecycleEvidence(
      validationWith(['IMPLEMENT', 'PR']),
      evidence({ prsCreated: 1, reviewVerdict: null }),
    );
    expect(r.processGaps.some((g) => g.phase === 'PR' && /review/.test(g.reason))).toBe(true);
  });

  it('flags a created PR with a skipped review', () => {
    const r = verifyLifecycleEvidence(
      validationWith(['IMPLEMENT', 'PR']),
      evidence({ prsCreated: 1, reviewVerdict: 'skipped' }),
    );
    expect(r.processGaps.some((g) => /review/.test(g.reason))).toBe(true);
  });

  it('a fully corroborated run is process-complete (PR built, reviewed)', () => {
    const r = verifyLifecycleEvidence(
      validationWith(['PICK', 'IMPLEMENT', 'TEST', 'PR']),
      evidence({ prsCreated: 1, casesCreated: 1, reviewVerdict: 'pass' }),
    );
    expect(r.processComplete).toBe(true);
    expect(r.processGaps).toEqual([]);
  });

  it('a review verdict of fail still counts as review evidence (not a gap)', () => {
    const r = verifyLifecycleEvidence(
      validationWith(['IMPLEMENT', 'PR']),
      evidence({ prsCreated: 1, reviewVerdict: 'fail' }),
    );
    expect(r.processGaps.some((g) => /review/.test(g.reason))).toBe(false);
  });

  it('an explore/reflect-only run with no PR claim and a filed issue is process-complete', () => {
    const r = verifyLifecycleEvidence(
      validationWith(['PICK', 'REFLECT']),
      evidence({ issuesFiledOrClosed: 2 }),
    );
    expect(r.processComplete).toBe(true);
  });
});

describe('foldEvidenceIntoHealth', () => {
  it('raises clean to degraded when process-incomplete', () => {
    expect(foldEvidenceIntoHealth('clean', { processGaps: [{ phase: 'PR', reason: 'x' }], processComplete: false })).toBe('degraded');
  });

  it('keeps critical as critical when process-incomplete', () => {
    expect(foldEvidenceIntoHealth('critical', { processGaps: [{ phase: 'PR', reason: 'x' }], processComplete: false })).toBe('critical');
  });

  it('leaves health untouched when process-complete', () => {
    expect(foldEvidenceIntoHealth('clean', { processGaps: [], processComplete: true })).toBe('clean');
    expect(foldEvidenceIntoHealth('degraded', { processGaps: [], processComplete: true })).toBe('degraded');
  });
});

describe('summarizeEvidence', () => {
  it('reports process complete when there are no gaps', () => {
    expect(summarizeEvidence({ processGaps: [], processComplete: true })).toMatch(/complete/i);
  });

  it('names each gap reason when process-incomplete', () => {
    const s = summarizeEvidence({
      processGaps: [
        { phase: 'PR', reason: 'claimed PR but the harness extracted 0 PRs from the run' },
        { phase: 'REFLECT', reason: 'claimed REFLECT but no issues were filed or closed' },
      ],
      processComplete: false,
    });
    expect(s).toMatch(/incomplete/i);
    expect(s).toContain('0 PRs');
    expect(s).toContain('no issues were filed');
  });
});

describe('validateProcessEvidence — durable kaizen evidence verdict (#1149)', () => {
  const validationWith = (phasesPresent: string[]): LifecycleValidation => ({
    valid: true,
    phasesPresent,
    phasesMissing: [],
    violations: [],
    criticalGaps: [],
    phantomPhases: [],
    health: 'clean',
  });

  const fullEvidence = (over: Partial<ProcessEvidence> = {}): ProcessEvidence => ({
    planEvidence: true,
    implementationEvidence: true,
    prEvidence: true,
    testEvidence: true,
    reviewEvidence: true,
    reflectionEvidence: true,
    mergeReadiness: 'ready',
    ...over,
  });

  it('returns process-incomplete when a PR claim lacks implementation evidence', () => {
    const result = validateProcessEvidence(
      validationWith(['PICK', 'EVALUATE', 'PR']),
      fullEvidence({ implementationEvidence: false, prEvidence: true }),
    );
    expect(result.verdict).toBe('process-incomplete');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'implementation',
      status: 'fail',
    }));
  });

  it('returns process-incomplete when tests are claimed green without test evidence', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR']),
      fullEvidence({ testEvidence: false }),
    );
    expect(result.verdict).toBe('process-incomplete');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'test',
      status: 'fail',
    }));
  });

  it('checks for missing durable plan evidence', () => {
    const result = validateProcessEvidence(
      validationWith(['PICK', 'EVALUATE', 'IMPLEMENT']),
      fullEvidence({ planEvidence: false }),
    );
    expect(result.verdict).toBe('process-incomplete');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'plan',
      status: 'fail',
    }));
  });

  it('checks for missing review evidence when a PR exists', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR']),
      fullEvidence({ reviewEvidence: false }),
    );
    expect(result.verdict).toBe('process-incomplete');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'review',
      status: 'fail',
    }));
  });

  it('checks for missing reflection evidence when reflection is claimed', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR', 'REFLECT']),
      fullEvidence({ reflectionEvidence: false }),
    );
    expect(result.verdict).toBe('process-incomplete');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'reflection',
      status: 'fail',
    }));
  });

  it('returns fail-open-warning when merge readiness is explicitly not ready', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR', 'MERGE']),
      fullEvidence({ mergeReadiness: 'not-ready' }),
    );
    expect(result.verdict).toBe('fail-open-warning');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'merge-readiness',
      status: 'warning',
    }));
  });

  it('can pass with durable plan, implementation, PR, test, review, reflection, and merge-readiness evidence', () => {
    const result = validateProcessEvidence(
      validationWith(['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT']),
      fullEvidence(),
    );
    expect(result.verdict).toBe('pass');
    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
  });

  it('treats provider review fail as completed review evidence, not missing evidence', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR']),
      fullEvidence({
        providerReviewEvidence: {
          claude: 'pass',
          codex: 'fail',
        },
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'review-provider',
      status: 'pass',
    }));
  });

  it('summarizes failed checks as steering-ready text', () => {
    const result = validateProcessEvidence(
      validationWith(['IMPLEMENT', 'TEST', 'PR']),
      fullEvidence({ planEvidence: false, testEvidence: false }),
    );
    const summary = summarizeProcessValidation(result);
    expect(summary).toContain('process-incomplete');
    expect(summary).toContain('plan');
    expect(summary).toContain('test');
  });
});

describe('adversarial false-success fixtures (#1150)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'false-success-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeLog = (name: string, lines: string[]) => {
    const f = join(tmpDir, `${name}.log`);
    writeFileSync(f, lines.join('\n'));
    return f;
  };

  const fullEvidence = (over: Partial<ProcessEvidence> = {}): ProcessEvidence => ({
    planEvidence: true,
    implementationEvidence: true,
    prEvidence: true,
    testEvidence: true,
    reviewEvidence: true,
    reflectionEvidence: true,
    mergeReadiness: 'ready',
    ...over,
  });

  const fixtures: Array<{
    name: string;
    logShape: 'claude' | 'codex' | 'provider-neutral';
    lines: string[];
    evidence: ProcessEvidence;
    expectedFailedIds: string[];
  }> = [
    {
      name: 'claude-claims-tests-passed-without-durable-test-evidence',
      logShape: 'claude',
      lines: [
        'Claude run completed',
        'AUTO_DENT_PHASE: IMPLEMENT | case=case-1',
        'AUTO_DENT_PHASE: TEST | result=pass | count=12',
        'AUTO_DENT_PHASE: PR | url=https://github.com/test/repo/pull/1',
      ],
      evidence: fullEvidence({ testEvidence: false }),
      expectedFailedIds: ['test'],
    },
    {
      name: 'claude-claims-review-passed-without-review-attachment',
      logShape: 'claude',
      lines: [
        'AUTO_DENT_PHASE: IMPLEMENT | case=case-2',
        'AUTO_DENT_PHASE: TEST | result=pass | count=5',
        'AUTO_DENT_PHASE: PR | url=https://github.com/test/repo/pull/2',
        'review: pass',
      ],
      evidence: fullEvidence({ reviewEvidence: false }),
      expectedFailedIds: ['review'],
    },
    {
      name: 'codex-claims-reflection-done-without-durable-reflection-output',
      logShape: 'codex',
      lines: [
        '[provider] codex synthetic test-task',
        '[provider] raw_jsonl=run-3-codex.jsonl',
        '--- codex final text ---',
        'AUTO_DENT_PHASE: IMPLEMENT | case=case-3',
        'AUTO_DENT_PHASE: TEST | result=pass | count=4',
        'AUTO_DENT_PHASE: PR | url=https://github.com/test/repo/pull/3',
        'AUTO_DENT_PHASE: REFLECT | issues_filed=1',
      ],
      evidence: fullEvidence({ reflectionEvidence: false }),
      expectedFailedIds: ['reflection'],
    },
    {
      name: 'provider-neutral-pr-created-outside-case-worktree',
      logShape: 'provider-neutral',
      lines: [
        'AUTO_DENT_PHASE: TEST | result=pass | count=3',
        'AUTO_DENT_PHASE: PR | url=https://github.com/test/repo/pull/4',
      ],
      evidence: fullEvidence({ implementationEvidence: false, prEvidence: true }),
      expectedFailedIds: ['implementation'],
    },
    {
      name: 'provider-neutral-resume-lost-plan-state',
      logShape: 'provider-neutral',
      lines: [
        'resume: restored run after interruption; plan_state=missing',
        'AUTO_DENT_PHASE: IMPLEMENT | case=case-5',
        'AUTO_DENT_PHASE: TEST | result=pass | count=2',
      ],
      evidence: fullEvidence({ planEvidence: false, prEvidence: false, mergeReadiness: 'not-applicable' }),
      expectedFailedIds: ['plan'],
    },
    {
      name: 'hybrid-review-never-completes-but-worker-claims-success',
      logShape: 'provider-neutral',
      lines: [
        'AUTO_DENT_PHASE: IMPLEMENT | case=case-6',
        'AUTO_DENT_PHASE: TEST | result=pass | count=9',
        'AUTO_DENT_PHASE: PR | url=https://github.com/test/repo/pull/6',
        'AUTO_DENT_PHASE: REFLECT | issues_filed=1',
      ],
      evidence: fullEvidence({
        reviewEvidence: true,
        providerReviewEvidence: {
          claude: 'pass',
          codex: 'pending',
        },
      }),
      expectedFailedIds: ['review-provider'],
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.logShape}: ${fixture.name}`, () => {
      const validation = validateRunLifecycle(writeLog(fixture.name, fixture.lines));
      const result = validateProcessEvidence(validation, fixture.evidence);

      expect(result.verdict).toBe('process-incomplete');
      for (const id of fixture.expectedFailedIds) {
        expect(result.failedChecks.map((check) => check.id)).toContain(id);
      }
    });
  }
});
