/**
 * pre-push.test.ts — unit tests for the pre-push git hook (epic #1059).
 *
 * Invariants tested (from testplan):
 *   I-A: no side effects when no agent env var is set
 *   I-B: MERGED+no-newer-open → deny, regardless of preceding PR count
 *   I-C: OPEN → allow + idempotent gate-file write
 *   I-D: no PR history → silent allow
 *   I-E: trace JSONL emitted on every invocation that passes the agent gate
 *   I-F: kaizen-force push option → allow even on merged branch
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AGENT_ENV_VARS,
  applyDecision,
  decide,
  detectAgentEnv,
  parseStdin,
  processPrePush,
  readPushOptions,
  trace,
  type PrQueryResult,
  type PrePushDecision,
} from './pre-push.js';

// ── detectAgentEnv ────────────────────────────────────────────────────

describe('detectAgentEnv', () => {
  it('returns detected=false when no agent vars set (I-A)', () => {
    const result = detectAgentEnv({});
    expect(result.detected).toBe(false);
    expect(result.vars).toEqual([]);
  });

  it('detects CLAUDECODE', () => {
    const result = detectAgentEnv({ CLAUDECODE: '1' });
    expect(result.detected).toBe(true);
    expect(result.vars).toContain('CLAUDECODE');
  });

  it('detects CLAUDE_PROJECT_DIR', () => {
    const result = detectAgentEnv({ CLAUDE_PROJECT_DIR: '/home/user/proj' });
    expect(result.detected).toBe(true);
    expect(result.vars).toContain('CLAUDE_PROJECT_DIR');
  });

  it('detects CODEX_SESSION', () => {
    const result = detectAgentEnv({ CODEX_SESSION: 'abc' });
    expect(result.detected).toBe(true);
    expect(result.vars).toContain('CODEX_SESSION');
  });

  it('detects KAIZEN_SESSION', () => {
    const result = detectAgentEnv({ KAIZEN_SESSION: '1' });
    expect(result.detected).toBe(true);
    expect(result.vars).toContain('KAIZEN_SESSION');
  });

  it('detects multiple agent vars', () => {
    const result = detectAgentEnv({ CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/x' });
    expect(result.detected).toBe(true);
    expect(result.vars).toHaveLength(2);
  });

  it('treats empty string as not set', () => {
    const result = detectAgentEnv({ CLAUDECODE: '' });
    expect(result.detected).toBe(false);
  });

  it('AGENT_ENV_VARS list matches epic design decision', () => {
    expect(AGENT_ENV_VARS).toEqual(['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CODEX_SESSION', 'KAIZEN_SESSION']);
  });
});

// ── parseStdin ────────────────────────────────────────────────────────

describe('parseStdin (git pre-push protocol)', () => {
  it('returns empty array on empty input', () => {
    expect(parseStdin('')).toEqual([]);
    expect(parseStdin('   ')).toEqual([]);
    expect(parseStdin('\n\n')).toEqual([]);
  });

  it('parses a single ref line', () => {
    const raw = 'refs/heads/feat/foo abc123 refs/heads/feat/foo def456';
    const refs = parseStdin(raw);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      localRef: 'refs/heads/feat/foo',
      localSha: 'abc123',
      remoteRef: 'refs/heads/feat/foo',
      remoteSha: 'def456',
    });
  });

  it('parses multiple ref lines', () => {
    const raw = [
      'refs/heads/a sha-a1 refs/heads/a sha-a2',
      'refs/heads/b sha-b1 refs/heads/b sha-b2',
    ].join('\n');
    const refs = parseStdin(raw);
    expect(refs).toHaveLength(2);
    expect(refs[0].localRef).toBe('refs/heads/a');
    expect(refs[1].localRef).toBe('refs/heads/b');
  });

  it('skips lines with wrong number of fields', () => {
    const raw = 'only three fields\nrefs/heads/a sha1 refs/heads/a sha2';
    const refs = parseStdin(raw);
    expect(refs).toHaveLength(1);
  });

  it('handles extra whitespace', () => {
    const raw = '  refs/heads/a   sha1   refs/heads/a   sha2  ';
    const refs = parseStdin(raw);
    expect(refs).toHaveLength(1);
  });
});

// ── readPushOptions ───────────────────────────────────────────────────

describe('readPushOptions (I-F override flag)', () => {
  it('returns empty when GIT_PUSH_OPTION_COUNT absent', () => {
    expect(readPushOptions({})).toEqual([]);
  });

  it('returns empty when count=0', () => {
    expect(readPushOptions({ GIT_PUSH_OPTION_COUNT: '0' })).toEqual([]);
  });

  it('reads a single push option', () => {
    const opts = readPushOptions({
      GIT_PUSH_OPTION_COUNT: '1',
      GIT_PUSH_OPTION_0: 'kaizen-force',
    });
    expect(opts).toEqual(['kaizen-force']);
  });

  it('reads multiple push options', () => {
    const opts = readPushOptions({
      GIT_PUSH_OPTION_COUNT: '3',
      GIT_PUSH_OPTION_0: 'foo',
      GIT_PUSH_OPTION_1: 'bar',
      GIT_PUSH_OPTION_2: 'kaizen-force',
    });
    expect(opts).toEqual(['foo', 'bar', 'kaizen-force']);
  });

  it('ignores options beyond COUNT', () => {
    const opts = readPushOptions({
      GIT_PUSH_OPTION_COUNT: '1',
      GIT_PUSH_OPTION_0: 'first',
      GIT_PUSH_OPTION_1: 'ignored',
    });
    expect(opts).toEqual(['first']);
  });
});

// ── decide (pure decision function) ───────────────────────────────────

const emptyInput = (overrides: Partial<Parameters<typeof decide>[0]> = {}) => ({
  refs: [],
  branch: 'feat/foo',
  repo: 'owner/repo',
  pushOptions: [],
  ...overrides,
});

const openQuery = (): PrQueryResult => ({
  mostRecent: { number: 42, state: 'OPEN', url: 'https://github.com/owner/repo/pull/42' },
  hasOpen: true,
  openUrl: 'https://github.com/owner/repo/pull/42',
});

const mergedQuery = (): PrQueryResult => ({
  mostRecent: { number: 41, state: 'MERGED', url: 'https://github.com/owner/repo/pull/41' },
  hasOpen: false,
});

const closedQuery = (): PrQueryResult => ({
  mostRecent: { number: 40, state: 'CLOSED', url: 'https://github.com/owner/repo/pull/40' },
  hasOpen: false,
});

const emptyQuery = (): PrQueryResult => ({
  mostRecent: null,
  hasOpen: false,
});

describe('decide — core decision matrix', () => {
  it('I-D: no PR history → allow_silent', () => {
    const result = decide(emptyInput(), emptyQuery());
    expect(result.action).toBe('allow_silent');
    expect(result.reason).toBe('no_pr_history');
  });

  it('I-C: OPEN PR → allow_gate with needs_review signal', () => {
    const result = decide(emptyInput(), openQuery());
    expect(result.action).toBe('allow_gate');
    expect(result.reason).toBe('open_pr_push');
    expect(result.gateSignal?.gate).toBe('needs_review');
    expect(result.gateSignal?.pr).toBe('https://github.com/owner/repo/pull/42');
  });

  it('I-B: MERGED + no newer OPEN → deny', () => {
    const result = decide(emptyInput(), mergedQuery());
    expect(result.action).toBe('deny');
    expect(result.reason).toBe('merged_branch_push');
    expect(result.message).toContain('feat/foo');
    expect(result.message).toContain('merged');
  });

  it('I-B: deny message includes recovery steps', () => {
    const result = decide(emptyInput(), mergedQuery());
    expect(result.message).toContain('git checkout');
    expect(result.message).toContain('cherry-pick');
    expect(result.message).toContain('kaizen-force');
  });

  it('closed (not merged) → allow_silent', () => {
    const result = decide(emptyInput(), closedQuery());
    expect(result.action).toBe('allow_silent');
    expect(result.reason).toBe('closed_pr_or_unknown');
  });

  it('I-F: kaizen-force push option overrides merged block', () => {
    const result = decide(
      emptyInput({ pushOptions: ['kaizen-force'] }),
      mergedQuery(),
    );
    expect(result.action).toBe('allow_silent');
    expect(result.reason).toBe('push_option_override');
  });

  it('I-F: kaizen-force with other options still works', () => {
    const result = decide(
      emptyInput({ pushOptions: ['other', 'kaizen-force', 'another'] }),
      mergedQuery(),
    );
    expect(result.action).toBe('allow_silent');
  });

  it('OPEN wins over MERGED in same result (I-C priority)', () => {
    // Edge case: branch re-used. If both a MERGED and OPEN exist, OPEN wins.
    const query: PrQueryResult = {
      mostRecent: { number: 50, state: 'OPEN', url: 'https://github.com/owner/repo/pull/50' },
      hasOpen: true,
      openUrl: 'https://github.com/owner/repo/pull/50',
    };
    const result = decide(emptyInput(), query);
    expect(result.action).toBe('allow_gate');
  });
});

// ── applyDecision (side-effecting gate write) ─────────────────────────

describe('applyDecision — idempotent gate write', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-test-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes state file on allow_gate', () => {
    const decision = decide(emptyInput(), openQuery());
    applyDecision(decision, 'feat/foo', { stateDir });
    const files = fs.readdirSync(stateDir);
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(stateDir, files[0]), 'utf-8');
    expect(content).toContain('STATUS=needs_review');
    expect(content).toContain('BRANCH=feat/foo');
    expect(content).toContain('PR_URL=https://github.com/owner/repo/pull/42');
  });

  it('does not write on allow_silent (I-D)', () => {
    const decision = decide(emptyInput(), emptyQuery());
    applyDecision(decision, 'feat/foo', { stateDir });
    expect(fs.readdirSync(stateDir)).toHaveLength(0);
  });

  it('does not write on deny (I-B)', () => {
    const decision = decide(emptyInput(), mergedQuery());
    applyDecision(decision, 'feat/foo', { stateDir });
    expect(fs.readdirSync(stateDir)).toHaveLength(0);
  });

  it('I-C: idempotent — two applies produce same final state', () => {
    const decision = decide(emptyInput(), openQuery());
    applyDecision(decision, 'feat/foo', { stateDir });
    const firstFiles = fs.readdirSync(stateDir);
    const firstContent = fs.readFileSync(path.join(stateDir, firstFiles[0]), 'utf-8');

    applyDecision(decision, 'feat/foo', { stateDir });
    const secondFiles = fs.readdirSync(stateDir);
    const secondContent = fs.readFileSync(path.join(stateDir, secondFiles[0]), 'utf-8');

    expect(secondFiles).toEqual(firstFiles);
    expect(secondContent).toBe(firstContent);
  });
});

// ── trace (JSONL emission, I-E) ───────────────────────────────────────

describe('trace — JSONL emission', () => {
  let traceFile: string;

  beforeEach(() => {
    traceFile = path.join(os.tmpdir(), `pre-push-trace-${Date.now()}-${Math.random()}.jsonl`);
  });

  afterEach(() => {
    try { fs.unlinkSync(traceFile); } catch { /* already gone */ }
  });

  it('I-E: writes JSONL entry with required fields on agent-detected invocation', () => {
    const decision: PrePushDecision = {
      action: 'deny',
      reason: 'merged_branch_push',
      message: 'denied',
      context: { branch: 'feat/foo', mergedPr: 41 },
    };
    trace(decision, { detected: true, vars: ['CLAUDECODE'] }, { traceFile });

    const raw = fs.readFileSync(traceFile, 'utf-8').trim();
    const entry = JSON.parse(raw);
    expect(entry.hook).toBe('pre-push');
    expect(entry.agent_detected).toBe(true);
    expect(entry.env_vars_seen).toEqual(['CLAUDECODE']);
    expect(entry.action).toBe('deny');
    expect(entry.reason).toBe('merged_branch_push');
    expect(entry.branch).toBe('feat/foo');
    expect(entry.mergedPr).toBe(41);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('I-E: writes entry even when no agent env detected', () => {
    const decision: PrePushDecision = {
      action: 'allow_silent',
      reason: 'no_agent_env',
      message: null,
      context: {},
    };
    trace(decision, { detected: false, vars: [] }, { traceFile });

    const raw = fs.readFileSync(traceFile, 'utf-8').trim();
    const entry = JSON.parse(raw);
    expect(entry.agent_detected).toBe(false);
    expect(entry.env_vars_seen).toEqual([]);
  });

  it('I-E: appends (does not overwrite) on multiple calls', () => {
    const decision: PrePushDecision = { action: 'allow_silent', reason: 'r', message: null };
    trace(decision, { detected: true, vars: ['CLAUDECODE'] }, { traceFile });
    trace(decision, { detected: true, vars: ['CLAUDECODE'] }, { traceFile });

    const lines = fs.readFileSync(traceFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

// ── processPrePush (integrated flow) ──────────────────────────────────

describe('processPrePush — integrated flow with injected query', () => {
  it('I-A: no-agent env → allow_silent without calling query', () => {
    let queryCalled = false;
    const result = processPrePush(
      '',
      {},
      {
        queryPrState: () => {
          queryCalled = true;
          return emptyQuery();
        },
      },
    );
    expect(result.decision.action).toBe('allow_silent');
    expect(result.decision.reason).toBe('no_agent_env');
    expect(queryCalled).toBe(false);
    expect(result.envDetection.detected).toBe(false);
  });

  it('agent-env + OPEN PR → allow_gate', () => {
    const result = processPrePush(
      '',
      { CLAUDECODE: '1' },
      { queryPrState: () => openQuery() },
    );
    expect(result.decision.action).toBe('allow_gate');
    expect(result.envDetection.detected).toBe(true);
  });

  it('agent-env + MERGED branch → deny', () => {
    const result = processPrePush(
      '',
      { CLAUDECODE: '1' },
      { queryPrState: () => mergedQuery() },
    );
    expect(result.decision.action).toBe('deny');
  });

  it('agent-env + MERGED + kaizen-force push option → allow', () => {
    const result = processPrePush(
      '',
      {
        CLAUDECODE: '1',
        GIT_PUSH_OPTION_COUNT: '1',
        GIT_PUSH_OPTION_0: 'kaizen-force',
      },
      { queryPrState: () => mergedQuery() },
    );
    expect(result.decision.action).toBe('allow_silent');
    expect(result.decision.reason).toBe('push_option_override');
  });
});
