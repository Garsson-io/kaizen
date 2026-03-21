# Kaizen Standalone Plugin — Specification

## 1. Problem Statement

Kaizen (the continuous improvement system) is deeply embedded in NanoClaw (the agent harness). Every kaizen improvement — a new hook, a policy update, a skill refinement — must pass NanoClaw's full CI: `strict:true` TypeScript compilation, container e2e tests, agent harness integration tests. This "tax" slows kaizen's ability to improve itself.

The systems are conceptually distinct:
- **NanoClaw** is a container-based agent orchestration platform with channels, routing, and case management
- **Kaizen** is a process improvement methodology — philosophy, hooks, skills, and reflection workflows that can apply to *any* project

Today kaizen can only improve one project (NanoClaw). But the methodology is general: any project where Claude Code agents do dev work would benefit from enforcement hooks, reflection workflows, issue taxonomy, and escalation levels.

### Concrete pain points

1. **Testing tax:** Changing a shell hook requires passing TypeScript strict compilation and container tests that are irrelevant to the change.
2. **Coupling:** Kaizen skills reference NanoClaw internals (case system, IPC, container runner). A kaizen skill fix can break NanoClaw and vice versa.
3. **Single-project learning:** Patterns discovered while kaizening NanoClaw have no path to reach other projects. The compound interest loop is capped at one project.
4. **File count:** ~150+ kaizen-related files in NanoClaw make the codebase harder to navigate for non-kaizen work.

### What happens today

- All kaizen files (hooks, skills, agents, policies, docs) live in the NanoClaw repo
- All kaizen issues live in `Garsson-io/kaizen` (a GitHub Issues-only repo)
- Improvements to kaizen tooling and NanoClaw-specific improvements are mixed in the same issue backlog
- Skills like `/kaizen-pick`, `/kaizen-gaps`, `/kaizen-reflect` assume a single repo context

## 2. Desired End State

Kaizen is a standalone Claude Code plugin hosted at `Garsson-io/kaizen`. Any project can install it and get:

- **Enforcement hooks** — PR review loops, worktree isolation, test coverage checks, dirty file gates, kaizen reflection triggers
- **Dev workflow skills** — `/kaizen-pick`, `/kaizen-gaps`, `/kaizen-evaluate`, `/kaizen-implement`, `/kaizen-deep-dive`, `/kaizen-reflect`, `/kaizen-audit-issues`, `/kaizen-prd`, `/kaizen-plan`, `/kaizen-review-pr`, `/kaizen-zen`
- **Background agents** — `kaizen-bg` for post-PR reflection
- **Philosophy and policies** — zen, escalation levels (L1/L2/L3), verification discipline, engineering practices
- **Issue taxonomy** — labels, epics, horizons, incident recording format
- **A setup skill** — `/kaizen-setup` to configure the plugin for the host project

The host project provides a `kaizen.config.json` telling kaizen where to file issues, what the label taxonomy looks like, and what horizons/epics exist.

NanoClaw becomes kaizen's first (and reference) host project.

### What's explicitly NOT in scope

- Kaizen does NOT own case management. Cases are NanoClaw's work-item system. Kaizen uses whatever work-item system the host provides (or none — it can work with just GitHub Issues).
- Kaizen does NOT own container orchestration, message routing, or channel management.
- Kaizen does NOT require NanoClaw. It works on any project where Claude Code runs.
- Multi-host security (preventing host-specific information from leaking to the kaizen repo via generalized patterns) is acknowledged but deferred. Patterns are naturally sanitized. A review gate can be added later.

## 3. Three-Way Issue Routing

Kaizen produces three kinds of insights. Each routes to a different destination:

| Insight Type | Destination | Example |
|-------------|-------------|---------|
| **Meta-kaizen** — improving kaizen tooling itself | `Garsson-io/kaizen` repo | "Reflection should batch duplicate checks before filing" |
| **Host-kaizen** — improving how this host project works | Host's own repo, tagged `kaizen` | "Container runner needs retry logic" |
| **Generalized pattern** — reusable lesson applicable to any project | `Garsson-io/kaizen` repo, tagged `type:pattern` | "Always verify path exists before writing fix" |

### Routing decision in `/kaizen-reflect`

After completing work, the reflection skill classifies each impediment:

```
impediment discovered during reflection
  → "Is this about kaizen's own hooks/skills/policies?"
      YES → file in kaizen repo (meta-kaizen)
  → "Is this about this specific host project?"
      YES → file in host repo with `kaizen` label (host-kaizen)
  → "Is this a pattern any project would benefit from?"
      YES → file in kaizen repo with `type:pattern` label (generalized pattern)
```

### Host awareness

For kaizen to operate effectively on a host project, it needs read access to:

| Host Concept | Why Kaizen Needs It | Which Skills Use It |
|-------------|--------------------|--------------------|
| **Issues** | `/kaizen-pick` selects from host backlog | `/kaizen-pick`, `/kaizen-evaluate` |
| **Epics** | `/kaizen-gaps` checks epic momentum/coverage | `/kaizen-gaps`, `/kaizen-audit-issues` |
| **Horizons** | `/kaizen-gaps` checks dimension concentration | `/kaizen-gaps`, `/kaizen-audit-issues` |
| **Labels/taxonomy** | `/kaizen-audit-issues` checks label hygiene | `/kaizen-audit-issues` |
| **Incident history** | `/kaizen-reflect` checks for repeat impediments | `/kaizen-reflect`, `/kaizen-deep-dive` |

All accessed via GitHub API using configuration from `kaizen.config.json`.

## 4. Skill & Hook Naming Convention

All kaizen skills and hooks are prefixed with `kaizen-` for clear identification and namespace separation from host project tooling.

### Skills

| Old Name | New Name | Purpose |
|----------|----------|---------|
| `/kaizen` | `/kaizen-reflect` | Post-work reflection — classify impediments, file issues |
| `/pick-work` | `/kaizen-pick` | Intelligently select next issue from backlog |
| `/gap-analysis` | `/kaizen-gaps` | Strategic analysis — tooling gaps, horizon concentration |
| `/accept-case` | `/kaizen-evaluate` | Scope gate — evaluate issue before implementation |
| `/implement-spec` | `/kaizen-implement` | Spec-to-code executor — worktree, build, ship |
| `/make-a-dent` | `/kaizen-deep-dive` | Autonomous root-cause fix across a category |
| `/audit-issues` | `/kaizen-audit-issues` | Taxonomy audit — label coverage, epic health, incidents |
| `/write-prd` | `/kaizen-prd` | Problem mapping — iterative discovery to spec |
| `/plan-work` | `/kaizen-plan` | Break large work into sequenced PRs |
| `/review-pr` | `/kaizen-review-pr` | Self-review checklist after PR creation |
| `/zen` | `/kaizen-zen` | Print the Zen of Kaizen philosophy |
| `/wip` | `/kaizen-wip` | Show in-progress work (worktrees, PRs, branches, cases) |
| `/du` | `/kaizen-cleanup` | Disk usage analysis and safe worktree cleanup |
| (new) | `/kaizen-setup` | Install & configure plugin for a host project |
| (new) | `/kaizen-update` | Pull updates from kaizen repo, re-run setup |

### Hooks

All hooks prefixed `kaizen-`:

| Old Name | New Name |
|----------|----------|
| `enforce-pr-review.sh` | `kaizen-enforce-pr-review.sh` |
| `enforce-pr-review-tools.sh` | `kaizen-enforce-pr-review-tools.sh` |
| `enforce-pr-review-stop.sh` | `kaizen-enforce-pr-review-stop.sh` |
| `enforce-case-worktree.sh` | `kaizen-enforce-case-worktree.sh` |
| `enforce-worktree-writes.sh` | `kaizen-enforce-worktree-writes.sh` |
| `enforce-case-exists.sh` | `kaizen-enforce-case-exists.sh` |
| `check-test-coverage.sh` | `kaizen-check-test-coverage.sh` |
| `check-verification.sh` | `kaizen-check-verification.sh` |
| `check-dirty-files.sh` | `kaizen-check-dirty-files.sh` |
| `verify-before-stop.sh` | `kaizen-verify-before-stop.sh` |
| `check-cleanup-on-stop.sh` | `kaizen-check-cleanup-on-stop.sh` |
| `pr-review-loop.sh` | `kaizen-pr-review-loop.sh` |
| `kaizen-reflect.sh` | `kaizen-reflect.sh` (already prefixed) |
| `enforce-pr-kaizen.sh` | `kaizen-enforce-pr-reflect.sh` |
| `pr-kaizen-clear.sh` | `kaizen-pr-reflect-clear.sh` |
| `enforce-post-merge-stop.sh` | `kaizen-enforce-post-merge-stop.sh` |
| `post-merge-clear.sh` | `kaizen-post-merge-clear.sh` |
| `enforce-kaizen-stop.sh` | `kaizen-enforce-reflect-stop.sh` |
| `block-git-rebase.sh` | `kaizen-block-git-rebase.sh` |
| `capture-worktree-context.sh` | `kaizen-capture-worktree-context.sh` |
| `check-practices.sh` | `kaizen-check-practices.sh` |
| `squash-merge-safety.sh` | `kaizen-squash-merge-safety.sh` |
| `warn-code-quality.sh` | `kaizen-warn-code-quality.sh` |
| `check-wip.sh` | `kaizen-check-wip.sh` |

Hook libraries under `hooks/lib/` keep short names (they're internal):
`parse-command.sh`, `state-utils.sh`, `send-notification.sh`, `allowlist.sh`, `resolve-main-checkout.sh`, `resolve-project-root.sh`

## 5. Plugin Structure

### Repository layout: `Garsson-io/kaizen`

```
garsson-io/kaizen/
├── .claude/
│   ├── kaizen/                          # Philosophy & methodology
│   │   ├── zen.md
│   │   ├── policies.md                  # Generic enforcement policies
│   │   ├── verification.md
│   │   ├── practices.md
│   │   ├── workflow.md
│   │   ├── horizon.md
│   │   └── README.md
│   │
│   ├── skills/                          # All kaizen skills
│   │   ├── kaizen-reflect/SKILL.md
│   │   ├── kaizen-pick/SKILL.md
│   │   ├── kaizen-gaps/SKILL.md
│   │   ├── kaizen-evaluate/SKILL.md
│   │   ├── kaizen-implement/SKILL.md
│   │   ├── kaizen-deep-dive/SKILL.md
│   │   ├── kaizen-audit-issues/SKILL.md
│   │   ├── kaizen-prd/SKILL.md
│   │   ├── kaizen-plan/SKILL.md
│   │   ├── kaizen-review-pr/SKILL.md
│   │   ├── kaizen-zen/SKILL.md
│   │   ├── kaizen-wip/SKILL.md
│   │   ├── kaizen-cleanup/SKILL.md
│   │   ├── kaizen-setup/SKILL.md
│   │   └── kaizen-update/SKILL.md
│   │
│   ├── hooks/                           # Enforcement hooks
│   │   ├── kaizen-enforce-pr-review.sh
│   │   ├── kaizen-enforce-pr-review-tools.sh
│   │   ├── kaizen-enforce-pr-review-stop.sh
│   │   ├── kaizen-enforce-case-worktree.sh
│   │   ├── kaizen-enforce-worktree-writes.sh
│   │   ├── kaizen-enforce-case-exists.sh
│   │   ├── kaizen-check-test-coverage.sh
│   │   ├── kaizen-check-verification.sh
│   │   ├── kaizen-check-dirty-files.sh
│   │   ├── kaizen-verify-before-stop.sh
│   │   ├── kaizen-check-cleanup-on-stop.sh
│   │   ├── kaizen-pr-review-loop.sh
│   │   ├── kaizen-reflect.sh
│   │   ├── kaizen-enforce-pr-reflect.sh
│   │   ├── kaizen-pr-reflect-clear.sh
│   │   ├── kaizen-enforce-post-merge-stop.sh
│   │   ├── kaizen-post-merge-clear.sh
│   │   ├── kaizen-enforce-reflect-stop.sh
│   │   ├── kaizen-block-git-rebase.sh
│   │   ├── kaizen-capture-worktree-context.sh
│   │   ├── kaizen-check-practices.sh
│   │   ├── kaizen-squash-merge-safety.sh
│   │   ├── kaizen-warn-code-quality.sh
│   │   ├── kaizen-check-wip.sh
│   │   ├── lib/
│   │   │   ├── parse-command.sh
│   │   │   ├── state-utils.sh
│   │   │   ├── send-notification.sh
│   │   │   ├── allowlist.sh
│   │   │   ├── resolve-main-checkout.sh
│   │   │   └── resolve-project-root.sh
│   │   ├── tests/
│   │   │   ├── harness.sh
│   │   │   ├── test-helpers.sh
│   │   │   ├── run-all-tests.sh
│   │   │   └── test-*.sh
│   │   └── docs/
│   │       ├── hook-design-principles.md
│   │       ├── hook-portability-matrix.md
│   │       └── hook-migration-plan.md
│   │
│   ├── agents/
│   │   └── kaizen-bg.md
│   │
│   └── settings-fragment.json
│
├── src/
│   ├── hooks/
│   │   ├── kaizen-reflect.ts
│   │   ├── kaizen-reflect.test.ts
│   │   ├── kaizen-pr-reflect-clear.ts
│   │   └── kaizen-pr-reflect-clear.test.ts
│   ├── cli-kaizen.ts                    # Issue query CLI (list, view)
│   └── github-issues.ts                 # Thin GitHub Issues API client
│
├── docs/
│   ├── issue-taxonomy.md
│   ├── horizons-framework-spec.md
│   └── horizons/
│       └── incident-driven-kaizen.md
│
├── kaizen.schema.json                   # JSON schema for kaizen.config.json
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

### Host project after installation

```
my-project/
├── .claude/
│   ├── kaizen/        → (installed by plugin)
│   ├── skills/        → (kaizen skills registered by plugin)
│   ├── hooks/         → (kaizen hooks registered by plugin)
│   ├── agents/        → (kaizen-bg registered by plugin)
│   └── settings.json  → (hook registrations merged by /kaizen-setup)
├── kaizen.config.json
└── ...project code...
```

## 6. Host Configuration

### `kaizen.config.json`

```json
{
  "host": {
    "name": "nanoclaw",
    "repo": "Garsson-io/nanoclaw",
    "description": "Agent orchestration harness"
  },
  "kaizen": {
    "repo": "Garsson-io/kaizen",
    "issueLabel": "kaizen"
  },
  "taxonomy": {
    "levels": ["level-1", "level-2", "level-3"],
    "areas": ["hooks", "skills", "cases", "container", "deploy", "testing", "worktree"],
    "areaPrefix": "area/",
    "epicPrefix": "epic/",
    "horizonPrefix": "horizon/",
    "horizons": ["reliability", "growth", "dx", "security", "autonomous-ops"]
  },
  "policies": {
    "localFile": ".claude/kaizen/policies-local.md"
  },
  "notifications": {
    "channel": "telegram",
    "config": {}
  }
}
```

Skills read this config at runtime to know where to query/file issues, what labels are valid, what horizons/epics exist, and where host-specific policies live.

### Policies: generic + local

Kaizen provides `policies.md` with generic policies (recursive kaizen on fixes, co-commit tests, smoke tests ship with feature, etc.). The host project extends with `policies-local.md` for project-specific policies (NanoClaw's strict:true, container isolation, MCP enforcement, etc.).

At runtime, skills load both. The local file can override or extend generic policies.

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current Implementation | Status |
|------------|----------------------|--------|
| Hook enforcement system | 24 hooks in `.claude/kaizen/hooks/` | Working, needs prefix rename + path abstraction |
| Kaizen skills | 13 skills in `.claude/skills/` | Working, need rename + config-driven repo references |
| Background reflection agent | `.claude/agents/kaizen-bg.md` | Working, needs MCP tool abstraction |
| Hook test infrastructure | `hooks/tests/harness.sh` + 15+ test files | Working, portable as-is |
| TypeScript hooks | `src/hooks/kaizen-reflect.ts`, `pr-kaizen-clear.ts` | Working, portable as-is |
| Philosophy & docs | `.claude/kaizen/*.md` | Portable as-is |
| Issue taxonomy | `docs/issue-taxonomy.md` | Portable, needs host-config integration |

### Needs Building

| Component | What | Why It Doesn't Exist Yet |
|-----------|------|-------------------------|
| `kaizen.config.json` schema + reader | Config file that skills/hooks read for host context | Currently hardcoded to NanoClaw's repo/labels |
| `/kaizen-setup` skill | Interactive setup: creates config, merges hooks, scaffolds `policies-local.md` | Plugin installation is manual today |
| `/kaizen-update` skill | Pull kaizen updates, re-run setup to merge new hook registrations | No update path exists yet |
| Three-way issue routing in `/kaizen-reflect` | Classify impediments → meta-kaizen / host-kaizen / generalized pattern | Currently everything goes to one repo |
| `send-notification.sh` abstraction | Channel-agnostic notification from hooks | Currently `send-telegram-ipc.sh` is Telegram-only |
| Thin GitHub Issues client | Standalone issue query (list, view, create) for kaizen repo | Currently uses NanoClaw's `github-api.ts` |
| `/kaizen-implement` worktree abstraction | Create worktree without requiring NanoClaw's case system | Currently calls `case_create` which is NanoClaw-specific |
| `kaizen-bg` tool abstraction | Suggest improvements without requiring MCP `case_suggest_dev` | Currently assumes NanoClaw's case infrastructure |
| NanoClaw migration | Extract files, rename CLI, create `policies-local.md`, update CLAUDE.md | First host project needs migration path |
| Existing issue triage | Sort current `Garsson-io/kaizen` issues into meta-kaizen vs NanoClaw host-kaizen | Current backlog mixes both types |
| Plugin CI | Tests for hooks, TypeScript hooks, config validation | Currently tested inside NanoClaw's CI |
| Operational docs | Installation guide, host configuration reference, migration guide | Currently documented inline in NanoClaw |

## 8. What Moves vs What Stays

### Moves to `Garsson-io/kaizen`

| Category | Files | Count |
|----------|-------|-------|
| Philosophy & docs | `.claude/kaizen/*.md` | ~7 |
| Skills | `.claude/skills/{kaizen,pick-work,gap-analysis,...}` (renamed with `kaizen-` prefix) | ~13 |
| Hooks (shell) | `.claude/kaizen/hooks/*.sh` + `lib/` + `tests/` + `docs/` (renamed with `kaizen-` prefix) | ~50+ |
| Hooks (TypeScript) | `src/hooks/kaizen-reflect.ts`, `src/hooks/pr-kaizen-clear.ts` + tests | ~4 |
| Background agent | `.claude/agents/kaizen-bg.md` | 1 |
| Settings fragment | `.claude/kaizen/settings-fragment.json` | 1 |
| Issue taxonomy docs | `docs/issue-taxonomy.md`, `docs/horizons-framework-spec.md`, `docs/horizons/` | ~3 |
| CLI (issue queries) | `src/cli-kaizen.ts` (list, view commands only) | partial |
| Hook design docs | `hooks/docs/*.md` | ~3 |

### Stays in NanoClaw

| Category | Files | Reason |
|----------|-------|--------|
| Case management | `src/cases.ts`, `src/case-backend*.ts`, `src/case-router.ts`, `src/case-auth.ts` | NanoClaw's work-item system |
| IPC handlers | `src/ipc-cases.ts`, `src/ipc.ts` | NanoClaw IPC infrastructure |
| Container runner | `src/container-runner.ts` | NanoClaw core |
| CLI (case ops) | `src/cli-kaizen.ts` → rename to `src/cli-cases.ts` | Case commands are not kaizen |
| GitHub API client | `src/github-api.ts` | Shared NanoClaw utility (kaizen gets its own thin client) |
| NanoClaw-specific policies | Policies #12-19 | → `policies-local.md` in NanoClaw |
| All channel/routing code | `src/channels/`, `src/router.ts` | NanoClaw core |
| E2E / container tests | various | NanoClaw testing concern |

### Requires abstraction before moving

| Item | Current State | Needed Change |
|------|--------------|---------------|
| `send-telegram-ipc.sh` | Hardcoded to Telegram IPC | Abstract to `send-notification.sh` — reads config from `kaizen.config.json` |
| `/kaizen-implement` | References NanoClaw's case system for worktree creation | If host has cases, use them; otherwise `git worktree add` directly |
| `cli-kaizen.ts` | Mixed case ops + issue queries | Split: case ops → `cli-cases.ts` (stays), issue queries → kaizen's own CLI |
| Hook path resolution | Some hooks resolve paths relative to NanoClaw | Use `resolve-project-root.sh` consistently |
| `kaizen-bg.md` agent | References MCP `case_suggest_dev` | If host has case system, suggest dev case; otherwise file an issue |

## 9. Open Questions & Known Risks

### Open Questions

| # | Question | Options | Lean |
|---|----------|---------|------|
| 1 | **How does the plugin get installed?** | (a) Claude Code native plugin mechanism, (b) `gh repo clone` + `/kaizen-setup` skill, (c) git submodule | **(a)** if Claude Code supports it, otherwise **(b)** — clone repo, run `/kaizen-setup` which wires it into host |
| 2 | **Should kaizen have `strict:true` TypeScript?** | (a) Yes for TS hooks (they're small), (b) No — the whole point is less tax | **(a)** for TypeScript hooks, shell hooks have their own test harness |
| 3 | **How do worktrees work without NanoClaw's case system?** | (a) Kaizen provides minimal case tracking, (b) Plain git worktrees, (c) Optional case integration | **(b)** for v1 — `git worktree add` is sufficient. Cases are a NanoClaw luxury. |
| 4 | **How does kaizen's own development work?** | (a) Kaizen uses kaizen on itself (recursive), (b) Standard dev workflow | **(a)** — kaizen's `kaizen.config.json` points to itself. It eats its own dog food. |
| 5 | **Should existing issues be triaged during migration or after?** | (a) Triage first, (b) Triage incrementally | **(b)** — triage as issues come up. Don't block migration on backlog cleanup. |
| 6 | **How does the host project update kaizen?** | (a) `git pull`, (b) `/kaizen-update` skill, (c) Submodule update | **(b)** — a skill that pulls updates and re-runs setup for new hook registrations |

### Known Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Skills assume NanoClaw internals** | Skills break on non-NanoClaw hosts | Audit each skill for NanoClaw-specific references before moving. Abstract or feature-gate. |
| **Hook path resolution** | Hooks fail on other host project structures | Standardize on `resolve-project-root.sh`. Test on a second project. |
| **Lost incident context** | NanoClaw-specific policies lose their "why" | Keep "Why" sections in policies. NanoClaw-specific policies stay in `policies-local.md` with incident history. |
| **Two repos to maintain** | More git ops, CI, coordination | Kaizen CI is lightweight (shell tests + minimal TS). That's the point. |
| **Plugin installation drift** | Host's kaizen gets out of sync | `/kaizen-update` skill. Setup is idempotent. |
| **Circular dependency during migration** | NanoClaw needs kaizen while it's being extracted | Phased: copy first, verify, then remove from NanoClaw. Both copies coexist temporarily. |

## 10. Implementation Sequencing

### Phase 1: Scaffold the kaizen repo

- Create repo structure (`.claude/`, `src/`, `docs/`)
- Move philosophy & methodology docs (zen, policies, verification, practices, workflow, horizon)
- Move issue taxonomy docs
- Create `kaizen.config.json` schema
- Set up CI (shell hook tests, TypeScript compilation)
- Write `CLAUDE.md` for the kaizen repo itself
- Write `README.md` with installation instructions

**No NanoClaw changes yet. Can start immediately.**

### Phase 2: Rename and abstract

- Rename all skills with `kaizen-` prefix
- Rename all hooks with `kaizen-` prefix
- Create `send-notification.sh` abstraction (replaces `send-telegram-ipc.sh`)
- Make all hook path resolution use `resolve-project-root.sh`
- Create config reader utility (shell function that reads `kaizen.config.json`)
- Abstract `/kaizen-implement` worktree creation (plain git worktree if no case system)
- Abstract `kaizen-bg` tool usage (file issue if no case system)

**Can be done in NanoClaw first, then moved. Depends on Phase 1 for target repo.**

### Phase 3: Move hooks and skills

- Move all shell hooks + test infrastructure + hook libs
- Move all kaizen skills
- Move TypeScript hooks + tests
- Move background agent definition
- Move `settings-fragment.json`
- Build `/kaizen-setup` skill
- Build `/kaizen-update` skill

**Depends on Phase 2 abstractions.**

### Phase 4: Build three-way routing

- Update `/kaizen-reflect` with routing logic (meta vs host vs pattern)
- Update `kaizen-bg` agent with routing awareness
- Create config-driven issue filing (reads `kaizen.config.json` for repo targets)
- Add `type:pattern` label support

**Depends on Phase 3 (skills must be in kaizen repo).**

### Phase 5: NanoClaw migration

- Install kaizen as a plugin in NanoClaw
- Create NanoClaw's `kaizen.config.json`
- Create `policies-local.md` with NanoClaw-specific policies (#12-19)
- Rename `src/cli-kaizen.ts` → `src/cli-cases.ts` (case commands only)
- Remove kaizen files from NanoClaw repo
- Update NanoClaw's `CLAUDE.md` to reference kaizen plugin
- Verify all hooks/skills work via the plugin

**Depends on Phase 3. Phase 4 can run in parallel.**

### Phase 6: Backlog triage (incremental)

- Review existing `Garsson-io/kaizen` issues
- Tag each as meta-kaizen, NanoClaw host-kaizen, or generalized pattern
- Move NanoClaw host-kaizen issues to `Garsson-io/nanoclaw` with `kaizen` label

**Runs incrementally after Phase 5.**

### Phase 7: Second host project (validation)

- Install kaizen plugin on a second project (e.g., a vertical or a fresh repo)
- Verify `/kaizen-setup` works
- Verify hooks fire correctly
- Verify skills can query host issues/epics/horizons
- Verify three-way routing files to correct repos

**The real test. Until this works, kaizen isn't truly standalone.**

### Dependency graph

```
Phase 1 (scaffold) ─────────────────────────────────────┐
                                                         │
Phase 2 (rename+abstract) ──→ Phase 3 (move) ──→ Phase 5 (migrate NanoClaw)
                                             │                    │
                                             └──→ Phase 4 (routing)
                                                                  │
Phase 6 (triage) ←────────────────────────────────────────────────┘
                                                                  │
Phase 7 (second host) ←──────────────────────────────────────────┘
```

Phases 1 and 2 can run in parallel. Phase 6 runs incrementally after Phase 5. Phase 7 is the validation gate.
