# Horizon: Scalability (Dormant)

*Activates when 3+ verticals are active.*

## Why dormant

NanoClaw currently serves 1-2 verticals with a single operator. Scalability concerns (multi-tenant isolation, concurrent agent coordination, resource contention, distributed state) are real but premature to formalize. The relevant sub-concerns are currently covered by:

- **State Integrity** — multi-agent consistency
- **Resilience** — degradation under load
- **Cost Governance** — resource allocation across verticals

## When to activate

This horizon should be activated and given a full taxonomy when:

1. A third vertical is deployed, OR
2. Concurrent agent sessions regularly exceed 3, OR
3. State Integrity or Resilience issues are traced to scale rather than correctness

## Rough shape (not a taxonomy)

- L0: Single-user, single-vertical
- L1: Multi-vertical, sequential agents
- L2: Multi-vertical, concurrent agents, shared resources
- L3: Resource partitioning per vertical
- L4: Elastic scaling (spin up/down based on demand)
- L5: Distributed operation (multiple hosts)

This is speculative. The real taxonomy should be designed when the activation signal fires.
