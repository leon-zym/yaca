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
│   Content Store                  ├─ Session Projector            │
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
- expected Session Version checks;
- Command Receipt lookup and transitions;
- Desired Settings and their next-Run application;
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
- `SessionCatalog` lists durable Sessions by registered Workspace and returns committed summaries without activating them.
- `CommandLedger` durably records state-changing command delivery and terminal outcomes.
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
  app/         Workspace registry, schema metadata, Command Ledger
  content/     content-addressed complete tool output
  trash/       recoverably removed Sessions
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
| Workspace registration | Workspace registry | Atomically replaced after fsync |
| Complete oversized output | Content Store | Addressed by digest and scoped metadata |
| Browser view | Host projection | Always replaceable by sync |

The Host does not maintain a durable copy of every realtime event. At settlement it reads the durable Session path again and replaces the Active Overlay with a Committed Snapshot. After restart it does the same without replaying transient deltas.

Session trash moves files under `~/.yaca/trash/`; removing a Workspace registration never deletes the user's Workspace.

## Command delivery and recovery

The SDK does not provide an atomic transaction between a yaca command record and `prompt()`. yaca therefore promises durable at-most-once invocation, not exactly-once execution.

For each state-changing command:

1. The Host validates authentication, schema, phase, and expected Session Version.
2. It appends a `recorded` Command Receipt and reaches a durability boundary.
3. It invokes the Pi adapter.
4. It records `accepted` when public preflight behavior confirms acceptance.
5. It records one terminal result: `succeeded`, `failed`, `aborted`, or `interrupted_unknown`.

A duplicate mutation identifier returns its existing receipt and never invokes the adapter again. On Host startup, every non-terminal receipt becomes `interrupted_unknown` unless a tested reconciliation rule can prove a terminal outcome. Unknown Delivery is never automatically replayed; retry is an explicit new user action with a new mutation identifier.

Recovery behavior:

- Browser reconnect: handshake, recent receipts, active sync, then projected events.
- Sequence gap: stop applying deltas and request sync.
- Host restart: reopen the Session, rebuild the Committed Snapshot, mark the prior Run interrupted, and remain idle.
- JSONL failure: preserve the source, expose the readable prefix if the public SDK permits it, and avoid writes until the user selects a safe recovery action.
- Command Ledger tail damage: preserve the valid prefix, quarantine the unreadable tail, and classify affected delivery as unknown.

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

One Pi model-response/tool-loop unit maps to an Assistant Step, not a Product Turn. Blocks preserve source order. Tool execution updates join by Tool Call identity rather than completion order. Stable keys survive the final replacement of a streaming block so disclosure state, Inspector selection, and scroll anchors remain intact.

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

The Content Store copies complete output into `~/.yaca/content/` before an upstream temporary path can expire, computes a digest, and returns an opaque scoped reference. Authorized HTTP supports streaming and ranges. A Content Reference never contains or accepts an arbitrary filesystem path.

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

### Projection

- Golden event traces cover Product Turn/Assistant Step grouping, stable keys, final replacement, tool identity, interrupted partials, errors, and unknown fallbacks.
- Tests assert observable projections rather than projector internals.

### Command Ledger

- Duplicate identifiers, durability ordering, every state transition, restart classification, truncated tails, and explicit retry receive deterministic tests.
- A fault-injection test kills the Host at each durability boundary and proves it never automatically invokes the same mutation twice.

### Recovery and browser paths

- Host integration tests reopen Sessions and reconcile active/committed state.
- Playwright covers refresh, WebSocket loss, Host kill/restart, read-only inspection of another Session, Stop, next-Run settings, long content, and the real file-edit path.
- Keyboard, IME, Light/Dark, reduced motion, and desktop screenshots form release evidence.

## Capability validation gates

Public SDK research identifies the required 0.84.2 exports and event/detail types, but executable capability validation remains a prerequisite for implementation and release. The gates are:

- all SDK-owned paths remain under `~/.yaca/`;
- event settlement correctly spans retries and complete tool loops;
- runtime replacement subscription behavior is duplicate-free;
- abort reaches idle and can be projected truthfully;
- JSONL reopen reconstructs the expected Session path;
- DeepSeek model lookup, environment credential resolution, and supported Thinking Levels behave as projected;
- full read/shell output remains available long enough for Content Store ingestion;
- edit/write details contain or permit derivation of a trustworthy diff.

An unmet gate changes the implementation plan or blocks the affected release capability. It is not represented as a working feature.
