---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Keep authority in the Host behind a Pi adapter

yaca will keep Sessions, credentials, model access, Workspace operations, and tool execution in the local Host; the browser consumes only yaca projections and commands. We rejected a browser-owned agent and exposing Pi wire or SDK types because either choice would spread Provider secrets, persistence, and upstream compatibility across the UI. A dedicated Pi adapter keeps SDK replacement and event semantics local and permits a deterministic fake at the same seam.
