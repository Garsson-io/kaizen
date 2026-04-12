---
name: kaizen-gaps
description: Systematic analysis of kaizen issues and incidents to find tooling gaps, testing gaps, horizon concentration, and unnamed dimensions. Produces prioritized lists for filing kaizens, writing feature PRDs, and writing meta/horizon PRDs. Triggers on "gap analysis", "analyze gaps", "what gaps do we have", "tooling gaps", "testing gaps", "horizon analysis", "where are problems concentrated".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Gap Analysis — Strategic Kaizen Intelligence

**Role:** The strategist. Looks across the entire kaizen backlog and incident history to find patterns, gaps, and unnamed dimensions that individual issue triage misses. Produces actionable output that feeds into `/kaizen-pick`, `/kaizen-prd`, and `/kaizen-reflect`.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"A good taxonomy of the problem outlasts any solution"* and *"The horizon you can't name climbs you."*

**When to use:**
- Periodic strategic review of the kaizen system
- Before planning a sprint or large body of work
- After a cluster of incidents suggests a systemic pattern
- When asking "where should we invest next?" at the meta level
- When the user asks about gaps, concentration, or unnamed horizons

## The Process

This is a multi-phase analysis. Each phase produces a concrete artifact. The skill is designed to run with parallel research agents for speed.

### Phase 1: Gather the Landscape

Launch **two parallel research agents** to collect raw data:

**Agent A — Issues & Structure:**
```bash
# All open kaizen issues with full context
gh issue list --repo "$ISSUES_REPO" --state open --limit 100 --json number,title,labels,body,createdAt,updatedAt,comments

# Recently closed issues (last 20) for pattern detection
gh issue list --repo "$ISSUES_REPO" --state closed --limit 20 --json number,title,labels,closedAt,body

# Active cases and their linked issues (via domain model CLI, not raw SQL)
$KAIZEN_CLI case-list --status suggested,backlog,active,blocked
```

Also read:
- Existing horizon taxonomies: `docs/horizons/` directory and any `horizon.md` files
- The kaizen system docs: `.claude/kaizen/` directory
- The enforcement level framework in the kaizen SKILL.md

**Agent B — Incidents & Friction:**
```bash
# Issues with incident comments (search for "incident", "broke", "failed", "manual fix")
gh issue list --repo "$ISSUES_REPO" --state open --limit 100 --json number,title,body,comments --jq '.[] | select(.body + (.comments | map(.body) | join(" ")) | test("incident|broke|failed|manual fix|production|hotfix"; "i"))'
```

Also search for:
- Hook enforcement gaps: `.claude/kaizen/hooks/` and what they cover vs what they don't
- Test coverage: what's tested, what critical paths have zero coverage
- CI pipeline: what checks exist, what's missing

### Phase 1.5: Cluster by Shared Root Cause (kaizen #207)

Before classifying gaps, **cluster the open issues by shared root cause**. Individual issues are symptoms; clusters reveal categories.

**How to cluster:**
1. For each open issue, write a one-line root cause hypothesis (not the symptom — the underlying reason)
2. Group issues whose root causes share a common theme
3. Name each cluster (e.g., "format contracts missing", "stale cache assumptions", "skill files lack meta-cognitive checkpoints")
4. Count the cluster size — clusters of 3+ are high-value targets for `/kaizen-deep-dive`

**Output format:**
```
Root cause cluster                    | Issues        | Size | Compound fix?
--------------------------------------|---------------|------|-------------
Format contracts missing between hooks | #163,#125,#239|   3  | Yes — add format specs
Skill files lack verification prompts  | #212,#257,#260|   3  | Yes — add checkpoints
Worktree state assumed but not checked | #233,#232,#196|   3  | Yes — add guards
```

Clusters feed directly into the "Low-Hanging Fruit" and "Feature PRD Candidates" lists in Phase 5. A cluster with a compound fix is worth more than the sum of its individual issues.

### Phase 1.7: Hypothesis Validation (kaizen #948)

Before classifying gaps, **validate each cluster as a hypothesis**. A cluster derived from issue-title pattern-matching is a guess, not a finding. Nothing enters the actionable lists as "low-hanging fruit" until it is either proven or explicitly flagged as speculation.

**For each root-cause cluster from Phase 1.5:**

1. **State the hypothesis explicitly:**
   > "We believe [X] is true because we observe [Y]."

2. **Design the minimal test** — the fastest thing that would confirm or falsify it:
   - Grep the codebase for the claimed pattern
   - Read the relevant file/hook/skill to confirm the gap exists
   - Run a command that would fail if the problem were absent
   - Check git log for recent commits that may have already fixed it

3. **Run the test or defer with a reason:**
   - If run: record the evidence ("confirmed — found X at file:line" or "refuted — Y is already handled at Z")
   - If deferred: state why ("requires running claude -p, too slow for this session") and mark as `[HYPOTHESIS]`

4. **Tag every item** in the actionable lists:
   - `[PROVEN]` — hypothesis tested, concrete evidence gathered
   - `[HYPOTHESIS]` — not yet tested, test described, treat as speculation

**Rule:** Nothing ships as "low-hanging fruit" tagged `[HYPOTHESIS]`. Hypothesis items belong in a separate "Unvalidated — needs testing first" section, not the actionable lists.

**Dual failure mode check:**
- If absent: actionable lists contain guesses formatted as findings — agents act on speculation
- If present: analysis takes slightly longer, some real gaps get deferred — acceptable trade-off

### Phase 2: Classify Gaps

Organize findings into three categories:

#### A. Testing Gaps

For each untested critical path, record:

| Component | LOC | What's at risk | Related kaizen # | Severity |
|-----------|-----|---------------|-----------------|----------|
| ... | ... | ... | ... | Critical/High/Medium |

**Key questions:**
- Which components have zero test coverage?
- Which tests exercise mocks but never the real artifact? (fidelity gap)
- Which integration paths are tested in isolation but never end-to-end?
- Is there source-to-artifact drift (source fixed but dist/ stale)?

#### B. Tooling Gaps

For each missing tool/check/enforcement:

| Gap | Level | Kaizen # | Impact | Effort |
|-----|-------|----------|--------|--------|
| ... | L1-L3 | ... | ... | Low/Med/High |

**Key questions:**
- What L1 instructions have failed and need L2+ escalation?
- What enforcement hooks are missing or have false positive/negative issues?
- What MCP tools need policy enforcement added?
- What CI checks are missing?

#### C. Taxonomy & Horizon Gaps

**Key questions:**
- Are problems concentrated in specific horizons?
- Does each horizon have a clear taxonomy with levels/dimensions?
- Are there clusters of issues that don't fit any existing horizon?
- Is there an unnamed dimension where incidents keep recurring?

### Phase 2.5: Meta-Finding Aggregation (kaizen #245)

Scan recent PR bodies for `KAIZEN_IMPEDIMENTS` declarations and aggregate patterns across sessions. This is what makes the recursion real — individual reflections produce findings; aggregation produces insight.

**Data collection:**
```bash
# Get recent merged PRs with kaizen impediments
gh pr list --repo "$HOST_REPO" --state merged --limit 20 --json number,title,body,mergedAt \
  --jq '.[] | select(.body | test("KAIZEN_IMPEDIMENTS")) | {number, title, mergedAt, body}'
```

Use `/kaizen-sections` to read specific sections from PR bodies efficiently: `npx tsx src/cli-section-editor.ts read-section --pr {N} --repo "$HOST_REPO" --name "Known limitations"` — avoids reading the entire PR body.

**Extract and classify findings from each PR body:**
- Parse the `KAIZEN_IMPEDIMENTS` JSON block from each PR
- Separate by `type`: `"meta"` (system improvements), `"positive"` (what worked), standard (work impediments)
- Group by `disposition`: `"filed"` (with issue ref), `"fixed-in-pr"`, `"incident"`, `"no-action"` (positive findings)

**Aggregate and report:**

| Question | What to look for |
|----------|-----------------|
| Which skills were praised? | `type: "positive"` findings — what's working well |
| Which skills were criticized? | `type: "meta"` findings with `disposition: "filed"` — what needs fixing |
| What friction keeps recurring? | Same impediment appearing across 2+ PRs despite fixes |
| Are positive-reclassifications masking real issues? | `type: "positive"` with `"no-action"` on the same category across multiple PRs |

**Output format:**
```
Meta-finding pattern               | Occurrences | Status
-----------------------------------|-------------|--------
Stale issue recommendations        |     3/10    | Filed as #243
Reflection questions too abstract  |     2/10    | Filed as #246
Accept-case heavyweight for specs  |     4/10    | Open — needs attention
```

If a pattern appears in 3+ of the last 10 PRs, it should be flagged as a **systemic friction** that warrants its own kaizen issue if not already filed.

### Phase 2.7: Failure Mode Analysis (kaizen #441 — autoresearch methodology)

Classify closed issues and recent PRs by the **failure mode taxonomy** (FM1-FM7). This is the autoresearch approach from #334: form a hypothesis about what breaks, test whether we can detect it, measure detection rate.

**The taxonomy** (from epic #441):

| FM | Name | Signal in issues/PRs |
|----|------|---------------------|
| FM1 | DRY Violation | Issue mentions "copy-paste", "duplicate", "extract helper"; PR has jscpd warnings |
| FM2 | Multi-PR Fix Cycle | 3+ PRs for same feature/case within hours; "fix:" titles referencing same area |
| FM3 | Reflection Gaming | Issue mentions "waived", "no-action", "gate"; reflection quality is low |
| FM4 | Scope Cut Testability | Issue mentions "deferred tests", "E2E later", "scope creep"; source without tests |
| FM5 | Env Assumption | Issue mentions "CWD", "worktree", "CI fails", "hardcoded path" |
| FM6 | Stale Reference | Issue mentions "old name", "renamed", "migration"; 24+ stale references found |
| FM7 | Squash Data Loss | Issue mentions "squash", "dropped files", "missing from merge" |

**Step 1: Classify recent closed issues**

```bash
# Recent closed issues
gh issue list --repo "$ISSUES_REPO" --state closed --limit 30 \
  --json number,title,labels,body,closedAt
```

For each closed issue, assign FM tags based on title/body keywords. Report:

```
FM  | Issues           | Recent trend | Detection exists?
----|------------------|-------------|------------------
FM1 | #430, #365, #209 | stable      | Yes (jscpd hook + src/analysis/diff-checks.ts)
FM2 | #400             | decreasing  | Yes (src/analysis/pr-pattern-checks.ts)
FM3 | #388, #280, #258 | stable      | Yes (src/analysis/reflection-checks.ts)
FM5 | #232, #219       | decreasing  | Yes (src/analysis/diff-checks.ts)
FM6 | #413             | decreasing  | Yes (src/analysis/diff-checks.ts)
```

**Step 2: Run synthetic scenarios** (if detectors are available)

The `src/analysis/` module provides deterministic detectors. Run the synthetic test suite to measure current detection effectiveness:

```bash
npx vitest run src/analysis/ --reporter=verbose 2>&1 | tail -20
```

Report the detection rate per FM and any failed scenarios. A failed scenario means a known-bad pattern isn't being caught — high-priority improvement target.

**Step 3: Classify recent merged PRs by failure mode**

```bash
# Recent merged PRs
gh pr list --repo "$HOST_REPO" --state merged --limit 20 \
  --json number,title,mergedAt,additions,deletions,changedFiles
```

For each PR, check: did it introduce or fix a failure mode? Was it itself a multi-PR fix cycle member? This produces the "live validation" layer — do detectors catch real incidents, not just synthetic ones?

**Output:** Add an FM concentration table to the Phase 5 report. High-concentration FMs with low detection rates are priority targets for new detectors or detector improvements.

### Phase 3: Analyze Concentration

For each existing horizon, count:
- Open issues assigned to it
- Incidents (concrete failures) within it
- Active work in progress

Present this as a concentration map:

```
Horizon              | Open | Incidents | Active | Assessment
---------------------|------|-----------|--------|------------
Testability          |   N  |     N     |   N    | Over/Under/Balanced
Autonomous Kaizen    |   N  |     N     |   N    | ...
Security             |   N  |     N     |   N    | ...
...                  |      |           |        |
```

Look for:
- **Over-concentrated:** Many issues, few incidents — may be over-engineering
- **Under-concentrated:** Few issues, many incidents — blind spot
- **Orphaned incidents:** Incidents that don't map to any horizon — signal of an unnamed dimension

### Phase 4: Identify Unnamed Dimensions

This is the most valuable part. Look for:

1. **Incident clusters that don't fit existing horizons** — If 3+ incidents share a root cause pattern that no horizon tracks, name it.

2. **Missing axes on existing horizons** — A horizon may track one dimension (e.g., test depth) but miss another (e.g., test fidelity). The signal: issues that belong to the horizon but the taxonomy can't express.

3. **Cross-horizon dependencies** — "X can't improve until Y reaches level N." These implicit dependencies should be made explicit.

For each candidate unnamed dimension, evaluate:
- Is this truly a new horizon (infinite game, fundamental quality dimension)?
- Or is it a missing axis on an existing horizon?
- Or is it actually a feature (finite, has a definition of done)?

### Phase 5: Produce Actionable Output

Organize all findings into three prioritized lists:

#### List 1: Low-Hanging Fruit (file as kaizen issues)

Issues that are:
- Small scope (hours, not days)
- Clear fix (no architectural decisions needed)
- High incident count relative to fix effort
- L1 to L2 escalations where the L1 already failed

**MANDATORY: Verify each recommendation against git log before declaring it low-hanging fruit.** The issue tracker is a lagging indicator — code is the truth. For each candidate:

```bash
# Check if recent commits reference this issue
git log --oneline --all --grep="kaizen #NNN" --since="2 weeks ago" | head -5
# Check if any merged PRs reference it
gh pr list --repo "$HOST_REPO" --state merged --search "kaizen #NNN" --limit 3
```

If matches found, flag the issue as: **"Possibly already addressed — verify before starting. Recent: [commit/PR references]"** and move it to a separate "needs verification" list rather than recommending it as ready work.

**Tag requirement (from Phase 1.7):** Every item in List 1 must be tagged `[PROVEN]` (hypothesis tested) or `[HYPOTHESIS]` (not yet tested). Items tagged `[HYPOTHESIS]` go into a separate "Unvalidated — needs testing first" section, NOT into the main low-hanging fruit list.

Format each verified issue as a ready-to-file kaizen issue with: title, body (what/why/how), labels.

#### List 2: Feature PRD Candidates

Work items that are:
- Concrete features with a definition of done
- Too large for a single issue but not epic-sized
- Clear enough to spec without major discovery

Format each as: title, one-paragraph summary, estimated scope (S/M/L), blocking dependencies.

#### List 3: Meta/Horizon PRD Candidates

Work items that are:
- New horizons or horizon taxonomy updates
- Cross-cutting architectural changes
- Process/system redesigns
- Foundational infrastructure (like incident data layer)

Format each as: title, one-paragraph summary, what it enables (downstream value), why now.

### Phase 6: Present to Admin

Present the full analysis in a structured format:

1. **Executive summary** — 3-5 sentences on the biggest findings
2. **Meta-finding patterns** — recurring friction across recent reflections (Phase 2.5)
3. **Concentration map** — where problems cluster
4. **Critical gaps table** — testing and tooling gaps ranked by severity
5. **Unnamed dimensions** — what's climbing you that you haven't named
6. **Recommended priority** — immediate / next sprint / foundational
7. **Three actionable lists** — low-hanging fruit (verified against git log), feature PRDs, meta PRDs

Ask the admin:
- Do these findings match your intuition? What's surprising?
- Which list should we act on first?
- Any gaps I missed that you've felt but not articulated?

## After the Analysis

The output of this skill feeds into:
- **Low-hanging fruit** — file as kaizen issues, then `/kaizen-pick` to start executing
- **Feature PRDs** — `/kaizen-prd` for each, producing specs and tracking issues
- **Meta/Horizon PRDs** — `/kaizen-prd` (horizon mode) for taxonomy updates

This skill should be run periodically (every 2-4 weeks or after a burst of incidents) to keep the strategic view fresh.

## Integration with the Dev Work Skill Chain

```
/kaizen-gaps  (strategic: where should we invest?)
    ↓
  Low-hanging fruit → file kaizen issues → /kaizen-pick → /kaizen-evaluate → /kaizen-implement
  Feature PRDs → /kaizen-prd → /kaizen-plan → /kaizen-implement
  Meta PRDs → /kaizen-prd (horizon mode) → /kaizen-plan → /kaizen-implement
    ↓
/kaizen  (reflect on the work, close the loop)
```

`/kaizen-gaps` sits ABOVE `/kaizen-pick` in the skill chain — it's the strategic layer that decides WHERE to invest before `/kaizen-pick` decides WHICH specific issue to tackle.

## Anti-patterns

- **Analysis paralysis** — Don't spend days analyzing. The goal is actionable lists, not a perfect taxonomy. Ship the analysis, iterate.
- **Counting without reasoning** — Raw issue counts mean nothing. A horizon with 2 issues and 5 incidents is more important than one with 10 issues and 0 incidents.
- **Ignoring the unnamed** — The most valuable output is often the unnamed dimension. Don't force-fit everything into existing categories.
- **Skipping incidents** — Issues are hypotheses. Incidents are data. Always weight incidents higher than issue counts.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Gather landscape (parallel agents) | Agent A: issues + structure. Agent B: incidents + friction. |
| 2 | Cluster by root cause | Group issues with common roots. Identify clusters of 3+ (high-value for deep-dive). |
| 2.7 | Validate hypotheses (Phase 1.7) | For each cluster: state hypothesis, design test, run or defer, tag as [PROVEN] or [HYPOTHESIS]. |
| 3 | Classify gaps | Testing gaps, tooling gaps, taxonomy/horizon gaps. Failure mode analysis (FM1-FM12). |
| 4 | Analyze concentration | Per-horizon: open issues, incidents, active work. Over/under-concentrated, orphaned. |
| 5 | Identify unnamed dimensions | Incident clusters not in existing horizons. Missing axes. Evaluate: new horizon vs axis vs feature. |
| 6 | Present actionable output | 3 lists: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates. Present to admin. |

**What comes next:** Low-hanging fruit → file issues → `/kaizen-pick`. Feature PRDs → `/kaizen-prd`. Meta/horizon PRDs → `/kaizen-prd` in horizon mode. See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.
