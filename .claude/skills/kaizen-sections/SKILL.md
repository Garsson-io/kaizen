---
name: kaizen-sections
description: Structured PRs and issues — manage named sections in PR/issue bodies and named attachments (marker comments) on issues. Triggers on "add section", "read section", "list sections", "store plan", "attach to issue", "structured data", "store review", "review findings". Use this whenever you need to read or write a specific part of a PR body or issue without rewriting the entire body.
user_invocable: true
---

# Structured PRs and Issues

Two layers: **high-level API** (`cli-structured-data.ts`) for domain workflows (reviews, plans, metadata), and **low-level API** (`cli-section-editor.ts`) for raw section/attachment CRUD.

**Always prefer the high-level API.** Use the low-level only when the high-level doesn't cover your use case.

## High-Level API — `npx tsx src/cli-structured-data.ts`

### Reviews

Store per-dimension findings with structured format (table + expanded analysis):

```bash
# Auto-detect next round number
npx tsx src/cli-structured-data.ts next-round --pr 903 --repo Garsson-io/kaizen
# Output: 6

# Store a finding (pass JSON via --file or --stdin)
cat finding.json | npx tsx src/cli-structured-data.ts store-review-finding --pr 903 --repo R --stdin
# finding.json: {"dimension":"correctness","verdict":"pass","summary":"...","findings":[...]}
# Auto-detects round if --round not given

# Store all findings + auto-compose summary in one batch
cat all-findings.json | npx tsx src/cli-structured-data.ts store-review-batch --pr 903 --repo R --stdin
# all-findings.json: [{"dimension":"correctness",...}, {"dimension":"security",...}]

# Quick pass — shorthand for all-DONE dimensions
npx tsx src/cli-structured-data.ts quick-pass --pr 903 --repo R --dimension security --summary "No issues" --requirements "No injection,Timeout set,Args array"

# Auto-compose summary from stored findings
npx tsx src/cli-structured-data.ts store-review-summary --pr 903 --repo R

# Query review data
npx tsx src/cli-structured-data.ts list-review-rounds --pr 903 --repo R
npx tsx src/cli-structured-data.ts list-review-dims --pr 903 --repo R --round 5
npx tsx src/cli-structured-data.ts read-review-finding --pr 903 --repo R --round 5 --dimension correctness
npx tsx src/cli-structured-data.ts read-review-summary --pr 903 --repo R --round 5
```

**Finding format** (stored on PR as named attachments `review/r{N}/{dimension}`):
```markdown
<!-- meta:{"round":5,"dimension":"correctness","verdict":"pass","done":3,"partial":0,"missing":0} -->
### correctness — PASS
*Round 5 | 120s | $0.150*

> All logic verified.

| # | Status | Requirement |
|---|--------|-------------|
| 1 | ✅ DONE | Agent unblock |
| 2 | ❌ MISSING | gh-exec tests |

---

#### 2. ❌ gh-exec tests
Zero tests for foundation code.
`src/lib/gh-exec.ts` needs 3 tests...
**Fix**: Add gh-exec.test.ts.
```

### Plans

```bash
npx tsx src/cli-structured-data.ts store-plan --issue 904 --repo R --file plan.md
npx tsx src/cli-structured-data.ts retrieve-plan --issue 904 --repo R
npx tsx src/cli-structured-data.ts store-testplan --issue 904 --repo R --file testplan.md
npx tsx src/cli-structured-data.ts retrieve-testplan --issue 904 --repo R
```

Plans stored via `store-plan` are auto-loaded by `reviewBattery()` for plan-dependent dimensions.

### Metadata (connected issues, PR number)

```bash
npx tsx src/cli-structured-data.ts store-metadata --issue 904 --repo R --file metadata.yaml
npx tsx src/cli-structured-data.ts query-connected --issue 904 --repo R
npx tsx src/cli-structured-data.ts query-pr --issue 904 --repo R
```

### PR Sections

```bash
npx tsx src/cli-structured-data.ts update-pr-section --pr 903 --repo R --name "Validation" --text "- [x] All tests pass"
```

### Iteration State

```bash
npx tsx src/cli-structured-data.ts store-iteration --pr 903 --repo R --file state.json
npx tsx src/cli-structured-data.ts retrieve-iteration --pr 903 --repo R
```

## Low-Level API — `npx tsx src/cli-section-editor.ts`

Use when the high-level API doesn't cover your case.

```bash
# Sections in PR/issue bodies
npx tsx src/cli-section-editor.ts list-sections --pr 903 --repo R
npx tsx src/cli-section-editor.ts read-section --pr 903 --repo R --name "Plan"
npx tsx src/cli-section-editor.ts add-section --issue 904 --repo R --name "Plan" --file plan.md
npx tsx src/cli-section-editor.ts replace-section --pr 903 --repo R --name "Validation" --text "..."
npx tsx src/cli-section-editor.ts remove-section --pr 903 --repo R --name "Draft"

# Attachments (marker comments on issues/PRs)
npx tsx src/cli-section-editor.ts list-attachments --issue 904 --repo R [--prefix review/]
npx tsx src/cli-section-editor.ts read-attachment --issue 904 --repo R --name plan
npx tsx src/cli-section-editor.ts write-attachment --pr 903 --repo R --name review-status --text "PASSED"
npx tsx src/cli-section-editor.ts remove-attachment --issue 904 --repo R --name draft
```

## When to Use What

| Task | Command | Why |
|------|---------|-----|
| Store review findings | `store-review-finding` or `store-review-batch` | Structured format + auto round |
| Quick PASS dimension | `quick-pass` | No JSON needed |
| Check review progress | `list-review-rounds` + `list-review-dims` | Mechanistic, no body parsing |
| Store a plan | `store-plan` | Auto-loaded by reviewBattery |
| Update one PR section | `update-pr-section` | No full body rewrite |
| Track connected issues | `store-metadata` + `query-connected` | Queryable YAML |
| Raw section CRUD | Low-level `cli-section-editor.ts` | When high-level doesn't fit |

## Architecture

```
Skills (review-pr, implement, deep-dive, ...)
    ↓ use
structured-data.ts (reviews, plans, metadata, iterations)
    ↓ delegates to
section-editor.ts (sections + attachments CRUD)
    ↓ calls
gh-exec.ts (spawnSync args array)
    ↓ invokes
gh CLI → GitHub API
```
