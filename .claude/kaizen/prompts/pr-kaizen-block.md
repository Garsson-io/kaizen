STOP BLOCKED: Kaizen reflection is incomplete.

{{PR_HEADER}}

You MUST submit a KAIZEN_IMPEDIMENTS declaration before finishing:

  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [{"impediment": "description", "disposition": "filed", "ref": "#NNN"}]
  IMPEDIMENTS

Or for no impediments: echo 'KAIZEN_IMPEDIMENTS: [] brief reason'

This is mandatory — every PR must have a structured reflection.

NOTE: This clears the pr-kaizen gate only. If you also have a post-merge gate,
you must separately run `/kaizen` to clear that.
