---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Keep corrupt-tail evidence logical and zero-write

yaca will preserve a damaged Command Ledger unchanged and represent its unreadable range as logical Corrupt Tail Evidence rather than a quarantine directory or sidecar file. The descriptor exposes no path and can read only the captured range while the canonical ledger and parent still have the expected identities and the ledger has the same metadata and tail digest; corruption immediately degrades the Host and blocks every mutation.

## Considered options

We rejected copying the tail into a deterministic sidecar. Node does not provide a portable `openat`-style operation that creates a child relative to an already verified directory descriptor, so a path-based check followed by sidecar creation retains a check-to-open race: a substituted parent could redirect the write outside `~/.yaca/`, while pre-validation or repair could mutate a symlink or hard-linked user file. Retrying validation narrows but cannot remove that window.

## Threat model

The MVP includes pre-existing and validation-visible symlinks, hard links, path escape, replacement, unsafe ownership or mode, wrong device/inode, and parent-identity changes; these fail closed. It excludes only a deliberate same-UID filesystem actor that exchanges the exact parent or leaf in the nanosecond-scale interval between the final successful identity check and the immediately following path mutation (`create`, `rename`, or cleanup `unlink`). An exchange visible at any earlier checkpoint remains in scope and must fail closed. Eliminating the final interval requires portable descriptor-relative create, rename, and unlink primitives that Node does not expose.

## Consequences

Corrupt-tail inspection is strictly read-only: no directory, evidence file, permission change, rename, or other metadata write occurs. Evidence remains valid only while the canonical ledger and parent identities plus the ledger's owner, link count, mode, size, modification/change times, range, and digest still match at validation points; an observed change fails closed. Writes capture the target's initial missing-or-existing `LeafState`, preserve it through every checkpoint, and verify open file and parent descriptors. Missing files use exclusive creation; existing files remain identity-bound and are never chmod-repaired. Atomic replacement rechecks target, parent, and temporary identities throughout create and rename. Cleanup unlinks only a proven temporary node; uncertainty retains the `0600` temporary and returns an opaque `retained_temporary` id without a path or automatic deletion. A Host restart reconstructs logical corrupt-tail evidence by re-reading the unchanged ledger rather than reopening a durable copy. If a future runtime offers safe descriptor-relative path-mutation primitives, a new ADR may strengthen the same persistence seam without changing recovery semantics.
