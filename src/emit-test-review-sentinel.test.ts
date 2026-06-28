import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateReviewSentinel } from './review-sentinel.js';

// The `emit-test-review-sentinel` command can write a sentinel that PASSES the
// review gate. That is exactly the fabrication a malicious/confused caller could
// use to bypass review (#1019/#1212). Its only protection is the
// KAIZEN_TEST_RUNNER guard — so prove, end-to-end, that the guard holds.
const CLI = resolve(__dirname, 'cli-structured-data.ts');
const TSX = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/55';

function run(stateDir: string, env: Record<string, string>) {
  return spawnSync(TSX, [CLI, 'emit-test-review-sentinel', '--repo', 'Garsson-io/kaizen', '--pr', '55', '--round', '1'], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: stateDir, ...env },
  });
}

describe('emit-test-review-sentinel guard (#1481/#1518 anti-bypass)', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'kf-sentinel-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('REFUSES (nonzero, writes nothing) without KAIZEN_TEST_RUNNER', () => {
    const r = run(stateDir, { KAIZEN_TEST_RUNNER: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refused/i);
    expect(readdirSync(stateDir)).toHaveLength(0); // no sentinel fabricated
  });

  it('writes a VALID signed sentinel WITH KAIZEN_TEST_RUNNER=1', () => {
    const r = run(stateDir, { KAIZEN_TEST_RUNNER: '1' });
    expect(r.status).toBe(0);
    const files = readdirSync(stateDir).filter(f => f.endsWith('.reviewed-r1'));
    expect(files).toHaveLength(1);
    const content = readFileSync(join(stateDir, files[0]), 'utf8');
    expect(validateReviewSentinel(content, { prUrl: PR_URL, round: 1 }).ok).toBe(true);
  });
  // Generous timeout: each case cold-starts tsx, which can be slow under the
  // full suite's parallel load. (#1481 spirit: no flaky tests.)
}, 60_000);
