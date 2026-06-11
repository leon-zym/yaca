---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Reconcile Session facts and guarantee durable at-most-once invocation

yaca will reconstruct committed conversation state from Pi-managed Session JSONL and keep realtime output as a replaceable Active Overlay, rather than persisting a second application event truth. Host/Workspace/Session/Run-scoped mutation intent is durable before its side effect: local mutations end committed/failed, only Prompt acceptance creates a Run envelope, and unproven commit/acceptance becomes Unknown Delivery while accepted Prompt without a terminal record becomes Outcome Unknown. Neither state is replayed automatically; scope-aware acknowledgement is required before new in-scope side effects. This sacrifices automatic recovery in crash windows because SDK and local commits cannot share the journal transaction, but avoids applying coding side effects twice.
