import { describe, it, expect } from 'vitest';
import {
  detectReflectionGaming,
  classifyReflectionQuality,
} from './reflection-checks.js';
import { FailureMode, type Impediment } from './types.js';

// ============================================================
// FM3: Reflection Gaming Detection
// ============================================================

describe('FM3: detectReflectionGaming', () => {
  // --- Real incident: issue #280, agent waived finding as "low frequency" ---
  it('detects generic "low frequency" waiver (issue #280)', () => {
    const impediments: Impediment[] = [
      {
        finding: 'Stacked post-merge gates block subsequent PR workflows',
        disposition: 'waived',
        reason: 'low frequency — only happens when multiple PRs merge in the same session',
      },
    ];

    const detections = detectReflectionGaming(impediments);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.REFLECTION_GAMING);
    expect(detections[0].detail).toContain('low frequency');
  });

  // --- Real incident: issue #258, "overengineering" waiver ---
  it('detects "overengineering" waiver (issue #258)', () => {
    const impediments: Impediment[] = [
      {
        finding: 'Bootstrap counter uses L1 enforcement for L2 policy',
        disposition: 'waived',
        reason: 'fixing this would be overengineering for the current scope',
      },
    ];

    const detections = detectReflectionGaming(impediments);
    const overengineeringDetections = detections.filter((d) =>
      d.detail.includes('overengineering'),
    );
    expect(overengineeringDetections.length).toBeGreaterThan(0);
  });

  // --- Pattern: all findings waived ---
  it('detects all-waived reflection (100% avoidance)', () => {
    const impediments: Impediment[] = [
      {
        finding: 'Hook test coverage gap for new enforcement path',
        disposition: 'no-action',
        type: 'positive',
        reason: 'tests exist for the happy path',
      },
      {
        finding: 'Skill documentation could reference the new hook',
        disposition: 'no-action',
        type: 'positive',
        reason: 'existing docs are sufficient',
      },
    ];

    const detections = detectReflectionGaming(impediments);
    const allWaivedDetections = detections.filter((d) =>
      d.detail.includes('zero filed'),
    );
    expect(allWaivedDetections.length).toBeGreaterThan(0);
  });

  // --- Pattern: empty reflection ---
  it('detects empty impediments list', () => {
    const detections = detectReflectionGaming([]);
    expect(detections.length).toBe(1);
    expect(detections[0].detail).toContain('Empty impediments');
  });

  // --- Pattern: "filed" without issue reference ---
  it('detects filed disposition without ref', () => {
    const impediments: Impediment[] = [
      {
        finding: 'The hook should validate JSON format more strictly',
        disposition: 'filed',
        // no ref!
      },
    ];

    const detections = detectReflectionGaming(impediments);
    const noRefDetections = detections.filter((d) =>
      d.detail.includes('no issue reference'),
    );
    expect(noRefDetections.length).toBeGreaterThan(0);
  });

  // --- Pattern: trivially short finding ---
  it('detects trivially short findings', () => {
    const impediments: Impediment[] = [
      { finding: 'tests', disposition: 'filed', ref: '#100' },
    ];

    const detections = detectReflectionGaming(impediments);
    const trivialDetections = detections.filter((d) =>
      d.detail.includes('trivially short'),
    );
    expect(trivialDetections.length).toBeGreaterThan(0);
  });

  // --- Clean scenario: high-quality reflection ---
  it('does NOT flag well-structured reflection with real filings', () => {
    const impediments: Impediment[] = [
      {
        finding:
          'Hook test infrastructure needs DRY refactoring — 3 test files share identical setup blocks',
        type: 'meta',
        disposition: 'filed',
        ref: '#430',
      },
      {
        finding:
          'E2E test harness caught the git config issue before CI — validates the investment',
        type: 'positive',
        disposition: 'no-action',
        reason: 'Pattern is working as designed, no changes needed',
      },
      {
        finding:
          'Post-merge gate clearing instructions were ambiguous, causing fumbling between gate types',
        disposition: 'fixed-in-pr',
      },
    ];

    const detections = detectReflectionGaming(impediments);
    // Should have zero or minimal detections — this is a good reflection
    const highConfDetections = detections.filter(
      (d) => d.confidence >= 80,
    );
    expect(highConfDetections).toHaveLength(0);
  });

  // --- Clean: single filed impediment with ref ---
  it('does NOT flag single well-formed filed impediment', () => {
    const impediments: Impediment[] = [
      {
        finding: 'The review criteria should include a "rename completeness" check',
        disposition: 'filed',
        ref: '#443',
      },
    ];

    const detections = detectReflectionGaming(impediments);
    const highConfDetections = detections.filter(
      (d) => d.confidence >= 80,
    );
    expect(highConfDetections).toHaveLength(0);
  });
});

// ============================================================
// Reflection Quality Classification
// ============================================================

describe('classifyReflectionQuality', () => {
  it('returns "empty" for no impediments', () => {
    expect(classifyReflectionQuality([])).toBe('empty');
  });

  it('returns "high" for 2+ filed with refs', () => {
    expect(
      classifyReflectionQuality([
        { finding: 'a', disposition: 'filed', ref: '#1' },
        { finding: 'b', disposition: 'filed', ref: '#2' },
      ]),
    ).toBe('high');
  });

  it('returns "medium" for 1 actionable', () => {
    expect(
      classifyReflectionQuality([
        { finding: 'a', disposition: 'filed', ref: '#1' },
        { finding: 'b', disposition: 'no-action', type: 'positive' },
      ]),
    ).toBe('medium');
  });

  it('returns "low" for all no-action', () => {
    expect(
      classifyReflectionQuality([
        { finding: 'a', disposition: 'no-action', type: 'positive' },
        { finding: 'b', disposition: 'no-action', type: 'positive' },
      ]),
    ).toBe('low');
  });
});
