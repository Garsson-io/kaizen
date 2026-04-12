To clear the kaizen reflection gate, submit a KAIZEN_IMPEDIMENTS JSON declaration:

  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [
    {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
    {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
    {"finding": "positive observation", "type": "positive", "disposition": "no-action", "reason": "why"}
  ]
  IMPEDIMENTS

Dispositions (in order of preference):
  1. fixed-in-pr — PREFERRED for fixes < 10 min / < 30 lines in files you already touched
  2. filed (with ref) — for fixes that would change the PR's scope or need design decisions
  3. incident (with ref) — record on an existing issue
  4. no-action (positive only, with reason)
  - "waived" is NOT valid (kaizen #198) — file it or reclassify as positive/no-action
  - Meta-findings MUST be filed or fixed-in-pr (waived is not allowed — kaizen #198)
  - FIX-FIRST RULE: Before filing, ask "can I fix this in < 10 min?" If yes, fix it now.
    Filing creates future context-reload cost. Fixing while you have context is faster.

If no impediments found: echo 'KAIZEN_IMPEDIMENTS: [] brief reason here'

For trivial changes only: echo 'KAIZEN_NO_ACTION [category]: reason'
  Categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

HOW CLEARING WORKS: Run your echo command (KAIZEN_IMPEDIMENTS or KAIZEN_NO_ACTION).
The gate clears automatically after the command completes — no extra step needed.
