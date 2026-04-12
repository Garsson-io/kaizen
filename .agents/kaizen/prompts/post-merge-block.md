STOP BLOCKED: Post-merge workflow is incomplete.

{{PR_HEADER}}
You MUST complete these steps before finishing:

1. Run `/kaizen` — reflect on impediments, what you'd do differently, process friction
   (One /kaizen invocation clears ALL pending post-merge gates)
2. Mark the case as done (if a case exists for this work)
3. Sync main: `git -C {{MAIN_CHECKOUT}} fetch origin main && git -C {{MAIN_CHECKOUT}} merge origin/main --no-edit`
4. Update linked kaizen issue if applicable

IMPORTANT: Use the `/kaizen` skill to clear this gate. Do NOT use `KAIZEN_IMPEDIMENTS` or
`KAIZEN_NO_ACTION` — those clear a DIFFERENT gate (the pr-kaizen reflection gate).
The post-merge gate is ONLY cleared by invoking `/kaizen`.
