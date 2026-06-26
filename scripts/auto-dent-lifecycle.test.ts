import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateRunLifecycle,
  summarizeLifecycle,
  LIFECYCLE_ORDER,
  REQUIRED_PREDECESSORS,
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
