# Horizon: Deployment Automation

*"Every manual step is a step that can fail silently."*

## Problem

Deploying changes — whether to a host project or to the kaizen plugin itself — involves manual steps that are undocumented, unrepeatable, and error-prone. Kaizen plugin updates require running `/kaizen-update` manually. Host project deploys (build, restart, health check) are SSH-driven with no rollback. The gap between "PR merged" and "change live" is a black box.

Without deployment automation:
- **Merged PRs aren't live.** Code-service drift accumulates silently after merge.
- **Rollbacks are manual.** A bad deploy requires SSH, git revert, rebuild — human time burned.
- **Health checks are visual.** No automated verification that a deploy succeeded.
- **Plugin distribution is ad-hoc.** `kaizen-setup`/`kaizen-update` work but have no validation or versioning guarantees.

## Taxonomy

| Level | Name | What you can answer | Mechanism |
|-------|------|---------------------|-----------|
| **L0** | Manual | "How do I deploy?" (you ask someone) | No procedure. Knowledge in heads. |
| **L1** | Documented | "What are the steps?" (checklist) | Written deploy procedure. Repeatable but manual. |
| **L2** | CI builds | "Is the artifact ready?" (automatic) | CI builds on merge. Human triggers deploy. |
| **L3** | Auto-deploy | "Is it live?" (automatic + verified) | Deploy triggers on merge. Health check confirms. Rollback on failure. |
| **L4** | Staged | "Is it safe?" (validated before production) | Staging environment. Smoke tests before promotion. |
| **L5** | Canary | "Is it better?" (gradual rollout) | Canary deploys. Metric comparison. Automatic rollback on regression. |

## You Are Here

**L1 (documented).** Kaizen plugin has `kaizen-setup` (install) and `kaizen-update` (pull + re-setup) skills. Plugin version tracked in `plugin.json`. CI runs typecheck + unit tests + E2E on every PR. But no automated deploy after merge — host projects must manually run `/kaizen-update`. No health check validates that an update succeeded. No rollback mechanism if an update breaks hooks.

Gaps: No post-update validation. No version compatibility checking between kaizen and host project. No automated notification when plugin updates are available.

## What Exists

| Artifact | What it does | Gaps |
|----------|-------------|------|
| `kaizen-setup` skill | Installs plugin, creates config, injects CLAUDE.md section | No validation of result; no idempotency guarantee |
| `kaizen-update` skill | Pulls latest, re-runs setup | No rollback if update breaks hooks; no compatibility check |
| `plugin.json` | Tracks plugin version | Version not checked against host requirements |
| CI pipeline | Typecheck + tests + E2E on PRs | No post-merge deployment step |
| `.claude/settings-fragment.json` | Hook registrations for host projects | Merge conflicts possible; no conflict detection (#667) |

## Next Steps

### L1 → L2: Automated build validation

1. **Post-update validation hook** — after `kaizen-update`, automatically run `npm run build && npm test` to verify the update didn't break anything. If validation fails, restore the previous version.
2. **Settings-fragment merge validation** — detect conflicts and stale entries during `kaizen-setup` (#667).
3. **Version compatibility manifest** — declare minimum kaizen version requirements so host projects can detect incompatible updates.

### L2 → L3: Auto-deploy with health check

1. **Post-merge plugin notification** — when kaizen merges a PR, notify host projects that an update is available (via GitHub issue or Slack).
2. **Health check after update** — run a subset of hook tests against the host project's configuration to verify hooks still work.
3. **Rollback mechanism** — if health check fails, restore previous kaizen version automatically.

## Relationship to Other Horizons

- **Extensibility** (#250) — plugin architecture must support versioned contracts for deployment to validate
- **Resilience** (#248) — rollback and health checks are resilience patterns applied to deployment
- **Observability** (#249) — deploy events should be telemetry-visible (when did each host last update?)
- **State Integrity** (#252) — settings-fragment merge is a state consistency problem
