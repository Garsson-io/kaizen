# Credential Inventory

Last audited: 2026-03-23 (batch-260323-0003-072b/run-73)

## Overview

Kaizen is a Claude Code plugin — it runs inside the user's Claude Code session and inherits the session's credentials. No secrets are stored in the repository. All GitHub operations flow through the `gh` CLI, which manages its own authentication.

## Credential Map

### 1. GitHub Token (via `gh` CLI)

| Property | Value |
|----------|-------|
| **Type** | OAuth / PAT (managed by `gh auth`) |
| **Storage** | `~/.config/gh/hosts.yml` (outside repo) |
| **Scope** | Whatever the user granted — typically `repo`, `read:org` |
| **Used by** | Every script/hook that calls `gh` |

**Operations by category:**

| Category | Operations | Files |
|----------|-----------|-------|
| **Read** | `gh pr view`, `gh issue view`, `gh pr diff`, `gh pr list`, `gh api repos/*/check-runs` | Most hooks and scripts |
| **Write (issues)** | `gh issue create`, `gh issue comment`, `gh issue close`, `gh issue edit --add-label` | `auto-dent-run.ts`, `auto-dent-github.ts`, `pr-kaizen-clear.ts` |
| **Write (PRs)** | `gh pr create`, `gh pr comment`, `gh pr edit --add-label`, `gh pr close` | `auto-dent-run.ts`, `auto-dent-github.ts` |
| **Write (merge)** | `gh pr merge --squash --delete-branch --auto` | `auto-dent-run.ts`, `auto-dent-github.ts` |
| **Write (branch)** | `gh api repos/{repo}/pulls/{n}/update-branch -X PUT` | `auto-dent-github.ts` |

**Over-privilege assessment:** The token scope is controlled by the user's `gh auth` configuration, not by kaizen. Kaizen uses whatever scope is available. In auto-dent batch mode, the token needs full `repo` write access. For interactive sessions, read-only would suffice for most hooks but write is needed for reflection (filing issues, commenting on PRs).

**Recommendation:** Document minimum required scopes for each usage mode (interactive vs batch) so users can configure fine-grained PATs.

### 2. Claude Code / Anthropic API Key

| Property | Value |
|----------|-------|
| **Type** | Anthropic API key or Claude Code subscription |
| **Storage** | Managed by Claude Code CLI (outside repo) |
| **Scope** | Model access — conversation, tool use |
| **Used by** | Claude Code session (kaizen hooks/skills run within this) |

Kaizen never references or accesses the Anthropic API key directly. It is consumed by the Claude Code runtime.

**Over-privilege assessment:** N/A — kaizen cannot control or scope this.

### 3. Claude Code Session Permissions (`.claude/settings.local.json`)

This file grants Claude Code permission to execute commands without prompting. It is local-only (not committed to the repo, lives in the worktree).

| Permission pattern | Scope | Risk |
|-------------------|-------|------|
| `Bash(gh pr:*)` | All `gh pr` subcommands | Permits `gh pr close`, `gh pr merge` without confirmation |
| `Bash(gh issue:*)` | All `gh issue` subcommands | Permits `gh issue close`, `gh issue delete` |
| `Bash(gh label:*)` | Label management | Low risk |
| `Bash(git push:*)` | Push to any remote/branch | Permits push to main (though branch protection helps) |
| `Bash(git add:*)`, `Bash(git commit:*)` | Local git operations | Low risk |
| `Bash(npm test:*)`, `Bash(npx vitest:*)` | Test execution | Low risk |

**Over-privilege assessment:** The wildcard patterns are broader than necessary for most interactive work. Auto-dent batch mode legitimately needs broad write access. Interactive mode could use narrower patterns.

**Recommendation:** Create documented permission profiles (interactive vs batch) with minimal scopes for each.

## Environment Variables (Non-Secret Configuration)

These variables control paths and behavior but contain no secrets:

| Variable | Default | Purpose |
|----------|---------|---------|
| `STATE_DIR` | `/tmp/.pr-review-state` | PR review state tracking |
| `AUDIT_DIR` | (project-relative) | Audit log storage |
| `IPC_DIR` | (project-relative) | Inter-process communication |
| `KAIZEN_TELEMETRY_DIR` | (project-relative) | Telemetry data |
| `CLAUDE_PROJECT_DIR` | (auto-detected) | Project root resolution |

## What Does NOT Exist

| Component | Status | Notes |
|-----------|--------|-------|
| `.env` files | None in repo | No dotenv usage |
| Docker credential mounts | N/A | This is a plugin repo, not a container platform |
| `case-auth.ts` | Referenced in horizon doc | Belongs to host project, not this repo |
| `credential-proxy.ts` | Referenced in horizon doc | Belongs to host project, not this repo |
| `mount-security.ts` | Referenced in horizon doc | Belongs to host project, not this repo |
| Hardcoded tokens/keys | None found | Clean — no secrets in source |

## Risk Summary

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `gh` token scope not minimized per usage mode | Medium | Document minimum scopes; create fine-grained PATs per mode |
| No token lifecycle (no session-scoping, no auto-revocation) | Medium | Future: #661 (auto-revoke on case completion) |
| Settings permissions use broad wildcards | Low-Medium | Create documented permission profiles |
| Security components in horizon doc reference host-project code | Low | Clarify in horizon doc which components are plugin vs host |

## Scope Reduction Recommendations

### 1. Document minimum `gh` token scopes per mode

Create a table of required GitHub token permissions:
- **Interactive hooks:** `repo:read`, `issues:write` (for filing kaizens), `pull_requests:read`
- **Auto-dent batch:** `repo:write`, `issues:write`, `pull_requests:write`
- **Read-only analysis:** `repo:read`, `issues:read`

### 2. Narrow `settings.local.json` permission patterns

Replace broad wildcards with specific subcommands:
- `Bash(gh pr:*)` could become `Bash(gh pr view:*)`, `Bash(gh pr create:*)`, etc.
- `Bash(gh issue:*)` could become `Bash(gh issue view:*)`, `Bash(gh issue create:*)`, etc.

### 3. Clarify host-project vs plugin security boundaries

The security horizon doc lists `case-auth.ts`, `credential-proxy.ts`, `mount-security.ts` as existing components. These belong to the host project, not this plugin. The horizon doc should clarify which security controls are plugin-responsibility vs host-responsibility.
