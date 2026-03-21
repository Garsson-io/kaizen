# Test Ladder — Specification

*"I want to become stronger."* Total victory — perfect testability, perfect validation — is the impossible ideal. We don't need to achieve it. We need to climb toward it, step by practical step.

## 1. Problem Statement

Projects accumulate tests at two extremes: unit tests that verify components in isolation, and manual/E2E tests that verify the system works in production. But between "components work in isolation" and "the system works in production" lies a large, uncharted gap.

### What fails in that gap

Real production incidents that passed all tests:

- **Type errors at boundaries**: Code compiled on one side but failed at runtime on the other. All unit tests passed. The system didn't start.
- **Interface mismatches**: Both sides tested with mocks that agreed with each other but not with reality. Runtime failure.
- **Path/config changes**: Unit tests mocked the filesystem or config. The real system couldn't access resources at runtime.

These bugs live at boundaries: between components, between services, between layers. No existing test crosses those boundaries with real components.

### The cost of the gap

Every bug at a component boundary requires a human to discover, diagnose, and fix. This is the single largest blocker to autonomous development. A dev agent that can't verify its changes work end-to-end must always defer to a human for the final "does it actually work?" check.

## 2. Desired End State

A dev agent makes a code change. It runs the test suite. If tests pass, the agent has justified confidence that the change works in production. Not certainty — certainty is the impossible ideal — but justified confidence proportional to the test coverage level achieved.

The test ladder provides:

1. **A shared vocabulary** — when someone says "this capability is tested at L8," everyone knows exactly what that means.
2. **A climbing strategy** — each rung is a piece of test infrastructure. Building rung N enables that level of testing for all capabilities.
3. **A capability matrix** — every capability has a current position on the ladder and a target position. We can see gaps and prioritize.
4. **Incremental progress** — no big bang. Each rung is independently valuable. Each capability can climb independently.

## 3. The Test Ladder

Thirteen rungs, ordered by infrastructure cost, determinism, and what they prove. The ladder has two dimensions: **infrastructure depth** (how much of the real system is exercised) and **security coverage** (a cross-cutting taxonomy).

### Infrastructure Rungs

#### L0: Static Analysis
**Cost:** Free (<10s). **Determinism:** 100%. **Requires:** Source code only.

TypeScript/language compilation, formatting, schema validation. Catches type errors, missing imports, declaration drift.

**What it proves:** Code is well-formed and type-safe.
**What it misses:** Everything about runtime behavior.

#### L1: Pure Unit
**Cost:** Free (<1ms/test). **Determinism:** 100%. **Requires:** Runtime only.

Isolated function tests. All dependencies mocked. No I/O, no filesystem, no network. Tests individual functions produce correct output for given input.

**What it proves:** Function logic is correct in isolation.
**What it misses:** Whether mocks match reality. Whether components work together.

#### L2: Integrated Unit
**Cost:** Free (<100ms/test). **Determinism:** 100%. **Requires:** Runtime, temp dirs, in-memory DB.

Multiple real components wired together. Real SQLite (`:memory:`), real file I/O in temp directories. No containers, no network, no external services.

**What it proves:** Components work together. Schema migrations work. File format contracts hold.
**What it misses:** Container/service behavior. Runtime configuration. Network I/O.

#### L3: Build Verification
**Cost:** Low (~30s). **Determinism:** 100%. **Requires:** Build toolchain (e.g., Docker).

Build artifacts are produced successfully. Code compiles in the target environment. System dependencies are installed and runnable.

**What it proves:** Build config is valid. All dependencies resolve. Code compiles.
**What it misses:** Whether the built artifact works at runtime.

#### L4: Service Boot + Registration
**Cost:** Low (~30s). **Determinism:** 100%. **Requires:** Build toolchain.

Service/container starts, tools register, API surface matches contract.

**What it proves:** Service boots. API surface matches expectations.
**What it misses:** Whether APIs work when called.

#### L5: Round-Trip (Stub External Services)
**Cost:** Low (~10s). **Determinism:** 100%. **Requires:** Build + stub server.

System receives input, calls stub external services, produces output with correct structure. No real external APIs.

**What it proves:** Input contract. Output contract. Internal pipeline.
**What it misses:** Host/orchestrator behavior. Real external API behavior.

#### L6: Host Pipeline Smoke
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** Build + stub APIs + testable host pipeline.

The critical missing rung in many projects. Full host-side pipeline exercised: input arrives → routing → processing → output delivery.

Tests the orchestration code that no other test exercises:
- Queue serialization and batching
- Input assembly (configuration, mounts, env, session state)
- Output parsing and formatting
- State persistence across requests

**What it proves:** The orchestrator can process a request from ingestion to delivery.
**What it misses:** Real external service behavior. Real API output.

**Prerequisites:** Refactor orchestrator for dependency injection. Often all dependencies are module-level globals — not testable without refactoring.

#### L7: Observable Pipeline
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** L6 infrastructure + structured event emission.

Same as L6, but the pipeline emits structured events at each processing step. Tests can assert not just on the final output but on the *sequence of internal decisions*:

```
request_received { id, sender, timestamp }
  → request_validated { allowed: true, rule: "allowlist-match" }
  → route_decided { handler: "handler-A", confidence: 0.95 }
  → processing_started { session_id: "abc", config: [...] }
  → output_produced { type: "response", target: "..." }
  → response_delivered { channel: "http", id: "..." }
```

**Why this matters for testing:**
- L6 tests "input in, output out." If it fails, you don't know WHERE in the pipeline it broke.
- L7 tests "input in, these 6 things happened in this order, output out." Failures are immediately localizable.
- The same event infrastructure enables production observability, debug logging, and cost attribution.

**What it proves:** Internal processing decisions are correct and traceable.

#### L8: Synthetic Input Injection
**Cost:** Medium (~60s). **Determinism:** 100%. **Requires:** L6 infrastructure + input adapters.

Instead of injecting inputs at the API/queue level (L6), inject them at the *adapter level*. A test adapter emits events indistinguishable from a real input source. The input traverses the same code path as a real request — parsing, validation, routing — and only then enters the pipeline.

**What this adds over L6:**
- Source-specific input parsing (different formats, protocols)
- Pattern matching and filtering
- ID resolution and sender extraction

**Example:**
```typescript
TestAdapter.injectInput({
  source: { id: "test-group-1", type: "group", name: "Test Group" },
  sender: { id: "user-123", name: "Test User" },
  content: "process this request",
  timestamp: Date.now()
})
// → assert: input processed, response sent via TestAdapter.sentOutputs
```

**What it proves:** Source-specific input handling works end-to-end.
**What it misses:** Real network I/O. Real source API quirks (rate limits, encoding edge cases).

#### L9: Real Service Loopback
**Cost:** High (~5-30s, requires credentials). **Determinism:** ~95%. **Requires:** Real service credentials, network access.

Send a real request through a real external service and verify it arrives, is processed, and produces a response visible through the same service.

**What this adds over L8:**
- Real network I/O (TLS, DNS, API auth)
- Real API behavior (rate limits, formatting, encoding)
- Real credential/OAuth flow

**What it misses:** Real AI/LLM behavior.
**Non-determinism sources:** Network latency, API rate limits, delivery timing. Mitigated with retries and generous timeouts.

#### L10: LLM Smoke (Real API, Controlled Prompts)
**Cost:** ~$0.01-0.05/test, 5-30s. **Determinism:** ~90%. **Requires:** Real API key.

First real LLM call. Carefully designed prompts with near-deterministic expected outputs. Verify the *structure* of the response, not exact wording.

**Examples:**
- "Reply with exactly the word PONG" → response contains "PONG"
- "What is 2+2?" → response contains "4"
- System prompt says "Always start responses with [OK]" → response starts with "[OK]"

**What it proves:** API credentials work. System can make real API calls. Basic prompt → response pipeline works.
**Cost control:** Use cheapest model (~$0.001/test). Run only on merge to main, not on every PR.

#### L11: LLM Tool Verification (Real API, Tool Calling)
**Cost:** ~$0.05-0.20/test, 10-60s. **Determinism:** ~85%. **Requires:** Real API key.

Agent calls specific tools in response to prompts. Verify the tool was called with correct parameters.

**Examples:**
- "Send a message saying 'hello'" → `send_message` called with text "hello"
- "Create a task called test-task for fixing the login bug" → `create_task` called with name containing "test-task"

**What it proves:** Agent understands tool definitions. Tool parameters are correct.
**What it misses:** Complex multi-step workflows. Judgment about *when* to use tools.

#### L12: Full Behavioral
**Cost:** ~$0.10-1.00/test, 30-120s. **Determinism:** ~70-80%. **Requires:** Real API key, possibly real services.

Complex multi-turn scenarios. Agent follows policies, respects restrictions, handles ambiguous routing, creates appropriate work items, asks for clarification when needed.

**These are probabilistic.** Run N times, expect >80% pass rate. Track pass rate over time. Flag regressions when rate drops.

**What it proves:** The system works as a product. Agent behavior matches intent.
**What it misses:** Nothing — this is the summit we climb toward.

### Summary Table

| Level | Name | Cost | Det. | Requires |
|-------|------|------|------|----------|
| L0 | Static Analysis | <10s | 100% | Source |
| L1 | Pure Unit | <1ms | 100% | Runtime |
| L2 | Integrated Unit | <100ms | 100% | Runtime + DB |
| L3 | Build Verification | ~30s | 100% | Build toolchain |
| L4 | Boot + Registration | ~30s | 100% | Build toolchain |
| L5 | Round-Trip (Stub) | ~10s | 100% | Build + stub |
| **L6** | **Host Pipeline** | **~60s** | **100%** | **Build + stub** |
| L7 | Observable Pipeline | ~60s | 100% | L6 + events |
| L8 | Synthetic Input | ~60s | 100% | L6 + adapters |
| L9 | Real Service Loopback | ~30s | ~95% | Real credentials |
| L10 | LLM Smoke | ~$0.02 | ~90% | Real API key |
| L11 | LLM Tool Verification | ~$0.10 | ~85% | Real API key |
| L12 | Full Behavioral | ~$0.50 | ~70% | Real API + services |

## 4. Security Testing Taxonomy

Security is a cross-cutting concern, not a single rung on the ladder. Each security category has a minimum infrastructure level required to test it meaningfully.

### S1: Input Validation
**Minimum level:** L1 (pure unit). **Determinism:** 100%.

Malformed inputs are rejected before they reach business logic. Covers: invalid JSON, SQL injection, path traversal in strings, oversized payloads.

**Gaps commonly found:**
- No fuzzing/property-based tests
- No null byte or Unicode edge case tests
- No payload size limit tests

### S2: Authorization Gates
**Minimum level:** L2 (integrated unit). **Target:** L6 (host pipeline).

Unauthorized actions are rejected at the gate. Covers: sender allowlists, action authorization, cross-scope restrictions, privilege levels.

### S3: Resource Isolation
**Minimum level:** L3 (build verification). **Target:** L6 (host pipeline).

Processes/containers can only access resources they're authorized to see. Read-only access is actually read-only. Blocked paths are inaccessible.

**Gaps commonly found:**
- No test verifies that a process *actually cannot* read a blocked path at runtime
- No test for symlink-based escapes
- No test that read-only resources are actually read-only

### S4: Session & Work Isolation
**Minimum level:** L6 (host pipeline). **Target:** L7 (observable pipeline).

Work item A's agent cannot see work item B's data, session, or workspace. Sessions don't leak across scopes.

### S5: Instance Isolation
**Minimum level:** L7 (multi-component). **Target:** L9 (real service loopback).

Staging and production instances cannot interfere. Different instance identifiers produce fully separated systems.

### S6: Input Source Security
**Minimum level:** L8 (synthetic input). **Target:** L9 (real service loopback).

Inputs from unauthorized sources are dropped before reaching the agent. Source authentication is valid. Outputs go to the correct recipient.

### S7: Behavioral Compliance
**Minimum level:** L12 (full behavioral). **Determinism:** ~70%.

Agent follows policies even when the LLM "wants" to do something else. Covers: hook compliance, data access policies, escalation behavior.

## 5. The Gap Analysis Framework

### Typical Strengths

**L0-L2:** Most projects have good coverage here. Unit tests, CI enforcement, static analysis.

**L3-L5:** Build verification and stub-based testing cover the deployment pipeline.

### Typical Critical Gaps

**1. L6 Host Pipeline — nobody tests the orchestrator.**
The central orchestration function often has zero test coverage. All dependencies are module-level globals, making it untestable without refactoring to dependency injection. This is typically the single highest-value improvement.

**2. No test crosses component boundaries with a real host.**
Stub tests verify components in isolation. L6 would test the host orchestrating components. Nobody tests the seam — the code that assembles input, passes state, parses output, and persists results.

**3. Session continuity is assumed, never verified.**
Session state is stored and passed to the next invocation. Tests mock this. Nobody verifies that a second request actually resumes where the first left off.

**4. External service behavior is entirely mocked.**
Every integration test mocks the external library. No test sends a real request or verifies real receipt. Service-specific edge cases are invisible.

## 6. Implementation Sequencing

```
Phase 1: L6 Foundation
  +-- Refactor orchestrator for dependency injection
  +-- Write host pipeline smoke tests (7-10 tests)

Phase 2: Observability & Adapters
  +-- Processing event emitter (L7)
  +-- Test input adapters (L8)

Phase 3: Real Services
  +-- Test service credentials setup
  +-- Real service loopback tests (L9)

Phase 4: LLM Testing
  +-- LLM smoke patterns (L10)
  +-- LLM tool verification (L11)
  +-- Behavioral test framework (L12)
```

Each phase is independently valuable. Phase 1 is the highest-value investment. Phases 2-4 can proceed incrementally.

## 7. Keeping the Ladder Current

### The Problem

The capability inventory and coverage matrix are only valuable if they reflect reality. A stale matrix is worse than no matrix — it creates false confidence. The inventory will rot through four predictable failure modes:

1. **New capability, no row.** Someone adds a feature. No one updates the inventory. The matrix silently becomes incomplete.
2. **Test added, matrix not updated.** Someone writes L6 tests. The matrix still says L1. The gap analysis overstates risk.
3. **Capability removed, row lingers.** A feature is deprecated. The matrix still tracks it. Noise accumulates.
4. **No enforcement on new work.** A dev case creates a new feature. Nothing prompts the agent to assess where it lands on the ladder.

### Maturity Scale for Inventory Currency

| Level | What | How it works | Failure mode |
|-------|------|-------------|-------------|
| **IC-1** | Instructions | This document says "update the inventory." Agents read it. | Agents forget. Inventory drifts silently. |
| **IC-2** | Prompted | A workflow step asks "which capabilities did you touch?" before work is marked done. | Agents dismiss the prompt. Inventory drifts slowly. |
| **IC-3** | Linked | Tests declare which capabilities they cover. Coverage can be computed from the test suite. | New capabilities without tests are invisible. |
| **IC-4** | Validated | CI checks that the inventory matches reality. | Requires defining "reality" precisely enough to check mechanistically. |
| **IC-5** | Self-updating | The inventory is generated from the codebase, not maintained by hand. Drift is impossible by construction. | Requires structured codebase. |

The immediate next step is IC-2 — make the workflow *ask the question*. When IC-2 fails repeatedly, that's the signal to escalate to IC-3.
