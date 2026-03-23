/**
 * issue-routing.test.ts — E2E test for issue repo routing.
 *
 * Verifies that kaizen skills query the CORRECT GitHub repo for issues
 * based on kaizen.config.json. This is a LIVE test that hits the GitHub API.
 *
 * Two scenarios:
 *   1. Self-dogfood (kaizen repo): ISSUES_REPO == KAIZEN_REPO
 *   2. Host project (langsmith-cli): ISSUES_REPO == HOST_REPO (not KAIZEN_REPO)
 *
 * Run with: npx vitest run src/e2e/issue-routing.test.ts
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const HOST_PROJECT = "/home/aviadr1/projects/langsmith-cli";

// Read kaizen.config.json and compute ISSUES_REPO / ISSUES_LABEL
// This is the exact logic from skill-config-header.md
function computeIssueRouting(configPath: string): {
  kaizenRepo: string;
  hostRepo: string;
  issuesRepo: string;
  issuesLabel: string;
} {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);
  const kaizenRepo: string = config.kaizen.repo;
  const hostRepo: string = config.host.repo;

  if (kaizenRepo === hostRepo) {
    return { kaizenRepo, hostRepo, issuesRepo: kaizenRepo, issuesLabel: "" };
  }
  return {
    kaizenRepo,
    hostRepo,
    issuesRepo: hostRepo,
    issuesLabel: "--label kaizen",
  };
}

// Run gh issue list and return parsed JSON
function ghIssueList(
  repo: string,
  opts: { labels?: string[]; limit?: number; state?: string } = {},
): Array<{ number: number; title: string; url: string; labels: Array<{ name: string }> }> {
  const args = ["gh", "issue", "list", "--repo", repo, "--json", "number,title,url,labels"];
  args.push("--limit", String(opts.limit ?? 5));
  args.push("--state", opts.state ?? "open");
  for (const label of opts.labels ?? []) {
    args.push("--label", label);
  }

  const result = execSync(args.join(" "), {
    encoding: "utf-8",
    timeout: 15000,
  });
  return JSON.parse(result.trim());
}

// Verify an issue URL belongs to the expected repo
function issueUrlMatchesRepo(url: string, repo: string): boolean {
  // GitHub issue URLs look like: https://github.com/owner/repo/issues/123
  return url.includes(`github.com/${repo}/issues/`);
}

describe("Issue Routing — Self-Dogfood (kaizen repo)", () => {
  const configPath = resolve(KAIZEN_ROOT, "kaizen.config.json");

  it("kaizen.config.json exists", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it("routes to KAIZEN_REPO when host == kaizen (self-dogfood)", () => {
    const routing = computeIssueRouting(configPath);
    expect(routing.kaizenRepo).toBe(routing.hostRepo); // self-dogfood
    expect(routing.issuesRepo).toBe(routing.kaizenRepo);
    expect(routing.issuesLabel).toBe("");
  });

  it("gh issue list returns issues from kaizen repo", { timeout: 20000 }, () => {
    const routing = computeIssueRouting(configPath);
    const issues = ghIssueList(routing.issuesRepo, { limit: 3 });
    expect(issues.length).toBeGreaterThan(0);

    // Every issue URL must point to the kaizen repo
    for (const issue of issues) {
      expect(
        issueUrlMatchesRepo(issue.url, routing.kaizenRepo),
        `Issue #${issue.number} URL ${issue.url} doesn't match repo ${routing.kaizenRepo}`,
      ).toBe(true);
    }
  });
});

describe("Issue Routing — Host Project (langsmith-cli)", () => {
  const configPath = resolve(HOST_PROJECT, "kaizen.config.json");
  const hostExists = existsSync(configPath);

  if (!hostExists) {
    it.skip("langsmith-cli not found — skipping host project tests", () => {});
    return;
  }

  it("kaizen.config.json exists in host project", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it("host repo differs from kaizen repo", () => {
    const routing = computeIssueRouting(configPath);
    expect(routing.kaizenRepo).not.toBe(routing.hostRepo);
    expect(routing.kaizenRepo).toBe("Garsson-io/kaizen");
    expect(routing.hostRepo).toBe("gigaverse-app/langsmith-cli");
  });

  it("routes to HOST_REPO with kaizen label filter", () => {
    const routing = computeIssueRouting(configPath);
    expect(routing.issuesRepo).toBe(routing.hostRepo);
    expect(routing.issuesRepo).not.toBe(routing.kaizenRepo);
    expect(routing.issuesLabel).toBe("--label kaizen");
  });

  it("gh issue list hits host repo, NOT kaizen repo", { timeout: 20000 }, () => {
    const routing = computeIssueRouting(configPath);

    // Query the ISSUES_REPO (should be host repo)
    // This may return 0 results if no issues exist yet — that's fine,
    // the important thing is that gh doesn't error and the repo is correct
    let issues: Array<{ number: number; title: string; url: string }>;
    try {
      issues = ghIssueList(routing.issuesRepo, { limit: 5 });
    } catch (e: unknown) {
      // If the repo has no issues or is empty, gh returns [] not an error
      // A real error (wrong repo, no access) would throw
      throw new Error(
        `gh issue list failed for ${routing.issuesRepo} — ` +
        `this is the bug: skills would query the wrong repo. Error: ${e}`,
      );
    }

    // If there are issues, verify they come from the host repo, not kaizen
    for (const issue of issues) {
      expect(
        issueUrlMatchesRepo(issue.url, routing.hostRepo),
        `Issue #${issue.number} URL ${issue.url} should be from ${routing.hostRepo}, not ${routing.kaizenRepo}`,
      ).toBe(true);

      // Negative check: should NOT be a kaizen repo issue
      expect(
        issueUrlMatchesRepo(issue.url, routing.kaizenRepo),
        `Issue #${issue.number} URL ${issue.url} is from kaizen repo — routing is WRONG`,
      ).toBe(false);
    }
  });

  it("OLD routing (bug) would have queried kaizen repo instead", { timeout: 20000 }, () => {
    // Demonstrate the bug: the old code used $KAIZEN_REPO for everything
    const routing = computeIssueRouting(configPath);
    const kaizenIssues = ghIssueList(routing.kaizenRepo, { limit: 3 });
    const hostIssues = ghIssueList(routing.issuesRepo, { limit: 3 });

    // Kaizen repo has issues (it's an active project)
    expect(kaizenIssues.length).toBeGreaterThan(0);

    // Verify kaizen issues come from kaizen repo (not host)
    for (const issue of kaizenIssues) {
      expect(issueUrlMatchesRepo(issue.url, routing.kaizenRepo)).toBe(true);
      // These are NOT host project issues — the old code served these to the host
      expect(issueUrlMatchesRepo(issue.url, routing.hostRepo)).toBe(false);
    }

    // If host has issues, they should be different from kaizen issues
    if (hostIssues.length > 0) {
      const kaizenNumbers = new Set(kaizenIssues.map((i) => i.number));
      const hostNumbers = new Set(hostIssues.map((i) => i.number));
      // Different repos, different issue number spaces
      // (could overlap by coincidence, but URLs definitely differ)
      for (const issue of hostIssues) {
        expect(issueUrlMatchesRepo(issue.url, routing.hostRepo)).toBe(true);
      }
    }
  });
});
