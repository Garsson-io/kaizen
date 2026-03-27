---
name: schema-validation
description: Structured data crossing system boundaries is validated with zod (TypeScript) or pydantic (Python) — not raw JSON.parse / YAML.parse / dict. Catches the class of failure where LLM/agent output is trusted without verification. Also checks that JSON schemas for --json-schema are derived from zod/pydantic, never hand-rolled (Policy #14).
applies_to: pr
needs: [diff]
high_when:
  - "PR introduces or modifies agent/LLM output parsing"
  - "PR adds CLI handlers that accept --text or --file structured input"
  - "PR adds functions that call YAML.parse, JSON.parse, or dict-unpack on external/LLM data"
  - "PR adds a new subagent communication channel or structured output contract"
  - "PR adds or modifies --json-schema argument passing to claude -p"
low_when:
  - "Diff is pure type changes with no runtime parsing"
  - "Diff is docs or config only"
  - "Diff modifies existing validated paths without adding new parse calls"
---

Your task: Review PR {{pr_url}} for missing schema validation at structured-data boundaries.

You are reviewing whether the PR enforces schema validation (zod / pydantic / equivalent) wherever structured data crosses a system boundary — especially LLM/agent output. This is Policy #12, #13, and #14.

## Review Dimension: Schema Validation

**The failure pattern this catches:**

An agent produces a JSON block. The receiving code does `JSON.parse(text)` and immediately uses the result as if it's the right shape. When the LLM returns the wrong field name, a missing key, or trailing prose, the system silently stores garbage or crashes deep in a call stack with an unhelpful error.

Schema validation makes the contract explicit and the failure immediate and readable.

**What counts as a boundary:**

- LLM / subagent output parsed by any code
- CLI `--text` / `--file` / `--stdin` inputs that expect structured data
- External API responses used for logic (not just displayed)
- `gh` CLI output parsed as JSON
- JSON Schema objects passed to `claude -p --json-schema`

**What does NOT need schema validation:**

- Reading plain text (prose, markdown, free-form descriptions)
- Internal data that was already validated when it entered the system
- Passing already-typed TypeScript objects between functions

## Instructions

### Step 1: Find raw parse calls

Scan the diff for:
- `JSON.parse(...)` — any call not immediately followed by a schema `.parse()` or `.safeParse()`
- `YAML.parse(...)` — same
- `dict(...)` / `yaml.safe_load(...)` in Python without pydantic validation
- Type assertions (`as SomeType`) applied to externally-sourced data

For each, determine if the input comes from outside the process boundary (LLM output, CLI arg, file, gh response). If yes, it needs schema validation.

### Step 2: Check existing validations

For each schema validation found (zod `.parse()`, pydantic `.model_validate()`), check:
- Does the schema cover all fields the downstream code accesses? A schema that only validates `dimension` but not `findings` leaves `findings` unvalidated.
- Is the error handling on parse failure explicit and non-silent? (exit(1) with a message, not a swallowed catch)
- Is the schema exported so tests can use it directly?

### Step 3: Check prompt / schema alignment

If the diff modifies a prompt that specifies structured output format AND modifies the parsing code:
- Does the schema in the code match the structure described in the prompt?
- If the prompt changed the output shape, did the zod schema change too?

### Step 4: Check prose contamination

For any agent/subagent communication channel in the diff:
- Does the prompt instruct the agent to output ONLY the structured block (Policy #13)?
- Is there a "you may add prose commentary" line or equivalent? That's a MISSING finding.
- If the prompt is not in the diff but the parser is, flag it for review.

### Step 5: Check JSON schema derivation (Policy #14)

For any `--json-schema` argument to `claude -p` or equivalent structured-output enforcement:
- Is the JSON Schema object derived from the zod/pydantic model (e.g., `z.toJSONSchema(MySchema)` or `MyModel.model_json_schema()`)? → DONE
- Is it a hand-rolled object literal with no reference to the zod schema? → MISSING (two sources of truth that will drift)
- Is it derived from the schema but with manual overrides? → PARTIAL (explain what's overridden and why)

## Output Format

Output JSON only — no prose before or after the block.

```json
{
  "dimension": "schema-validation",
  "verdict": "pass",
  "summary": "<one-line: N boundaries validated / M raw parse calls found>",
  "findings": [
    {
      "requirement": "<boundary or parse call being evaluated>",
      "status": "DONE",
      "detail": "<specific file:line, what schema is used or missing, what the failure mode would be>"
    }
  ]
}
```

Rules for status:
- DONE: External/LLM data validated with zod `.parse()` / pydantic `.model_validate()` before use. Parse failure exits non-zero with a clear error. Schema is exported and testable. JSON schemas for `--json-schema` are derived from the zod/pydantic model.
- PARTIAL: Schema exists but incomplete (missing fields accessed downstream, error silently swallowed, schema not exported, JSON Schema partially hand-rolled alongside a zod schema).
- MISSING: Raw `JSON.parse` / `YAML.parse` / `dict` on external data with no schema validation. Or prompt permits prose in structured output (Policy #13 violation). Or JSON Schema hand-rolled instead of derived from zod/pydantic (Policy #14 violation).
