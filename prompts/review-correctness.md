---
name: correctness
description: Logic errors (off-by-one, inverted conditions, null safety) and error handling (swallowed exceptions, missing error paths). The basics.
applies_to: pr
needs: [diff]
high_when:
  - "Diff introduces new branching logic, comparisons, loops, or arithmetic"
  - "Diff uses try/catch, async/await, or Promise chains"
  - "Diff modifies error paths, fallback values, or null-handling"
low_when:
  - "Docs-only or config-only changes"
  - "Pure deletions with no new logic"
  - "Diff only changes types, interfaces, or comments"
---

Your task: Review PR {{pr_url}} for logic errors and error handling failures.

You are checking two things: (1) does the logic produce correct results for all inputs, including boundaries and edge cases, and (2) do errors get surfaced to callers rather than swallowed?

## Review Dimension: Correctness

### Logic errors

- **Off-by-one**: loop bounds, array indices, `< N` vs `<= N`, fencepost conditions
- **Inverted condition**: `if (!condition)` when `if (condition)` was intended; negated compound conditions that violate De Morgan's law
- **Wrong comparison**: `<` vs `<=`, `==` vs `===`, string vs number coercion
- **Null/undefined safety**: `a.b.c` where `a` or `a.b` could be null; optional chaining that returns `undefined` and silently propagates
- **Boolean logic**: operator precedence (`a || b && c` = `a || (b && c)`), short-circuit order (left side should guard right side), double negation
- **Loop termination**: can a loop run forever? Does it process the first and last element correctly?
- **Unreachable branches**: conditions that can never be true given the types or guards already in place

**Trace every new function with these inputs:** null/undefined, empty string/array/object, zero, negative number, single-element array. Name the specific input that triggers each bug.

### Error handling

- **Empty catch**: `catch (e) {}` or `catch (e) { return null; }` — swallowed, caller can't distinguish failure from success
- **Log-then-mask**: `catch (e) { console.log(e); return defaultValue; }` — logs but still hides the failure from the caller
- **Unhandled failable operations**: `JSON.parse`, `readFileSync`, `execSync`, `fetch`, array destructuring of potentially-undefined results — no try/catch and no `.catch()`
- **Promise swallowing**: `.catch(() => {})` or unawaited async calls — silent failure
- **Fallback masking**: `catch` that returns a safe-looking default (empty array, false, 0) when downstream code will proceed as if the operation succeeded

## Instructions

1. Identify every function, conditional, loop, and arithmetic expression added or modified in the diff
2. For each: trace with null, empty, 0, negative, and boundary inputs — does it produce the correct result?
3. Find every `try/catch`, `.catch()`, and `|| fallback` pattern — is the error logged AND propagated, or just swallowed?
4. Find failable operations with no error handling — flag as MISSING

## Output Format

```yaml
{
  "dimension": "correctness",
  "summary": "<one-line summary>",
  "findings": [
    {
      "file": "<file path>",
      "line": "<line number or range>",
      "type": "<logic-error | error-handling>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<the specific bug, the input that triggers it, the correct behavior>"
    }
  ]
}
```

Rules:
- DONE: Logic is correct for all reachable inputs. Errors are surfaced to callers.
- PARTIAL: Works in the common case but has a named gap (specific boundary, specific failure mode that's masked).
- MISSING: Definite bug — wrong result for a reachable input, or error fully swallowed.

Every MISSING or PARTIAL finding must name the specific input or execution path that demonstrates the problem. "This might be wrong" is not a finding. Trace to a concrete failure.

If no issues found: return a single DONE finding.
