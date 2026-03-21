# Horizon: Extensibility

*"Clone template, fill in config, deploy."*

## Problem

Adding a new vertical, channel, or skill to NanoClaw requires understanding the harness internals. The channel registry self-registers at startup. Skills are modular. Vertical config contracts exist. But none of this is documented as a coherent "how to extend NanoClaw" experience. Each extension point was built for a specific need and happens to be reusable.

Without extensibility:
- **New verticals require Aviad** — non-developer operators can't add their own domain
- **Skill contributions are ad-hoc** — `/contribute-skill` exists but the integration testing story is manual
- **Breaking changes are invisible** — `contract.json` validates MCP surface but vertical compatibility isn't checked
- **The platform thesis is unproven** — "NanoClaw is a harness" is an aspiration until someone other than Aviad extends it

## Taxonomy

| Level | Name | What's extensible | Mechanism |
|-------|------|-------------------|-----------|
| **L0** | Fork-and-modify | Nothing modular. Understand the whole codebase. | Source code |
| **L1** | Documented extension points | Channel registry, skill system, vertical mounts documented. | CLAUDE.md, README.md |
| **L2** | Self-describing plugins | Skills declare triggers, channels self-register, verticals provide config contracts. System knows what's plugged in. | Registration APIs, structured config |
| **L3** | Validated integration | New plugins tested against harness contract at install time. Breaking extensions rejected. | Contract validation, integration tests |
| **L4** | Guided authoring | Scaffolding tools, templates for new verticals and skills. | `/contribute-skill`, vertical template |
| **L5** | Ecosystem | Third-party skills/channels installable. Version compatibility enforced. Upgrade paths tested. | Package management, compatibility matrix |
| **L6** | Self-extending | System identifies missing capabilities from user friction and proposes new plugins. | Autonomous Kaizen + capability gap detection |

## You Are Here

**L1-2.** Channel self-registration (L2). Skill branches for upstream contribution (L1). Vertical config contracts — `escalation.yaml`, `materials.json` (L2). `/contribute-skill` guide (L1). `contract.json` MCP surface validation (L2).

## What Exists

| Component | Level | Location |
|-----------|-------|----------|
| Channel registry | L2 | `src/channels/registry.ts` |
| Skill system | L1-2 | `.claude/skills/` |
| Vertical config contracts | L2 | `config/` in vertical repos, mounted at `/workspace/extra/{name}/config/` |
| `/contribute-skill` | L1 | `.claude/skills/contribute-skill/` |
| `contract.json` | L2 | MCP surface validation in CI |
| `nanoclaw-compat.example.json` | L1 | Compatibility declaration template |

## L2→L3: Validated Integration (next step)

**Problem L3 solves:** A skill contributor submits a PR that breaks an existing MCP tool. Today: discovered when CI runs (if covered) or at runtime (if not). L3: integration test that validates the new skill against the existing contract before merge.

**Rough shape:** CI step that runs `contract:check` against the PR's changes and verifies no existing tools are broken. For verticals: a `vertical:validate` command that checks the vertical's config files against the harness's expected schema.

**Signal to escalate to L4:** Multiple people attempt to add verticals or skills and repeatedly fail because the documentation/guides are insufficient — they need scaffolding, not just docs.

## L4–L5: Visible but not designed

**L4 (guided authoring):** Problem: adding a vertical requires reading CLAUDE.md, understanding mount conventions, writing config files from scratch, testing manually. Need: `nanoclaw create-vertical` that scaffolds directory structure, config templates, test harness, and docs. `/contribute-skill` already exists but is a guide, not a tool.

**L5 (ecosystem):** Problem: skills and channels are currently managed as git branches merged into forks. Need: skills as installable packages with version constraints. "This skill requires NanoClaw ≥2.1 and conflicts with skill X." The `nanoclaw-compat.json` pattern is the seed of this.

## L6: Horizon

**L6 (self-extending):** The system detects that users frequently ask for a capability it doesn't have (e.g., "summarize this PDF" when no PDF tool exists). It identifies the gap, searches for existing skills that could fill it, and either installs one or proposes creating one. This converges with Autonomous Kaizen L8 (self-modifying process).

## What We Can't See Yet

Beyond L6, the system becomes a platform in the full sense: third parties build and publish extensions, a marketplace exists, compatibility and security are managed automatically. This requires trust (Security horizon), validation (Testability horizon), and discoverability (Observability horizon) to all be at high levels.

## Relationship to Other Horizons

- **Security constrains Extensibility** — new plugins need trust boundaries
- **Testability supports Extensibility** — integration tests validate new plugins
- **Extensibility at L6 converges with Autonomous Kaizen L8** — self-extension and self-modification are the same capability
- **Human-Agent Interface interacts at L4+** — non-technical users need to understand what extensions do
