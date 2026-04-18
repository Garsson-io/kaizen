# Plugin Lifecycle — What Hot-Reloads vs What Requires Restart

Claude Code loads plugin hook registrations into an **in-memory registry at session start**. Some kinds of on-disk changes are picked up on the next tool call; others only take effect after you restart Claude Code. Knowing the difference is load-bearing — the common symptom of the stale-registry bug is every `Bash` tool call emitting `PreToolUse/PostToolUse:Bash hook error — Failed with non-blocking status code: No stderr output`, with no indication which hook failed.

Canonical incident: [#1061](https://github.com/Garsson-io/kaizen/issues/1061). Structural fix: [#1063](https://github.com/Garsson-io/kaizen/issues/1063).

## Single source of truth

Kaizen distributes hooks **exclusively** via `.claude-plugin/plugin.json`. A project's `.claude/settings.json` is the **activation switch** (`enabledPlugins["kaizen@kaizen"]: true`), never a hook registry. This applies to host projects and to the kaizen repo itself — kaizen-on-kaizen runs the exact same load path a host project does.

If `.claude/settings.json` in any project has both `enabledPlugins["kaizen@kaizen"]=true` AND a `hooks` block registering kaizen's hooks, every hook fires twice and any mid-session plugin-state change silently breaks one source. That's the #1061 dual-load state — now guarded structurally:

- `kaizen-doctor`'s `single-registration-path` check FAILs when both sources have hook entries.
- `kaizen-block-self-plugin-enable.sh` blocks `git commit` of that combined state.
- `scripts/kaizen-self-invariants.test.ts` keeps kaizen's own repo from re-growing a hooks block.

## Hot-reload safe (no restart needed)

Changes to these files take effect on the next matching tool call in the same session:

| Change | Effect |
|---|---|
| Add/remove/edit hook entries in `.claude/settings.json` | Re-read before each tool call |
| Edit the body of a hook script (`*.sh`, `*.ts`) | Next invocation runs the new code |
| Add/remove entries in `.claude/settings.local.json` permissions | Applied immediately |
| Edit skill bodies under `.agents/skills/` | Picked up when the skill is next invoked |
| Edit CLAUDE.md / AGENTS.md | Next message |

## Requires Claude Code restart

Any mid-session change to these files leaves the hook registry stale until you restart. In the stale state, the registry keeps firing hooks against paths that no longer exist (or no longer match the intended behavior), producing silent `No stderr output` errors on every matching tool call.

| Change | Why restart is required |
|---|---|
| `.claude/settings.json` `enabledPlugins` edits | Plugin registration is resolved at session start |
| `~/.claude/plugins/installed_plugins.json` | Install index is read once |
| `~/.claude/plugins/cache/<name>/` create/delete | Cache → registry mapping is snapshotted at start |
| Marketplace add/remove/update | Marketplace list is cached in the session |
| Hook command path **renames** (moving `foo.sh` → `bar.sh`) | Registered path is still `foo.sh` until restart |
| Deleting a hook file that is still referenced in a registered config | Registry points at nothing; exec fails silently |
| Adding a new hook inside `.claude-plugin/plugin.json` of an already-loaded plugin | Plugin manifest is read at start |

## How to diagnose

Run the doctor:

```bash
npx tsx scripts/kaizen-doctor.ts
```

Sample output when the registry is stale:

```
[FAIL] plugin-double-install — "kaizen@kaizen" is in enabledPlugins AND project settings.json registers its own hooks …
[PASS] dangling-hook-paths — all 54 hook paths resolve.
[FAIL] stale-plugin-cache — installed_plugins.json has record for "kaizen@kaizen" but cache dir missing …
[FAIL] restart-needed — Claude Code restart REQUIRED — installed-plugins, project-settings changed since session start. …
[PASS] hook-exec-smoke — all 54 hook files executable.
```

Pass `--json` for machine output, `--quiet` to drop PASS lines.

The `restart-needed` check requires a session-start snapshot written by `.claude/hooks/kaizen-session-snapshot.sh` (registered as a SessionStart hook). Without that snapshot the check emits WARN, not FAIL.

## How to fix (uninstall recipe)

```bash
scripts/kaizen-uninstall-plugin.sh                # defaults to kaizen@kaizen
scripts/kaizen-uninstall-plugin.sh --plugin x@y   # other plugin
```

The script is idempotent — safe to run multiple times. It removes the `enabledPlugins` entry, the `installed_plugins.json` record, and the cache dir; then prints a loud restart banner. **Always restart Claude Code after running it.**

## Why the error message is so unhelpful

`Failed with non-blocking status code: No stderr output` is emitted by the Claude Code harness when a registered hook exits non-zero and produces no stderr. When the registered path is missing, the shell's `file not found` diagnostic is suppressed, so the harness has nothing to display. The result is an unactionable error on every tool call. A fix for this belongs upstream in `anthropics/claude-code`; until then, `kaizen-doctor` is the mechanical substitute.

## Rules of thumb

- **Touching plugin state → restart.** If you just edited `enabledPlugins`, the plugin cache, or the installed-plugins index, expect to restart.
- **Touching hook scripts only → keep working.** Bodies hot-reload.
- **When in doubt, run `kaizen-doctor`.** It will tell you.
