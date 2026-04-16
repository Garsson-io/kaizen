/**
 * prehook-no-verify.test.ts — unit tests for the --no-verify PreToolUse hook (epic #1059).
 */

import { describe, it, expect } from 'vitest';
import { analyzeCommand } from './prehook-no-verify.js';

describe('analyzeCommand', () => {
  it('allows empty command', () => {
    expect(analyzeCommand('').allow).toBe(true);
  });

  it('allows plain git push', () => {
    expect(analyzeCommand('git push').allow).toBe(true);
  });

  it('allows git push origin main', () => {
    expect(analyzeCommand('git push origin main').allow).toBe(true);
  });

  it('allows git push -n (dry run is not --no-verify)', () => {
    expect(analyzeCommand('git push -n').allow).toBe(true);
  });

  it('allows git push --dry-run', () => {
    expect(analyzeCommand('git push --dry-run').allow).toBe(true);
  });

  it('allows git push --force-with-lease', () => {
    expect(analyzeCommand('git push --force-with-lease').allow).toBe(true);
  });

  it('allows push with kaizen-force push option', () => {
    expect(analyzeCommand('git push -o kaizen-force origin main').allow).toBe(true);
  });

  it('allows unrelated commands', () => {
    expect(analyzeCommand('ls -la').allow).toBe(true);
    expect(analyzeCommand('echo no-verify').allow).toBe(true);
    expect(analyzeCommand('git status').allow).toBe(true);
  });

  it('denies git push --no-verify', () => {
    const result = analyzeCommand('git push --no-verify');
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('no_verify_flag');
    expect(result.message).toContain('kaizen-force');
  });

  it('denies git push origin main --no-verify', () => {
    expect(analyzeCommand('git push origin main --no-verify').allow).toBe(false);
  });

  it('denies git push --no-verify origin main', () => {
    expect(analyzeCommand('git push --no-verify origin main').allow).toBe(false);
  });

  it('denies even with env prefix', () => {
    // Common bypass pattern per #1057
    expect(analyzeCommand('EDITOR=vim git push --no-verify').allow).toBe(false);
  });

  it('denies in chained command (&&)', () => {
    expect(analyzeCommand('echo hi && git push --no-verify').allow).toBe(false);
  });

  it('denies in pipeline', () => {
    expect(analyzeCommand('echo foo | git push --no-verify').allow).toBe(false);
  });

  it('denies in multi-line command (newline separator)', () => {
    expect(analyzeCommand('cd /tmp\ngit push --no-verify').allow).toBe(false);
  });

  it('does not deny --no-verify in unrelated commands', () => {
    // --no-verify used in another context isn't a git push concern
    expect(analyzeCommand('some-other-tool --no-verify').allow).toBe(true);
  });

  it('does not deny if --no-verify appears as a quoted string arg', () => {
    // This is a partial false-negative — we can't tell from regex if it's quoted.
    // Acceptable: the user's intent isn't to push anyway.
    // (We match at the command level; `echo '--no-verify'` passes.)
    expect(analyzeCommand('echo "--no-verify"').allow).toBe(true);
  });

  it('deny message references docs/git-hooks-design.md', () => {
    const result = analyzeCommand('git push --no-verify');
    expect(result.message).toContain('docs/git-hooks-design.md');
  });

  it('deny message explains the escape hatch', () => {
    const result = analyzeCommand('git push --no-verify');
    expect(result.message).toContain('git push -o kaizen-force');
  });
});
