---
name: kaizen-write-pr
description: Write a rich PR description using the Story Spine narrative arc. Takes a branch with commits and produces a PR body that tells the story — problem, discovery, solution, evidence, impact. Triggers on "write pr", "pr description", "pr body", "describe this pr", "write pr description", "story spine". Also triggered by kaizen-implement task #7 when creating a PR.
user_invocable: true
---

# Write PR Description — Story Spine Narrative

Write a PR description that a reviewer can understand **without reading the diff**. The diff is proof — the description is the argument.

**When to use:**
- Creating a PR (`gh pr create`) — write the body before creating
- Improving an existing PR description (`gh pr edit`)
- Called from `/kaizen-implement` task #7

## The Story Spine

Adapted from Pixar's storytelling structure for technical context. The "Man in Hole" narrative arc — character faces trouble, struggles, finds resolution, ends better off — is the most commercially successful story shape (Kurt Vonnegut). It works for PRs because reviewers are humans who follow narratives, not feature lists.

### The Arc

| Beat | Purpose | PR Translation |
|------|---------|---------------|
| **Once upon a time...** | Establish the world | What system existed? What was it doing? Set the scene. |
| **Every day...** | Show the routine | What was the status quo? What metrics said things were fine? |
| **One day...** | The inciting incident | What discovery or incident revealed the problem? Be concrete — name the PR, issue, failure, date. |
| **Because of that...** | Rising action | What did you build? Show real output — actual findings, error messages, before/after data. Not "we added a feature" but "here's what it produces." |
| **Because of that...** | Deepening consequences | What did testing/validation reveal? Empirical results, not claims. |
| **Until finally...** | Climax and proof | What's the concrete evidence it works? Link to artifacts — test results, follow-up PRs, validation data. |
| **And ever since...** | The new world | How is the world different now? What's changed for the next person? |

### After the narrative

Follow the story with structured sections:

1. **Architecture** — diagram, data flow, or component map. ASCII art is fine.
2. **Design decisions** — table with columns: Decision | Why | Tradeoff. Every non-obvious choice gets a row.
3. **What's in this PR** — file table with purpose column. Helps reviewers prioritize what to read.
4. **Validation** — checked boxes with specifics. Not "tests pass" but "18 vitest tests pass, E2E against PR #832 catches zero-adoption gap."
5. **Known limitations** — honest, with next steps. Reviewers trust PRs that name their own weaknesses.

## Process

1. **Read the commits**: `git log main..HEAD --oneline` — understand what was built
2. **Read the diff**: `git diff main..HEAD --stat` — understand the scope
3. **Read the linked issue**: `gh issue view <N>` — understand the motivation
4. **Find the inciting incident**: What specific failure, discovery, or user request triggered this work? If you can't name it, the PR may be solving a theoretical problem.
5. **Gather evidence**: Test results, cost data, performance numbers, real output. The "Because of that" beats need concrete data, not assertions.
6. **Write the narrative first**, then the structured sections. The story is the skeleton — the sections are the flesh.

## Examples of each beat

### Good "Once upon a time"
> The jolly-marsupial auto-dent batch ran 36 sessions overnight. It produced 25 PRs, closed 8 issues, and cost $61.47. Every PR went through 4 rounds of code self-review.

*Sets the scene with specifics. The reader knows the scale and context.*

### Bad "Once upon a time"
> We have a system that creates PRs automatically.

*Too vague. No stakes, no specifics.*

### Good "One day"
> We looked at PR #832 and realized it closed #666 but 0 of the 16 existing SKILL.md files were updated to use the new schema. The code is correct. The issue is not solved.

*Names the specific PR, the specific gap, the specific count. The reader feels the problem.*

### Bad "One day"
> We noticed some PRs had gaps in their requirements coverage.

*Too abstract. "Some PRs" and "gaps" give the reader nothing to hold onto.*

### Good "Because of that" (with evidence)
> We validated on 5 real PRs: 27 findings, 0 false positives, $0.57 total. Here's what a review looks like:
> ```
> DONE:    Both failing tests pass reliably in CI
> PARTIAL: Root cause identified (was this a regression?)
> MISSING: Fix underlying slowness rather than increasing timeout
> ```

*Shows actual output. The reader can evaluate the tool's judgment.*

### Good "Until finally" (with proof)
> The fix session created branch `fix/790-review-gaps`, added a CI lint test, and created PR #847 autonomously. That PR exists right now.

*Links to a real artifact. The proof is clickable.*

## Anti-patterns

- **Feature list PR**: "Added X, changed Y, updated Z." No narrative, no motivation, no evidence. The reviewer must reverse-engineer the "why" from the diff.
- **Wall of text**: Narrative without structure. No tables, no diagrams, no checkboxes. Hard to scan, hard to review.
- **Claims without evidence**: "This improves quality." How? By how much? Measured how? Show the data.
- **Hiding limitations**: Pretending the solution is complete when it has known gaps. Name them — reviewers trust honest PRs.
- **Over-specification**: Including every implementation detail in the description. The description is for understanding; the diff is for details.

## Scaling guidance

| PR size | Narrative depth | Structured sections |
|---------|----------------|-------------------|
| Tiny (< 20 lines) | 2-3 sentences covering One day + Because of that | File table + validation only |
| Small (20-100 lines) | Short narrative, skip "Every day" if obvious | All sections, brief |
| Medium (100-500 lines) | Full story spine | All sections, detailed |
| Large (500+ lines) | Full story spine + "why this isn't split" | All sections + architecture diagram mandatory |

## References

These sources informed this skill's design:

- **Story Spine**: [Writing technical blog posts with the story spine](https://www.useanvil.com/blog/engineering/writing-technical-blog-posts-with-the-story-spine/) — Anvil's adaptation of Pixar's 8-step narrative structure for engineering content. The "Man in Hole" arc applied to technical writing.
- **dbt Labs PR Template**: [The Exact GitHub PR Template We Use at dbt Labs](https://docs.getdbt.com/blog/analytics-pull-request-template) — 6-section template emphasizing Description & Motivation, Validation of Models, and a Launch Checklist. Key insight: "the description should allow the reviewer to quickly understand the reason for opening this PR."
- **Microsoft Engineering Playbook**: [Pull Request Template](https://microsoft.github.io/code-with-engineering-playbook/code-reviews/pull-request-template/) — Structured template with breaking changes declaration, testing evidence, and relevant logs/screenshots.
- **HackerOne/PullRequest.com**: [Writing A Great Pull Request Description](https://www.pullrequest.com/blog/writing-a-great-pull-request-description/) — Emphasizes explaining the chosen approach AND alternatives considered.
- **Graphite**: [Best practices for GitHub PR descriptions](https://www.graphite.com/guides/github-pr-description-best-practices) — "A clean, easy to understand synopsis... explicit prose on your net change."
- **Pixar Story Spine origin**: [Pixar's 4th Rule of Storytelling](https://www.aerogrammestudio.com/2013/03/22/the-story-spine-pixars-4th-rule-of-storytelling/) — The original improv exercise adapted by Pixar for story development.

## Recursive kaizen

This skill should improve over time. When a PR description gets praised or criticized, update the examples and anti-patterns here. When a new narrative pattern works well, add it. The skill is a living document — not a frozen template.
