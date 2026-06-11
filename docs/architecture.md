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
- `CommandLedger` durably records state-changing command delivery, minimum Run envelopes, risk acknowledgements, and terminal outcomes.
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

Every yaca-owned persistent file is below `~/.yaca/`:

```text
~/.yaca/
  agent/       Pi credentials, models, settings, resources, Sessions
  app/         Workspace registry, preferences, schema metadata, Command Ledger
  content/     content-addressed complete tool output
  trash/       recoverably removed Sessions and restore metadata
  logs/        redacted operational logs
  run/         process lock and runtime metadata
```

The CLI establishes these paths before dynamically loading Host modules that import the SDK, and the Host also passes explicit paths wherever the public SDK accepts them. The capability gate verifies actual writes.

Authority is divided by fact, not duplicated:

| Fact | Authority | Rebuild behavior |
|---|---|---|
| Conversation, branch, selected durable Session state | Pi-managed Session JSONL | Reopened through public SessionManager surfaces |
| Active Run and streaming partials | AgentRuntimeKernel memory | Lost on Host crash; surfaced as interrupted |
| Command delivery and terminal outcome | Command Ledger | Parsed from durable valid prefix |
| Run-to-Product-Turn identity | Minimum Run envelope in Command Ledger | Reconciled before Session content projection |
| Workspace registration | Workspace registry | Atomically replaced after fsync |
| Theme preference | Preference Store | Returned by bootstrap and broadcast after updates |
| Complete oversized output | Content Store | Addressed by digest and scoped metadata |
| Browser view | Host projection | Always replaceable by sync |

The Host does not maintain a durable copy of every realtime event. At settlement it reads the durable Session path again and replaces the Active Overlay with a Committed Snapshot. After restart it does the same without replaying transient deltas.

Workspace registration stores a canonical realpath plus a user-editable display name. Registration validates that the path exists, is a directory, is readable, searchable, and writable, and is not already registered through another spelling or symlink. Display-name changes never rename or move the Workspace.

Session trash moves the Session and restore metadata under `~/.yaca/trash/`. Trashed Sessions and referenced Content Store objects are retained indefinitely, appear in a trash list, and can be restored when the original Workspace remains registered and the destination does not conflict. The MVP exposes no permanent-delete command; users may manually clear the trash directory. Removing a Workspace registration never deletes Workspace files, Sessions, or trash.

Theme preference is Host-owned application state. Bootstrap always returns `system`, `light`, or `dark`; an application command atomically persists updates under `~/.yaca/app/` and broadcasts the accepted value. Browser-local theme is only a pre-bootstrap rendering hint.

## Command delivery and recovery

The SDK does not provide an atomic transaction between a yaca command record and `prompt()`. yaca therefore promises durable at-most-once invocation, not exactly-once execution.

For each state-changing command:

1. The Host validates authentication, schema, phase, and expected Session Version.
2. It appends a `recorded` Command Receipt and reaches a durability boundary.
3. It invokes the Pi adapter.
4. When public preflight behavior confirms acceptance, it appends one durable journal record containing the `accepted` receipt and a minimum Run envelope.
5. On a proven terminal outcome, it appends one durable journal record containing the terminal receipt and terminal Run envelope before publishing the terminal event.

A minimum Run envelope contains `runId`, `productTurnId`, `sessionId`, `workspaceId`, Prompt receipt identity, client mutation identity, runtime projection epoch, base Session Version and leaf identity, Run-start model/Thinking snapshots, acceptance time, and current Run state. It omits Prompt text and Provider credentials.

A duplicate mutation identifier returns its existing receipt and never invokes the adapter again. Recovery uses this strict priority:

1. A valid combined terminal journal record is authoritative for command and Run outcome.
2. A durable `accepted` receipt plus Run envelope without a terminal record becomes `outcome_unknown`; Session JSONL content may be displayed but cannot upgrade the outcome.
3. A `recorded` receipt without durable acceptance becomes `delivery_unknown`, even when nearby Session content looks similar to the Prompt.
4. A corrupt journal tail is quarantined; affected Sessions enter degraded mode and block new side-effecting mutations.
5. Session JSONL is then reopened to rebuild committed content from the Run envelope's base identity.
6. A new runtime projection epoch is created, and every old-epoch Active Overlay event is discarded.

Neither Unknown Delivery nor Outcome Unknown is automatically replayed. The affected Session blocks Prompt, activation, rename, trash, and other side-effecting mutations until sync completes and the user explicitly acknowledges the specific receipt and risk. Inspection, content reads, theme changes, and the acknowledgement command remain available. After acknowledgement, a new Prompt is allowed only while the Active Session is idle, against the synced Session Version and runtime epoch, and with a new mutation identifier.

Recovery behavior:

- Browser reconnect: handshake, recent receipts, atomic sync, then buffered projected events.
- Sequence gap: stop applying deltas and request sync.
- Host restart: reopen the Session, rebuild the Committed Snapshot, mark the prior Run interrupted, and remain idle.
- JSONL failure: preserve the source, expose the readable prefix if the public SDK permits it, and avoid writes until the user selects a safe recovery action.
- Command Ledger tail damage: preserve the valid prefix, quarantine the unreadable tail, and classify each affected receipt as Unknown Delivery or Outcome Unknown from the last durable transition.

## Atomic sync and realtime ordering

Every runtime projection has an opaque `runtimeEpoch`. Host restart, active runtime replacement, Session activation, adapter resubscription, or projection reset creates a new epoch. Runtime-scoped events always carry it; a client discards an old-epoch event and requests sync rather than merging it into the current Active Overlay.

`app.bootstrap` and `session.sync` use a connection-local sequence barrier:

1. The connection event multiplexer pauses delivery and buffers newly assigned events.
2. The AgentRuntimeKernel serial queue reaches a barrier after all earlier state transitions.
3. Under that barrier, the Host captures the authoritative projection and the highest `connectionSeq` covered by it as `snapshotSeq`.
4. The Host writes the sync response before any post-barrier event frame on the same WebSocket.
5. The client atomically replaces its projection, runtime epoch, and last applied sequence with the snapshot and `snapshotSeq`.
6. The Host releases buffered events in ascending sequence order.
7. The client discards duplicates at or below its last applied sequence, accepts exactly `last + 1`, and starts another sync on a gap or epoch mismatch.

Each connection buffer is bounded by both event count and serialized bytes. Overflow fails the in-progress sync with `sync_buffer_overflow`, discards the buffer, and requires a fresh sync; it never emits a partial snapshot. A disconnected connection discards its buffer. Contract tests inject events before, during, and after the barrier and prove no transition is lost or applied twice.

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

One Pi model-response/tool-loop unit maps to an Assistant Step, not a Product Turn. Blocks preserve source order. Tool declarations and executions join by the SDK's `toolCallId`; parallel completion order never reorders their declared source positions. Stable keys survive the final replacement of a streaming block so disclosure state, Inspector selection, and scroll anchors remain intact.

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

## Process and CLI

`yaca` is both the product name and primary executable. The CLI:

1. resolves and validates `~/.yaca/` paths;
2. acquires a single-Host process lock;
3. initializes redacted logging;
4. starts the same-origin Host on loopback;
5. opens the authenticated fragment URL unless explicitly disabled; and
6. drains the active operation, settings writes, Command Ledger, and logs on shutdown within a bounded deadline.

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
- Bootstrap/sync tests place events on both sides of the sequence barrier, assert the atomic `snapshotSeq`, exercise buffering and overflow, discard duplicates, and reject stale runtime epochs.

### Projection

- Golden event traces cover Product Turn/Assistant Step grouping, stable keys, final replacement, tool identity, interrupted partials, errors, and unknown fallbacks.
- Tests assert observable projections rather than projector internals.

### Command Ledger

- Duplicate identifiers, minimum Run envelope linkage, durability ordering, delivery/outcome unknown separation, risk acknowledgement, every terminal transition, restart priority, truncated tails, and explicit new mutation receive deterministic tests.
- A fault-injection test kills the Host at each durability boundary and proves it never automatically invokes the same mutation twice.

### Recovery and browser paths

- Host integration tests reopen Sessions and reconcile active/committed state.
- Playwright covers refresh, WebSocket loss, Host kill/restart, read-only inspection of another Session, exact-run Stop, next-Run settings, theme persistence, trash/list/restore, long content, and the real file-edit path.
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
