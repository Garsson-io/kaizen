# Horizon: State Integrity

*"An agent can follow every rule and still act on stale data."*

## Problem

NanoClaw has multiple state stores: SQLite (local cache), GitHub Issues (CRM source of truth), git branches/worktrees, IPC filesystem, container mounts. When multiple agents operate concurrently, consistency becomes a real problem. Agent A reads case status, starts work, Agent B modifies the case, and Agent A's work is now based on stale reality.

Without state integrity:
- **Stale reads cause wrong output** — agent acts on outdated case status, issue labels, or file content
- **Sync conflicts destroy data** — CRM sync overwrites fields (kaizen #120: `githubIssue` overwritten by sync)
- **Recovery is impossible** — can't reconcile what you can't identify as inconsistent
- **Multi-agent coordination is unsafe** — can't run concurrent agents if their state views can silently diverge

## Taxonomy

| Level | Name | What's consistent | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | No guarantees | Nothing. Agents read whatever is locally cached. | None |
| **L1** | Collision detection | Two agents can't start the same issue. | `ipc-cases.ts` collision check, worktree locking |
| **L2** | Freshness guarantees | Before acting on state, verify it's current. Stale reads rejected. | Refresh-before-act pattern, TTL on cached state |
| **L3** | Conflict resolution | Conflicting changes have a defined resolution strategy. | Merge policies, priority rules, last-writer-wins with audit |
| **L4** | Transactional operations | Multi-step operations are atomic. Partial failures rolled back. | Transaction wrapper for create-branch + create-case + assign-issue |
| **L5** | Causal ordering | Agent A depends on Agent B's output → dependency explicit and enforced. | Dependency graph between cases |
| **L6** | Reconciliation | Periodic consistency check across all state stores. Auto-repair. | Background reconciliation process |

## You Are Here

**L1.** Collision detection in `ipc-cases.ts` blocks duplicate case creation for the same issue. Worktree locking prevents concurrent worktree access. `state-utils.sh` provides cross-worktree isolation for hook state files. But: no freshness guarantees on CRM data, no conflict resolution protocol, no transactional multi-step operations.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| Case collision detection | L1 | `src/ipc-cases.ts` |
| Worktree locking | L1 | `src/cases.ts` |
| Cross-worktree state isolation | L1-2 | `.claude/kaizen/hooks/lib/state-utils.sh` |
| CRM sync | L0-1 | `src/case-backend-github.ts` (can overwrite — #120) |

## L1→L2: Freshness Guarantees (next step)

**Problem L2 solves:** Agent reads case status from SQLite cache, starts work, but the GitHub Issue was modified by another agent 5 minutes ago. Today: agent works against stale state, potentially conflicting with the other agent's changes. L2: refresh case state from CRM before acting on it.

**Rough shape:** TTL on cached case records (e.g., 60 seconds). Before starting work on a case, check if the cache is fresh. If stale, sync from CRM. If sync fails (network), use cached data but flag it as potentially stale in the agent's context.

**Signal to escalate to L3:** Two agents produce conflicting changes to the same case (different branches, both valid) and the system has no way to resolve the conflict other than "whoever pushes first wins."

## L3–L4: Visible but not designed

**L3 (conflict resolution):** Problem: agent A and agent B both modify the same file in different worktrees. Git will handle the file-level conflict at merge time, but the semantic conflict (both changed the same behavior in incompatible ways) is invisible until a human reviews. Need: conflict detection at the semantic level, not just textual. Open question: is semantic conflict detection feasible for AI agents? Or is textual + human review sufficient?

**L4 (transactional operations):** Problem: "create worktree, create case, assign issue, sync to CRM" is 4 steps. If step 3 fails, steps 1-2 are orphaned. Today: manual cleanup. Need: transaction wrapper that rolls back partial operations. Open question: which operations are safely rollbackable? (Deleting a worktree is easy; un-assigning an issue has side effects.)

## L5–L6: Horizon

**L5 (causal ordering):** Explicit dependency graph between cases. "Case B depends on Case A's PR being merged." The system enforces ordering — Case B doesn't start until Case A completes. Prevents wasted work on dependent changes.

**L6 (reconciliation):** Background process that periodically compares SQLite, GitHub Issues, git branches, and filesystem. Detects inconsistencies: case in DB but no branch, branch but no case, GitHub issue labeled `status:active` but case is `done` in DB. Auto-repairs unambiguous inconsistencies, escalates ambiguous ones.

## What We Can't See Yet

Beyond L6, state integrity merges with distributed systems theory: consensus algorithms for multi-agent coordination, CRDT-like structures for concurrent case modifications, eventual consistency with convergence guarantees. This territory opens when the system runs many concurrent agents (Scalability horizon activation).

## Relationship to Other Horizons

- **State Integrity enables Resilience** — can't recover from failures if you can't reconcile state
- **Observability feeds State Integrity** — inconsistency detection requires knowing what state each agent saw
- **State Integrity is a prerequisite for Scalability** — multi-agent consistency is the core scaling challenge
- **State Integrity produced kaizen #120** — the incident that motivated the cross-layer integration testing spec
