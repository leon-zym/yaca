---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Run one active coding-agent runtime

The MVP will operate one Active Session and one Run in a single Host process while allowing committed read-only inspection of other Sessions. Per-Session workers would enable parallel Runs but add process supervision, reconciliation, and failure modes before concurrency is a product requirement; the single runtime also matches the public session-replacement model. Desired model and Thinking changes made during a Run apply to the next Run rather than mutating the execution already underway.
