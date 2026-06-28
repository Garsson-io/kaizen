# Host-Specific Kaizen Policies

These policies extend the generic kaizen policies for this project.
Add project-specific enforcement rules here.

## Known-failure ownership (#1481 / #1518)

A failing test is **never** invisible background noise. Before you merge:

1. **Run the real health path.** `npm run typecheck`, `npm test`, and
   `npm run test:hooks` (the last includes the Python hook lifecycle suite,
   `test_hooks.py`, which CI now runs with pytest installed — green CI no longer
   hides a red local hook suite).
2. **A failing test is one of two things, never a third.**
   - *Part of your change* → fix it before merge.
   - *A separate, pre-existing incident you believe is unrelated* → it must have
     an **owning OPEN issue** recorded in `.agents/kaizen/known-failures.json`
     (`{ test, issue, reason }`). Record the exact failing command/nodeid and the
     issue. "Probably unrelated / pre-existing noise" is not a disposition.
3. **Single owner under parallelism.** When multiple agents run at once, exactly
   **one** claims ownership of driving a known failure to resolution or explicit
   disposition. Do not assume another agent owns it.
4. **Enforcement is mechanical, not honor-system.**
   - `run-all-tests.sh` classifies every failure: owned-by-open-issue → logged
     and tolerated; otherwise the suite fails.
   - The `known-failures` CI job fails if any registry entry's owning issue is
     closed or missing (fix the test or re-file an owner).
   - The merge-readiness SSOT (`qualityVerdictBlockReasons`, consumed by both
     `enforce-merge-verdict` and `decideAutoMergeSafety`) blocks merge on a
     `testHealth: unowned-failures` signal; `test-health-verdict` is a
     terminal-critical entry in `docs/verdict-binding-inventory.md`.

<!-- Example:
10. Never install system packages on the host. System deps go in Dockerfiles.
11. All dev work must be in a case with its own worktree.
-->
