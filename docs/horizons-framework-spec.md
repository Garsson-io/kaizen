# Horizons Framework — Specification

*"Map the territory before you move through it. A good taxonomy of the problem outlasts any solution."*

## 1. Problem Statement

The kaizen system currently discovers maturity dimensions (horizons) through a manual, human-driven process:

1. Aviad observes a category of recurring failure (hooks breaking, reflections without action, tests that prove mocks work)
2. He recognizes this friction reveals an unnamed dimension of quality (testability, incident tracking, enforcement maturity)
3. He manually prompts Claude to think about that dimension — "how do you know your fix won't break it again?"
4. That produces a taxonomy (L0–L6 levels of that dimension)
5. The taxonomy gets inserted into the reflection prompts so future agents think along that axis
6. Now the system can self-improve along that axis — but only because a human did the discovery

**The bottleneck is steps 1-3.** The human is the horizon-discovery mechanism. Agents don't ask "is there a dimension of quality I'm not tracking?" — they only improve along dimensions already named in their prompts.

### What this costs

- **Same-category failures recur** until a human notices the pattern and names the dimension
- **Meta-level thinking requires explicit prompting** — agents stay at the current level unless pushed up
- **Horizon discovery doesn't compound** — each discovery starts from scratch, not from a structured search
- **The autonomous kaizen vision is blocked** — non-technical vertical experts can't discover horizons, so the system can't fully self-improve without a developer in the loop

### Concrete incidents

- **Testability horizon (#136):** Hooks kept breaking after fixes. Aviad had to prompt "how do you know your fix won't break it again, what kind of new testing would solve this?" — which produced the cross-layer integration testing spec. The agent had no framework to think about testability as a dimension.
- **Incident-driven kaizen (#124):** Same issues kept being rediscovered and re-filed. Aviad had to prompt for a taxonomy of how incidents flow through the system. Agents had no concept of "incident maturity."
- **Enforcement escalation:** The L1→L2→L3 framework itself was discovered through repeated failures of instructions-only approaches. It's now the best-formalized dimension.

## 2. Desired End State

A complete, enumerated set of maturity horizons with a self-extension mechanism, so that:

1. **Every kaizen reflection evaluates friction against known horizons** — agents ask "which dimension does this friction touch? Where are we? Should we move up?"
2. **Every reflection can discover new horizons** — one additional question: "does this friction reveal a dimension we're not tracking?"
3. **Periodic review catches what per-reflection misses** — every ~10 cases, review whether the horizon set is still complete
4. **Non-technical vertical experts benefit passively** — they never see horizons, but the system's self-improvement covers all dimensions, not just the ones a developer happened to think of

### What's explicitly NOT in scope

- Implementing improvements along any horizon (that's `/implement-spec`)
- Changing the enforcement framework (L1→L2→L3 stays as-is)
- Rewriting existing horizon docs (Autonomous Kaizen, Incident-Driven Kaizen, Testability already well-structured)

## 3. The Horizon Architecture

### 3.1 What is a horizon?

A **horizon** is a dimension of quality that's an infinite game — you never "solve" it, you just get better. Each horizon has:

- **A taxonomy:** What does good look like at each level? (L0→L6+)
- **A "You Are Here" marker:** Where is the system now?
- **Progressive detail:** Dense for the current and next level, sketched for future levels
- **Relationship map:** How does this horizon feed or depend on others?
- **Escalation signals:** What tells you it's time to move up a level?

### 3.2 Enforcement is cross-cutting, not a horizon

Enforcement (L1 instructions → L2 hooks → L3 mechanistic) is NOT a horizon. It's the meta-framework that applies **within** every horizon. Each horizon has its own enforcement level, independent of its maturity level.

The meaningful question for each horizon is two-dimensional:

```
What level of capability do we have?  (the horizon's own taxonomy)
What level of enforcement ensures it? (L1/L2/L3)
```

A system can be at Testability L5 (cross-layer integration tests) but only enforce it at L1 (instructions say "write tests"). The capability exists but isn't guaranteed.

### 3.3 The meta-architecture: horizon discovery tower

Three levels of reflection about horizons. The tower is self-referential at the top — there is no Level D.

**Level A — Move along known horizons** (every reflection, every PR)
- The reflection prompt lists the horizons by name
- Agent evaluates: "which horizon(s) does this friction touch? Where are we? Should we move up?"
- This is what the system already does for enforcement level — extend it to all horizons

**Level B — Discover new horizons** (every reflection, one question)
- One additional question in `kaizen-reflect.sh`: "Does this friction reveal a quality dimension not covered by our existing horizons? (See `docs/horizons/README.md` for the list.)"
- If yes → file a horizon-discovery kaizen issue with proposed taxonomy sketch
- This replaces the human as the horizon-discovery mechanism

**Level C — Review the horizon set** (periodic, every ~10 cases or monthly)
- Read `docs/horizons/README.md`, read recent kaizen issues
- Ask: "Are there clusters of issues that don't map to any horizon? Is any horizon stale? Should two horizons merge? Is there a gap?"
- Trigger: could be a question in `/pick-work` every Nth invocation, or a dedicated `/review-horizons` skill

**Why there's no Level D:** Level C reviews Level B's output. Level B reviews Level A's coverage. Level C is self-referential — it can discover that IT needs updating. All three levels produce the same artifact type (horizon documents and kaizen issues). The recursion terminates naturally.

## 4. The Complete Horizon Set

### 4.1 Summary table

| # | Horizon | Category | Current Level | Urgency | Status |
|---|---------|----------|---------------|---------|--------|
| 1 | Autonomous Kaizen | Process | L3-4 | Active | Formalized |
| 2 | Incident-Driven Kaizen | Process | L0→L1 | Active | Formalized |
| 3 | Testability | Quality | L0-5 solid, L6+ gap | Active | Formalized |
| 4 | Observability | Quality | L1 | **High** — prerequisite for everything | Needs doc |
| 5 | Resilience | Operational | L1 | **High** — prevents cleanup toil | Needs doc |
| 6 | Cost Governance | Operational | L1 | **High** — prevents acute damage | Needs doc |
| 7 | Security | Trust | L1-2 | Medium — foundations exist | Needs doc |
| 8 | Human-Agent Interface | Trust | L0 | **High** — IS the product interface | Needs doc |
| 9 | State Integrity | Quality | L1 | Medium — incidents rare so far | Needs doc |
| 10 | Extensibility | Platform | L1-2 | Medium | Needs doc |
| 11 | *Scalability* | *Dormant* | *n/a* | *Activates at 3+ verticals* | Stub |
| meta | Horizon Completeness | Meta | L0 | This spec | Needs doc |

### 4.2 Relationship map

```
                    ┌─────────────────┐
                    │    Horizon       │
                    │  Completeness    │  ← discovers new horizons
                    │    (meta)        │
                    └────────┬────────┘
                             │ governs all
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                   ▼
   ┌─────────────┐   ┌─────────────┐    ┌──────────────┐
   │ Autonomous   │   │ Incident-   │    │ Observability │
   │ Kaizen       │◄──│ Driven      │◄───│              │
   │ (process)    │   │ Kaizen      │    │ (quality)     │
   └──────┬───────┘   └─────────────┘    └──────┬───────┘
          │                                      │
          │ drives improvement across             │ feeds data to
          ▼                                      ▼
   ┌─────────────┐   ┌─────────────┐    ┌──────────────┐
   │ Testability  │   │ Security    │    │ Cost          │
   │ (quality)    │   │ (trust)     │    │ Governance    │
   └─────────────┘   └─────────────┘    │ (operational) │
                                         └──────────────┘
   ┌─────────────┐   ┌─────────────┐    ┌──────────────┐
   │ Resilience   │   │ State       │    │ Human-Agent   │
   │ (operational)│   │ Integrity   │    │ Interface     │
   └─────────────┘   │ (quality)   │    │ (trust)       │
                      └─────────────┘    └──────────────┘
   ┌─────────────┐
   │Extensibility │
   │ (platform)   │
   └─────────────┘

Key relationships:
  Observability → feeds → Incident-Driven Kaizen (can't track incidents you can't see)
  Incident-Driven Kaizen → feeds → Autonomous Kaizen (incidents drive prioritization)
  Autonomous Kaizen → drives improvement across → all other horizons
  Cost Governance → constrains → Autonomous Kaizen (budget limits autonomous action)
  Human-Agent Interface → gates → Autonomous Kaizen L7 (trust required for auto-merge)
  State Integrity → enables → Resilience (can't recover what you can't reconcile)
  Security → constrains → Extensibility (new plugins need trust boundaries)
```

### 4.3 Candidates evaluated and excluded

| Candidate | Verdict | Reasoning |
|-----------|---------|-----------|
| Speed | Not a horizon | Cross-cutting metric improved through other horizons. Response latency is a Human-Agent Interface concern. |
| Explainability | Duplicate | Human-Agent Interface L1-L3 IS explainability. |
| Usability | Duplicate | Split: vertical experts → HAI, developers → kaizen system. |
| Profitability | Not a horizon | Cost side = Cost Governance. Revenue = vertical-specific business logic. |
| Delivery Velocity (DORA) | Overlaps Autonomous Kaizen | Lead time and deployment frequency are measurable aspects of the autonomy scale. |
| DX / Friction Tracking | IS the kaizen system | Incident-Driven Kaizen captures friction. Observability measures it. |
| Deployment / Service Continuity | Sub-dimension | Resilience (recovery) + Autonomous Kaizen (auto-deploy). |
| Isolation | Mechanism, not horizon | Like enforcement — it's HOW you achieve L3 on Security, State Integrity, Resilience. |
| Agent Capability / Skill Routing | Premature | One agent type. Becomes relevant at Autonomous Kaizen L6+. |
| Dependency Management | Sub-dimension | Testability (contract testing) + State Integrity (version drift). |

## 5. Individual Horizon Taxonomies

Each horizon below follows the established convention: Problem → Taxonomy → You Are Here → What Exists → Next Step → Relationship to Other Horizons.

Existing formalized horizons are referenced, not repeated:
- **Autonomous Kaizen:** [`docs/horizons/kaizen.md`](horizons/kaizen.md)
- **Incident-Driven Kaizen:** [`docs/horizons/incident-driven-kaizen.md`](horizons/incident-driven-kaizen.md)
- **Testability:** [`docs/test-ladder-spec.md`](test-ladder-spec.md)

### 5.1 Observability

*"You can't improve what you can't see."*

**Problem:** Agent sessions are black boxes. A PR appears — no visibility into what the agent did, why it chose that approach, what it tried and rejected, or how much it cost. Patterns across sessions are invisible.

| Level | Name | What you can answer | Mechanism |
|-------|------|---------------------|-----------|
| **L0** | Blind | "Did something happen?" (maybe) | Nothing. Check git log. |
| **L1** | Output logs | "What happened?" (after the fact) | Session logs, CI results, pino logger |
| **L2** | Structured telemetry | "How much did this cost? What did the agent touch?" | Token cost, wall time, tool calls per case — queryable |
| **L3** | Decision tracing | "Why did the agent choose this approach?" | Key decisions logged with rationale and alternatives |
| **L4** | Anomaly detection | "Is this session behaving unusually?" | Baselines established, alerts on unusual duration/scope/cost |
| **L5** | Pattern analytics | "Which issue types produce the most rework?" | Cross-case analysis, outcome correlation |
| **L6** | Predictive | "This case will probably fail — here's why." | Historical patterns predict failure modes |

**You Are Here:** L1. pino logger, `api_usage` table, `task_run_logs`. Ephemeral session logs. No structured events.

**What exists:** pino logger (L1), `api_usage`/`usage_categories`/`task_run_logs` tables (L1), telemetry spec design doc (L2-3 design, `docs/kaizen-telemetry-and-investigations-spec.md`).

**Next step (L1→L2):** Structured event emission on tool calls, file operations, session boundaries. Stored per-case in SQLite, queryable via CLI.

**Signal to escalate:** Post-incident analysis repeatedly requires reconstructing "what was the agent thinking?" from git diffs.

**Relationships:** Feeds Incident-Driven Kaizen, feeds Cost Governance, enables Autonomous Kaizen L6+.

### 5.2 Resilience

*"The fix isn't done until the outcome is verified. But what happens when the fixer crashes mid-fix?"*

**Problem:** Agents fail in ways humans don't: context overflow, API outages mid-session, hallucinated paths, infinite tool loops. Aftermath is unpredictable: half-committed changes, orphaned worktrees, inconsistent case status.

| Level | Name | What survives a failure | Mechanism |
|-------|------|------------------------|-----------|
| **L0** | Fail-and-forget | Nothing. Human discovers and cleans up. | None |
| **L1** | Failure detection | System knows a session failed. WIP preserved. | Push-before-die, timeout, IPC reaper |
| **L2** | State preservation | All WIP recoverable without archaeology. | Recovery manifests, structured WIP snapshots |
| **L3** | Automatic retry | Transient failures retried with backoff. Permanent failures classified. | Error classification, retry policies |
| **L4** | Graceful degradation | Subsystem down → reduced mode, queue work. | Circuit breakers, fallback paths |
| **L5** | Proactive resilience | Recovery paths periodically verified. | Chaos testing for agent systems |
| **L6** | Self-healing | Orphaned state detected and repaired continuously. | Background reconciliation |

**You Are Here:** L1. Container timeout, IPC reaper, cursor rollback, push-before-die (spec'd). 30+ inconsistent catch blocks in index.ts.

**What exists:** `CONTAINER_TIMEOUT` (L1), IPC reaper (L1), cursor rollback (L1), download retry with backoff (L1), push-before-die (spec'd L1).

**Next step (L1→L2):** Recovery manifest on session start (case ID, branch, intent). On clean exit, delete it. On next session start, check for orphaned manifests.

**Signal to escalate:** Agents keep dying on transient failures (API rate limits) instead of retrying.

**Relationships:** Enables Autonomous Kaizen L7+, State Integrity enables Resilience, Observability feeds failure detection.

### 5.3 Cost Governance

*"The most dangerous agent is the one that spends money as fast as the API allows, with nobody watching."*

**Problem:** Agents consume expensive API tokens with no natural governor. Human teams are salaried. Agents spend at API speed. No ceiling on kaizen loops creating sessions.

| Level | Name | What's controlled | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | No awareness | Nothing. Invoice arrives. | None |
| **L1** | Tracking | "This case cost $X." | `api_usage` table, periodic reports |
| **L2** | Budgets | Per-case token budget. Warning + hard cap. | Budget in case record, agent receives remaining budget |
| **L3** | Proportional gating | Low-value tasks get smaller budgets. | Task-class-to-budget mapping |
| **L4** | Optimization | Detect waste: re-reading files, redundant CI, oversized context. | Token-per-outcome analytics |
| **L5** | Cost-quality tradeoffs | Auditable decisions: "skip extra tests, marginal value < $5 cost." | Decision framework with cost as input |
| **L6** | Autonomous resource management | Adjusts parallelism, model choice, context strategy. | Self-optimizing allocation |

**You Are Here:** L1. `api_usage`/`usage_categories` tables exist. Session cost visible. No enforcement, no budgets.

**What exists:** `api_usage` table (L1), `usage_categories` (L1), container timeout as time proxy (L1), usage tracking skill (L1 reference).

**Next step (L1→L2):** Budget field in case record. Agent prompt includes remaining budget. Hard cap via MCP enforcement.

**Signal to escalate:** Budget caps cause too many sessions killed mid-work because all tasks get the same budget.

**Relationships:** Constrains Autonomous Kaizen, Observability feeds Cost Governance.

### 5.4 Security

*"The developer is the attack surface."*

**Problem:** Threat model is qualitatively different: the developers are software. Prompt injection through issue descriptions, confused-deputy attacks, credential leakage through reasoning traces. Following every rule perfectly can still produce security failures.

| Level | Name | What's protected | Mechanism |
|-------|------|------------------|-----------|
| **L0** | Implicit trust | Nothing scoped. | None |
| **L1** | Least privilege | Min credentials per task type. | `case-auth.ts`, mount allowlist |
| **L2** | Credential lifecycle | Session-scoped tokens, rotation, revocation, audit. | `credential-proxy.ts` |
| **L3** | Input sanitization | Agent inputs treated as untrusted. | Validation at MCP boundary |
| **L4** | Blast radius containment | Compromised agent can't affect others. | Container isolation, network segmentation |
| **L5** | Threat modeling as process | New capabilities go through security review. | Review gate on MCP tool additions |
| **L6** | Autonomous security response | Anomalous credential usage auto-isolated. | Behavioral anomaly detection |

**You Are Here:** L1-2. Least privilege, credential proxy, mount security with 50 tests. Lifecycle management partial. Adversarial robustness untested.

**What exists:** `case-auth.ts` (L1), `mount-security.ts` (L1-2, 50 tests), `credential-proxy.ts` (L2), `sender-allowlist.ts` (L1), `SECURITY.md` (L1).

**Next step (L2→L3):** Input sanitization at MCP boundary. Issue descriptions, PR comments classified as untrusted input.

**Open question:** How to distinguish legitimate instructions in issues from adversarial ones? Open research problem — L3 may need defense-in-depth.

**Relationships:** Constrains Extensibility, constrains Autonomous Kaizen L7, Observability enables L4+.

### 5.5 Human-Agent Interface

*"The system's value is zero if its stakeholders can't tell whether it did the right thing."*

**Problem:** Product vision: non-technical vertical experts give tickets, system handles the rest. But output is technical: PRs, diffs, CI results. A printing workshop manager can't evaluate a PR. They either rubber-stamp (quality collapse) or refuse (throughput collapse).

| Level | Name | What the stakeholder experiences | Mechanism |
|-------|------|----------------------------------|-----------|
| **L0** | Raw output | PRs and diffs. Can't evaluate. | GitHub/Telegram notifications |
| **L1** | Summarized output | Plain-language summary of what changed and why. | Case summary, stakeholder-facing PR descriptions |
| **L2** | Impact-oriented | Changes in business terms. "Customers can filter by date." | Domain-aware summarization |
| **L3** | Structured approval | Routine auto-merges. Novel changes surface with decision framing. | Risk classification, approval tiers |
| **L4** | Trust calibration | Track approval quality. Adjust what surfaces. | Approval outcome correlation |
| **L5** | Proactive communication | Know when to notify and when to stay quiet. | Smart notification routing |
| **L6** | Collaborative reasoning | Structured dialogue. Options in domain terms. Reasoning captured and reused. | Decision-support framework |

**You Are Here:** L0. Telegram merge notification (technical title). Agent-generated case summaries (unstructured). PR descriptions developer-facing.

**What exists:** Telegram notification via `kaizen-reflect.sh` (L0), case summaries in messages (L0).

**Next step (L0→L1):** Stakeholder-facing summary attached to merge notification. Written for the vertical's audience, not developers.

**Signal to escalate:** Stakeholders consistently ask "but what does this mean for me?"

**Relationships:** Gates Autonomous Kaizen L7 (auto-merge needs stakeholder trust), IS the product interface, Observability feeds L4+.

### 5.6 State Integrity

*"An agent can follow every rule and still act on stale data."*

**Problem:** Multiple state stores: SQLite cache, GitHub Issues, git, IPC filesystem, container mounts. Multiple concurrent agents. Agent A reads case status, starts work, Agent B modifies the case. Agent A works against stale reality.

| Level | Name | What's consistent | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | No guarantees | Nothing. Read whatever is cached. | None |
| **L1** | Collision detection | Two agents can't start the same issue. | `ipc-cases.ts`, worktree locking |
| **L2** | Freshness guarantees | State verified current before acting. Stale reads rejected. | Refresh-before-act, TTL on cache |
| **L3** | Conflict resolution | Conflicting changes have defined resolution. | Merge policies, priority rules |
| **L4** | Transactional operations | Multi-step ops are atomic. Partial failures rolled back. | Transaction wrappers |
| **L5** | Causal ordering | Agent dependencies explicit and enforced. | Dependency graph between cases |
| **L6** | Reconciliation | Periodic consistency check across all stores. Auto-repair. | Background reconciliation |

**You Are Here:** L1. Collision detection, worktree locking, cross-worktree state isolation. No freshness guarantees on CRM data, no conflict resolution.

**What exists:** Collision detection (L1, `ipc-cases.ts`), worktree locking (L1, `cases.ts`), `state-utils.sh` (L1-2), CRM sync (L0-1, can overwrite — #120).

**Next step (L1→L2):** TTL on cached case records. Refresh from CRM before acting. Flag stale data in agent context.

**Signal to escalate:** Two agents produce conflicting changes and "whoever pushes first" is the only resolution.

**Relationships:** Enables Resilience, Observability feeds inconsistency detection, prerequisite for Scalability.

### 5.7 Extensibility

*"Clone template, fill in config, deploy."*

**Problem:** Adding a vertical, channel, or skill requires understanding the harness internals. Extension points exist but aren't documented as a coherent platform experience.

| Level | Name | What's extensible | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | Fork-and-modify | Nothing modular. | Source code |
| **L1** | Documented extension points | Channel registry, skills, vertical mounts documented. | CLAUDE.md, README.md |
| **L2** | Self-describing plugins | Skills declare triggers, channels self-register, verticals provide config contracts. | Registration APIs, config contracts |
| **L3** | Validated integration | New plugins tested against harness contract at install time. | Contract validation, integration tests |
| **L4** | Guided authoring | Scaffolding tools, templates for new verticals and skills. | `/contribute-skill`, vertical template |
| **L5** | Ecosystem | Third-party installable. Version compatibility enforced. | Package management, compat matrix |
| **L6** | Self-extending | System identifies missing capabilities and proposes plugins. | Autonomous Kaizen + gap detection |

**You Are Here:** L1-2. Channel self-registration (L2), skill branches (L1), vertical config contracts (L2), `/contribute-skill` (L1), `contract.json` (L2).

**Next step (L2→L3):** Integration tests that validate new skills against the existing contract before merge.

**Signal to escalate:** Multiple people attempt to add verticals/skills and repeatedly fail because guides are insufficient.

**Relationships:** Security constrains Extensibility, Testability supports Extensibility, L6 converges with Autonomous Kaizen L8.

## 6. Open Questions

1. **Should horizons be individual files or sections of one file?**
   Current convention: individual files in `docs/horizons/`. Testability is in `docs/test-ladder-spec.md`.
   **Lean: individual files** for new horizons that warrant full taxonomies (Observability, Resilience, Cost Governance, Security, HAI). Shorter horizons (State Integrity, Extensibility) can start as sections in the README and graduate to individual files when they accumulate enough detail.

2. **How should the reflection prompt reference horizons?**
   - (a) List all horizon names inline — risk: prompt bloat
   - (b) Reference `docs/horizons/README.md` by path — risk: agents may not read it
   - (c) List high-priority horizons inline, reference README for full list
   **Lean: (c).** List Observability, Cost, Resilience, HAI with one-line descriptions. Reference index for rest.

3. **How should "You Are Here" assessments stay current?**
   - (a) Manual update during kaizen reflection
   - (b) Automated from metrics (requires observability infrastructure)
   - (c) Updated during periodic Level C review
   **Lean: (a) initially**, upgrade to (c) when Level C is implemented.

4. **Should dormant horizons have docs?** Having a stub makes them findable.
   **Lean: yes**, one-paragraph stub.

## 7. Implementation Sequencing

### Phase 1: Foundation (this PRD → docs-only PR)

- Create `docs/horizons/README.md` (horizon index)
- Create individual horizon docs: `docs/horizons/observability.md`, `resilience.md`, `cost-governance.md`, `security.md`, `human-agent-interface.md`, `state-integrity.md`, `extensibility.md`
- Create stubs: `docs/horizons/scalability.md` (dormant), `docs/horizons/horizon-completeness.md` (meta)
- Update `.claude/kaizen/zen.md` with horizon discovery tower thesis
- Update existing horizon docs with "Relationship to Other Horizons" sections where missing

### Phase 2: Reflection integration

- Update `kaizen-reflect.sh` post-PR and post-merge prompts with horizon-aware questions
- Add Level B discovery question to both prompts
- Test: verify reflection prompt correctly references horizon index

### Phase 3: Periodic review

- Design Level C trigger (embed in `/pick-work` every Nth invocation, or dedicated skill)
- Implement review that reads horizon index, recent kaizen issues, checks for unclassified friction clusters

### Phase 4: Cross-horizon analytics (future)

- Requires Observability L2+ (structured telemetry)
- Cluster reflection friction by horizon
- Detect gaps: friction that doesn't map to any horizon
