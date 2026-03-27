# Kaizen Cases Unification — Specification

## 1. Problem Statement

Kaizen issues are often created and managed via raw `gh` CLI calls, bypassing any cases abstraction. This creates a split-brain architecture where regular work goes through a structured case system, but kaizen work goes through raw CLI calls. The consequences:

- **No validation or required fields.** Agents can create kaizen issues with missing labels, malformed titles, or no body structure.
- **No collision detection.** Two agents can create duplicate kaizen issues for the same problem.
- **No local cache.** Every backlog query makes multiple GitHub API calls. If GitHub is slow or rate-limited, skills fail.
- **Not CRM-agnostic.** The `gh` CLI is hardcoded throughout skills. Switching to a different issue tracker requires rewriting every skill.

### Who experiences this

- **Dev agents** creating kaizen issues after reflections, filing improvement suggestions, or running `/kaizen-prd`.
- **Admins** receiving malformed or duplicate issues that require manual cleanup.
- **The system** accumulating technical debt as each skill implements its own GitHub interaction pattern.

### What happens today

| Operation | Current path | Problem |
|-----------|-------------|---------|
| Create kaizen issue | Raw `gh issue create` in skills | No validation, no abstraction |
| Read backlog | Raw `gh issue list` in /kaizen-write-plan | GitHub-dependent, no cache |
| Update labels | Raw `gh issue edit` in /kaizen-write-plan | Bypasses any sync layer |
| Close issue | Auto-close via PR `Fixes` keyword | Works but fragile |

## 2. Desired End State

All kaizen issue lifecycle operations go through a cases abstraction. No agent ever calls `gh issue create/edit/list` directly for kaizen issues.

```
Skills (/kaizen-prd, /kaizen-write-plan, /kaizen-write-plan, /kaizen-reflect)
        |
Domain model (cases module)
        |
Case backend interface (adapter pattern)
        |
GitHub adapter
        |
GitHub Issues API
```

**What agents can do:**
- Create kaizen issues through validated tools (with required fields)
- Query active cases from local cache (fast, offline-capable)
- Fetch full backlog from CRM on demand (for /kaizen-write-plan)
- Update issue state (labels, status) through the backend adapter

**What agents cannot do:**
- Call `gh issue create` directly (blocked by L2 hook)
- Bypass validation (required fields enforced at the tool layer)
- Create duplicate issues (collision detection in domain model)

**What is NOT in scope:**
- Bidirectional sync for the full backlog (too complex, not needed)
- Moving off GitHub as the kaizen CRM (abstraction enables this later)

## 3. Architecture

### Desired layers

```
Agent (dev or work)
  |
  |  kaizen_suggest, kaizen_list_backlog,
  |  kaizen_view, kaizen_update
  |
Domain model (cases module)
  |
Case backend adapter
  |
GitHub REST API
```

### New operations for kaizen lifecycle

| Operation | Purpose | Current path |
|-----------|---------|-------------|
| `kaizen_suggest` | Create a kaizen issue in CRM | Raw `gh issue create` |
| `kaizen_list_backlog` | Fetch open issues from CRM | Raw `gh issue list` |
| `kaizen_view` | Read a specific issue | Raw `gh issue view` |
| `kaizen_update` | Update labels/status on issue | Raw `gh issue edit` |

These operations route through the backend adapter, which handles:
- Required field validation (title format, labels, body structure)
- Collision detection (duplicate title/description matching)
- Local cache update (for active/claimed issues)

### Read path: hybrid cache

| Data | Source | Cache? | Rationale |
|------|--------|--------|-----------|
| Active/claimed kaizen issues | Local DB | Yes | Fast routing, offline-capable |
| Full backlog (for /kaizen-write-plan) | GitHub API (on demand) | No | Changes frequently, needs freshness |
| Specific issue details | GitHub API (on demand) | No | Infrequent, needs latest state |

### L2 enforcement hook

A PreToolUse(Bash) hook that blocks `gh issue create --repo <kaizen-repo>` and `gh issue edit --repo <kaizen-repo>` commands. Must allowlist:
- `gh issue view` (read-only, always allowed)
- `gh issue list` (read-only, transitional — eventually replaced by domain model)
- Commands from within hook/skill context that are part of the backend adapter

## 4. Interaction Models

### Creating a kaizen issue (happy path)

1. Agent identifies improvement during `/kaizen-reflect`
2. Agent calls `kaizen_suggest` with: description, level (L1/L2/L3), context
3. Handler validates required fields
4. Backend adapter creates issue in kaizen repo with standard format
5. Issue number returned to agent for reference
6. Local cache updated (if issue is immediately claimed)

### /kaizen-write-plan reading the backlog

1. Skill calls `kaizen_list_backlog` (or domain model function)
2. Domain model fetches from GitHub API: open issues, no `status:active` label
3. Cross-references with local cache: filters out issues with active cases
4. Returns scored/filtered list to skill

### Error: agent tries raw `gh issue create`

1. Agent runs `gh issue create --repo <kaizen-repo>`
2. PreToolUse hook detects the command pattern
3. Hook blocks with: "Use the kaizen_suggest tool instead of raw gh CLI"
4. Agent uses the proper tool (which goes through the backend adapter)

## 5. What Exists vs What Needs Building

### Already Solved

| Capability | Status |
|------------|--------|
| GitHub API client for issues | Working |
| CLI wrapper for backlog queries | Working |
| Collision detection (same issue) | Working |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| `kaizen_suggest` tool | Validated kaizen issue creation through backend | Skills use raw `gh` instead |
| `kaizen_list_backlog` function | Fetch+filter backlog from GitHub through adapter | Skills call `gh issue list` directly |
| `kaizen_view` function | Read single issue through adapter | Skills call `gh issue view` directly |
| `kaizen_update` function | Update labels/status through adapter | Skills call `gh issue edit` directly |
| L2 hook blocking raw kaizen `gh` commands | PreToolUse(Bash) hook | No enforcement exists today |
| Skill migration | Update skills to use new tools | Skills hardcode `gh` CLI |

## 6. Open Questions

1. **Should the backend adapter handle issue body formatting?** Currently skills format issue bodies differently. Should the adapter enforce a standard format, or should each skill format its own body and pass it through?

2. **How to handle the transition?** Migration options:
   - Big bang: update all skills at once
   - Gradual: add the hook as advisory first, migrate skills one by one, then make it blocking

3. **Should `gh issue list` reads be blocked?** The hook could block writes immediately but allow reads (transitional), then block reads once the domain model read path is built.

## 7. Implementation Sequencing

```
Phase 1: GitHub API read ops + CLI wrapper               Done
    |
Phase 2: Domain model tools                              TODO
    |
Phase 3: L2 hook + skill migration (together)            TODO
```

Phases 2 and 3 must ship together — the hook without migrated skills would break them.
