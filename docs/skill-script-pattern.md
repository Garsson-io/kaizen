# Skill-Script Pattern — How to Build Testable Skills

## The Pattern

Skills are markdown prompts that Claude interprets. Scripts are executable code that runs deterministically. The best skills combine both: **Claude decides WHEN and WHETHER; scripts handle HOW.**

```
SKILL.md (Claude orchestrates)
  │
  ├── reads structured output from scripts
  ├── makes judgment calls (which path, ask user, handle edge cases)
  ├── handles conversation and UX
  │
  └── calls: npx tsx src/<module>.ts --step <name> [args]
        │
        ├── deterministic execution
        ├── structured JSON output (status blocks)
        ├── testable with vitest
        └── single entry point, multiple steps
```

## Why This Works

| Concern | Who handles it | Why |
|---------|---------------|-----|
| "Should we do X?" | Claude (skill) | Requires context, judgment, user interaction |
| "How to do X" | Script (TS module) | Deterministic, testable, no LLM variance |
| "Did X work?" | Script (structured output) → Claude (interpretation) | Script emits facts; Claude explains to user |
| "What if X fails?" | Claude reads error output, decides next action | Error handling needs context |

## Anti-Patterns

### Shell scripts that manipulate JSON
```bash
# BAD: one quote in $NAME breaks everything
cat > config.json << EOF
{ "name": "$NAME", "repo": "$REPO" }
EOF
```
Use TypeScript with `JSON.stringify` — it handles escaping, types, validation.

### Shell scripts with complex jq pipelines
```bash
# BAD: fragile, hard to test, hard to debug
jq -s '.[0].hooks as $existing | .[1].hooks as $new | ...'
```
Use TypeScript — native JSON manipulation with type safety.

### Free-form text output from scripts
```bash
# BAD: Claude has to parse natural language
echo "Created 5 symlinks, 2 failed"
```
Use structured JSON output:
```json
{"step": "symlinks", "created": 5, "failed": 2, "errors": ["path/to/broken"]}
```

### Many small scripts instead of one module
```bash
# BAD: 6 scripts with shared logic duplicated across them
bash detect-install.sh
bash generate-config.sh
bash scaffold-policies.sh
```
One TS module with steps:
```bash
npx tsx src/setup.ts --step detect
npx tsx src/setup.ts --step config --name foo
npx tsx src/setup.ts --step scaffold
```

## What Stays as Shell

Simple operations that don't need testing:
- Checking if a directory exists
- `cat`-ing a file for Claude to read
- `chmod`, `mkdir`, `ln -sfn`
- Environment variable checks

Rule of thumb: **if the script produces or consumes JSON, it should be TS.**

## What Stays as Skill (Claude)

- User interaction (questions, choices, confirmation)
- Context-sensitive decisions (plugin vs submodule, skip vs run)
- Content injection into existing files (CLAUDE.md — needs understanding of surrounding content)
- Error interpretation and recovery suggestions
- Sequencing steps based on intermediate results

## Structured Output Convention

Scripts should emit one JSON status block per step:

```json
{"step": "detect", "status": "ok", "method": "plugin", "root": "/path/to/plugin"}
{"step": "config", "status": "ok", "path": "kaizen.config.json"}
{"step": "config", "status": "error", "error": "missing required field: host.repo"}
```

Claude reads these and decides what to tell the user or what to do next.

## Testing Strategy

The TS module is testable with vitest using temp directories:

```typescript
describe("kaizen-setup", () => {
  it("detects plugin install via env var", () => {
    const result = detectInstall({ cwd: "/tmp/proj", env: { CLAUDE_PLUGIN_ROOT: "/plugins/kaizen" } });
    expect(result).toEqual({ method: "plugin", root: "/plugins/kaizen" });
  });

  it("generates valid config", () => {
    const config = generateConfig({ name: "my-project", repo: "org/repo", description: "test" });
    expect(JSON.parse(config)).toHaveProperty("host.name", "my-project");
  });

  it("merges hooks without duplication", () => {
    const merged = mergeHooks(existingSettings, kaizenFragment);
    const bashHooks = merged.hooks.PreToolUse.find(h => h.matcher === "Bash");
    const commands = bashHooks.hooks.map(h => h.command);
    expect(new Set(commands).size).toBe(commands.length); // no duplicates
  });
});
```

## Reference Implementation

NanoClaw's `/setup` skill demonstrates this pattern:
- Skill markdown describes the flow and decision points
- `bash setup.sh` handles bootstrap (Node.js, deps)
- `npx tsx setup/index.ts --step <name>` handles each mechanical step
- Scripts emit structured status blocks
- Claude reads status, handles errors, asks user questions
