# Review Dimensions Research

Research into the most important code review dimensions from industry tools, engineering playbooks, and static analysis systems, ranked for use as independent adversarial review prompts targeting autonomous agent-produced code.

## Sources Consulted

- Google Engineering Practices: code review guidelines (design, functionality, complexity, tests, naming, comments, style, consistency, documentation, context)
- Microsoft Engineering Playbook: reviewer guidance, engineering fundamentals checklist
- SonarQube: reliability, maintainability, security dimensions; bugs, vulnerabilities, security hotspots, code smells
- CodeClimate: 10-point technical debt assessment (argument count, complexity, duplication, nesting, file/method length)
- CodeRabbit: security, quality, performance, best practices, bugs; severity-tiered findings
- Anthropic PR Review Toolkit: 6 specialized agents (comment-analyzer, test-analyzer, silent-failure-hunter, type-design-analyzer, code-reviewer, code-simplifier)
- Garry Tan's gstack /review skill: structural safety, scope drift detection, two-pass adversarial review, test coverage analysis
- LinearB: statefulness, noise ratio, time-to-useful-signal for AI review tools
- ESLint / Semgrep: correctness rules, security taint analysis, style enforcement
- Forensic audits of AI agent PRs (Stack Overflow, Addy Osmani, Vivek Babu): scope creep, logic errors, over-engineering, hallucinated features, silent test failures

## Ranked Review Dimensions

### 1. Scope Fidelity

**Description:** Does the diff do what the issue/plan asked for -- nothing more, nothing less?

**What it catches that reading alone misses:** Autonomous agents frequently bundle unrequested refactors, stylistic changes, or speculative features into a PR. Reviewers experience this as noise. A dedicated scope-fidelity pass compares the diff against the issue spec line by line, catching additions and omissions that a general read-through normalizes away.

**Applies to:** both (PR + plan/issue context required)

**Estimated value for agent code:** **high** -- AI agents overshoot scope in 30-40% of PRs per forensic audits. This is the single highest-signal check for autonomous work.

### 2. Logic and Correctness

**Description:** Are there logical errors, off-by-one bugs, incorrect conditionals, or flawed control flow?

**What it catches that reading alone misses:** AI-generated code has 75% more logic/correctness errors than human code (194 per 100 PRs vs human baseline). A focused correctness pass forces the reviewer to trace execution paths and boundary conditions rather than pattern-matching code structure. Catches inverted conditions, short-circuit logic errors, and incorrect operator precedence.

**Applies to:** pr

**Estimated value for agent code:** **high** -- the dominant defect category in AI-produced code.

### 3. Error Handling and Silent Failures

**Description:** Are errors caught, logged, and surfaced appropriately? Are there empty catch blocks, swallowed exceptions, or inappropriate fallback behaviors?

**What it catches that reading alone misses:** Silent failures are invisible in a general review because the code "looks fine" -- it compiles, tests pass, and the happy path works. A dedicated hunter traces every error path and asks "what happens when this fails?" Catches missing error logging, catch blocks that return defaults instead of propagating, and try/catch around code that cannot throw.

**Applies to:** pr

**Estimated value for agent code:** **high** -- agents consistently produce code with inadequate error handling because their training optimizes for the happy path.

### 4. Test Quality and Coverage

**Description:** Do tests verify behavior (not just exercise code)? Are edge cases, error paths, and boundary conditions tested? Are assertions meaningful?

**What it catches that reading alone misses:** Agents frequently produce tests that achieve high line coverage but have weak assertions (assert result is not None), test implementation details rather than behavior, or miss critical edge cases entirely. A dedicated test analysis pass examines each test's assertion strength and identifies untested error paths.

**Applies to:** pr

**Estimated value for agent code:** **high** -- agents generate tests that look complete but verify nothing, creating a false sense of safety.

### 5. Security and Trust Boundaries

**Description:** Are inputs validated? Are there injection risks (SQL, command, prompt)? Are secrets handled correctly? Are authentication/authorization checks present where needed?

**What it catches that reading alone misses:** Security issues are contextual -- a function that looks correct in isolation may be dangerous when called with untrusted input. A security-focused pass traces data flow from external inputs to sensitive operations, checking for sanitization gaps. Catches hardcoded credentials, missing auth checks on new endpoints, and unvalidated user input reaching system calls or LLM prompts.

**Applies to:** pr

**Estimated value for agent code:** **high** -- agents lack threat modeling intuition and frequently omit security checks they weren't explicitly told to add.

### 6. Complexity and Over-Engineering

**Description:** Is the code unnecessarily complex? Are there premature abstractions, speculative generality, or abstractions that serve no current need?

**What it catches that reading alone misses:** Agents produce "impressive" code with unnecessary abstraction layers, generic frameworks for single-use cases, and configuration systems where a constant would suffice. A complexity-focused pass asks "could this be simpler?" for every abstraction and indirection. Catches wrapper classes that add no value, over-parameterized functions, and inheritance hierarchies that could be flat functions.

**Applies to:** pr

**Estimated value for agent code:** **high** -- over-engineering is the second most common agent defect after scope creep. Models optimize for appearing thorough.

### 7. Consistency and Codebase Conventions

**Description:** Does the new code match existing patterns, naming conventions, project structure, and architectural decisions?

**What it catches that reading alone misses:** Agents have limited context about codebase conventions. They introduce new patterns that conflict with established ones (e.g., using callbacks where the project uses promises, introducing a new logging framework alongside the existing one, or placing files in non-standard locations). A consistency pass compares the diff against existing code in the same area.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- significant but partially caught by linters. The architectural consistency (not just style) is what requires review.

### 8. API Design and Contract Integrity

**Description:** Are function signatures, return types, error contracts, and public interfaces well-designed? Do changes maintain backward compatibility?

**What it catches that reading alone misses:** Agents may change function signatures, add required parameters, or alter return types without updating all callers. A contract-focused pass examines every public interface change and traces its impact. Catches breaking changes to exported functions, inconsistent error return conventions, and missing type annotations on public APIs.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- agents are decent at local correctness but poor at cross-boundary contract awareness.

### 9. Dead Code and Leftover Artifacts

**Description:** Are there unreachable code paths, unused imports, commented-out code blocks, debug statements, or TODO comments that should have been resolved?

**What it catches that reading alone misses:** Agents leave behind scaffolding: console.log statements, commented-out alternative implementations, unused helper functions they generated but didn't end up calling, and placeholder TODOs. A cleanup pass scans for these artifacts systematically.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- very common in agent output but low severity per instance. High aggregate value for code hygiene.

### 10. Concurrency and State Management

**Description:** Are there race conditions, shared mutable state issues, missing locks, or unsafe concurrent access patterns?

**What it catches that reading alone misses:** Concurrency bugs are invisible in single-threaded testing and code reading. They require reasoning about interleaved execution. Catches unprotected shared state, missing await on async operations, non-atomic read-modify-write sequences, and event handler registration that could fire before initialization completes.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- agents rarely reason about concurrency correctly, but not all PRs involve concurrent code. High value when applicable.

### 11. Documentation Accuracy

**Description:** Do comments, docstrings, README updates, and inline documentation accurately reflect what the code does? Are they present where needed and absent where misleading?

**What it catches that reading alone misses:** Agents produce fluent documentation that sounds correct but describes what they intended to write rather than what they actually wrote. Comments may describe a previous iteration of the code. A documentation accuracy pass cross-references each comment against the actual implementation.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- agent documentation is fluent but frequently stale or aspirational.

### 12. Performance and Resource Efficiency

**Description:** Are there unnecessary allocations, N+1 query patterns, unbounded loops, missing pagination, or operations that scale poorly?

**What it catches that reading alone misses:** Performance issues require reasoning about scale -- code that works for 10 items may fail for 10,000. A performance pass examines loops, database calls, and memory allocation patterns, asking "what happens at 100x the expected load?" Catches nested loops over collections, synchronous I/O in hot paths, and missing caching for repeated expensive operations.

**Applies to:** pr

**Estimated value for agent code:** **medium** -- agents produce functionally correct but often inefficient code. Value depends heavily on the code's criticality.

### 13. Dependency and Integration Safety

**Description:** Are new dependencies justified? Are version constraints appropriate? Do integrations handle API failures, timeouts, and schema changes gracefully?

**What it catches that reading alone misses:** Agents add dependencies freely without considering bundle size, license compatibility, maintenance status, or security posture. An integration safety pass audits each new dependency and examines how external service calls handle failure modes.

**Applies to:** pr

**Estimated value for agent code:** **low-medium** -- agents occasionally introduce unnecessary dependencies but this is less frequent than other issues. Higher value for PRs that add new integrations.

### 14. Observability and Debuggability

**Description:** Can the code be debugged in production? Are there appropriate log statements, metrics, error context, and tracing hooks?

**What it catches that reading alone misses:** Agents produce code that works but is opaque in production. When something goes wrong, there are no breadcrumbs. A debuggability pass checks that error messages include context (which user, which input, which step), that significant operations are logged, and that failure modes are distinguishable from each other.

**Applies to:** pr

**Estimated value for agent code:** **low-medium** -- important for production code but not always applicable. Agents consistently omit observability unless prompted.

### 15. Plan Completeness and Sequencing

**Description:** Does the implementation plan cover all requirements? Are PRs sequenced to avoid broken intermediate states? Are dependencies between PRs identified?

**What it catches that reading alone misses:** This is a plan-level review, not a code-level one. It catches missing requirements that weren't translated into tasks, circular dependencies between planned PRs, and sequencing that would leave the system in a broken state between merges.

**Applies to:** plan

**Estimated value for agent code:** **medium** -- agents produce plans that look comprehensive but miss edge requirements and create implicit ordering dependencies.

## Selection Criteria for Adversarial Review Prompts

The dimensions above were selected based on:

1. **Independent evaluability** -- each can be assessed by reading the diff plus the issue/plan, without running the code
2. **Cost-effectiveness** -- each check is completable in a single LLM call ($0.10-0.20)
3. **Agent-specificity** -- dimensions ranked higher are ones where autonomous agents fail more often than human developers
4. **Orthogonality** -- each dimension catches a distinct class of defect with minimal overlap

## Recommended Implementation Priority

**Phase 1 (highest ROI for agent code):**
- Scope Fidelity (catches the #1 agent failure mode)
- Logic and Correctness (catches the #1 defect type)
- Error Handling and Silent Failures
- Test Quality and Coverage

**Phase 2 (strong value):**
- Security and Trust Boundaries
- Complexity and Over-Engineering
- Consistency and Codebase Conventions

**Phase 3 (situational value):**
- API Design and Contract Integrity
- Dead Code and Leftover Artifacts
- Concurrency and State Management
- Plan Completeness and Sequencing

**Phase 4 (polish):**
- Documentation Accuracy
- Performance and Resource Efficiency
- Dependency and Integration Safety
- Observability and Debuggability

## References

- [Google Engineering Practices - What to Look For](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [Google Engineering Practices - The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)
- [Microsoft Engineering Playbook - Reviewer Guidance](https://microsoft.github.io/code-with-engineering-playbook/code-reviews/process-guidance/reviewer-guidance/)
- [Microsoft Engineering Fundamentals Checklist](https://microsoft.github.io/code-with-engineering-playbook/engineering-fundamentals-checklist/)
- [SonarQube Rules Documentation](https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-rules/rules)
- [SonarQube Metrics Definition](https://docs.sonarsource.com/sonarqube-server/10.8/user-guide/code-metrics/metrics-definition)
- [CodeClimate Maintainability](https://docs.codeclimate.com/docs/maintainability)
- [CodeClimate 10-Point Technical Debt Assessment](https://codeclimate.com/blog/10-point-technical-debt-assessment)
- [CodeRabbit Review Instructions](https://docs.coderabbit.ai/guides/review-instructions)
- [Anthropic PR Review Toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit)
- [gstack /review Skill](https://github.com/garrytan/gstack/blob/main/review/SKILL.md)
- [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
- [Semgrep vs ESLint Comparison](https://semgrep.dev/blog/2021/javascript-static-analysis-comparison-eslint-semgrep/)
- [LinearB AI Code Review Benchmarks](https://linearb.io/blog/best-ai-code-review-tool-benchmark-linearb)
- [Code Smells for AI Agents - Stack Overflow Blog](https://stackoverflow.blog/2026/02/04/code-smells-for-ai-agents-q-and-a-with-eno-reyes-of-factory/)
- [The 80% Problem in Agentic Coding - Addy Osmani](https://addyo.substack.com/p/the-80-problem-in-agentic-coding)
- [Martin Fowler - How Far Can We Push AI Autonomy](https://martinfowler.com/articles/pushing-ai-autonomy.html)
- [Cortex Production Readiness Checklist](https://www.cortex.io/post/how-to-create-a-great-production-readiness-checklist)
- [8 Critical Components of a GitHub PR Review Checklist](https://www.pullchecklist.com/posts/github-pr-review-checklist)
