To clear the kaizen reflection gate, submit a KAIZEN_IMPEDIMENTS JSON declaration:

  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [
    {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
    {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
    {"finding": "positive observation", "type": "positive", "disposition": "no-action", "reason": "why"}
  ]
  IMPEDIMENTS

Dispositions: filed (with ref), incident (with ref), fixed-in-pr, no-action (positive only, with reason)
  - "waived" is NOT valid (kaizen #198) — file it or reclassify as positive/no-action
  - Meta-findings MUST be filed or fixed-in-pr (waived is not allowed — kaizen #198)
  - Positive findings accept no-action with a reason

If no impediments found: echo 'KAIZEN_IMPEDIMENTS: [] brief reason here'

For trivial changes only: echo 'KAIZEN_NO_ACTION [category]: reason'
  Categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

HOW CLEARING WORKS: Run your echo command (KAIZEN_IMPEDIMENTS or KAIZEN_NO_ACTION).
The gate clears automatically after the command completes — no extra step needed.
