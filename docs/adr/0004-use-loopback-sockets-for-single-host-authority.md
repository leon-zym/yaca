---
status: accepted
date: 2026-08-19
supersedes: []
superseded-by: null
---

# Use loopback sockets for single-Host authority

yaca will use two exclusively bound loopback sockets, derived deterministically from the canonical data-root path, as the only single-Host authority fence. We rejected PID files and file-backed leases because PID reuse, stale cleanup, process pauses, and crash windows require fallible ownership inference; the kernel keeps socket exclusion during an event-loop pause and releases it on process death without recovery metadata.

## Consequences

The Host must bind both ports before application startup, roll back a partial or later startup failure, and release them only after bounded application shutdown. The finite port range intentionally fails closed: another root or unrelated process sharing either port prevents startup, even when no data ownership conflict exists. This conservative availability loss is preferable to overlapping Hosts, requires no on-disk `host.lock`, and can be rolled back in a future decision by replacing the fence behind the Host lifecycle seam rather than changing yaca's persistent data.

The port pair is produced from two independent 32-bit segments of the canonical root's SHA-256 digest, mapped into `49152–65535`; an equal second port advances by one with wrap. The pair is safe to expose as diagnostics, but it conveys no authority unless the process holds both sockets.
