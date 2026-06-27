import { describe, expect, it } from 'vitest';
import { makeBatchState, makeRunResult } from './auto-dent-test-utils.js';

describe('auto-dent test utilities', () => {
  it('centralizes shared batch fixtures for auto-dent tests (#110)', () => {
    expect(makeBatchState()).toMatchObject({
      batch_id: 'batch-260322-2100-a1b2',
      kaizen_repo: 'Garsson-io/kaizen',
      prs: [],
    });
    expect(makeRunResult({ toolCalls: 3 })).toMatchObject({
      prs: [],
      toolCalls: 3,
      stopRequested: false,
    });
  });
});
