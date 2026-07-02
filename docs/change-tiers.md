# Change Tiers — Proportional Ceremony (#1748)

## Why

Before tiers, every source change paid the identical full gate stack — a
substantive multi-heading plan, a behaviors-table test plan, a 7-field Impact
proof, and full review — whether it changed 5 lines or 500. Measured across
all merged PRs, a quarter of them changed ≤ 64 lines; for that class the
process overhead routinely exceeded the cost of the change itself. Docs-only
changes were already exempt; everything else was maximum ceremony.

Tiers make ceremony proportional to blast radius, without weakening the bar
where it matters: the enforcement surface always takes the standard flow, and
a tier declaration is verified against the real diff before a PR can be
created.

## The contract

| Tier | Declared how | Plan bar | Test plan | Impact proof | Verified when |
|------|--------------|----------|-----------|--------------|---------------|
| docs | implicit (diff is non-source only) | none | none | none | `gh pr create` (existing `isDocsOnly`) |
| trivial | `git config --worktree kaizen.tier trivial` | mini plan: what changes + how verified (≥ 120 chars, names a test/verification step) | not required separately | not required | edit time (surface check) + `gh pr create` (limits) |
| standard | default (unset / anything else) | full substance bar (#1035) | required (I3) | required (#1505) | as today |

### Trivial limits

A trivial change must satisfy ALL of:

- ≤ 4 changed files
- ≤ 80 total changed lines (additions + deletions, `main...HEAD`)
- zero enforcement-surface files

Limits live in `src/change-tier.ts` (`TRIVIAL_LIMITS`). The line budget is
sized so a small fix plus its co-committed test (I17) fits.

### Enforcement surface (never trivial)

`src/hooks/`, `.claude/hooks/`, `.githooks/`, `.claude-plugin/`,
`.agents/skills/`, `.agents/kaizen/`, `.claude/skills/`, `prompts/`, plus
`src/change-tier.ts`, `src/case-system.ts`, `src/review-sentinel.ts`.
Editing any of these under a trivial declaration is blocked at edit time with
an unset hint — the machinery that relaxes the gates can never itself ship
through the relaxed gates.

## Declare early, verify late

The declaration is trusted provisionally at edit time (cheap, local, no
network) and **verified against ground truth at `gh pr create`** — the same
outcome-over-command principle as #943/#1106. A change that outgrew its
declaration is blocked with the actual numbers and two exits:

- split the PR until the diff fits the tier, or
- upgrade: `git config --worktree --unset kaizen.tier` and run
  `/kaizen-write-plan`.

Unknown or garbage `kaizen.tier` values parse as `standard` — the failure
direction is always toward the stricter bar.

## What the trivial tier does NOT relax

- Issue binding (`kaizen.issue`, #1111) and the case-branch cross-check (#1106)
- The superseded-issue guard (#318)
- Plan **existence** on the issue (I8's audit trail survives — only the
  substance bar shrinks)
- Worktree/case discipline (I9, I10), dirty-file checks (I11), review rounds,
  reflection (I16)

Review-battery and reflection proportionality are natural follow-ups once
this primitive exists, but are deliberately out of scope here (one PR, one
issue).
