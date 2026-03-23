import { describe, it, expect } from 'vitest';
import { GENERIC_WAIVER_BLOCKLIST, matchesWaiverBlocklist } from './waiver-blocklist.js';

describe('GENERIC_WAIVER_BLOCKLIST', () => {
  it('contains expected incident-sourced terms', () => {
    expect(GENERIC_WAIVER_BLOCKLIST).toContain('overengineering');
    expect(GENERIC_WAIVER_BLOCKLIST).toContain('edge case');
    expect(GENERIC_WAIVER_BLOCKLIST).toContain('cosmetic');
  });

  it('has no empty strings', () => {
    for (const term of GENERIC_WAIVER_BLOCKLIST) {
      expect(term.length).toBeGreaterThan(0);
    }
  });
});

describe('matchesWaiverBlocklist', () => {
  it('matches each blocklist term when present in a reason string', () => {
    for (const term of GENERIC_WAIVER_BLOCKLIST) {
      const reason = `This is a ${term} situation`;
      expect(matchesWaiverBlocklist(reason)).toBe(term);
    }
  });

  it('returns the matched term, not just truthy', () => {
    const result = matchesWaiverBlocklist('this is a cosmetic change');
    expect(result).toBe('cosmetic');
  });

  it('matching is case-insensitive', () => {
    expect(matchesWaiverBlocklist('This is OVERENGINEERING')).toBe('overengineering');
    expect(matchesWaiverBlocklist('EDGE CASE handling')).toBe('edge case');
    expect(matchesWaiverBlocklist('Too Complex for now')).toBe('too complex');
  });

  it('returns null for legitimate waiver reasons', () => {
    expect(matchesWaiverBlocklist('filed as issue #500 for follow-up')).toBeNull();
    expect(matchesWaiverBlocklist('fixed in the same PR')).toBeNull();
    expect(matchesWaiverBlocklist('addressed by existing hook')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(matchesWaiverBlocklist('')).toBeNull();
  });

  it('handles partial word matches as substring (includes semantics)', () => {
    // "edge" alone does not match "edge case"
    expect(matchesWaiverBlocklist('edge')).toBeNull();
    // "edge case" does match
    expect(matchesWaiverBlocklist('this is an edge case')).toBe('edge case');
  });

  it('returns the first matching term when multiple match', () => {
    const reason = 'this is cosmetic and an edge case';
    const result = matchesWaiverBlocklist(reason);
    // Should return the first match in blocklist order
    expect(result).toBe('edge case');
  });

  it('matches hyphenated variants', () => {
    expect(matchesWaiverBlocklist('this is over-engineering')).toBe('over-engineering');
    expect(matchesWaiverBlocklist('acceptable trade-off')).toBe('acceptable trade-off');
  });
});
