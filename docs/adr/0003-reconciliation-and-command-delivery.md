---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Reconcile Session facts and guarantee durable at-most-once invocation

yaca will reconstruct committed conversation state from Pi-managed Session JSONL and keep realtime output as a replaceable Active Overlay, rather than persisting a second application event truth. State-changing commands are durably recorded before adapter invocation, duplicate mutation identifiers return the same receipt, an unproven acceptance becomes Unknown Delivery, and a proven acceptance without a terminal record becomes Outcome Unknown; neither state is replayed automatically. This sacrifices automatic recovery in crash windows because the SDK call and yaca journal cannot commit atomically, but avoids silently applying coding side effects twice.
