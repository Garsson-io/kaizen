# Horizon: Security

*"The developer is the attack surface."*

## Problem

The threat model for an AI-agent development system is qualitatively different from traditional AppSec. The developers themselves are software — susceptible to prompt injection, context manipulation, and confused-deputy attacks. An agent following every instruction perfectly can still leak credentials if its reasoning trace is exposed, or execute privileged operations if a work ticket contains adversarial instructions.

Without security governance:
- **Credential scope creep** — agents accumulate permissions as features are added, never reduced
- **Prompt injection is unmitigated** — issue descriptions, PR comments, user messages are trusted input
- **Blast radius is unbounded** — a compromised agent could reach beyond its case
- **Trust boundaries are implicit** — who can do what is documented but not mechanistically enforced everywhere

## Taxonomy

| Level | Name | What's protected | Mechanism |
|-------|------|------------------|-----------|
| **L0** | Implicit trust | Nothing scoped. Agents get whatever they need. | None |
| **L1** | Least privilege | Min credentials per task type. Work: read-only. Dev: repo-scoped write. | `case-auth.ts`, mount-security allowlist |
| **L2** | Credential lifecycle | Session-scoped tokens. Rotation. Revocation on case completion. Audit log. | `credential-proxy.ts`, token management |
| **L3** | Input sanitization | Agent inputs treated as untrusted. Defense against prompt injection. | Input validation at MCP boundary |
| **L4** | Blast radius containment | Compromised agent can't affect other agents, cases, or the harness. | Container isolation, network segmentation |
| **L5** | Threat modeling as process | New capabilities go through security review with agent-specific threats. | Security review gate on MCP tool additions |
| **L6** | Autonomous security response | Anomalous credential usage auto-detected and auto-isolated. | Behavioral anomaly detection |

## You Are Here

**L1-2.** Principles are right — least privilege, credential proxy, mount security. Lifecycle management is partial (tokens aren't session-scoped or auto-revoked). Adversarial robustness (prompt injection) is untested.

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| `case-auth.ts` | L1 | Authorization gates (dev vs work, active vs suggested) |
| `mount-security.ts` | L1-2 | Mount allowlist, blocked patterns, symlink check — 50 tests |
| `credential-proxy.ts` | L2 | Real credentials never enter containers |
| `sender-allowlist.ts` | L1 | Per-group access control |
| `SECURITY.md` | L1 | Trust model documentation |

## L2→L3: Input Sanitization (next step)

**Problem L3 solves:** An adversary crafts a GitHub issue description containing instructions that, when read by the agent as context, cause it to execute unintended operations (exfiltrate data, modify unrelated files, escalate privileges).

**Rough shape:** Input sanitization layer at the MCP boundary. Agent inputs (issue titles, descriptions, PR comments, user messages) are classified as untrusted. The system either strips potential injection patterns or presents them to the agent as explicitly-untrusted data blocks.

**Open question:** How to distinguish legitimate instructions in issues (which agents should follow) from adversarial instructions (which they shouldn't)? This is an open research problem. L3 may need defense-in-depth (multiple mitigations) rather than a single solution.

**Signal to escalate to L4:** Any incident where an agent's behavior was influenced by content in an issue/message in a way that crossed case boundaries.

## L4–L5: Visible but not designed

**L4 (blast radius containment):** Problem: a fully compromised agent has access to whatever its container has. Need: network segmentation (agents can't reach other agents' containers), filesystem isolation (already via containers, but verify for shared mounts), API scope (GitHub token scoped to single repo, not org).

**L5 (threat modeling as process):** Problem: new MCP tools are added for functionality without considering how an adversary would abuse them. Need: threat review checklist for new tools. "If an agent is tricked into calling this tool with adversarial input, what's the worst outcome?"

## L6: Horizon

**L6 (autonomous security response):** Behavioral baseline for agent credential usage. Alerts when an agent accesses repos outside its case, reads files outside its worktree, or makes API calls to unexpected endpoints. Auto-revocation on confirmed anomaly.

## What We Can't See Yet

Beyond L6, security becomes adversarial testing: red-team agents that probe for prompt injection vulnerabilities in MCP tools, test credential boundaries, and verify blast radius containment. This is Security's equivalent of Resilience L5 (proactive testing).

## Relationship to Other Horizons

- **Security constrains Extensibility** — new plugins need trust boundaries
- **Security constrains Autonomous Kaizen L7** — auto-merge requires confidence agents weren't manipulated
- **Observability enables Security L4+** — anomaly detection requires behavioral baselines
- **State Integrity supports Security** — credential state must be consistent across stores
