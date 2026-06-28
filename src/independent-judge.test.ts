/**
 * independent-judge.test.ts — unit tests for the independence-by-spawn primitive (#1231).
 *
 * All tests inject a fake spawn (zero cost, deterministic) — no real `claude` process. The real
 * spawn is exercised by independent-judge.e2e.test.ts (gated behind INDEPENDENT_JUDGE_E2E=1).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  independentJudge,
  buildJudgePrompt,
  parseJudgeReply,
  aggregateVotes,
  resolveCharterPlan,
  type JudgeVerdict,
} from './independent-judge.js';
import { CHARTERS, CHARTER_NAMES, getCharter } from './judge-charters.js';
import type { SpawnClaudeFn } from './spawn-claude.js';

// A fake spawn that returns a canned YAML reply and records every call.
function fakeSpawn(reply: string, opts: { exitCode?: number; costUsd?: number } = {}): {
  spawn: SpawnClaudeFn;
  calls: Array<{ prompt: string; opts: Parameters<SpawnClaudeFn>[1] }>;
} {
  const calls: Array<{ prompt: string; opts: Parameters<SpawnClaudeFn>[1] }> = [];
  const spawn: SpawnClaudeFn = async (prompt, spawnOpts) => {
    calls.push({ prompt, opts: spawnOpts });
    return { text: reply, costUsd: opts.costUsd ?? 0.01, durationMs: 1, exitCode: opts.exitCode ?? 0 };
  };
  return { spawn, calls };
}

const PASS_YAML = '```yaml\nverdict: pass\nconfidence: high\ncounterexample: null\nreasoning: looks fine\n```';
const FAIL_YAML =
  '```yaml\nverdict: fail\nconfidence: high\ncounterexample: |\n  feed it an empty diff\nreasoning: breaks\n```';

describe('charter library', () => {
  it('contains all five charters, each with required fields', () => {
    expect(CHARTER_NAMES).toEqual([
      'red-team',
      'staff-engineer',
      'mock-defeat',
      'verdict-honesty',
      'scope-skeptic',
    ]);
    for (const name of CHARTER_NAMES) {
      const c = getCharter(name);
      expect(c.name).toBe(name);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.stance.length).toBeGreaterThan(0);
      expect(c.question.length).toBeGreaterThan(0);
      expect(c.instructions.length).toBeGreaterThan(0);
    }
  });

  it('mock-defeat charter references the test/reality gap (the #1230 reason it exists)', () => {
    const c = getCharter('mock-defeat');
    expect(c.instructions.toLowerCase()).toMatch(/mock|stub|fake/);
    expect(c.instructions.toLowerCase()).toMatch(/real/);
  });
});

describe('buildJudgePrompt — structural independence', () => {
  it('includes the artifact, the charter stance, and a default-to-reject instruction', () => {
    const prompt = buildJudgePrompt(CHARTERS['red-team'], 'THE-ARTIFACT-BODY');
    expect(prompt).toContain('THE-ARTIFACT-BODY');
    expect(prompt).toContain(CHARTERS['red-team'].stance);
    expect(prompt.toLowerCase()).toContain('default to reject');
  });

  it('cannot carry producer rationalization: prompt depends only on (charter, artifact)', () => {
    // There is no parameter for producer context. Two callers with different "justifications"
    // in their heads produce byte-identical prompts for the same artifact — independence is
    // enforced by the type surface, not by discipline.
    const a = buildJudgePrompt(CHARTERS['staff-engineer'], 'same-diff');
    const b = buildJudgePrompt(CHARTERS['staff-engineer'], 'same-diff');
    expect(a).toBe(b);
  });
});

describe('parseJudgeReply — default-to-reject', () => {
  it('parses a well-formed PASS reply', () => {
    const v = parseJudgeReply(PASS_YAML, 'red-team', 0.02);
    expect(v.verdict).toBe('pass');
    expect(v.counterexample).toBeNull();
    expect(v.defaultedToReject).toBe(false);
    expect(v.costUsd).toBe(0.02);
  });

  it('parses a FAIL reply and keeps the counterexample', () => {
    const v = parseJudgeReply(FAIL_YAML, 'red-team', 0);
    expect(v.verdict).toBe('fail');
    expect(v.counterexample).toContain('empty diff');
  });

  it('treats "null"/empty counterexample as no counterexample', () => {
    const yaml = '```yaml\nverdict: pass\ncounterexample: "null"\n```';
    expect(parseJudgeReply(yaml, 'red-team', 0).counterexample).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['non-YAML garbage', 'I think this is fine, ship it!'],
    ['missing verdict', '```yaml\nconfidence: high\n```'],
    ['invalid verdict value', '```yaml\nverdict: maybe\n```'],
  ])('defaults to reject on %s', (_label, text) => {
    const v = parseJudgeReply(text, 'mock-defeat', 0);
    expect(v.verdict).toBe('fail');
    expect(v.defaultedToReject).toBe(true);
  });

  it('parses a bare --- fence and a plain ``` fence too', () => {
    const dashed = '---\nverdict: pass\n---';
    expect(parseJudgeReply(dashed, 'red-team', 0).verdict).toBe('pass');
    const plain = '```\nverdict: fail\ncounterexample: x\n```';
    expect(parseJudgeReply(plain, 'red-team', 0).verdict).toBe('fail');
  });
});

describe('aggregateVotes', () => {
  const v = (verdict: 'pass' | 'fail'): JudgeVerdict => ({
    verdict,
    counterexample: verdict === 'fail' ? 'x' : null,
    confidence: 'high',
    reasoning: '',
    charter: 'red-team',
    defaultedToReject: false,
    costUsd: 0,
  });

  it('any-blocks: any single FAIL fails the panel', () => {
    expect(aggregateVotes([v('pass'), v('fail'), v('pass')], 'any-blocks')).toBe('fail');
    expect(aggregateVotes([v('pass'), v('pass')], 'any-blocks')).toBe('pass');
  });

  it('majority: fails only when at least half fail (ties reject)', () => {
    expect(aggregateVotes([v('pass'), v('pass'), v('fail')], 'majority')).toBe('pass');
    expect(aggregateVotes([v('fail'), v('fail'), v('pass')], 'majority')).toBe('fail');
    expect(aggregateVotes([v('pass'), v('fail')], 'majority')).toBe('fail'); // tie → reject
  });

  it('empty panel rejects (no judge ran)', () => {
    expect(aggregateVotes([], 'any-blocks')).toBe('fail');
  });
});

describe('resolveCharterPlan', () => {
  it('single charter + n spawns n identical lenses', () => {
    expect(resolveCharterPlan({ artifact: 'x', charter: 'red-team', n: 3 })).toEqual([
      'red-team',
      'red-team',
      'red-team',
    ]);
  });

  it('charter array spawns one judge per distinct lens (diversity)', () => {
    expect(
      resolveCharterPlan({ artifact: 'x', charter: ['red-team', 'mock-defeat'] }),
    ).toEqual(['red-team', 'mock-defeat']);
  });

  it('rejects n < 1 and empty arrays', () => {
    expect(() => resolveCharterPlan({ artifact: 'x', charter: 'red-team', n: 0 })).toThrow();
    expect(() => resolveCharterPlan({ artifact: 'x', charter: [] })).toThrow();
  });
});

describe('independentJudge — end to end with injected spawn', () => {
  it('spawns exactly n judges and aggregates any-blocks', async () => {
    const { spawn, calls } = fakeSpawn(PASS_YAML);
    const r = await independentJudge({ artifact: 'a diff', charter: 'red-team', n: 3, spawn });
    expect(calls.length).toBe(3);
    expect(r.verdict).toBe('pass');
    expect(r.votes).toHaveLength(3);
    expect(r.totalCostUsd).toBeCloseTo(0.03);
  });

  it('passes the requested provider through the shared spawn seam', async () => {
    const { spawn, calls } = fakeSpawn(PASS_YAML);
    const r = await independentJudge({
      artifact: 'a diff',
      charter: 'red-team',
      provider: { provider: 'codex', billing: 'subscription-cli' },
      spawn,
    });

    expect(r.verdict).toBe('pass');
    expect(calls[0].opts.provider).toEqual({ provider: 'codex', billing: 'subscription-cli' });
  });

  it('one FAIL among passes blocks the panel (any-blocks default)', async () => {
    let i = 0;
    const replies = [PASS_YAML, FAIL_YAML, PASS_YAML];
    const spawn: SpawnClaudeFn = async () => ({
      text: replies[i++],
      costUsd: 0,
      durationMs: 1,
      exitCode: 0,
    });
    const r = await independentJudge({
      artifact: 'a diff',
      charter: ['red-team', 'mock-defeat', 'staff-engineer'],
      spawn,
    });
    expect(r.verdict).toBe('fail');
    expect(r.counterexamples.length).toBeGreaterThan(0);
  });

  it('non-zero exit code → default-to-reject (never silently passes)', async () => {
    const { spawn } = fakeSpawn(PASS_YAML, { exitCode: 1 });
    const r = await independentJudge({ artifact: 'a diff', charter: 'red-team', spawn });
    expect(r.verdict).toBe('fail');
    expect(r.votes[0].defaultedToReject).toBe(true);
  });

  it('a thrown spawn (infra failure) → reject', async () => {
    const spawn: SpawnClaudeFn = async () => {
      throw new Error('claude not found');
    };
    const r = await independentJudge({ artifact: 'a diff', charter: 'red-team', spawn });
    expect(r.verdict).toBe('fail');
    expect(r.votes[0].reasoning).toMatch(/spawn failed/);
  });

  it('rejects an empty artifact', async () => {
    const { spawn } = fakeSpawn(PASS_YAML);
    await expect(independentJudge({ artifact: '   ', charter: 'red-team', spawn })).rejects.toThrow();
  });
});

describe('DRY guard — one spawn loop in the repo', () => {
  it('review-battery imports the shared spawnClaude and defines no second spawn loop', () => {
    const src = readFileSync(resolve(__dirname, 'review-battery.ts'), 'utf8');
    expect(src).toContain("from './spawn-claude.js'");
    // No second copy of the claude -p argv loop.
    expect(src).not.toContain("spawn('claude'");
  });

  it('independent-judge imports the shared spawnClaude and defines no spawn loop', () => {
    const src = readFileSync(resolve(__dirname, 'independent-judge.ts'), 'utf8');
    expect(src).toContain("from './spawn-claude.js'");
    expect(src).not.toContain("spawn('claude'");
  });
});
