# Invariant Fixtures

Hand-written `--include-hook-events` fixtures that represent specific invariant-enforcement scenarios. Each fixture captures: "what hook events should appear when an agent attempts to violate invariant X".

Use these fixtures with the hook-gym validator:

```bash
npx tsx scripts/hook-gym.ts --validate-fixture fixtures/invariants/<name>.json --scenario <scenario>
```

## Purpose

Before the hook-gym live runner (PR 3 of epic #1028) lands, these fixtures let us:
- **Specify** what a correct invariant enforcement looks like, as data
- **Test** that enforcement hooks behave as specified (once #1036 lands)
- **Regression-guard** against silent hook drift

The validator is agnostic about where the timeline came from — hand-written fixture, captured live session, or replayed. That means once PR 3+ lands, the same fixture ground truth validates real runs too.

## Format

A fixture is either:
- A stream-json file (newline-delimited JSON, one event per line — the format `claude -p --include-hook-events --output-format stream-json --verbose` produces), OR
- A JSON array of event objects (more convenient for hand-writing)

Each event is either `hook_started` or `hook_response` per the schema in `scripts/hook-gym-schema.ts`.

## Current fixtures

See adjacent files for examples matching invariants from `docs/kaizen-invariants.md`, including review gate false-pass prevention for I27 and I28.
