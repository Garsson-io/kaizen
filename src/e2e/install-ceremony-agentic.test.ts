/**
 * install-ceremony-agentic.test.ts — end-to-end proof of #1093.
 *
 * Sibling to `install-flow-agentic.test.ts`. That test covers the four
 * on-disk artifacts in a bare local temp repo — it proves "the agent
 * converges on a configured working tree." This test covers the rest
 * of the ceremony that actually makes kaizen installed for the team:
 *
 *   - commit of the on-disk artifacts,
 *   - branch pushed to the host remote,
 *   - tracking issue filed on GitHub,
 *   - plan attachment stored on that issue,
 *   - PR opened with `Closes #<tracking>`.
 *
 * Per CLAUDE.md's fixture-repo policy (#778), this test runs against
 * `Garsson-io/kaizen-test-fixture` — a real GitHub repo dedicated to
 * exactly this kind of destructive E2E. Each run files + closes a
 * tracking issue and opens + closes a PR with a unique run-id branch
 * name so parallel CI jobs don't collide.
 *
 * Gated on BOTH:
 *   - KAIZEN_LIVE_TEST=1         (agentic E2E opt-in)
 *   - GH_TOKEN authed for kaizen-test-fixture with `repo` scope
 *
 * Cost: ~$3-$5 per run (three `claude -p` calls: install, setup, PR).
 *
 * Cleanup is best-effort in `afterEach`: closes the PR, closes the
 * tracking issue, deletes the remote branch, removes the local clone.
 * If a run dies mid-teardown the fixture may accumulate stale
 * closed-but-not-deleted branches — catchable with a maintenance
 * script. Open issues/PRs from failed runs will block future runs by
 * registerCeremony's idempotency check, which is the correct
 * fail-loud signal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const FIXTURE_REPO = "Garsson-io/kaizen-test-fixture";
const isLive = process.env.KAIZEN_LIVE_TEST === "1";
const hasGh = (() => {
  try {
    execFileSync("gh", ["auth", "status"], { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
})();

const PLUGIN_SOURCE = process.env.KAIZEN_E2E_PLUGIN_SOURCE ?? KAIZEN_ROOT;

interface ClaudeResult {
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
}

function runClaude(prompt: string, cwd: string, opts: { maxTurns?: number; maxBudget?: number } = {}): ClaudeResult {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", "sonnet",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 40),
    "--max-budget-usd", String(opts.maxBudget ?? 4.0),
    prompt,
  ];
  const r = spawnSync("claude", args, {
    encoding: "utf-8",
    cwd,
    timeout: 20 * 60 * 1000,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });
  if (r.error) throw new Error(`claude failed: ${r.error.message}`);
  try {
    return JSON.parse(r.stdout.trim()) as ClaudeResult;
  } catch {
    throw new Error(
      `claude output not JSON:\nstdout: ${r.stdout?.slice(0, 800)}\nstderr: ${r.stderr?.slice(0, 800)}`,
    );
  }
}

function resetKaizenInstall(): void {
  spawnSync("claude", ["plugin", "uninstall", "kaizen@kaizen"], { encoding: "utf-8", timeout: 30000 });
  spawnSync("claude", ["plugin", "marketplace", "remove", "kaizen"], { encoding: "utf-8", timeout: 30000 });
}

function cloneFixture(dir: string, branch: string): void {
  execFileSync("gh", ["repo", "clone", FIXTURE_REPO, dir, "--", "--depth", "1"], {
    encoding: "utf-8", timeout: 60000,
  });
  execFileSync("git", ["checkout", "-b", branch], { cwd: dir, encoding: "utf-8", timeout: 15000 });
}

/**
 * Safe, idempotent cleanup. Each step swallows errors — a previous
 * failure should not stop the remaining steps.
 */
function teardownFixture(opts: {
  hostRepo: string;
  branch: string;
  trackingIssueNumber?: number;
  prNumber?: number;
}): void {
  if (opts.prNumber) {
    spawnSync("gh", ["pr", "close", String(opts.prNumber), "--repo", FIXTURE_REPO, "--delete-branch"], {
      encoding: "utf-8", timeout: 30000,
    });
  }
  if (opts.trackingIssueNumber) {
    spawnSync("gh", ["issue", "close", String(opts.trackingIssueNumber), "--repo", FIXTURE_REPO], {
      encoding: "utf-8", timeout: 30000,
    });
  }
  // Belt-and-suspenders branch delete (in case --delete-branch on close
  // didn't run because the PR was never opened).
  spawnSync("git", ["push", "origin", "--delete", opts.branch], {
    cwd: opts.hostRepo, encoding: "utf-8", timeout: 30000,
  });
  if (opts.hostRepo && existsSync(opts.hostRepo)) {
    rmSync(opts.hostRepo, { recursive: true, force: true });
  }
}

describe("install-ceremony agentic E2E (#1093) — /kaizen-setup must land a full PR-ceremony install, not just working-tree artifacts", () => {
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 (and authed gh) to run the live ceremony test (~$3-5/run)", () => {});
    return;
  }
  if (!hasGh) {
    it.skip("gh must be authenticated with repo scope on kaizen-test-fixture", () => {});
    return;
  }

  let hostRepo: string;
  let branch: string;
  let trackingIssueNumber: number | undefined;
  let prNumber: number | undefined;

  beforeEach(() => {
    resetKaizenInstall();
    // Unique branch per run: run-id + pid + timestamp collide-resistance.
    const runId = process.env.GITHUB_RUN_ID ?? String(process.pid);
    const ts = Date.now().toString(36);
    branch = `e2e/install-ceremony-${runId}-${ts}`;
    hostRepo = mkdtempSync(join(tmpdir(), `kaizen-ceremony-`));
    // The mkdtemp dir is the parent; cloneFixture clones into a subdir
    // so the working tree has a clean layout.
    hostRepo = join(hostRepo, "fixture");
    cloneFixture(hostRepo, branch);
  });

  afterEach(() => {
    teardownFixture({ hostRepo, branch, trackingIssueNumber, prNumber });
    resetKaizenInstall();
    trackingIssueNumber = undefined;
    prNumber = undefined;
  });

  it(
    "full ceremony: agent lands commit + tracking issue + plan + open PR against fixture",
    { timeout: 25 * 60 * 1000 },
    () => {
      // --- install (equivalent to phase 1 of install-flow-agentic) ---
      execFileSync("claude", ["plugin", "marketplace", "add", PLUGIN_SOURCE, "--scope", "project"], {
        cwd: hostRepo, encoding: "utf-8", timeout: 60000,
      });
      execFileSync("claude", ["plugin", "install", "kaizen@kaizen", "--scope", "project"], {
        cwd: hostRepo, encoding: "utf-8", timeout: 60000,
      });

      // --- full setup + PR ceremony ---
      // Minimal-intent prompt: the agent must discover it needs a
      // worktree, tracking issue, stored plan, and PR. If the README
      // or SKILL.md drifts and buries any of these, the assertion
      // below points at which artifact the agent failed to produce.
      const result = runClaude(
        `configure this repo to use the kaizen plugin that's already installed, and open a PR with the setup changes`,
        hostRepo,
        { maxTurns: 60, maxBudget: 6.0 },
      );

      const diag = `turns=${result.num_turns} cost=$${result.total_cost_usd?.toFixed(2)} tail:\n${(result.result ?? "").slice(-1600)}`;

      expect(result.is_error, `ceremony is_error=true. ${diag}`).toBe(false);

      // --- on-disk artifacts (same as local-repo E2E) ---
      expect(existsSync(join(hostRepo, "kaizen.config.json")), `kaizen.config.json missing. ${diag}`).toBe(true);
      expect(existsSync(join(hostRepo, ".agents/kaizen/local/policies-local.md")), `policies-local.md missing. ${diag}`).toBe(true);
      const claudeMd = existsSync(join(hostRepo, "CLAUDE.md"))
        ? readFileSync(join(hostRepo, "CLAUDE.md"), "utf-8")
        : "";
      expect(claudeMd.toLowerCase().includes("kaizen"), `CLAUDE.md missing kaizen section. ${diag}`).toBe(true);

      // --- commit present on the branch ---
      const log = execFileSync("git", ["log", "--oneline", "-5"], { cwd: hostRepo, encoding: "utf-8", timeout: 10000 });
      expect(log, `no commits on branch ${branch}. ${diag}`).not.toBe("");

      // --- branch pushed ---
      let pushedBranch = "";
      try {
        pushedBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], {
          cwd: hostRepo, encoding: "utf-8", timeout: 10000,
        }).trim();
      } catch {
        /* falls through to assertion */
      }
      expect(pushedBranch, `branch not pushed (no upstream). ${diag}`).toContain(branch);

      // --- PR open against fixture with this head branch ---
      const prListOut = execFileSync(
        "gh",
        [
          "pr", "list", "--repo", FIXTURE_REPO,
          "--head", branch, "--state", "open",
          "--json", "number,title,body,state",
          "--limit", "5",
        ],
        { encoding: "utf-8", timeout: 30000 },
      );
      const prs = JSON.parse(prListOut) as Array<{ number: number; title: string; body: string; state: string }>;
      expect(prs.length, `no open PR with head=${branch}. ${diag}`).toBeGreaterThan(0);
      const pr = prs[0];
      prNumber = pr.number;

      // --- PR body closes a tracking issue ---
      const closesMatch = pr.body.match(/Closes\s+#(\d+)/i);
      expect(closesMatch, `PR body missing \`Closes #N\`. Body head:\n${pr.body.slice(0, 400)}`).toBeTruthy();
      trackingIssueNumber = closesMatch ? parseInt(closesMatch[1], 10) : undefined;

      // --- tracking issue exists and has a stored plan ---
      const issueOut = execFileSync(
        "gh",
        ["issue", "view", String(trackingIssueNumber), "--repo", FIXTURE_REPO, "--json", "number,state,title"],
        { encoding: "utf-8", timeout: 30000 },
      );
      const issue = JSON.parse(issueOut) as { number: number; state: string; title: string };
      expect(issue.state, `tracking issue #${trackingIssueNumber} is not open`).toBe("OPEN");
      expect(issue.title.toLowerCase(), `tracking issue title doesn't look like a kaizen ceremony title`)
        .toContain("kaizen");

      // retrieve-plan via the same CLI real users hit.
      const planOut = execFileSync(
        "npx",
        [
          "tsx", join(KAIZEN_ROOT, "src/cli-structured-data.ts"),
          "retrieve-plan", "--issue", String(trackingIssueNumber), "--repo", FIXTURE_REPO,
        ],
        { encoding: "utf-8", timeout: 30000 },
      );
      expect(
        planOut.trim().length,
        `no plan stored on tracking issue #${trackingIssueNumber}. retrieve-plan output:\n${planOut.slice(0, 400)}`,
      ).toBeGreaterThan(0);
    },
  );
});
