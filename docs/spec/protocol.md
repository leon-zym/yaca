# Application protocol specification

## 1. Scope and conformance

The yaca application protocol is the browser's only interface to Host authority. It transports yaca domain projections and never exposes Pi SDK types. The normative implementation uses strict TypeBox schemas; generated TypeScript types and fixtures in Host and Web must conform to this document.

Keywords `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. Every object schema is closed: fields not listed here are rejected. Every array has the stated maximum. Unknown enum members are invalid.

Protocol v1 uses one authenticated JSON WebSocket for commands, responses, and events. HTTP is limited to the Web application, bootstrap-token exchange, and Content Reference reads. There is no second mutation transport.

## 2. Limits and scalar types

Limits are measured after UTF-8 JSON serialization unless stated otherwise.

| Name | Limit |
|---|---:|
| WebSocket frame | 1,048,576 bytes |
| HTTP JSON request | 262,144 bytes |
| Prompt text | 262,144 bytes |
| One realtime delta string | 32,768 bytes |
| One preview string | 65,536 bytes |
| Tool argument preview | 65,536 bytes |
| One stored Content object | 268,435,456 bytes |
| Sync event buffer | 4,096 events and 8,388,608 bytes |
| Workspace registrations returned | 1,000 |
| Session page | 1–200, default 50 |
| Product Turns in sync | 1–100, default 40 |
| Assistant Steps per Product Turn | 256 |
| Content Blocks per Assistant Step | 256 |
| Recent receipts in bootstrap/sync | 200 |

The Host rejects an inbound oversized frame with `frame_too_large` and closes with WebSocket code `1009`. Outbound projections MUST use previews and Content References to remain within the same limit. A sync response that cannot fit reduces its Turn window and returns a history cursor; it never fragments one JSON envelope across frames.

Normative scalar aliases:

| Alias | Schema |
|---|---|
| `OpaqueId` | string, `1..128`, pattern `^[A-Za-z0-9_-]+$` |
| `RequestId` | `OpaqueId` |
| `MutationId` | `OpaqueId` |
| `SessionVersion` | `OpaqueId` |
| `RuntimeEpoch` | `OpaqueId` |
| `Cursor` | string, `1..512` |
| `IsoInstant` | string, ISO 8601 UTC date-time, max 40 |
| `DisplayName` | trimmed string, `1..128`, no control characters |
| `SessionTitle` | trimmed string, `1..200`, no control characters |
| `LocalPathInput` | string, `1..4096`, no NUL |
| `DisplayPath` | string, `1..4096`, no NUL |
| `SafeText` | string, max 65,536 bytes unless a smaller field limit is stated |
| `Sequence` | JSON safe integer, `0..9007199254740991` |
| `DurationMs` | JSON safe integer, `0..9007199254740991` |
| `ByteCount` | decimal digit string, `1..32` characters |

## 3. Enums

```text
ThemePreference = system | light | dark

RuntimePhase = idle | starting | running | stopping | degraded

ThinkingLevel = off | minimal | low | medium | high | xhigh | max
DesiredSettingState = ready_for_next_run | pending_current_run_terminal

RunStatus = accepted | running | stopping | succeeded | failed |
            aborted | interrupted | outcome_unknown

ReceiptState = recorded | accepted | succeeded | failed | aborted |
               committed | delivery_unknown | outcome_unknown

ReceiptScope = host | workspace | session | run

RiskAcknowledgement = not_required | required | acknowledged

BlockStatus = streaming | settled | interrupted
ToolKind = read | edit | write | bash | unknown
ToolDeclarationStatus = preparing | ready | invalid
ToolExecutionStatus = pending | running | succeeded | failed | aborted

InterruptionReason = host_restart | runtime_replaced | runtime_lost

WorkspaceChange = registered | updated | selected | removed
SessionChange = created | renamed | committed | trashed | restored

RetryDisposition = never | after_sync | restart_catalog | explicit
```

Thinking choices are model-specific. A `ThinkingLevel` enum member is selectable only when present in that model's `supportedThinkingLevels`. The validated DeepSeek catalog entry contains exactly `off`, `low`, `high`, and `max`. Runtime clamp behavior MUST NOT add a catalog choice.

## 4. Closed shared schemas

The notation `field?: Type` means the field may be omitted. `Type | null` means the field is required and may be null.

### Error and theme

```text
AppError = {
  code: ErrorCode,
  message: string{1..1000},
  retryDisposition: RetryDisposition,
  details?: ErrorDetails
}

ErrorDetails = {
  field?: string{1..128},
  expected?: string{1..512},
  actual?: string{1..512},
  receiptId?: OpaqueId,
  activeRunId?: OpaqueId
}

ThemeSetting = {
  themePreference: ThemePreference,
  updatedAt: IsoInstant
}
```

`ErrorDetails` is the complete v1 shape. It never contains a stack, credential, authorization value, Prompt, unrestricted absolute path, or raw SDK exception.

### Workspace, Session, and trash

```text
WorkspaceSummary = {
  workspaceId: OpaqueId,
  displayName: DisplayName,
  displayPath: DisplayPath,
  selected: boolean,
  available: boolean,
  createdAt: IsoInstant,
  updatedAt: IsoInstant
}

SessionSummary = {
  sessionId: OpaqueId,
  workspaceId: OpaqueId,
  title: SessionTitle,
  sessionVersion: SessionVersion,
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  active: boolean,
  unreadTerminal: boolean,
  lastRunStatus: RunStatus | null
}

TrashRecord = {
  trashId: OpaqueId,
  originalSessionId: OpaqueId,
  workspaceId: OpaqueId,
  title: SessionTitle,
  originalSessionVersion: SessionVersion,
  trashedAt: IsoInstant,
  restorable: boolean,
  restoreBlockedReason: string{1..500} | null
}
```

`displayPath` is a presentation value. It is never accepted by a content endpoint as authority. Trashed Sessions are retained until users manually clear yaca's trash directory; protocol v1 has no permanent-delete command.

### Model and Desired Settings

```text
ModelRef = {
  providerId: OpaqueId,
  modelId: OpaqueId
}

ModelCatalogEntry = {
  model: ModelRef,
  providerDisplayName: DisplayName,
  modelDisplayName: DisplayName,
  available: boolean,
  supportedThinkingLevels: ThinkingLevel[1..7 unique]
}

ModelCatalog = {
  revision: OpaqueId,
  models: ModelCatalogEntry[0..1000]
}

DesiredSettings = {
  revision: OpaqueId,
  model: ModelRef,
  thinkingLevel: ThinkingLevel,
  state: DesiredSettingState,
  updatedAt: IsoInstant
}

RunSettingSnapshot = {
  model: ModelRef,
  thinkingLevel: ThinkingLevel
}
```

### Command Receipt and Run envelope

```text
CommandReceipt = {
  receiptId: OpaqueId,
  clientMutationId: MutationId,
  commandType: MutationCommandType,
  scope: ReceiptScope,
  authorityId: OpaqueId,
  state: ReceiptState,
  workspaceId: OpaqueId | null,
  sessionId: OpaqueId | null,
  runId: OpaqueId | null,
  productTurnId: OpaqueId | null,
  riskAcknowledgement: RiskAcknowledgement,
  recordedAt: IsoInstant,
  acceptedAt: IsoInstant | null,
  terminalAt: IsoInstant | null,
  acknowledgedAt: IsoInstant | null,
  error: AppError | null
}

RunEnvelope = {
  runId: OpaqueId,
  productTurnId: OpaqueId,
  workspaceId: OpaqueId,
  sessionId: OpaqueId,
  promptReceiptId: OpaqueId,
  promptClientMutationId: MutationId,
  runtimeEpoch: RuntimeEpoch,
  baseSessionVersion: SessionVersion,
  baseLeafEntryId: OpaqueId | null,
  settings: RunSettingSnapshot,
  status: RunStatus,
  acceptedAt: IsoInstant,
  terminalAt: IsoInstant | null,
  terminalError: AppError | null,
  interruptionReason: InterruptionReason | null
}
```

Invariants:

- `authorityId` is the one canonical id used for mutation blocking and ledger lookup. Scope `host` requires the fixed Host authority listed in section 6; its Workspace, Session, and Run lineage fields are null. Scope `workspace` uses `workspaceId` as `authorityId` and requires only the Workspace lineage. Scope `session` uses `sessionId` as `authorityId` and requires Workspace and Session lineage. Scope `run` uses `runId` as `authorityId` and requires Workspace, Session, and Run lineage; `productTurnId` is required only for the `run.prompt` receipt.
- Every mutation other than `run.prompt` follows `recorded → committed | failed | delivery_unknown`. Its `delivery_unknown` means durable intent exists but the local or runtime-control commit cannot be proven.
- A recorded `run.prompt` allocates Run and Product Turn ids so its receipt is Run-scoped. Only durable Prompt acceptance creates and requires the Run envelope; a Prompt that becomes `delivery_unknown` retains allocated ids with `acceptedAt: null` and has no Run envelope.
- `outcome_unknown` means durable acceptance exists but no durable terminal outcome exists; receipt and Run envelope identities are complete.
- `riskAcknowledgement` is `required` for either unknown state until `command.acknowledgeUnknown` succeeds.
- A terminal combined journal record changes the Run envelope and Prompt receipt together. Host restart changes an accepted nonterminal Prompt to `outcome_unknown`, never `interrupted`; `interruptionReason: host_restart` explains the UI condition without changing the receipt fact.
- Run envelope persistence excludes Prompt text and credentials.

### Content

```text
ContentReference = {
  contentRef: OpaqueId,
  sessionId: OpaqueId,
  kind: text | terminal | diff | json | binary,
  mediaType: string{1..200},
  byteLength: ByteCount,
  digest: string{64},
  available: boolean
}

ContentPreview = {
  text: string{0..65536 bytes},
  truncated: boolean,
  originalByteLength: ByteCount,
  complete: ContentReference | null
}
```

### Product projection

Tool arguments are the protocol's only intentionally open data value:

```text
JsonValue = null | boolean | finite number | string{0..65536 bytes} |
            JsonValue[0..1024] | { string{1..256}: JsonValue }{0..1024 keys}
```

Serialized tool arguments are limited to 262,144 bytes and nesting depth 32. The surrounding event and block objects remain closed.

```text
PromptView = {
  promptId: OpaqueId,
  text: string{0..262144 bytes},
  createdAt: IsoInstant
}

UsageView = {
  inputTokens: ByteCount,
  outputTokens: ByteCount,
  cacheReadTokens: ByteCount,
  cacheWriteTokens: ByteCount
}

ThinkingBlock = {
  kind: thinking,
  blockId: OpaqueId,
  stepId: OpaqueId,
  sourceIndex: integer{0..255},
  status: BlockStatus,
  content: ContentPreview
}

TextBlock = {
  kind: text,
  blockId: OpaqueId,
  stepId: OpaqueId,
  sourceIndex: integer{0..255},
  status: BlockStatus,
  content: ContentPreview
}

ReadDetails = {
  kind: read,
  path: DisplayPath,
  startLine: integer{1..9007199254740991} | null,
  endLine: integer{1..9007199254740991} | null,
  content: ContentPreview
}

EditDetails = {
  kind: edit,
  path: DisplayPath,
  diff: ContentPreview,
  additions: integer{0..9007199254740991} | null,
  deletions: integer{0..9007199254740991} | null
}

WriteDetails = {
  kind: write,
  path: DisplayPath,
  diff: ContentPreview,
  additions: integer{0..9007199254740991} | null,
  deletions: integer{0..9007199254740991} | null
}

BashDetails = {
  kind: bash,
  command: string{1..262144 bytes},
  output: ContentPreview,
  exitCode: integer{-2147483648..2147483647} | null,
  signal: string{1..64} | null,
  durationMs: DurationMs | null
}

UnknownToolDetails = {
  kind: unknown,
  input: ContentPreview,
  output: ContentPreview | null
}

ToolDetails = ReadDetails | EditDetails | WriteDetails |
              BashDetails | UnknownToolDetails

ToolCallView = {
  toolCallId: OpaqueId,
  name: string{1..256},
  toolKind: ToolKind,
  declarationStatus: ToolDeclarationStatus,
  argumentsPreview: string{0..65536 bytes},
  argumentsTruncated: boolean,
  arguments: JsonValue | null,
  argumentsContent: ContentReference | null,
  executionStatus: ToolExecutionStatus,
  summary: string{0..1000},
  details: ToolDetails | null,
  startedAt: IsoInstant | null,
  terminalAt: IsoInstant | null,
  error: AppError | null
}

ToolBlock = {
  kind: tool,
  blockId: OpaqueId,
  stepId: OpaqueId,
  sourceIndex: integer{0..255},
  status: BlockStatus,
  tool: ToolCallView
}

ErrorBlock = {
  kind: error,
  blockId: OpaqueId,
  stepId: OpaqueId,
  sourceIndex: integer{0..255},
  status: settled | interrupted,
  error: AppError
}

ContentBlock = ThinkingBlock | TextBlock | ToolBlock | ErrorBlock

AssistantStepView = {
  stepId: OpaqueId,
  productTurnId: OpaqueId,
  stepIndex: integer{0..255},
  status: streaming | settled | interrupted,
  blocks: ContentBlock[0..256],
  startedAt: IsoInstant,
  terminalAt: IsoInstant | null,
  usage: UsageView | null
}

ProductTurnView = {
  productTurnId: OpaqueId,
  runId: OpaqueId,
  sessionId: OpaqueId,
  prompt: PromptView,
  settings: RunSettingSnapshot,
  status: RunStatus,
  steps: AssistantStepView[0..256],
  startedAt: IsoInstant,
  terminalAt: IsoInstant | null,
  error: AppError | null
}
```

During declaration, a Tool Call may have `arguments: null` and `details: null`; complete Tool Details are required only when the applicable execution projection is available. `argumentsContent` is an opaque Host Content Reference for complete safe arguments when the Web preview is truncated; it is never an SDK temporary path. Tools are joined only by `toolCallId`. Parallel `tool.execution_settled` arrival order MUST NOT change `sourceIndex` or block order.

### Snapshots

```text
CommittedSnapshot = {
  session: SessionSummary,
  turns: ProductTurnView[0..100],
  historyCursor: Cursor | null
}

ActiveOverlay = {
  runtimeEpoch: RuntimeEpoch,
  run: RunEnvelope,
  turn: ProductTurnView,
  runSeq: Sequence
}

SessionSyncView = {
  committed: CommittedSnapshot,
  runtimePhase: RuntimePhase | null,
  runtimeEpoch: RuntimeEpoch | null,
  activeOverlay: ActiveOverlay | null,
  desiredSettings: DesiredSettings | null,
  receipts: CommandReceipt[0..200],
  mutationBlockedByReceiptIds: OpaqueId[0..200 unique]
}

DegradedView = {
  code: ErrorCode,
  message: string{1..1000},
  since: IsoInstant
}

SessionCatalogPage = {
  workspaceId: OpaqueId,
  catalogRevision: OpaqueId,
  appliedLimit: integer{1..200},
  sessions: SessionSummary[0..200],
  nextCursor: Cursor | null
}

TrashCatalogPage = {
  workspaceId: OpaqueId | null,
  catalogRevision: OpaqueId,
  appliedLimit: integer{1..200},
  entries: TrashRecord[0..200],
  nextCursor: Cursor | null
}

BootstrapResult = {
  snapshotSeq: Sequence,
  workspaceCatalogRevision: OpaqueId,
  theme: ThemeSetting,
  workspaces: WorkspaceSummary[0..1000],
  selectedWorkspaceId: OpaqueId | null,
  selectedSessionCatalog: SessionCatalogPage | null,
  trashCatalog: TrashCatalogPage,
  activeSessionId: OpaqueId | null,
  activeSync: SessionSyncView | null,
  modelCatalog: ModelCatalog,
  desiredSettings: DesiredSettings | null,
  recentReceipts: CommandReceipt[0..200],
  degraded: DegradedView | null
}

SessionSyncResult = {
  view: SessionSyncView
}

AppSyncResult = BootstrapResult
```

`selectedSessionCatalog` is null exactly when `selectedWorkspaceId` is null; otherwise its `workspaceId` equals `selectedWorkspaceId`. `trashCatalog.workspaceId` is null because bootstrap and app sync return the first global trash page. Every page contains at most `appliedLimit` entries; bootstrap, app sync, and `workspace.select` use and report the default 50. Only `BootstrapResult`/`AppSyncResult.snapshotSeq` is an atomic connection-global watermark, defined in section 10. `SessionSyncResult` is a navigation read and never advances the event sequence baseline.

## 5. Handshake and envelopes

The first client frame MUST be:

```text
Hello = {
  type: hello,
  protocolMajor: 1,
  protocolMinor: integer{0..65535},
  clientId: OpaqueId,
  capabilities: string{1..128}[0..128 unique]
}
```

The Host responds before any other frame:

```text
Welcome = {
  type: welcome,
  protocolMajor: 1,
  protocolMinor: integer{0..65535},
  connectionId: OpaqueId,
  serverVersion: string{1..128},
  capabilities: string{1..128}[0..128 unique],
  connectionSeq: Sequence
}
```

A major mismatch returns `unsupported_protocol` and closes with `1002`. A minor feature is sent only when its named capability was negotiated; this does not permit unknown fields in an existing closed schema.

```text
CommandEnvelope<P> = {
  v: 1,
  requestId: RequestId,
  type: CommandType,
  clientMutationId: MutationId | null,
  sessionId: OpaqueId | null,
  expectedSessionVersion: SessionVersion | null,
  payload: P
}

SuccessResponse<R> = {
  v: 1,
  requestId: RequestId,
  ok: true,
  result: R
}

ErrorResponse = {
  v: 1,
  requestId: RequestId,
  ok: false,
  error: AppError
}

EventEnvelope<P> = {
  v: 1,
  connectionSeq: Sequence,
  type: EventType,
  workspaceId: OpaqueId | null,
  sessionId: OpaqueId | null,
  sessionVersion: SessionVersion | null,
  runtimeEpoch: RuntimeEpoch | null,
  runId: OpaqueId | null,
  runSeq: Sequence | null,
  payload: P
}
```

Read commands require `clientMutationId: null`. Mutation commands require a non-null unique value. Session mutations require `sessionId` and `expectedSessionVersion` unless the command table explicitly says otherwise. Every command produces exactly one response. Run completion is event/sync state, not a second command response.

## 6. Command schemas

`{}` means an exact empty object. Result arrays are bounded by section 2 and their shared schemas.

Catalog pagination requests are closed unions:

```text
FirstSessionCatalogPageRequest = {
  workspaceId: OpaqueId,
  limit: integer{1..200}
}

ContinueSessionCatalogPageRequest = {
  workspaceId: OpaqueId,
  appliedLimit: integer{1..200},
  catalogRevision: OpaqueId,
  cursor: Cursor
}

SessionCatalogPageRequest = FirstSessionCatalogPageRequest |
                            ContinueSessionCatalogPageRequest

FirstTrashCatalogPageRequest = {
  workspaceId: OpaqueId | null,
  limit: integer{1..200}
}

ContinueTrashCatalogPageRequest = {
  workspaceId: OpaqueId | null,
  appliedLimit: integer{1..200},
  catalogRevision: OpaqueId,
  cursor: Cursor
}

TrashCatalogPageRequest = FirstTrashCatalogPageRequest |
                          ContinueTrashCatalogPageRequest
```

A first page omits both `catalogRevision` and `cursor` and requests `limit`; every page response reports the actual `appliedLimit`. A continuation includes `catalogRevision`, `cursor`, and the prior response's `appliedLimit`. Supplying only part of that continuation triple is schema-invalid.

| Command type | Kind | Envelope scope | Exact payload | Exact success result |
|---|---|---|---|---|
| `app.bootstrap` | read | no Session/version | `{}` | `BootstrapResult` |
| `app.sync` | read | no Session/version | `{ knownSnapshotSeq: Sequence \| null, knownRuntimeEpoch: RuntimeEpoch \| null }` | `AppSyncResult` |
| `app.setThemePreference` | mutation | no Session/version | `{ themePreference: ThemePreference }` | `{ receipt: CommandReceipt, theme: ThemeSetting }` |
| `workspace.list` | read | no Session/version | `{}` | `{ workspaces: WorkspaceSummary[] }` |
| `workspace.register` | mutation | no Session/version | `{ path: LocalPathInput, displayName?: DisplayName }` | `{ receipt: CommandReceipt, workspace: WorkspaceSummary }` |
| `workspace.select` | mutation | no Session/version | `{ workspaceId: OpaqueId }` | `{ receipt: CommandReceipt, workspace: WorkspaceSummary, sessionCatalog: SessionCatalogPage }` |
| `workspace.updateDisplayName` | mutation | no Session/version | `{ workspaceId: OpaqueId, displayName: DisplayName }` | `{ receipt: CommandReceipt, workspace: WorkspaceSummary }` |
| `workspace.remove` | mutation | no Session/version | `{ workspaceId: OpaqueId }` | `{ receipt: CommandReceipt, workspaceId: OpaqueId }` |
| `session.list` | read | no Session/version | `SessionCatalogPageRequest` | `SessionCatalogPage` |
| `session.create` | mutation | no Session/version | `{ workspaceId: OpaqueId, title?: SessionTitle }` | `{ receipt: CommandReceipt, session: SessionSummary, activated: boolean, view: SessionSyncResult }` |
| `session.activate` | mutation | Session/version required | `{}` | `{ receipt: CommandReceipt, session: SessionSummary, view: SessionSyncResult }` |
| `session.inspect` | read | Session required, version null | `{ turnLimit: integer{1..100} }` | `{ snapshot: CommittedSnapshot }` |
| `session.rename` | mutation | Session/version required | `{ title: SessionTitle }` | `{ receipt: CommandReceipt, session: SessionSummary }` |
| `session.trash` | mutation | Session/version required | `{}` | `{ receipt: CommandReceipt, trash: TrashRecord, activeSessionId: OpaqueId \| null, runtimeEpoch: RuntimeEpoch }` |
| `session.trash.list` | read | no Session/version | `TrashCatalogPageRequest` | `TrashCatalogPage` |
| `session.trash.restore` | mutation | no Session/version | `{ trashId: OpaqueId }` | `{ receipt: CommandReceipt, session: SessionSummary }` |
| `session.sync` | read | Session required, version null | `{ knownRuntimeEpoch: RuntimeEpoch \| null, knownSessionVersion: SessionVersion \| null }` | `SessionSyncResult` |
| `session.history` | read | Session required, version null | `{ cursor: Cursor, limit: integer{1..100} }` | `{ turns: ProductTurnView[], nextCursor: Cursor \| null, sessionVersion: SessionVersion }` |
| `run.prompt` | mutation | Active Session/version required | `{ text: string{1..262144 bytes} }` | `{ receipt: CommandReceipt, run: RunEnvelope }` |
| `run.abort` | mutation | Active Session/version required | `{ runId: OpaqueId }` | `{ receipt: CommandReceipt, runId: OpaqueId }` |
| `command.status` | read | no Session/version | `{ clientMutationId: MutationId }` | `{ receipt: CommandReceipt }` |
| `command.acknowledgeUnknown` | mutation | no Session/version | `{ receiptId: OpaqueId, expectedState: delivery_unknown \| outcome_unknown }` | `{ receipt: CommandReceipt, acknowledgedReceipt: CommandReceipt }` |
| `runtime.setDesiredModel` | mutation | Active Session/version required | `{ model: ModelRef }` | `{ receipt: CommandReceipt, desiredSettings: DesiredSettings }` |
| `runtime.setDesiredThinking` | mutation | Active Session/version required | `{ thinkingLevel: ThinkingLevel }` | `{ receipt: CommandReceipt, desiredSettings: DesiredSettings }` |

`MutationCommandType` is exactly the mutation rows above. `CommandType` is exactly all rows above. Each mutation success returns its scope-aware committed or accepted receipt; an error response remains correlatable through `command.status`.

Every mutation has exactly one receipt authority mapping:

| Mutation command | Receipt scope | `authorityId` | Required lineage |
|---|---|---|---|
| `app.setThemePreference` | `host` | `app` | all lineage ids null |
| `workspace.register` | `host` | `workspace-catalog` | all lineage ids null |
| `workspace.select` | `host` | `selection` | all lineage ids null |
| `workspace.updateDisplayName` | `workspace` | payload `workspaceId` | that `workspaceId`; Session/Run ids null |
| `workspace.remove` | `workspace` | payload `workspaceId` | that `workspaceId`; Session/Run ids null |
| `session.create` | `workspace` | payload `workspaceId` | that `workspaceId`; Session/Run ids null |
| `session.activate` | `session` | envelope `sessionId` | resolved Workspace and envelope Session; Run id null |
| `session.rename` | `session` | envelope `sessionId` | resolved Workspace and envelope Session; Run id null |
| `session.trash` | `session` | envelope `sessionId` | resolved Workspace and envelope Session; Run id null |
| `session.trash.restore` | `workspace` | trash record `workspaceId` | resolved Workspace; Session/Run ids null |
| `run.prompt` | `run` | Host-allocated `runId` | resolved Workspace/Session plus allocated Run and Product Turn ids |
| `run.abort` | `run` | payload `runId` | active Workspace/Session plus the exact payload Run id; Product Turn id null |
| `command.acknowledgeUnknown` | `host` | `app` | all lineage ids null; target receipt scope remains unchanged |
| `runtime.setDesiredModel` | `session` | envelope `sessionId` | resolved Workspace and envelope Session; Run id null |
| `runtime.setDesiredThinking` | `session` | envelope `sessionId` | resolved Workspace and envelope Session; Run id null |

This table is exhaustive for `MutationCommandType`; implementations MUST fail schema generation or conformance if a mutation is missing or maps to more than one row. For `run.prompt`, the Host allocates `runId` and `productTurnId` before appending the durable `recorded` intention. Those ids and the receipt are returned by success or recovered by `command.status(clientMutationId)`, so the same mutation identity never acquires a second Run id.

Command invariants:

- `app.bootstrap` and `app.sync` execute through the global atomic snapshot barrier. `session.sync` is a navigation/inspection read and MUST NOT pause global delivery, change `lastApplied`, or supply a `snapshotSeq`.
- Every first Session/Trash catalog response returns its current opaque `catalogRevision`, actual `appliedLimit`, and `nextCursor`. A continuation cursor is valid only with the same revision, catalog kind, Workspace filter, sort, and `appliedLimit` encoded by that cursor. A continuation MUST echo that `appliedLimit`; mismatch returns `invalid_cursor`. If the current catalog changed, the Host returns `stale_catalog_revision`. `session.sync` neither returns nor changes a catalog revision.
- For each Session catalog identity (`workspaceId`) and Trash catalog identity (`workspaceId` filter or global null), Web maintains `currentObservedRevision`. A catalog-changing event first replaces that value with the event's revision and invalidates all pages from the prior revision. An ordinary `session.list`, `session.trash.list`, or `workspace.select` page is applied only when its `catalogRevision` equals an existing `currentObservedRevision`; on mismatch Web discards the entire response page, preserves the observed revision, and refetches from the first page. If no revision has yet been observed, the first ordinary page response establishes it. An ordinary response MUST NOT overwrite a different observed revision.
- Bootstrap and `app.sync` are the exception because their `snapshotSeq` barrier makes the complete snapshot authoritative. Web atomically installs all embedded catalog pages and revisions, unconditionally replacing earlier observed revisions, then applies only buffered events with `connectionSeq > snapshotSeq` in sequence. Those events advance `currentObservedRevision` and invalidate snapshot pages as usual. Embedded sync pages MUST NOT pass through the ordinary equality gate.
- `app.setThemePreference` reaches atomic persistence before success and emits `app.theme_changed` to all connected clients.
- `workspace.register` canonicalizes the path, then requires existence, directory type, read/search/write permission, and uniqueness by canonical identity.
- `workspace.updateDisplayName` changes no filesystem path.
- `session.trash` retains restore metadata and Content References. `session.trash.restore` fails on missing Workspace or destination conflict. No command permanently deletes trash. Active-session trash follows section 12.
- Every Session mutation requires idle. During a Run, non-active Sessions are read-only.
- `run.prompt` success means durable acceptance and a durable Run envelope exist. It is the only command whose accepted receipt creates or requires a Run envelope. Preflight rejection is an error response with a failed receipt retrievable by `command.status`.
- `run.abort.payload.runId` is mandatory and MUST equal the active Run. Missing is schema-invalid; no active Run returns `run_not_active`; a different active identity returns `run_mismatch`. The Host never aborts by implicit current state.
- Desired Settings never alter the current Run snapshot.
- A receipt's unknown-risk blocker follows its scope: Host blocks every mutation; Workspace blocks that Workspace and descendants; Session blocks that Session and Runs; Run blocks new Run/Session side effects for its Session. `command.acknowledgeUnknown` discovers the target scope from the referenced receipt and therefore requires no Session envelope fields; the acknowledgement mutation's own receipt is always Host-scoped at `app`, while the acknowledged receipt retains its original scope and authority. Reads remain allowed.
- A post-acknowledgement Prompt requires idle, a fresh sync's Session Version/runtime epoch, and a new mutation identifier.

## 7. Event schemas

Every event payload below is exact. Envelope scope columns specify required non-null fields; all other envelope scope fields are null unless named.

```text
ThemeChangedPayload = { theme: ThemeSetting }

WorkspaceChangedPayload = {
  change: WorkspaceChange,
  workspaceCatalogRevision: OpaqueId,
  workspaceId: OpaqueId,
  workspace: WorkspaceSummary | null
}

SessionDirectoryChangedPayload = {
  change: SessionChange,
  sessionCatalogRevision: OpaqueId,
  trashCatalogRevision: OpaqueId,
  sessionId: OpaqueId,
  session: SessionSummary | null,
  trash: TrashRecord | null
}

ActiveSessionChangedPayload = {
  previousSessionId: OpaqueId | null,
  activeSessionId: OpaqueId | null,
  runtimeEpoch: RuntimeEpoch,
  sessionVersion: SessionVersion | null,
  sessionCatalogRevision: OpaqueId
}

DesiredSettingsChangedPayload = { desiredSettings: DesiredSettings }

RunStartedPayload = {
  run: RunEnvelope,
  turn: ProductTurnView
}

AssistantStepStartedPayload = {
  productTurnId: OpaqueId,
  step: AssistantStepView
}

BlockStartedPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  block: ContentBlock
}

BlockDeltaPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  blockId: OpaqueId,
  append: string{1..32768 bytes}
}

BlockSettledPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  block: ContentBlock
}

ToolDeclarationStartedPayload = {
  productTurnId: OpaqueId,
  block: ToolBlock
}

ToolDeclarationDeltaPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  blockId: OpaqueId,
  toolCallId: OpaqueId,
  argumentsFragment: string{1..32768 bytes}
}

ToolDeclarationSettledPayload = {
  productTurnId: OpaqueId,
  block: ToolBlock
}

ToolExecutionStartedPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  blockId: OpaqueId,
  toolCallId: OpaqueId,
  startedAt: IsoInstant
}

ToolExecutionUpdatedPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  blockId: OpaqueId,
  toolCallId: OpaqueId,
  outputAppend: string{0..32768 bytes},
  previewTruncated: boolean
}

ToolExecutionSettledPayload = {
  productTurnId: OpaqueId,
  stepId: OpaqueId,
  blockId: OpaqueId,
  tool: ToolCallView
}

RunStateChangedPayload = { run: RunEnvelope }

SessionCommittedPayload = {
  sessionVersion: SessionVersion,
  sessionCatalogRevision: OpaqueId,
  turns: ProductTurnView[0..4]
}

CommandReceiptChangedPayload = { receipt: CommandReceipt }

HostDegradedPayload = { degraded: DegradedView }
```

The declaration-start block is a complete deterministic initial `ToolBlock`: `kind=tool`; payload `productTurnId` owns `stepId`; `sourceIndex` is its stable source position; `status=streaming`; `tool.toolCallId` and `tool.name` are the SDK declaration identities; `tool.toolKind` is `read`, `edit`, `write`, or `bash` only for that exact built-in name and otherwise `unknown`; `declarationStatus=preparing`; `argumentsPreview=""`; `argumentsTruncated=false`; `arguments=null`; `argumentsContent=null`; `executionStatus=pending`; `summary` equals `name`; `details=null`; `startedAt` is the Host-observed declaration event time; and `terminalAt` and `error` are null.

The declaration-settled block repeats the same block, step, source, and Tool Call identities. Its `declarationStatus` is `ready` with non-null safe `arguments` and null `error`, or `invalid` with null `arguments` and non-null safe `error`; all other fields reflect the accumulated declaration. `argumentsContent` is non-null when complete safe arguments were retained outside the bounded preview. This xor is normative.

`WorkspaceChangedPayload.workspace` is non-null for `registered`, `updated`, and `selected`, and null for `removed`.

| Event type | Required envelope scope | Exact payload |
|---|---|---|
| `app.theme_changed` | all scope null | `ThemeChangedPayload` |
| `workspace.changed` | `workspaceId` | `WorkspaceChangedPayload` |
| `session.directory_changed` | `workspaceId`, `sessionId`, `sessionVersion` when restored/committed | `SessionDirectoryChangedPayload` |
| `active_session.changed` | `workspaceId`, `runtimeEpoch`; `sessionId`/`sessionVersion` equal active values or null | `ActiveSessionChangedPayload` |
| `desired_settings.changed` | `workspaceId`, `sessionId`, `sessionVersion`, `runtimeEpoch` | `DesiredSettingsChangedPayload` |
| `run.started` | `workspaceId`, `sessionId`, `sessionVersion`, `runtimeEpoch`, `runId`, `runSeq` | `RunStartedPayload` |
| `assistant_step.started` | same runtime scope | `AssistantStepStartedPayload` |
| `block.started` | same runtime scope | `BlockStartedPayload` |
| `block.delta` | same runtime scope | `BlockDeltaPayload` |
| `block.settled` | same runtime scope | `BlockSettledPayload` |
| `tool.declaration_started` | same runtime scope | `ToolDeclarationStartedPayload` |
| `tool.declaration_delta` | same runtime scope | `ToolDeclarationDeltaPayload` |
| `tool.declaration_settled` | same runtime scope | `ToolDeclarationSettledPayload` |
| `tool.execution_started` | same runtime scope | `ToolExecutionStartedPayload` |
| `tool.execution_updated` | same runtime scope | `ToolExecutionUpdatedPayload` |
| `tool.execution_settled` | same runtime scope | `ToolExecutionSettledPayload` |
| `run.state_changed` | same runtime scope | `RunStateChangedPayload` |
| `session.committed` | `workspaceId`, `sessionId`, `sessionVersion`; runtime fields when active | `SessionCommittedPayload` |
| `command.receipt_changed` | receipt-derived scope; runtime fields only for accepted Run | `CommandReceiptChangedPayload` |
| `host.degraded` | affected scope or all null for Host-wide | `HostDegradedPayload` |

Runtime events MUST carry the current `runtimeEpoch` and strictly increasing `runSeq`. A Tool declaration delta applies only when both `blockId` and `toolCallId` identify the same existing preparing block; deltas for each block append serially in `runSeq` order. The client appends UTF-8 bytes to `argumentsPreview` until the cumulative 65,536-byte limit, then stops appending and sets `argumentsTruncated=true`; it never appends part of a Unicode scalar. A missing target, either mismatched identity, or a delta after settlement is a protocol violation: the event is not applied and the client requires full `app.sync`. Generic `block.delta` MUST NOT carry tool arguments.

At settlement the Host safely parses complete SDK arguments or supplies a safe `AppError`. Arguments exposed to Web remain bounded: structured `arguments` obeys `JsonValue` limits, `argumentsPreview` obeys the preview limit, and larger complete safe input uses `argumentsContent`. An execution event may use the adapter's complete SDK arguments to build presenter details but MUST NOT copy them unbounded into the Web projection. Execution may settle out of order but always joins declaration state by `toolCallId`.

A client encountering a global `connectionSeq` gap, runtime-epoch mismatch, or sync-buffer overflow requests `app.sync`. It MUST NOT repair global state with `session.sync`.

## 8. Delivery and Run reconciliation

Local and runtime-control mutations other than `run.prompt` use:

```text
recorded ── local/runtime-control commit proven ──► committed
   ├────── explicit failure proven ───────────────► failed
   └────── commit cannot be proven ───────────────► delivery_unknown
```

Only `run.prompt` uses:

```text
recorded ── acceptance not durable ──► delivery_unknown
   │
   └─ accepted + RunEnvelope ─┬─► succeeded
                             ├─► failed
                             ├─► aborted
                             └─ terminal not durable ─► outcome_unknown
```

Every mutation writes a scoped `recorded` intention first. A local mutation then records `committed` or `failed`; a crash window with no provable result becomes `delivery_unknown`. Only Prompt acceptance writes an accepted receipt and minimum Run envelope in one append-only journal record. It writes terminal Prompt receipt and terminal Run envelope in one later record before terminal events. A duplicate `clientMutationId` returns the existing receipt and never invokes the adapter.

Restart reconciliation order is normative:

1. Parse the valid Command Ledger prefix. A corrupt tail is quarantined and affected Session mutations remain blocked.
2. A valid local `committed`/`failed` record or combined Prompt terminal record wins.
3. An accepted Prompt receipt/Run envelope without a terminal record becomes `outcome_unknown` with `interruptionReason: host_restart`; it is not rewritten to `interrupted`.
4. Any recorded intent without a provable local commit, and a recorded Prompt without durable acceptance, becomes `delivery_unknown`.
5. Reopen Session JSONL and project content relative to `baseSessionVersion` and `baseLeafEntryId`; content never upgrades receipt state.
6. Create a new `runtimeEpoch`, clear the Active Overlay, and expose receipt blockers in sync.

For either unknown state, the user MUST first complete `app.sync` and inspect the affected scope. `command.acknowledgeUnknown` records explicit risk acknowledgement but does not rewrite the unknown outcome. The block applies at receipt scope, not an assumed Session. Only then may a new in-scope side-effecting mutation be submitted under current authority/version conditions with a new mutation identifier.

## 9. Error codes

`ErrorCode` is exactly:

```text
invalid_frame | frame_too_large | invalid_command | unsupported_command |
unsupported_protocol | protocol_violation | unauthenticated |
forbidden_origin | sync_buffer_overflow |

workspace_not_found | workspace_path_invalid | workspace_path_not_found |
workspace_path_not_directory | workspace_path_unreadable |
workspace_path_unwritable | workspace_duplicate |
workspace_display_name_invalid | workspace_in_use |

session_not_found | session_busy | stale_session_version |
invalid_cursor | stale_catalog_revision |
trash_not_found | session_restore_conflict | session_restore_workspace_missing |

run_not_active | run_mismatch | receipt_not_found |
receipt_state_mismatch | unresolved_command_outcome |
model_unavailable | thinking_unsupported | provider_auth_required |
provider_failed | command_delivery_unknown | command_outcome_unknown |
run_interrupted |

content_unavailable | content_too_large | storage_failed |
sdk_incompatible
```

Stable retry dispositions:

| Error family | Disposition |
|---|---|
| schema, protocol, auth, invalid path/name | `never` |
| stale version, gap, epoch mismatch | `after_sync` |
| stale or invalid Session/Trash catalog continuation | `restart_catalog` |
| busy, restore conflict, model/provider, unknown delivery/outcome | `explicit` |
| storage failure, SDK incompatibility | `never` until Host state changes |

Specific invariants:

- Canonical duplicates return `workspace_duplicate`, including symlink aliases.
- Permission checks return `workspace_path_unreadable` or `workspace_path_unwritable`, not generic storage errors.
- Abort identity mismatch returns `run_mismatch` with safe `activeRunId` detail.
- Unknown receipt state blocks mutation with `unresolved_command_outcome` and the blocking `receiptId`.
- A valid continuation cursor whose bound revision is no longer current returns `stale_catalog_revision`; the response exposes no replacement cursor or page.
- A cursor used with a different catalog identity, filter, sort, or `appliedLimit` returns `invalid_cursor`.
- `command_delivery_unknown` describes unproven local commit or Prompt acceptance; `command_outcome_unknown` describes proven Prompt acceptance with unproven terminal result.

## 10. Atomic sync watermark

`app.bootstrap` and `app.sync` use this algorithm for the connection-global `connectionSeq`:

1. The connection EventMux pauses outbound event delivery and starts a bounded buffer.
2. The AgentRuntimeKernel serial queue reaches a barrier after all earlier transitions.
3. Under the same barrier, the Host captures the projection and marks the highest connection sequence represented by it as `snapshotSeq`.
4. Later events receive greater sequences and remain buffered.
5. The Host writes the success response containing the snapshot and `snapshotSeq` before buffered event frames.
6. The client atomically replaces its local projection, every embedded catalog page and `currentObservedRevision`, runtime epoch, and last applied sequence with the response, regardless of earlier observed catalog revisions.
7. The Host releases buffered events in ascending `connectionSeq` order.
8. The client discards `connectionSeq <= lastApplied`, accepts exactly `lastApplied + 1`, advances catalog revisions from accepted events, and requests another `app.sync` only on a sequence gap or runtime-epoch mismatch—not because the installed snapshot revision differed from pre-sync state.

The application snapshot includes the complete Workspace registry and its revision, authoritative first `selectedSessionCatalog` and global `trashCatalog` pages with opaque revisions/cursors, Active Session/runtime state, theme, model/Desired Settings, and recent scoped receipts. Installing it invalidates cached Session/Trash catalog pages whose revision differs; the client refetches those catalogs from their first page without advancing the watermark. The snapshot and watermark are one logical read; neither may be captured without the other. Buffer overflow returns `sync_buffer_overflow`, sends no partial snapshot, discards the buffer, and requires a fresh `app.sync`. Socket loss discards the connection buffer. This protocol provides lossless reconciliation without claiming durable event replay.

`session.sync` returns one navigation view at its observed Session Version. It does not pause events, include `snapshotSeq` or a catalog revision, modify `lastApplied`, recover a gap, or increment any catalog revision. Events arriving around it are reconciled only by their normal global sequence or a later `app.sync`.

## 11. Content HTTP schema

`GET /api/v1/content/{contentRef}` requires the authenticated loopback cookie and exact Host/Origin checks. `contentRef` is an `OpaqueId`; query paths are not accepted.

Request headers:

- `Range` MAY request one byte range.
- `If-None-Match` MAY contain the quoted content digest.

Responses:

- `200` complete body;
- `206` one valid range with `Content-Range`;
- `304` matching digest;
- `404` with `content_unavailable` for absent or unauthorized opaque references;
- `416` for an invalid range.

The response includes `Content-Type`, `Content-Length`, `ETag`, `X-Content-Type-Options: nosniff`, and a restrictive Content Security Policy. HTML is returned as inert text or attachment, never active same-origin application content.

One Host Content Store serves all tools. The SDK spike establishes these source rules:

- Read has no `fullOutputPath`; complete returned content is captured directly before preview truncation.
- Bash may expose a temporary `fullOutputPath`; the Host copies it before expiry.
- Large edit/write diffs are stored before event projection.
- Realtime and persisted views expose only opaque Content References, never those source paths.

## 12. Theme and trash persistence

Bootstrap always includes `ThemeSetting`. `app.setThemePreference` validates the enum, atomically persists under `~/.yaca/app/`, then emits `app.theme_changed`. All tabs reconcile to the event. Tests cover all three values, invalid input, concurrent clients, persistence failure, and Host restart.

`session.trash` atomically moves the Session and restore metadata into `~/.yaca/trash/`. `session.trash.list` returns retained entries. `session.trash.restore` validates the registered Workspace and destination before moving the Session back. Missing manually cleared trash is reconciled as absent without recreating it. Protocol v1 provides no permanent-delete mutation or retention timer.

Trashing the Active Session is defined as follows:

1. `running` or `stopping` returns `session_busy` without disposing or moving anything.
2. While idle, the Host preflights the trash destination and selects the most recently updated surviving Session in the same Workspace as fallback, or null when none exists.
3. The Host disposes the idle runtime, increments `runtimeEpoch`, moves the target and restore metadata, activates the fallback when present, and commits catalog/active state as one application transaction.
4. After commit it emits `active_session.changed` first, with the previous id, fallback id or null, new epoch, and fallback version or null. It then emits `session.directory_changed(change: trashed)`. The command response follows the same committed values.
5. Failure before disposal changes nothing and emits no event. Failure after disposal compensates by moving the target back if necessary and reopening it under another new epoch. The error response is followed only by `active_session.changed` for the reopened same Session/new epoch; no trash event is emitted.
6. If compensation cannot restore a usable runtime and source file, the Host emits `host.degraded`, leaves Active Session null, blocks mutation, and preserves every recoverable file. It never reports trash success.

## 13. Unknown fields and compatibility

- Every object is closed and every discriminator/enum is exhaustive for v1.
- Unknown command types return `unsupported_command` without invocation.
- Unknown event types, response fields, or enum members are `protocol_violation`; the client closes, reconnects, and bootstraps instead of guessing.
- Minor capabilities may introduce a separate negotiated command/event variant, but MUST NOT add an unnegotiated field to an existing closed variant.
- Major changes may reinterpret or remove fields and require handshake rejection by older peers.
- Stable receipt states and error codes never change meaning within major v1.

## 14. Fixture and conformance matrix

Host and Web independently generate fixtures from the schemas above. The shared suite contains:

- one minimum valid, one maximum-boundary valid, and one unknown-field-invalid fixture for every command payload, result, event payload, and envelope;
- invalid mutation/read envelope combinations and every stable error code;
- `system`, `light`, and `dark` bootstrap/update/restart fixtures;
- Workspace missing, file-not-directory, unreadable, unwritable, symlink duplicate, display-name update, and remove-without-delete fixtures;
- trash/list/restore, missing manual trash, restore conflict, and indefinite-retention fixtures;
- exact-run abort success, missing `runId`, no active Run, and mismatched Run fixtures;
- one generated fixture row for every mutation in the exhaustive authority table, asserting its sole `ReceiptScope`, exact `authorityId`, required/null lineage, and no duplicate or missing mapping; Host/Workspace/Session/Run-scoped non-Prompt receipts cover `recorded → committed | failed | delivery_unknown`;
- Prompt receipt paths for terminal success/failure/abort, `delivery_unknown`, `outcome_unknown`, scope-aware risk acknowledgement, and post-acknowledgement new mutation;
- minimum Run envelope linkage across receipt, Product Turn, Session, Run, base version, settings, and runtime epoch;
- first and continuation Session/Trash catalog pages with `appliedLimit`, same-revision/limit echo, cursor filter binding, invalid limit echo, ordinary event-before-response rejection without revision rollback, authoritative sync replacement of an older observed revision, buffered post-snapshot revision advance without a sync loop, client page discard/restart, revision-bearing catalog events, and proof that `session.sync` neither returns nor changes a catalog revision;
- full `app.sync` snapshots with events immediately before, during, and after the barrier, duplicate events, gaps, epoch mismatch, buffer overflow, and reconnect; `session.sync` fixtures prove it never advances the global watermark;
- a DeepSeek catalog fixture with exactly `off`, `low`, `high`, and `max`, plus rejection of unsupported levels;
- Tool declaration start with every deterministic initial `ToolBlock` field, serial argument fragments, exact 65,536-byte UTF-8 truncation, missing/mismatched-target rejection, complete settled block with safe parsed arguments or error, Content Reference fallback, and parallel Tool Calls whose execution completion order differs from declaration order but remains joined by `toolCallId`;
- active-session trash rejection while running, idle fallback selection, event order, successful restore, compensation, and degraded rollback failure;
- Read direct Content Store capture, Bash temporary-path ingestion, large edit diff reference, Content range, and oversized-content failure; and
- strict rejection of oversized frames, unknown fields, unsafe Origin, forged Session Version, and unauthorized Content Reference.

The repository carries exactly five review-risk golden scenarios under `docs/spec/fixtures/`:

- `non-run-mutation-receipt.json`;
- `app-sync-gap.json`;
- `tool-declaration-stream.json`;
- `restart-unknown-outcomes.json`;
- `active-session-trash.json`.

Each file contains protocol objects plus an `expect` oracle. Scenario wrapper fields are test metadata, not wire fields; every nested command, response, event, receipt, Run envelope, and projection object remains closed under this specification.
