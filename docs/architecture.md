# Architecture

## Architectural thesis

yaca is a local control plane around the public Pi Coding Agent SDK. A single Node Host owns all durable facts and side effects; the browser renders projections and submits typed commands. The Host coordinates one active coding-agent runtime and one Run, while allowing read-only inspection of other committed Sessions.

The architecture favors reconciliation over a second event-sourced truth. Pi-managed Session JSONL remains the conversation fact; realtime deltas form an Active Overlay and are replaced by an authoritative Committed Snapshot at durable boundaries.

## System context

```text
┌──────────────────────────── Browser ─────────────────────────────┐
│ Workspace / Session navigation                                  │
│ Conversation projection + Active Overlay                        │
│ Composer + model / Thinking Desired Settings                    │
│ Tool views + Inspector                                          │
└───────────────┬──────────────────────────┬───────────────────────┘
                │ versioned WebSocket      │ authorized HTTP
                │ commands/events          │ bootstrap/content
┌───────────────▼──────────────────────────▼───────────────────────┐
│                         yaca Host                                │
│ Gateway → Command Dispatcher → AgentRuntimeKernel                │
│             │                     │                              │
│   Workspace/Session catalogs     ├─ Command Ledger               │
│   Preferences / Content Store    ├─ Session Projector            │
│                                  └─ PiRuntimePort                │
└──────────────────────────────────────────┬───────────────────────┘
                                           │ PiSdkAdapter
                          ┌────────────────▼─────────────────┐
                          │ Public Pi Coding Agent SDK       │
                          │ Provider + Workspace filesystem │
                          └──────────────────────────────────┘
```

The Host serves the built Web application from the same loopback origin. HTTP is used for bootstrap and large content. One WebSocket carries every state-changing application command and every realtime event; there is no second mutation path.

## Module shape and dependency direction

```text
web ───────────────────────────────► contracts
host ──────────────────────────────► contracts
host ─► pi-adapter ─► @earendil-works/pi-coding-agent

web       -X-> pi-adapter / Pi SDK
contracts -X-> pi-adapter / Pi SDK
pi-adapter-X-> host / web
```

Recommended repository shape:

```text
apps/
  host/
  web/
packages/
  contracts/
  pi-adapter/
tests/
  contract/
  integration/
  e2e/
```

### AgentRuntimeKernel

`AgentRuntimeKernel` is the central deep module. Its interface accepts a typed command, returns a sync view, and exposes a projected event stream. Behind that seam it owns:

- the single active runtime and Active Session;
- the single serial mutation queue;
- Run phase and abort-to-idle behavior;
- exact Run identity checks for Stop;
- expected Session Version checks;
- Command Receipt lookup and transitions;
- persistent Run envelopes and restart reconciliation;
- Desired Settings and their next-Run application;
- a runtime projection epoch that changes on runtime replacement and Host restart;
- Pi session replacement, unsubscribe/resubscribe, and event translation;
- Active Overlay reconciliation into a Committed Snapshot.

Callers never receive an SDK `AgentSession` reference.

### PiRuntimePort

`PiRuntimePort` is a real seam with two adapters:

- `PiSdkAdapter` for the pinned public SDK;
- `ScriptedFakePiAdapter` for deterministic application and browser tests.

The adapter owns SDK-specific types, lifecycle, event names, error classification, SessionManager access, model lookup, Thinking Level support, tool details, and runtime replacement. The interface exposes yaca domain outcomes rather than mirroring every SDK method, so SDK changes remain local.

### Catalogs and stores

- `WorkspaceCatalog` owns registered canonical Workspace paths and display metadata.
- `SessionCatalog` lists durable Sessions and Trashed Sessions by registered Workspace, returns committed summaries without activating them, and restores trashed files without permanent deletion.
- `CommandLedger` durably records Host/Workspace/Session/Run-scoped mutation receipts, Prompt-only Run envelopes, risk acknowledgements, and terminal outcomes.
- `PreferenceStore` owns the persisted `system`, `light`, or `dark` theme preference returned by bootstrap.
- `ContentStore` ingests complete oversized content and returns scoped Content References.
- `SessionProjector` converts Pi facts into Product Turns, Assistant Steps, stable Content Blocks, tool executions, and error states.

Filesystem dependencies are tested with real temporary directories. They do not require a public `StorageBackend` seam in the MVP. Likewise, one local process does not justify `RuntimePlacement`, `SecretBackend`, or multi-tenant authorization modules.

## Runtime and concurrency model

The Host owns exactly one active Pi runtime. It may list and inspect many Sessions, but only the Active Session can accept a Prompt or mutate runtime settings.

Rules:

- A Prompt is accepted only in `idle` phase.
- One accepted Prompt creates one Run and one Product Turn.
- Pi model-response/tool-loop units become Assistant Steps within that Product Turn.
- A second Prompt during a Run returns `session_busy`.
- Abort must carry the caller's observed `runId`; the kernel rejects a missing or non-active identity and never interprets it as "abort whichever Run is current."
- Another Session may be inspected through a Committed Snapshot during a Run.
- Every Session mutation requires an idle runtime. During a Run, every Session other than the Active Session is read-only and the Active Session accepts only Run control and Desired Setting commands.
- Model and Thinking changes during a Run update Desired Settings only. The running Run retains its start snapshot; accepted Desired Settings are applied before the next Run.
- Abort moves through `stopping` and becomes terminal only after the Pi adapter reports idle.

This follows the public `AgentSessionRuntime` replacement model and avoids worker supervision before parallel Runs are a product requirement.

## Authority and persistence

Within the persistence threat model below, every yaca-owned persistent file is below `~/.yaca/`:

```text
~/.yaca/
  agent/       Pi credentials, models, settings, resources, Sessions
  app/         Workspace registry, preferences, schema metadata, Command Ledger
  content/     content-addressed complete tool output
  trash/       recoverably removed Sessions and restore metadata
  logs/        redacted operational logs
  run/         non-authoritative runtime artifacts
  tmp/         yaca-owned temporary files
```

The CLI establishes the root and all seven runtime directories before dynamically loading Host modules that import the SDK, and the Host also passes explicit paths wherever the public SDK accepts them. A missing directory is created, opened and identity-checked, then chmodded to exact `0700` through its descriptor. An existing directory must already be canonical, non-symlink, owned by the current user, and exactly `0700`; yaca never chmod-repairs it. The capability gate verifies actual writes.

Single-Host ownership is not a persistent fact. yaca writes no PID file, lease, `host.lock`, or diagnostic ownership metadata. Instead, it derives a stable pair of authority ports from the canonical data-root path: two independent 32-bit segments of its SHA-256 digest map into the loopback dynamic/private range `49152–65535`; if both map to the same port, the second advances by one with range wrap. The non-sensitive pair may appear in health diagnostics, but only the bound kernel sockets carry authority.

Before application initialization or HTTP listen, the Host exclusively binds both authority ports on `127.0.0.1`. It owns the data root only after both binds succeed. A conflict on either port fails closed; failure of the second bind releases the first before startup returns. Any later startup failure also releases the full fence. Process exit, crash, and `SIGKILL` let the OS release the sockets without stale-owner recovery.

The deterministic finite port range admits conservative false conflicts. Two different canonical roots that share either derived port cannot run together, and an unrelated local listener on either port also prevents startup. yaca accepts that availability cost rather than risk two Hosts mutating one data root; changing the root changes the derived pair. The choice and rejected PID/file-lease alternatives are recorded in [ADR-0004](adr/0004-use-loopback-sockets-for-single-host-authority.md).

Authority is divided by fact, not duplicated:

| Fact | Authority | Rebuild behavior |
|---|---|---|
| Conversation, branch, selected durable Session state | Pi-managed Session JSONL | Reopened through public SessionManager surfaces |
| Active Run and streaming partials | AgentRuntimeKernel memory plus minimum accepted Run envelope | Overlay is lost on Host crash; accepted nonterminal outcome remains unknown with a restart reason |
| Command delivery and terminal outcome | Command Ledger | Parsed from durable valid prefix |
| Run-to-Product-Turn identity | Minimum Run envelope in Command Ledger | Reconciled before Session content projection |
| Workspace registration | Workspace registry | Atomically replaced after fsync |
| Theme preference | Preference Store | Returned by bootstrap and broadcast after updates |
| Complete oversized output | Content Store | Addressed by digest and scoped metadata |
| Browser view | Host projection | Always replaceable by sync |

The durable JSONL module is a deep module at the persistence seam: reads and appends share one linear queue, so a read observes only an fsync-complete prefix and cannot race an append. A read captures the file size, rejects values above `268435456` bytes, allocates exactly the captured size, and rejects growth before returning. Before append, the module captures one initial target `LeafState`: `missing` must remain absent and is created with `O_EXCL`; `existing` binds the original safe file identity throughout the operation. Append opens first, revalidates the initial state, descriptor, canonical path, and parent identity, then writes and fsyncs only the verified descriptor. A corrupt tail permanently degrades that module instance and blocks every mutation; the original ledger remains byte-for-byte unchanged.

Corruption produces logical **Corrupt Tail Evidence**, not a quarantine directory, sidecar, copied tail, or Content Reference. Its interface exposes only an opaque id, byte length, and bounded read operation—never a filesystem path. The evidence binds the canonical ledger and parent identities, ledger owner, link count, mode, size, modification time, change time, valid-prefix offset, tail length, and tail SHA-256. Each evidence read opens the canonical ledger read-only with `O_NOFOLLOW`, reads only the captured range, and verifies descriptor, path, and parent identity again. Replacement, symlink or hard-link substitution, metadata or byte modification, and identity mismatch observable at those checks fail closed. Detecting or reading corruption performs no filesystem write, including no create, copy, rename, truncate, chmod, or metadata repair. [ADR-0005](adr/0005-keep-corrupt-tail-evidence-logical.md) records why yaca rejected a physical quarantine sidecar and the remaining path-operation limit.

The atomic JSON module captures the target's initial `LeafState` and revalidates that invariant after every persistence checkpoint, including before path creation, after temporary-file creation, and immediately before and after rename. It also verifies an open parent descriptor and the temporary-file identity, and it never repairs permissions on an existing target. Cleanup unlinks only a temporary node whose identity is still proven. If cleanup identity becomes uncertain, the module leaves the `0600` temporary in place, returns `retained_temporary` with only an opaque id and no path, and schedules no automatic deletion.

The Host does not maintain a durable copy of every realtime event. At settlement it reads the durable Session path again and replaces the Active Overlay with a Committed Snapshot. After restart it does the same without replaying transient deltas.

Workspace registration stores a canonical realpath plus a user-editable display name. Registration validates that the path exists, is a directory, is readable, searchable, and writable, and is not already registered through another spelling or symlink. Display-name changes never rename or move the Workspace.

Session trash moves the Session and restore metadata under `~/.yaca/trash/`. Trashed Sessions and referenced Content Store objects are retained indefinitely, appear in a trash list, and can be restored when the original Workspace remains registered and the destination does not conflict. The MVP exposes no permanent-delete command; users may manually clear the trash directory. Removing a Workspace registration never deletes Workspace files, Sessions, or trash.

An Active Session cannot be trashed while `running` or `stopping`. While idle, the Host preflights a fallback, disposes the runtime, increments its projection epoch, moves the Session, and chooses the most recently updated surviving Session in that Workspace or none. The committed event order is active-session change followed by trash-directory change. A post-dispose failure moves the file back and reopens the original under another epoch; failed compensation enters degraded mode without claiming trash success.

Theme preference is Host-owned application state. Bootstrap always returns `system`, `light`, or `dark`; an application command atomically persists updates under `~/.yaca/app/` and broadcasts the accepted value. Browser-local theme is only a pre-bootstrap rendering hint.

## Command delivery and recovery

The SDK does not provide an atomic transaction between a yaca command record and `prompt()`. yaca therefore promises durable at-most-once invocation, not exactly-once execution.

Every state-changing command records exactly one scope and canonical authority id: Host (`app`, `workspace-catalog`, or `selection`), Workspace id, Session id, or Run id. The exhaustive per-command mapping is part of the application protocol rather than inferred by handlers. Local mutations and runtime controls other than Prompt use `recorded → committed | failed | delivery_unknown`; `delivery_unknown` means durable intent exists but commit cannot be proven. Only `run.prompt` uses acceptance and creates a Run envelope:

1. The Host validates authentication, schema, phase, and expected Session Version.
2. It resolves the canonical receipt authority; for Prompt it also allocates the stable Run and Product Turn ids. It then appends a `recorded` Command Receipt and reaches a durability boundary.
3. It invokes the Pi adapter.
4. When public preflight behavior confirms Prompt acceptance, it appends one durable journal record containing the `accepted` Run-scoped receipt and a minimum Run envelope.
5. On a proven Prompt terminal outcome, it appends one durable journal record containing the terminal receipt and terminal Run envelope before publishing the terminal event. Other mutations append a scope-aware committed or failed receipt without creating a Run envelope.

A minimum Run envelope contains `runId`, `productTurnId`, `sessionId`, `workspaceId`, Prompt receipt identity, client mutation identity, runtime projection epoch, base Session Version and leaf identity, Run-start model/Thinking snapshots, acceptance time, and current Run state. It omits Prompt text and Provider credentials.

A duplicate mutation identifier returns its existing receipt and never invokes the adapter again. Recovery uses this strict priority:

1. A valid local committed/failed record or combined Prompt terminal journal record is authoritative.
2. A durable accepted Prompt receipt plus Run envelope without a terminal record becomes `outcome_unknown` with a Host-restart interruption reason; it is never rewritten to `interrupted`. Session JSONL content may be displayed but cannot upgrade the outcome.
3. Any recorded local intent without proven commit, and a recorded Prompt without durable acceptance, becomes `delivery_unknown`.
4. A corrupt journal tail leaves the original ledger unchanged, exposes only logical Corrupt Tail Evidence, and puts the Host in degraded mode with every mutation blocked.
5. Session JSONL is then reopened to rebuild committed content from the Run envelope's base identity.
6. A new runtime projection epoch is created, and every old-epoch Active Overlay event is discarded.

Neither Unknown Delivery nor Outcome Unknown is automatically replayed. Risk blocks mutations at receipt scope: Host, Workspace and descendants, Session and Runs, or the affected Run's Session side effects. After full application sync and explicit acknowledgement of that receipt, new in-scope mutation is allowed under current phase/version rules with a new mutation identifier. Reads and acknowledgement remain available; acknowledgement discovers target scope from the receipt and never requires a Session payload. The acknowledgement command itself is a Host `app` mutation; it does not relabel the target receipt's authority.

Recovery behavior:

- Browser reconnect: handshake, recent receipts, atomic sync, then buffered projected events.
- Sequence gap: stop applying deltas and request full application sync.
- Host restart: reopen the Session, rebuild the Committed Snapshot, classify recorded Prompt as Unknown Delivery or accepted nonterminal Prompt as Outcome Unknown, attach a restart reason for UI explanation, and remain idle.
- JSONL failure: preserve the source, expose the readable prefix if the public SDK permits it, and avoid writes until the user selects a safe recovery action.
- Command Ledger tail damage: preserve the ledger byte-for-byte, project the valid prefix, retain only logical Corrupt Tail Evidence for the unreadable range, block every mutation, and classify receipts as Unknown Delivery or Outcome Unknown from the last durable transition. A restart re-inspects the unchanged ledger and reconstructs evidence; it does not rely on a sidecar.

## Atomic sync and realtime ordering

Every runtime projection has an opaque `runtimeEpoch`. Host restart, active runtime replacement, Session activation, adapter resubscription, or projection reset creates a new epoch. Runtime-scoped events always carry it; a client discards an old-epoch event and requests sync rather than merging it into the current Active Overlay.

`connectionSeq` orders all application events for one connection. `app.bootstrap` and `app.sync` use a connection-global sequence barrier:

1. The connection event multiplexer pauses delivery and buffers newly assigned events.
2. The AgentRuntimeKernel serial queue reaches a barrier after all earlier state transitions.
3. Under that barrier, the Host captures the authoritative projection and the highest `connectionSeq` covered by it as `snapshotSeq`.
4. The Host writes the sync response before any post-barrier event frame on the same WebSocket.
5. The client atomically replaces its projection, runtime epoch, and last applied sequence with the snapshot and `snapshotSeq`.
6. The Host releases buffered events in ascending sequence order.
7. The client discards duplicates at or below its last applied sequence, accepts exactly `last + 1`, and starts another `app.sync` on a gap or epoch mismatch.

Each connection buffer is bounded by both event count and serialized bytes. Overflow fails the in-progress sync with `sync_buffer_overflow`, discards the buffer, and requires a fresh `app.sync`; it never emits a partial snapshot. `session.sync` is only a navigation/explicit-inspection read and never returns or advances the global watermark. A disconnected connection discards its buffer. Contract tests inject events before, during, and after the barrier and prove no transition is lost or applied twice.

Session and trash catalogs use revision-bound opaque cursors. A first page has no cursor or revision and returns the captured catalog revision, actual `appliedLimit`, and next cursor. Every continuation echoes that revision and limit; cursors bind catalog kind, Workspace filter, sort, limit, and revision. A concurrent catalog mutation yields `stale_catalog_revision`, while a mismatched bound limit yields `invalid_cursor`.

For each catalog identity, Web retains `currentObservedRevision`. A catalog-changing event updates it before invalidating old pages. A later ordinary list or workspace-selection page with a different revision is discarded in full and triggers a first-page refetch; it never rolls the observed revision back. The first ordinary response establishes the value only when none has been observed.

Bootstrap and app sync do not use that equality gate. Their `snapshotSeq` barrier atomically replaces all catalog pages and observed revisions, even when the client previously observed a different revision. Web then applies only buffered events above the installed watermark in sequence, allowing those events to advance revisions. `session.sync` is not a catalog operation and never changes a catalog revision.

## Projection model

The Session projector creates this product hierarchy:

```text
Workspace
└── Session
    └── Product Turn
        ├── User Prompt
        ├── Assistant Step 1
        │   ├── Thinking block
        │   ├── Text block
        │   └── Tool call + execution/result
        ├── Assistant Step 2
        └── Terminal state
```

One Pi model-response/tool-loop unit maps to an Assistant Step, not a Product Turn. Blocks preserve source order. Tool declaration has dedicated start, argument-fragment delta, and parsed-arguments/error settlement events. Start carries the complete deterministic preparing Tool Block; tool kind is derived only from exact built-in names, while summary, empty argument preview, timestamps, null details/error, and pending execution all have closed initial values. Deltas serially target the same block and `toolCallId`; unmatched deltas force reconciliation rather than creating a block. The argument preview stops at 64 KiB of complete UTF-8 scalars and marks truncation. Settlement carries the complete ready/invalid Tool Block and puts larger safe input in Content Store. Declaration and execution join by the SDK's `toolCallId`, so parallel completion order never reorders declared source positions. Stable keys survive final replacement so disclosure state, Inspector selection, and scroll anchors remain intact.

The active view contains two layers:

- a Committed Snapshot reconstructed from durable Session state;
- an Active Overlay keyed by Run, Assistant Step, block index, and Tool Call identity.

Final SDK messages replace partial block content without replacing stable product identities. Unknown message and tool types produce visible generic projections rather than being discarded.

## Long-content strategy

Realtime frames are bounded. Read output, shell output, diffs, and generic tool results carry:

- a bounded preview;
- original size and truncation status;
- media or content kind;
- a Content Reference when the complete value is available.

The Host uses one Content Store policy for every oversized presenter:

- Read does not expose `fullOutputPath`; the adapter streams or copies the complete returned content directly into Content Store before emitting a truncated projection.
- Bash exposes a temporary `fullOutputPath`; the adapter copies it into Content Store before that path can expire.
- Edit/write may produce a diff too large for a realtime frame; the Host persists the complete diff and projects a bounded preview.
- Generic tools follow the same preview/reference rule whenever complete content is observable.

Content Store writes land in `~/.yaca/content/`, compute a digest, and return an opaque scoped reference. Authorized HTTP supports streaming and ranges. A Content Reference never contains or accepts an arbitrary filesystem path.

Model catalog projection also follows observed SDK behavior. Thinking choices are model-specific; the currently validated DeepSeek catalog exposes `off`, `low`, `high`, and `max`. Runtime clamping is an internal execution detail and is not converted into additional selectable values.

Chat remains compact; the Inspector provides complete reading. If complete content cannot be retained, the projection reports that limitation and a structured storage error rather than silently truncating.

## Local security model

- Listen only on `127.0.0.1` by default.
- Generate a high-entropy single-use bootstrap token per Host start.
- Place the token in the URL fragment, exchange it for an HttpOnly `SameSite=Strict` cookie, and remove the fragment immediately.
- Validate exact Host and Origin on HTTP mutation routes and WebSocket upgrade.
- Reject requests without the authenticated local session and required anti-CSRF proof.
- Apply frame, body, connection, and content limits.
- Redact Provider keys, authorization material, and sensitive environment values from responses and ordinary logs.
- Serve untrusted text and code as escaped content; sanitize Markdown links and raw HTML.

These controls protect the loopback control plane from drive-by browser access. They do not sandbox the agent, shell, local extensions, or Workspace. The process has the user's OS authority.

### Persistence threat model and known limit

The local single-user MVP defends against pre-existing or check-visible symlinks, hard links, path escape, replacement, unsafe ownership or mode, wrong device/inode, and unexpected parent identity. Persistence operations verify open descriptors and paths repeatedly and fail closed on mismatches.

Node does not expose portable descriptor-relative `openat`/`renameat` operations. Consequently, yaca cannot atomically exclude a deliberately timed, same-UID actor that performs an exact parent or leaf exchange in the nanosecond-scale interval between the final successful identity check and the immediately following path mutation (`create`, `rename`, or cleanup `unlink`). Only that final check-to-mutation interval is outside the MVP threat model; it does not excuse a replacement visible at an earlier checkpoint. This limit does not relax crash durability, Host-restart recovery, browser reconnect behavior, or rejection of path anomalies already present or observable at a validation point.

## Process and CLI

`yaca` is both the product name and primary executable. The CLI:

1. resolves and validates the canonical `~/.yaca/` data root, rejecting a root-leaf symlink or any derived path that escapes it;
2. derives the two authority ports and binds both loopback sockets, rolling back a partial bind;
3. initializes redacted logging and the application only after the complete authority fence is held;
4. starts the same-origin Host on loopback;
5. opens the authenticated fragment URL unless explicitly disabled; and
6. drains active work and durable writes, gives application connections a two-second grace period, force-closes remaining connections, and releases the authority sockets last in reverse acquisition order.

Application shutdown is bounded before fence release so a contender cannot start while the previous Host can still serve or mutate. The same release path covers initialization failure. The Foundation and MVP acceptance environments are macOS and Linux; Windows build, typecheck, and package smoke remain best-effort rather than a Windows hardware support claim.

The production Host serves the compiled Web assets. No Electron shell, database server, container runtime, or external CLI is required.

## Test seams and evidence

The module interface is the test surface.

### PiRuntimePort

- Scripted fake tests cover multi-step Runs, thinking/text/tool deltas, parallel tool completion order, abort, Provider errors, Desired Settings, and runtime replacement.
- A pinned-SDK integration suite covers real public exports, path routing, JSONL reopen, event translation, tool details, and adapter error mapping.
- A credential-injected DeepSeek smoke test is opt-in locally and required in release acceptance without recording the key.

### Application protocol

- Shared schema fixtures are accepted identically by Host and Web.
- Tests cover version negotiation, strict validation, correlation, frame limits, unknown messages, Origin rejection, sequence gaps, and reconnect.
- Bootstrap/app-sync tests place events on both sides of the global sequence barrier, assert the atomic `snapshotSeq`, exercise buffering and overflow, discard duplicates, and reject stale runtime epochs. Session-sync tests prove it cannot advance the global watermark or alter a catalog revision.
- Catalog conformance covers first/continuation pairs, `appliedLimit` echo and cursor binding, ordinary event-before-response rejection without revision rollback, authoritative sync replacement, buffered post-snapshot revision advance without a sync loop, stale-page discard/restart, and new revisions on Session/trash events.

### Projection

- Golden event traces cover Product Turn/Assistant Step grouping, stable keys, final replacement, complete initial/final Tool Blocks, serial and oversized declaration fragments, rejected unmatched targets, `toolCallId` execution identity, interrupted display reasons, errors, and unknown fallbacks.
- Tests assert observable projections rather than projector internals.

### Command Ledger

- Duplicate identifiers, exhaustive mutation-to-authority mapping, local committed/failed paths, pre-record Prompt identity allocation, Prompt-only Run envelope linkage, delivery/outcome unknown separation, scope-aware acknowledgement, restart priority, truncated tails, and explicit new mutation receive deterministic tests.
- A fault-injection test kills the Host at each durability boundary and proves it never automatically invokes the same mutation twice.
- Persistence tests serialize reads with appends across the fsync barrier, reject ledgers above the `268435456`-byte safe-read ceiling before allocation, and prove corrupt-tail detection performs zero filesystem writes while the original ledger remains unchanged.
- Path tests cover all runtime-directory creation, an existing unsafe root or child without chmod repair, and a hard-linked root file without mutation. Atomic JSON tests cover cross-device rename, pre-existing symlinks and unsafe modes, initial missing/existing leaf replacement, parent swaps at temporary creation and rename checkpoints, existing-file mode preservation, and cleanup-time temporary replacement with opaque retained evidence. JSONL append tests cover parent swaps, descriptor-only writes after a verified path replacement, initial missing/existing leaf replacement, unsafe existing mode, and interleaved read/append ordering.
- Corrupt Tail Evidence tests cover exact range recovery, mode, inode replacement, link count, size growth, timestamp and content mutation, path-versus-descriptor identity, and parent-alias changes. Production guards also reject wrong owner and device; the supported-platform suite does not inject those identities independently. Content mutation is normally detected by change time before the digest check, so the suite does not claim an isolated digest-only branch.

### Recovery and browser paths

- Host integration tests reopen Sessions and reconcile active/committed state.
- Process-lifecycle tests derive stable pairs for the same canonical root, exercise disjoint roots concurrently, reject any shared or externally occupied port, prove partial-bind and post-bind startup rollback, and verify the fence remains exclusive while the Host event loop is paused.
- Crash and shutdown tests cover OS release after `SIGKILL`, immediate restart on the same stable pair, application connection drain followed by forced close at the two-second bound, and authority release only after application close.
- Playwright covers refresh, full app sync after WebSocket loss, Host kill/restart unknown classifications, read-only inspection of another Session, exact-run Stop, next-Run settings, theme persistence, active-session trash fallback/rollback, trash restore, long content, and the real file-edit path.
- Preference tests cover bootstrap, update, broadcast, atomic persistence, invalid values, and restart for all three theme preferences.
- Workspace tests cover missing paths, non-directories, permission failures, symlink/canonical duplicates, display-name update, and removal without deletion.
- Keyboard, IME, Light/Dark, reduced motion, and desktop screenshots form release evidence.

## Capability validation gates

The 0.84.2 spike confirms public runtime/session/model surfaces, `toolCallId` correlation, model-specific Thinking catalogs, Read/Bash truncation differences, Bash temporary output paths, and edit diff details. Implementation and release still require conformance gates that prove yaca handles those facts correctly:

- all SDK-owned paths remain under `~/.yaca/`;
- event settlement correctly spans retries and complete tool loops;
- runtime replacement subscription behavior is duplicate-free;
- abort reaches idle and can be projected truthfully;
- JSONL reopen reconstructs the expected Session path;
- DeepSeek model lookup and environment credential resolution remain redacted, while its selectable Thinking fixture contains only `off`, `low`, `high`, and `max`;
- Read complete content is captured without relying on `fullOutputPath`;
- Bash temporary output is ingested before expiry;
- large edit/write diffs survive as opaque Content References;
- concurrent tool results remain attached by `toolCallId`; and
- runtime replacement increments the projection epoch and rejects old-epoch overlay events.

An unmet gate changes the implementation plan or blocks the affected release capability. It is not represented as a working feature.
