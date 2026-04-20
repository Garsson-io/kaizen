---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects agent-instructions section, installs git hooks, and files a tracking issue + plan so the install PR cleanly goes through kaizen's own enforcement. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Configure Kaizen for This Project

This skill walks through a **9-step sequence** that takes a host repo with kaizen freshly installed (via `/plugin install kaizen@kaizen --scope project`) and leaves it fully configured: config file + policies scaffold + CLAUDE.md injection + git hooks + a tracking issue with a stored plan, so the setup ceremony lands as a reviewable PR.

All step CLIs are idempotent — safe to re-run the whole skill if something partial happens.

---

## Step 1: Resolve the plugin root

The skill's internal scripts live under the plugin cache. Resolve the path robustly — **do not rely solely on `$CLAUDE_PLUGIN_ROOT`**, which is only set when Claude Code invokes hooks, not in ad-hoc Bash the agent makes (#1085 item 3).

Preferred: use the `detect` step's built-in fallback, which tries `$CLAUDE_PLUGIN_ROOT` first, then falls back to `claude plugin list --json`:

```bash
# If $CLAUDE_PLUGIN_ROOT is set, `detect` returns it.
# Otherwise `detect` parses `claude plugin list --json` and finds kaizen.
RESULT=$(claude plugin list --json 2>/dev/null | jq -r '.[] | select(.id == "kaizen@kaizen") | .installPath')
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$RESULT}"
echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
```

If that's empty, the plugin isn't installed. Tell the user:

```
/plugin marketplace add Garsson-io/kaizen --scope project
/plugin install kaizen@kaizen --scope project
/reload-plugins
```

Then re-run `/kaizen-setup`.

---

## Step 2: Preconditions — check `.claude/` is tracked

Project-scope install writes `enabledPlugins["kaizen@kaizen"]` into `.claude/settings.json`. If `.claude/` is in `.gitignore`, nothing propagates to collaborators and the install silently fails for the team (#1085 item 2).

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step precondition
```

If `status: "warn"`, the response tells you exactly which gitignore entry to fix. Replace `.claude/` with the narrower entries: `.claude/review-fix/`, `.claude/audit/`, `.claude/worktrees/`, `.claude/settings.local.json`.

---

## Step 3: Enable at project scope (#1063)

Activates the plugin for the team by writing `enabledPlugins["kaizen@kaizen"] = true` to the host's `.claude/settings.json`. Idempotent. Preserves all other keys.

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step enable
```

Activation lives ONLY in the project's `.claude/settings.json`, never in user-scope, and never alongside a `hooks` block — either of those re-creates the #1061 dual-load state (guarded by `scripts/kaizen-self-invariants.test.ts` and `kaizen-block-self-plugin-enable.sh`).

---

## Step 4: Create `kaizen.config.json`

**Auto-detect values first — do not stop to ask unless a value genuinely can't be derived.** The admin shouldn't have to answer three questions they could have answered from the repo itself.

Detect defaults:

```bash
NAME=$(basename "$(pwd)")

# Parse `git remote get-url origin` into `<owner>/<repo>`.
REMOTE=$(git remote get-url origin 2>/dev/null || true)
REPO=$(printf %s "$REMOTE" \
  | sed -E 's|^git@github\.com:|https://github.com/|; s|\.git$||; s|^https://github\.com/||')

# First non-empty non-heading line of README.md (or fallback).
DESCRIPTION=$(awk 'NF && !/^#/ { print; exit }' README.md 2>/dev/null \
  || echo "A kaizen-enabled project")
```

Now run config with the detected values. If you're in an interactive session and the values look wrong for the admin's intent, offer one confirmation prompt; otherwise proceed. In headless (`claude -p`) mode, proceed without asking.

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" \
  --step config \
  --name "$NAME" \
  --repo "$REPO" \
  --description "$DESCRIPTION" \
  --kaizen-repo "Garsson-io/kaizen" \
  --channel "none"
```

If `git remote get-url origin` returns nothing (fresh repo, no remote yet), the admin needs to set one before `--repo` can be filled — fall back to asking in that specific case only.

---

## Step 5: Scaffold policies + .gitignore entries

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step scaffold
```

Creates `.agents/kaizen/local/policies-local.md` if it doesn't exist. Also appends kaizen session-local entries to `.gitignore`: `.claude/review-fix/`, `.claude/audit/`, `.claude/worktrees/`, `.agents/kaizen/local/audit/`, `data/telemetry/`.

---

## Step 6: Inject CLAUDE.md section

Append the kaizen fragment to the host agent-instructions file (typically `CLAUDE.md`; `AGENTS.md` if present instead).

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step claude-md-inject
```

Idempotent — the CLI skips if the target already contains `<!-- BEGIN KAIZEN PLUGIN`. The fragment uses **skill names + GitHub URLs only** — no `{{KAIZEN_ROOT}}` placeholder, no local absolute paths. It survives kaizen version bumps and works on any collaborator's machine without substitution.

**Do not hand-roll this step.** Earlier prose-only documentation let agents skip it in headless mode; making it a CLI call makes the step mechanistic.

---

## Step 7: Install git hooks (epic #1059)

Installs kaizen's `pre-push` git hook into the host project. Detects the host's hook framework (pre-commit, husky, lefthook, raw `.git/hooks`, or none) and injects kaizen non-destructively. Idempotent.

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" \
  --step install-git-hooks --run-post-install true
```

**What gets installed:**
- `.kaizen-hooks/pre-push` — entry script (agent-env gate + dispatch to kaizen plugin)
- Framework-specific injection (one of):
  - pre-commit: adds `local` repo hook `kaizen-pre-push` to `.pre-commit-config.yaml`
  - husky: appends chain block to `.husky/pre-push`
  - lefthook: adds `pre-push.commands.kaizen-pre-push` to `lefthook.yml`
  - raw `.git/hooks/pre-push`: appends chain block
  - none: creates `.githooks/pre-push` and sets `git config core.hooksPath .githooks`

See `docs/git-hooks-design.md` for architecture.

---

## Step 8: File tracking issue + store plan (the ceremony)

Adopting kaizen is itself a kaizen — it deserves an issue, a plan, and a PR. This step files the tracking issue in the host repo and attaches a plan so the setup PR cleanly passes `enforce-plan-stored` (#1085 item 5).

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step ceremony
```

Idempotent: searches for an existing `chore(kaizen): configure kaizen plugin for <name>` issue first; creates one only if none exists. Stores a templated plan as a `kaizen:plan` attachment.

If this step returns `status: "error"` (e.g., `gh` not authenticated, user lacks issue permission), the admin files the issue manually — the rest of the install is still valid.

The returned `issueNumber` becomes the `Closes #N` on the setup PR.

---

## Step 9: Verify

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step verify
```

Reports per-check pass/fail. If anything fails, fix it and re-run.

---

## What happens next — you are entering kaizen

The admin now has a configured repo. Their next action will be: **commit these files + open the setup PR + clear the gates that fire along the way.** Tell them this explicitly. The ceremony they are about to walk through IS kaizen — running through it is the design, not a failure mode.

Concretely, they will hit (in order):

| Gate | When it fires | How to clear |
|---|---|---|
| `enforce-worktree-writes` | Any `Edit`/`Write` on `main` | `git worktree add ../<name> -b chore/kaizen-setup` — kaizen work happens in worktrees |
| `enforce-plan-stored` (Edit/Write) | First Edit/Write in the worktree | Already stored by Step 8 — declare the issue via `git config kaizen.issue <N>` or include `Closes #N` in the PR body |
| `enforce-plan-stored` (gh pr create) | `gh pr create` | Same plan, picked up via the PR body's `Closes #N` |
| `enforce-pr-review` | Post-push, every round | Deny message carries the exact two-step command (store-review-summary + re-run `gh pr diff`); or use `/kaizen-review-pr <N>` for a full review |
| `enforce-pr-reflect` | Post-merge | Reflection prompt; fill in what was learned |

**Do not treat these as obstacles.** Each gate is there to produce a durable artifact (plan, review, reflection). The discipline is the whole point of kaizen — if you bypass the gates, you lose the thing you just installed.

---

## Legacy workflow tasks table (for agents that prefer compact summaries)

| # | Task | Description |
|---|------|-------------|
| 1 | Resolve plugin root | `$CLAUDE_PLUGIN_ROOT` or `claude plugin list --json` |
| 2 | Precondition | Warn if `.claude/` is gitignored |
| 3 | Enable plugin | `enabledPlugins["kaizen@kaizen"] = true` |
| 4 | Create config | Run `--step config` |
| 5 | Scaffold policies | Run `--step scaffold` |
| 6 | Inject CLAUDE.md | Append fragment |
| 7 | Install git hooks | Run `--step install-git-hooks` |
| 8 | Ceremony | File tracking issue + store plan |
| 9 | Verify | Run `--step verify` |

## Idempotency

Every step is safe to re-run. Config overwrites; scaffold skips if exists; enable detects already-enabled; inject detects existing section; git-hooks detects existing chain markers; ceremony finds existing issue; verify re-checks.
