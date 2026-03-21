# Horizon: Horizon Completeness (Meta)

*"The tower has three floors and a mirror on the ceiling."*

## Problem

Horizons are currently discovered by a human (Aviad) who notices recurring friction in a category, names the category, and creates the taxonomy. Agents don't ask "is there a dimension of quality I'm not tracking?" — they only improve along dimensions already named in their prompts.

This creates a bottleneck: the system can only self-improve along dimensions a human has already identified. The autonomous kaizen vision requires the system to discover its own blind spots.

## Taxonomy

| Level | Name | How horizons are discovered | Mechanism |
|-------|------|----------------------------|-----------|
| **L0** | Human-discovered | Aviad notices patterns and prompts agents to think about them. | Manual |
| **L1** | Enumerated | Known horizons listed in `docs/horizons/README.md`. Agents reflect against the list. | Reflection prompt references horizon index |
| **L2** | Per-reflection discovery | Every reflection asks "does this friction reveal an untracked dimension?" | Level B question in `kaizen-reflect.sh` |
| **L3** | Periodic review | Every ~10 cases, review whether the horizon set is complete. | Level C review in `/pick-work` or dedicated trigger |
| **L4** | Evidence-driven | Horizon gaps detected from clustering "unclassified" friction across reflections. | Analytics on reflection data |
| **L5** | Self-evolving | The horizon set, the discovery process, and this meta-taxonomy all evolve based on accumulated data. | Full recursive closure |

## You Are Here

**L0 → L1.** This spec creates the enumerated horizon set (L1). The horizons framework spec designs L2 (per-reflection discovery question).

## The Horizon Discovery Tower

Three levels of reflection about horizons. Self-referential at the top — there is no Level D.

### Level A — Move along known horizons

**When:** Every reflection (post-PR, post-merge).

**What:** For each impediment, ask: "Which horizon does this touch? Where are we on that horizon? Should we move up a level?"

**Produces:** Kaizen issues targeting specific horizon levels (e.g., "move Observability from L1 to L2").

### Level B — Discover new horizons

**When:** Every reflection, one additional question.

**What:** "Does this friction reveal a quality dimension not covered by our existing horizons? (See `docs/horizons/README.md`.)"

**Produces:** Horizon-discovery kaizen issues with proposed taxonomy sketches. The issue goes through `/accept-case` before becoming a real horizon.

**This replaces the human as the horizon-discovery mechanism.**

### Level C — Review the horizon set

**When:** Periodic — every ~10 cases, or monthly, whichever comes first.

**What:** Read `docs/horizons/README.md`, read recent kaizen issues, and ask:
- Are there clusters of issues that don't map to any horizon?
- Is any horizon stale? (No movement in 20+ cases)
- Should two horizons merge? (Consistently mentioned together)
- Is there a gap that Level B hasn't caught?

**Produces:** Horizon updates (merge, split, retire, create) or confirmation that the set is correct.

### Why there's no Level D

Level C reviews Level B's output. Level B reviews Level A's coverage. Level C is self-referential — it can discover that IT needs updating. All three levels produce the same artifact type: horizon documents and kaizen issues. The recursion terminates because:

1. The artifact types are the same at every level
2. Level C can evaluate itself ("is our periodic review process catching gaps?")
3. Any hypothetical Level D ("review how we review how we discover horizons") would ask the same questions as Level C, just less frequently — that's a scheduling parameter, not a new level

## Implementation Plan

**L1 (Phase 1 — this PRD):** Create horizon index and individual docs. Reflection prompt references horizon names.

**L2 (Phase 2):** Add Level B question to `kaizen-reflect.sh`. One question, both prompts.

**L3 (Phase 3):** Add Level C trigger to `/pick-work` or create `/review-horizons` skill.

**Signal to escalate L2→L3:** Agents file horizon-discovery issues but nobody reviews them, or clusters of unclassified friction accumulate without being grouped into horizons.

## Relationship to Other Horizons

- **Horizon Completeness governs all horizons** — it determines whether the set is correct
- **Autonomous Kaizen L5 (meta-reflection) is the precursor** — meta-reflection asks "are we asking the right questions?" which is the same question Level B asks about horizons specifically
- **Observability enables L4** — evidence-driven gap detection requires structured reflection data
