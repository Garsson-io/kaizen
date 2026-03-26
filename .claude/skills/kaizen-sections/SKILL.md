---
name: kaizen-sections
description: Structured PRs and issues — manage named sections in PR/issue bodies and named attachments (marker comments) on issues. Triggers on "add section", "read section", "list sections", "store plan", "attach to issue", "structured data". Use this whenever you need to read or write a specific part of a PR body or issue without rewriting the entire body.
user_invocable: true
---

# Structured PRs and Issues

Manage named `##` sections in PR/issue bodies and named attachments (marker comments) on issues. Avoids full body read/rewrite — saves tokens, prevents clobbering.

## Two Concepts

### Sections (in PR/issue bodies)

Named `##` headers in the body text. Use for **human-visible** structured content: Story Spine narrative, Plan, Test Plan, Known Limitations, Validation.

```bash
# List section names
npx tsx src/cli-section-editor.ts list-sections --pr 903 --repo Garsson-io/kaizen

# Read one section (no need to read the entire body)
npx tsx src/cli-section-editor.ts read-section --pr 903 --repo Garsson-io/kaizen --name "Known limitations"

# Add or update a section (upsert)
npx tsx src/cli-section-editor.ts add-section --pr 903 --repo Garsson-io/kaizen --name "Validation" --text "- [x] Tests pass"

# Replace existing section content
npx tsx src/cli-section-editor.ts replace-section --issue 904 --repo Garsson-io/kaizen --name "Plan" --file plan.md

# Remove a section
npx tsx src/cli-section-editor.ts remove-section --pr 903 --repo Garsson-io/kaizen --name "Draft Notes"
```

### Attachments (marker comments on issues)

Named data stored as issue comments with `<!-- kaizen:name -->` HTML markers. Use for **machine-consumed** data: plans, test plans, YAML metadata. The marker is invisible when rendered — humans see the content, not the tag.

```bash
# List attachment names on an issue
npx tsx src/cli-section-editor.ts list-attachments --issue 904 --repo Garsson-io/kaizen

# Read a named attachment
npx tsx src/cli-section-editor.ts read-attachment --issue 904 --repo Garsson-io/kaizen --name plan

# Write or update an attachment (creates comment or updates existing by ID)
npx tsx src/cli-section-editor.ts write-attachment --issue 904 --repo Garsson-io/kaizen --name plan --file plan.md

# Remove an attachment (deletes the comment)
npx tsx src/cli-section-editor.ts remove-attachment --issue 904 --repo Garsson-io/kaizen --name metadata
```

## When to Use What

| Scenario | Use | Why |
|----------|-----|-----|
| Writing a PR description | **Sections** | Story Spine `##` headers are the body structure |
| Updating one part of a PR body | **Sections** (`add-section`) | Don't rewrite the whole body — edit one section |
| Storing a plan for review dimensions | **Attachment** (`write-attachment --name plan`) | `reviewBattery()` auto-loads from attachments |
| Storing YAML metadata (connected issues) | **Attachment** (`write-attachment --name metadata`) | Machine-readable, queryable via `cli-plan-store.ts` |
| Adding review findings to a PR | **Sections** (`add-section --name "Review Status"`) | Human-visible in the PR body |
| Updating validation checklist | **Sections** (`replace-section --name "Validation"`) | Just update that section |
| Persisting a test plan for future sessions | **Attachment** (`write-attachment --name testplan`) | Survives session restarts |

## Integration with Other Skills

- **`/kaizen-write-pr`** creates the initial PR body with Story Spine sections. Use **sections** to update individual parts later.
- **`/kaizen-implement`** stores the plan and test plan as **attachments** on the issue after the plan phase.
- **`/kaizen-review-pr`** reads the plan **attachment** for plan-dependent dimensions. Adds review status as a **section** on the PR.
- **`/kaizen-deep-dive`** stores YAML metadata (connected issues, PR number) as an **attachment** on the overarching issue.
- **Auto-dent** (`reviewBattery()`) auto-loads plan text from **attachments** when `planText` is not provided.

## Key Properties

- **Privacy**: Both sections and attachments inherit repo visibility. Private repo → private data.
- **Persistence**: Sections are in the body (always visible). Attachments are comments (persist across sessions).
- **Targeting**: Attachment updates use `gh api PATCH` with the comment ID — no `--edit-last` race conditions.
- **Idempotent**: `add-section` and `write-attachment` are upserts — safe to call repeatedly.
