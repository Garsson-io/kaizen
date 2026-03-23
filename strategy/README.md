# strategy/

Machine-written batch memory. Files here are committed directly to `main`
by the auto-dent trampoline after each batch completes.

These are **not source code** — they are structured summaries of what each
batch accomplished, what it learned, and what it recommends for next runs.

The `strategy/` directory is exempt from the main-checkout commit block
(kaizen #703) because it is machine-generated data, not code that requires
PR review.

File naming: `{batch-name}.md` (e.g., `brave-dolphin.md`).
