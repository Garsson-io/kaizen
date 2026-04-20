# Kaizen — Continuous Improvement Plugin for Claude Code

[![CI (main)](https://github.com/Garsson-io/kaizen/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Garsson-io/kaizen/actions/workflows/ci.yml?query=branch%3Amain)
[![CodeQL (main)](https://github.com/Garsson-io/kaizen/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Garsson-io/kaizen/actions/workflows/codeql.yml?query=branch%3Amain)
[![Coverage (main)](https://codecov.io/gh/Garsson-io/kaizen/branch/main/graph/badge.svg)](https://app.codecov.io/gh/Garsson-io/kaizen/tree/main)
[![TypeScript](https://img.shields.io/badge/lang-typescript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Node 22](https://img.shields.io/badge/node-22-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)](https://github.com/Garsson-io/kaizen/security/dependabot)

A process improvement methodology implemented as a Claude Code plugin. Kaizen provides enforcement hooks, reflection workflows, dev workflow skills, and a philosophical framework for autonomous, recursive self-improvement.

## What You Get

- **Enforcement hooks** — PR review loops, worktree isolation, test coverage checks, dirty file gates, kaizen reflection triggers
- **Dev workflow skills** — `/kaizen-pick`, `/kaizen-gaps`, `/kaizen-evaluate`, `/kaizen-implement`, `/kaizen-deep-dive`, `/kaizen-reflect`, `/kaizen-audit-issues`, `/kaizen-prd`, `/kaizen-plan`, `/kaizen-review-pr`, `/kaizen-zen`
- **Background agents** — `kaizen-bg` for post-PR reflection
- **Philosophy and policies** — the Zen of Kaizen, escalation levels (L1/L2/L3), verification discipline, engineering practices
- **Issue taxonomy** — labels, epics, horizons, incident recording format

## Installation

Installing kaizen is a **four-step sequence that must run to completion.** Stopping part-way leaves the plugin enabled but unconfigured — hooks fire without the project config they expect. Any agent doing the install must perform all four steps in the same session.

### Quick install (recommended — agents, read this)

Run these four commands, in order, from an interactive Claude Code session inside your host repo:

```
1. /plugin marketplace add Garsson-io/kaizen --scope project
2. /plugin install kaizen@kaizen --scope project
3. /reload-plugins
4. /kaizen-setup
```

> **`--scope project` is the right default for teams.** It writes marketplace + enabled-plugin entries into `.claude/settings.json`, which is checked into git, so every collaborator picks up kaizen on their next `git pull`. Use `--scope user` (the CLI default) only when you want kaizen just for yourself across many repos.

> **`/reload-plugins` is equivalent to restarting Claude Code** — it loads the skills registered by the plugin you just installed. Without it (or a restart), `/kaizen-setup` will not be available. **Agents**: do not hand the remaining steps to the human. Run `/reload-plugins` yourself, then run `/kaizen-setup` yourself, in the same session.

> **`/kaizen-setup` is mandatory, not optional.** It creates `kaizen.config.json`, scaffolds `.agents/kaizen/local/policies-local.md`, and injects a kaizen section into `CLAUDE.md`. Without it, kaizen's hooks run but have no config to read — you get warnings and fallbacks instead of enforcement. **The install is not complete until `/kaizen-setup` has finished.**

> **Headless mode (`claude -p`) is different.** `/reload-plugins` is an interactive-only slash command — a `claude -p` agent cannot invoke it and will correctly stop after step 2. Headless callers must start a second `claude -p` session after the install completes (the skill will be loaded in the fresh session) and run `/kaizen-setup` there. Interactive agents have no such restriction.

### You are done when

All four files exist in the host repo:

- `.claude/settings.json` — contains `"enabledPlugins": { "kaizen@kaizen": true }` (and a `marketplaces` block pointing at `Garsson-io/kaizen`)
- `kaizen.config.json` — project config (host name, repo, kaizen repo, taxonomy)
- `.agents/kaizen/local/policies-local.md` — project-specific policies scaffold
- `CLAUDE.md` — has a kaizen section injected

If any of those is missing, go back and run whichever of the four commands above was skipped.

### Install via the CLI (outside a Claude Code session)

If you're installing from a shell and not already inside `claude`:

```bash
1. claude plugin marketplace add Garsson-io/kaizen --scope project
2. claude plugin install kaizen@kaizen --scope project
```

Then open a Claude Code session in the repo and run `/kaizen-setup` (a restart or `/reload-plugins` is needed between install and setup so the skill loads).

### For local development

```bash
claude --plugin-dir /path/to/kaizen
```

**No Node.js required in your host project.** Kaizen runs from its own plugin directory.

## Updating

```
/reload-plugins
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
