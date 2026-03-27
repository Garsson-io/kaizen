# Kaizen-Cases Architecture

## The Mental Model

All work is a **case**. There are two types:

- **work** cases — using existing tooling to do useful work
- **dev** cases — improving the tooling (kaizen)

Both types use the same case system, same lifecycle (`SUGGESTED → BACKLOG → ACTIVE → DONE → REVIEWED → PRUNED`). Dev cases are backed by the kaizen GitHub repo.

**The kaizen feedback loop:**
- Work agents encounter friction → file improvement requests → these become dev cases
- Dev agents also encounter friction → file improvement requests → also dev cases
- On completion, agents reflect → suggest new dev cases

## Architecture

```
Agent (work or dev)
  |
  |  case_create, case_suggest_dev,
  |  case_mark_done, create_github_issue, ...
  |
Domain Model (cases module)
  |
  +-- Local DB (SQLite)     Case state, lifecycle
  |
  +-- Case Backend Adapter
        |
        GitHub REST API
        +-- kaizen repo      <- dev cases
        +-- host project repo <- work cases
```

Host-side skills access the domain model via CLI wrapper:

```
Host-side skills (/kaizen-deep-dive, /kaizen-write-plan, /kaizen-implement, /kaizen-reflect)
  |
CLI wrapper  -->  GitHub API  -->  GitHub REST API
(backlog queries)
```

## What Goes Through What

| Who | Operation | Mechanism |
|-----|-----------|-----------|
| Agent | Create/manage cases | Domain model tools |
| Agent | Suggest improvement | `case_suggest_dev` tool |
| Agent | Create GitHub issue | `create_github_issue` tool |
| Host-side skill | Query kaizen backlog | CLI wrapper (`list`, `view`) |
| Backend adapter | Sync case → GitHub | Automatic on state change |

**Rule: All case operations go through domain model tools or CLI wrapper. Never raw `gh` CLI.**

## Dev Workflow

```
/kaizen-deep-dive   Find root cause, create meta-issue
     |
/kaizen-write-plan  Validate, plan, get admin approval
     |
/kaizen-implement   Create case + worktree, TDD, PR, review loop, merge
     |
case_mark_done    Agent reflects → kaizen suggestions → new dev cases
     |
/kaizen-reflect   Recursive process improvement
```

## Key Concepts

| Concept | Purpose |
|---------|---------|
| Case lifecycle | Unified state machine for all work types |
| Backend adapter | CRM-agnostic sync (currently GitHub Issues) |
| CLI wrapper | Host-side skill access to backlog without raw `gh` |
| Domain model | Case CRUD, collision detection, local cache |
| Three-way routing | Meta-kaizen → kaizen repo, host-kaizen → host repo, pattern → kaizen repo |

## Related Docs

| Document | What it covers |
|----------|---------------|
| [`kaizen-cases-unification-spec.md`](kaizen-cases-unification-spec.md) | Original spec, problem statement, implementation phases |
