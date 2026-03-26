---
name: kaizen-dimensions
description: List, inspect, and manage review battery dimensions. Shows what dimensions exist, what they check, and how to add new ones. Triggers on "dimensions", "review dimensions", "list dimensions", "add dimension", "what dimensions", "show dimension".
user_invocable: true
---

# Review Dimensions — Discover, Inspect, Manage

Review dimensions are the adversarial checks that run against PRs and plans. Each dimension is a `prompts/review-*.md` file with YAML frontmatter. Adding a file adds a dimension — no code changes needed.

**When to use:**
- "What dimensions does the review battery check?"
- "Show me the requirements dimension"
- "Add a new dimension for security review"
- "What will my PR be reviewed on?"

## Quick Reference

Use the CLI tool for all operations:

```bash
# List all dimensions with descriptions
npx tsx src/cli-dimensions.ts list

# Show the full prompt for a dimension
npx tsx src/cli-dimensions.ts show requirements

# Show multiple dimensions
npx tsx src/cli-dimensions.ts show requirements pr-description

# Add a new dimension (scaffolds the file)
npx tsx src/cli-dimensions.ts add security --description "OWASP top 10, shell injection, secrets in code" --applies-to pr

# Validate all dimension files have correct frontmatter
npx tsx src/cli-dimensions.ts validate
```

## How Dimensions Work

Each dimension is a file at `prompts/review-<name>.md` with:

```yaml
---
name: <dimension-name>
description: <one-line TLDR — what this dimension checks>
applies_to: pr | plan | both
---
```

The body is an adversarial review prompt that:
1. Reads the issue/PR context
2. Evaluates specific criteria
3. Outputs structured JSON: `{ dimension, summary, findings: [{ requirement, status, detail }] }`

Status values: `DONE` (addressed), `PARTIAL` (gaps remain), `MISSING` (not addressed).

## Where Dimensions Are Used

| Consumer | Which dimensions | When |
|----------|-----------------|------|
| `auto-dent-run.ts` | All where `applies_to != plan` | After each run produces a PR (advisory) |
| `review-fix.ts` | All where `applies_to != plan` | CLI review→fix cycle |
| `kaizen-evaluate` Phase 5.5 | `plan-coverage` | After formulating a plan |
| `kaizen-implement` Step 5b | `requirements` | Before merge |
| `kaizen-review-pr` Phase 2 | All (data-driven table) | During self-review |

Consumers call `listDimensions()` or `loadDimensionMetas()` from `src/review-battery.ts` to discover what's available. No hardcoding.

## Adding a New Dimension

1. **Scaffold**: `npx tsx src/cli-dimensions.ts add <name> --description "..." --applies-to pr`
2. **Edit** the generated `prompts/review-<name>.md` — add your specific criteria and instructions
3. **Test**: `npx tsx scripts/review-fix.ts --pr <known-pr> --issue <N> --repo <repo> --dry-run` — verify it produces sensible findings
4. **Validate**: `npx tsx src/cli-dimensions.ts validate` — confirm frontmatter is correct
5. **Commit** — the dimension is now live in all consumers automatically

## When to Create a Dimension vs. Add to review-criteria.md

| Create a dimension (`prompts/review-*.md`) | Add to criteria (`.claude/kaizen/review-criteria.md`) |
|---|---|
| Needs issue/plan context beyond the diff | Pure code-level check |
| Must be independent of the implementing agent | Agent self-checks are sufficient |
| Worth $0.10-0.20 per check | Should be free (in-session) |
| Catches failures invisible to code review | Catches code quality issues visible in the diff |
| Example: requirements coverage, PR narrative | Example: DRY, naming conventions, import ordering |

**Rule of thumb**: If the check requires reading the *issue* to evaluate the *code*, it's a dimension. If reading the diff alone is sufficient, it's a criteria section.

## Current Dimensions

Run `npx tsx src/cli-dimensions.ts list` for the authoritative live list. The CLI is the source of truth — this table is a snapshot:

| Name | Description | Needs | Applies to |
|------|------------|-------|------------|
| `requirements` | Does the PR address every requirement in the linked issue? | diff, issue | pr |
| `scope-fidelity` | Does the diff do what the issue asked — nothing more, nothing less? | diff, issue | both |
| `plan-coverage` | Does the plan cover the issue's requirements? | issue, plan | plan |
| `plan-fidelity` | Does the PR implement what the plan said? Plan must exist. | diff, issue, plan, pr | pr |
| `test-plan` | Right testing strategy? Pyramid levels, SUT, invariants, category prevention. | diff, issue, tests | pr |
| `test-quality` | Meaningful assertions, edge cases, error paths? | diff, tests | pr |
| `logic-correctness` | Logic bugs, off-by-one, incorrect conditionals? | diff | pr |
| `error-handling` | Silent failures, empty catches, swallowed exceptions? | diff | pr |
| `dry` | Duplicated code, reimplemented utilities, copy-paste? | diff, codebase | pr |
| `pr-description` | Does the PR body tell the solution story? Story Spine. | diff, pr, issue | pr |
