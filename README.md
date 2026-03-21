# Kaizen — Continuous Improvement Plugin for Claude Code

A process improvement methodology implemented as a Claude Code plugin. Kaizen provides enforcement hooks, reflection workflows, dev workflow skills, and a philosophical framework for autonomous, recursive self-improvement.

## What You Get

- **Enforcement hooks** — PR review loops, worktree isolation, test coverage checks, dirty file gates, kaizen reflection triggers
- **Dev workflow skills** — `/kaizen-pick`, `/kaizen-gaps`, `/kaizen-evaluate`, `/kaizen-implement`, `/kaizen-deep-dive`, `/kaizen-reflect`, `/kaizen-audit-issues`, `/kaizen-prd`, `/kaizen-plan`, `/kaizen-review-pr`, `/kaizen-zen`
- **Background agents** — `kaizen-bg` for post-PR reflection
- **Philosophy and policies** — the Zen of Kaizen, escalation levels (L1/L2/L3), verification discipline, engineering practices
- **Issue taxonomy** — labels, epics, horizons, incident recording format

## Installation

In any Claude Code session:

```
/plugin add Garsson-io/kaizen
```

This installs kaizen as a managed plugin. All skills, hooks, and agents are automatically registered. Then run `/kaizen-setup` to configure your project.

## Updating

```
/plugin update kaizen
```

## Configuration

Kaizen reads `kaizen.config.json` from your project root:

```json
{
  "host": {
    "name": "my-project",
    "repo": "org/my-project",
    "description": "What this project does"
  },
  "kaizen": {
    "repo": "Garsson-io/kaizen",
    "issueLabel": "kaizen"
  },
  "taxonomy": {
    "levels": ["level-1", "level-2", "level-3"],
    "areas": ["hooks", "skills", "testing"],
    "areaPrefix": "area/"
  },
  "notifications": {
    "channel": "none"
  }
}
```

## The Dev Work Skill Chain

```
/kaizen-gaps      (strategic: where should we invest?)
  -> /kaizen-pick     (select: which issue next?)
    -> /kaizen-evaluate   (scope: what to build?)
      -> /kaizen-implement  (execute: spec to code)
        -> /kaizen-reflect    (learn: what went wrong/right?)
```

## Philosophy

Run `/kaizen-zen` to see the full Zen of Kaizen. Key principles:

- **Compound interest** — small improvements compound. Large rewrites don't ship.
- **Escalation levels** — L1 (instructions) < L2 (hooks) < L3 (mechanistic). When L1 fails, escalate.
- **No promises without mechanisms** — "later" without a signal is "never."
- **It's kaizens all the way down** — improve the work, improve how you work, improve how you improve.

## Development

Kaizen uses kaizen on itself. Its `kaizen.config.json` points to itself.

```bash
npm install     # Install deps
npm run build   # Compile TypeScript hooks
npm test        # Run TS hook tests
npm run test:hooks  # Run shell hook tests
```

## License

MIT
