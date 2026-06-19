---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Keep corrupt-tail evidence logical and zero-write

yaca will preserve a damaged Command Ledger unchanged and represent its unreadable range as logical Corrupt Tail Evidence rather than a quarantine directory or sidecar file. The descriptor exposes no path and can read only the captured range while the canonical ledger still has the same file identity, metadata, and tail digest; corruption immediately degrades the Host and blocks every mutation.

## Considered options

We rejected copying the tail into a deterministic sidecar. Node does not provide a portable `openat`-style operation that creates a child relative to an already verified directory descriptor, so a path-based check followed by sidecar creation retains a check-to-open race: a substituted parent could redirect the write outside `~/.yaca/`, while pre-validation or repair could mutate a symlink or hard-linked user file. Retrying validation narrows but cannot remove that window.

## Consequences

Corrupt-tail inspection is strictly read-only: no directory, evidence file, permission change, rename, or other metadata write occurs. Evidence remains valid only while the canonical ledger's device, inode, owner, link count, mode, size, modification/change times, path identity, range, and digest still match; any change fails closed. A Host restart reconstructs logical evidence by re-reading the unchanged ledger rather than reopening a durable copy. If a future runtime offers a safe descriptor-relative creation primitive, a new ADR may introduce physical evidence behind the same persistence seam.
