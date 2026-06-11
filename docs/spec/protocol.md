# Application protocol specification

## Purpose

The yaca application protocol is the only interface through which the browser observes or changes Host state. It is independent of Pi SDK types and transports Product Turns, Assistant Steps, Content Blocks, tool state, Session snapshots, Desired Settings, and structured errors.

The protocol is defined as strict TypeBox schemas with generated TypeScript types and shared fixtures. `@earendil-works/pi-coding-agent` types are not part of the wire contract.

## Transport

The production Host serves one loopback origin:

- HTTP serves the Web application, exchanges the single-use bootstrap token, returns initial metadata, and streams Content References.
- One authenticated JSON WebSocket carries all application commands, responses, and realtime events.
- Session mutation has no HTTP, secondary socket, or Pi-protocol path.

Frames have an explicit maximum. Large values use Content References. JSON numbers are not used for values that can exceed safe integer precision.

## Connection handshake

The client sends `hello` before any other WebSocket message:

| Field | Meaning |
|---|---|
| `protocolMajor` | Required major protocol version |
| `protocolMinor` | Highest minor version understood by the client |
| `clientId` | Ephemeral identifier for this page instance |
| `capabilities` | Optional behavior the client can consume |

The Host returns `welcome`:

| Field | Meaning |
|---|---|
| `protocolMajor` | Selected major version |
| `protocolMinor` | Selected minor version |
| `connectionId` | Host-issued connection identity |
| `serverVersion` | yaca version |
| `capabilities` | Negotiated optional behavior |
| `connectionSeq` | Sequence baseline for subsequent events |

A major mismatch closes with `unsupported_protocol`. Minor additions require capability negotiation. Unknown commands are rejected. Unknown events may be ignored only when the negotiated capability declares that behavior safe.

## Envelopes

### Command

| Field | Required | Meaning |
|---|---:|---|
| `v` | yes | Protocol major |
| `requestId` | yes | Correlates the immediate response |
| `clientMutationId` | mutations only | Globally unique idempotency key |
| `type` | yes | Command discriminator |
| `sessionId` | session commands | Opaque Session identity |
| `expectedSessionVersion` | Session mutations | Last Committed Snapshot version observed by the caller |
| `payload` | yes | Strict command-specific payload |

Read commands omit `clientMutationId`. Every command produces exactly one immediate response, even when the requested Run continues asynchronously.

### Response

| Field | Meaning |
|---|---|
| `v` | Protocol major |
| `requestId` | Matching command request |
| `ok` | Outcome discriminator |
| `result` | Present on success |
| `error` | Present on failure |

Acceptance of `run.prompt` means the Host has durably recorded the mutation and the Pi adapter has accepted it. It does not mean the Run has completed.

### Event

| Field | Meaning |
|---|---|
| `v` | Protocol major |
| `connectionSeq` | Strictly increasing within this connection |
| `type` | Event discriminator |
| `sessionId` | Related Session where applicable |
| `sessionVersion` | Durable version where applicable |
| `runId` | Related Run where applicable |
| `runSeq` | Monotonic sequence within one Run where applicable |
| `payload` | Strict event-specific payload |

`connectionSeq` is not a durable replay position. A gap stops incremental application and triggers `session.sync`.

## Identifiers and ordering

- All wire identifiers are opaque strings.
- UTC timestamps use ISO 8601 strings.
- Product entities have stable Host-issued identities.
- Assistant Steps are ordered within a Product Turn.
- Content Blocks preserve model source order.
- Tool executions update their source-positioned tool call by Tool Call identity; completion order never reorders the conversation.
- A final block replaces its partial content while retaining the same stable block identity.
- `SessionVersion` represents durable committed state and remains comparable after Host restart.

## Command surface

### Application and Workspace

| Command | Mutation | Result |
|---|---:|---|
| `app.bootstrap` | no | Workspaces, Session summaries, Active Session, runtime phase, recent receipts, model directory, Desired Settings |
| `workspace.list` | no | Registered Workspace summaries |
| `workspace.register` | yes | Canonicalized Workspace summary |
| `workspace.select` | yes | Selected Workspace summary and Sessions |
| `workspace.remove` | yes | Removed registration identity; Workspace files remain untouched |

### Session

| Command | Mutation | Result |
|---|---:|---|
| `session.list` | no | Bounded Session summaries for one Workspace |
| `session.create` | yes | New Session summary and activation result |
| `session.activate` | yes | New Active Session and Committed Snapshot; idle only |
| `session.inspect` | no | Committed Snapshot without runtime replacement |
| `session.rename` | yes | Updated summary and Session Version |
| `session.trash` | yes | Recoverable trash record; active Session requires idle replacement policy |
| `session.sync` | no | Authoritative committed view, runtime phase, active overlay, receipts, and Desired Settings |
| `session.history` | no | Earlier committed Product Turns using an opaque cursor |

`session.inspect` is valid for another Session while a Run is active. It never changes Active Session, current Run, Desired Settings, or runtime subscriptions.

All Session mutations require an idle runtime. While a Run is active, other Sessions expose committed read commands only; the Active Session accepts Run control and Desired Setting commands only.

### Run and Desired Settings

| Command | Mutation | Result |
|---|---:|---|
| `run.prompt` | yes | Accepted Command Receipt and Run identity |
| `run.abort` | yes | Accepted abort receipt; terminal state arrives by event/sync |
| `command.status` | no | Command Receipt by mutation identity |
| `runtime.setDesiredModel` | yes | Desired model and when it can take effect |
| `runtime.setDesiredThinking` | yes | Desired Thinking Level and when it can take effect |

`run.prompt` is valid only for Active Session in `idle`. During a Run, Desired Setting commands may be recorded, but they do not mutate that Run's model snapshot. The Host applies valid Desired Settings after settlement and before accepting the next Prompt.

The Host derives selectable models and Thinking Levels from its validated model runtime. A client cannot make an unsupported value valid by sending it directly.

## Snapshot shapes

### Session summary

Contains:

- opaque Session and Workspace identities;
- display title and durable timestamps;
- committed status summary;
- Session Version;
- whether it is active;
- whether a newer terminal result is unread.

It does not contain an arbitrary local path or full history.

### Session sync view

Contains:

- Session summary and Session Version;
- bounded recent Product Turns;
- an opaque cursor for earlier history;
- runtime phase if this is Active Session;
- Active Overlay if a Run is live;
- Run-start model and Thinking Level snapshots;
- current Desired Settings and their application state;
- recent relevant Command Receipts;
- referenced complete content metadata.

For a non-active Session, sync is a Committed Snapshot only.

### Product projection

```text
Product Turn
├── Prompt
├── Assistant Step[]
│   └── Content Block[]
│       ├── thinking
│       ├── text
│       ├── tool call + execution/result
│       └── error
└── terminal outcome
```

Each Tool Call exposes a generic name, safe input, status, preview, and error plus optional presenter details for `read`, `edit`, `write`, and `bash`. Unknown tools use the generic fields.

## Realtime events

The protocol projects SDK facts into these application event families:

| Event | Purpose |
|---|---|
| `directory.changed` | Workspace or Session summaries changed |
| `active_session.changed` | Runtime attached to a different Session |
| `desired_settings.changed` | Desired model/Thinking selection or application state changed |
| `run.started` | Creates Product Turn and records model/Thinking snapshot |
| `assistant_step.started` | Creates a stable Assistant Step |
| `block.started` | Creates a source-positioned thinking, text, tool, or error block |
| `block.delta` | Appends bounded incremental content to one block |
| `block.settled` | Replaces partial block with authoritative final content |
| `tool.execution_started` | Marks source-positioned Tool Call running |
| `tool.execution_updated` | Updates preview/progress without creating another conversation node |
| `tool.execution_settled` | Records result, error, truncation, details, and optional Content Reference |
| `run.state_changed` | Reports running, stopping, retrying when proven, or terminal state |
| `session.committed` | Announces a new Session Version and bounded Committed Snapshot |
| `command.receipt_changed` | Reports durable command delivery/outcome transition |
| `host.degraded` | Reports a storage, projection, or SDK condition affecting truthful operation |

The projector maps a complete coding-agent Run to one Product Turn. A lower-level agent end that will retry cannot emit a terminal `run.state_changed`.

## Command delivery state machine

```text
recorded
  ├─ accepted ─┬─ succeeded
  │            ├─ failed
  │            └─ aborted
  └─ interrupted_unknown
```

Any non-terminal receipt encountered after Host restart becomes `interrupted_unknown` unless a tested durable fact proves a terminal state. The Host never re-invokes a command for an existing mutation identifier. The browser reconciles receipts and Session state; it does not automatically resend an unacknowledged Prompt.

An explicit user retry is a new command with a new mutation identifier. The UI must not present Unknown Delivery as ordinary failure because the Workspace may already contain side effects.

## Error model

Every error contains:

- stable `code`;
- safe human-readable `message`;
- `retryDisposition`: `never`, `after_sync`, or `explicit`;
- optional schema-defined safe details.

Required codes:

| Code | Meaning | Retry disposition |
|---|---|---|
| `invalid_command` | Schema or invariant failed | never |
| `unsupported_protocol` | Major/capability mismatch | never |
| `unauthenticated` | Bootstrap/session missing | never |
| `forbidden_origin` | Host/Origin/CSRF validation failed | never |
| `workspace_not_found` | Workspace identity unavailable | after_sync |
| `session_not_found` | Session identity unavailable | after_sync |
| `session_busy` | Operation requires idle runtime | explicit |
| `stale_session_version` | Caller acted on old committed state | after_sync |
| `model_unavailable` | Desired model cannot be selected | explicit |
| `thinking_unsupported` | Model does not support requested level | explicit |
| `provider_auth_required` | Host lacks valid Provider credential | explicit |
| `provider_failed` | Provider rejected or failed the Run | explicit |
| `command_delivery_unknown` | Invocation cannot be proven after interruption | explicit |
| `run_interrupted` | Active Run ended with Host/runtime interruption | explicit |
| `content_unavailable` | Complete content could not be retained/read | never |
| `storage_failed` | A required durability boundary failed | explicit |
| `sdk_incompatible` | Validated public SDK behavior is unavailable | never |

SDK exceptions, stacks, credentials, authorization tokens, and unrestricted absolute paths are never returned as error details.

## Long content

A realtime projection includes only a bounded preview. Complete content is fetched over authenticated HTTP with an opaque Content Reference. Metadata includes content kind, byte length, digest where safe, truncation state, and availability.

The Host authorizes each read against the local authenticated session and the owning Session. Range requests are supported. HTML is served as untrusted text or sanitized output, never active same-origin application content.

## Reconnect and resync

1. The client keeps the last applied `connectionSeq` only for its current connection.
2. On disconnect it freezes the last Committed Snapshot and marks realtime state reconnecting.
3. On reconnect it performs a new handshake and requests `app.bootstrap` or `session.sync`.
4. The sync response replaces local authority; the client does not merge guessed missing deltas.
5. Recent Command Receipts explain accepted, terminal, or Unknown Delivery states.
6. Live events resume only after the sync baseline is installed.

Initial snapshot/event races are resolved by the Host assigning the connection sequence baseline associated with the snapshot. Tests must cover an event occurring during sync.

## Compatibility policy

- Major changes may remove or reinterpret fields and require an explicit handshake match.
- Minor changes may add negotiated commands, events, fields, or enum members.
- Schemas reject unknown command fields by default.
- Stable error codes and receipt states cannot change meaning within a major version.
- Fixtures cover the oldest supported client minor version.
- The Host must not translate unsupported behavior into a superficially successful response.

## Security invariants

- The authenticated principal, Workspace scope, Session ownership, and Content Reference scope come from Host state, never payload claims.
- Every mutation requires the authenticated loopback session and origin checks.
- Every Session mutation checks `expectedSessionVersion` where stale state can cause a destructive or surprising outcome.
- File paths in projections are display values; content endpoints accept opaque references only.
- Protocol logging redacts prompt content by default at ordinary log levels and always redacts credentials and authorization material.

## Conformance tests

The protocol suite must prove:

- handshake success and major rejection;
- strict schema parity between browser and Host;
- one response per command and correct correlation;
- duplicate mutation identifiers return the original receipt;
- sequence gap and initial sync races cause deterministic resync;
- non-active Session inspection does not replace the runtime;
- Desired Settings affect the next Run and not the current Run;
- unknown tools and events take their specified fallback path;
- oversized frames are rejected and long content uses Content References;
- restart changes non-terminal receipts to Unknown Delivery without replay; and
- forged Origin, Workspace, Session, version, and Content Reference values are rejected.
