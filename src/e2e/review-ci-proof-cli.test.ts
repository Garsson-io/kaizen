/**
 * review-ci-proof-cli.test.ts — system-level E2E for the redone #1070 CI-proof
 * gate (#1225, the behavioral test PR #1212 skipped — I23).
 *
 * Spawns the REAL `store-review-summary` CLI binary with a fake `gh` on PATH and
 * asserts the actual process exit codes on the CI-gate decision boundary:
 *   - failing CI  → exit 1 (refuse, real review-blocking state)
 *   - pending CI past the wait budget → exit 2 (distinct ci_pending; NOT a FAIL) (#1221)
 *   - stale head  → exit 1 (refuse)
 * These paths exit BEFORE any storage, so the fake `gh` only needs to answer
 * `pr view` / `pr checks`. No network, deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const KAIZEN_REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_TS = path.join(KAIZEN_REPO_ROOT, 'src/cli-structured-data.ts');

function findTsx(): string | null {
  const local = path.join(KAIZEN_REPO_ROOT, 'node_modules/.bin/tsx');
  if (fs.existsSync(local)) return local;
  let dir = path.dirname(KAIZEN_REPO_ROOT);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'node_modules/.bin/tsx');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd: KAIZEN_REPO_ROOT, encoding: 'utf-8' }).trim();
    const mainTsx = path.join(path.dirname(common), 'node_modules/.bin/tsx');
    if (fs.existsSync(mainTsx)) return mainTsx;
  } catch { /* ignore */ }
  return null;
}

const TSX_BIN = findTsx();
const HEAD = 'abc123def456';

let mockBin: string;

/**
 * Write a fake `gh` that returns the reviewed HEAD for `pr view` and the given
 * checks JSON for `pr checks`. `currentHead` lets us simulate a stale head.
 */
function writeMockGh(checksJson: string, currentHead = HEAD): void {
  const content = `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '${currentHead}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  cat <<'JSON'
${checksJson}
JSON
  exit 0
fi
exit 1
`;
  const ghPath = path.join(mockBin, 'gh');
  fs.writeFileSync(ghPath, content);
  fs.chmodSync(ghPath, 0o755);
}

function runStoreSummary(extraArgs: string[]): { code: number; stderr: string } {
  if (!TSX_BIN) throw new Error('tsx not found — cannot run E2E test');
  const result = spawnSync(
    TSX_BIN,
    [CLI_TS, 'store-review-summary', '--pr', '903', '--repo', 'Garsson-io/kaizen', '--round', '5', '--head-sha', HEAD, ...extraArgs],
    {
      cwd: KAIZEN_REPO_ROOT,
      env: { ...process.env, PATH: `${mockBin}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8',
    },
  );
  return { code: result.status ?? -1, stderr: result.stderr ?? '' };
}

const failChecks = JSON.stringify([{ name: 'TypeScript tests + coverage', bucket: 'fail', state: 'FAILURE' }]);
const pendingChecks = JSON.stringify([{ name: 'TypeScript tests + coverage', bucket: 'pending', state: 'IN_PROGRESS' }]);
const passChecks = JSON.stringify([{ name: 'TypeScript tests + coverage', bucket: 'pass', state: 'SUCCESS' }]);

const maybe = TSX_BIN ? describe : describe.skip;

maybe('store-review-summary CI gate — real CLI exit codes (#1070/#1225, I23)', () => {
  beforeEach(() => { mockBin = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-ciproof-')); });
  afterEach(() => { fs.rmSync(mockBin, { recursive: true, force: true }); });

  it('exits 1 (refuse) when CI is failing for the reviewed head', () => {
    writeMockGh(failChecks);
    const { code, stderr } = runStoreSummary([]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to store a PASS summary/i);
  });

  it('exits 2 with a distinct ci_pending message when CI never finishes (#1221)', () => {
    writeMockGh(pendingChecks);
    // timeout 0 → evaluate once, see pending, return immediately (no real wait).
    const { code, stderr } = runStoreSummary(['--ci-timeout-sec', '0']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/ci_pending/);
    expect(stderr).toMatch(/NOT a review FAIL/i);
  });

  it('exits 1 (refuse) when the PR head has moved past the reviewed head (stale)', () => {
    writeMockGh(passChecks, 'different-head-sha');
    const { code, stderr } = runStoreSummary([]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Reviewed .* but PR .* is currently/i);
  });
});
