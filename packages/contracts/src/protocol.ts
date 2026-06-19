import { Type, type Static, type TProperties, type TSchema } from "typebox";
import * as Value from "typebox/value";

const closed = <const P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
const serializedStringByteLength = (value: string) => utf8Length(JSON.stringify(value));
const utf8String = (maximum: number, minimum = 0) =>
  Type.Refine(Type.String(), (value) => {
    const scalarLength = [...value].length;
    return scalarLength >= minimum && serializedStringByteLength(value) <= maximum;
  });
const utf8Pattern = (maximum: number, minimum: number, pattern: string) =>
  Type.Refine(
    Type.String({ pattern }),
    (value) => [...value].length >= minimum && serializedStringByteLength(value) <= maximum,
  );
const trimmed = (maximum: number) =>
  Type.Refine(
    utf8String(maximum, 1),
    (value) =>
      value === value.trim() &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }),
  );

export const FRAME_BYTE_LIMIT = 1_048_576;
export const OpaqueIdSchema = utf8Pattern(128, 1, "^[A-Za-z0-9_-]+$");
export const RequestIdSchema = OpaqueIdSchema;
export const MutationIdSchema = OpaqueIdSchema;
export const SessionVersionSchema = OpaqueIdSchema;
export const RuntimeEpochSchema = OpaqueIdSchema;
export const CursorSchema = utf8String(512, 1);
export const IsoInstantSchema = Type.Refine(
  Type.String({ format: "date-time" }),
  (value) => serializedStringByteLength(value) <= 40 && value.endsWith("Z"),
);
export const DisplayNameSchema = trimmed(128);
export const SessionTitleSchema = trimmed(200);
export const LocalPathInputSchema = utf8Pattern(4096, 1, "^[^\\u0000]+$");
export const DisplayPathSchema = LocalPathInputSchema;
export const SafeTextSchema = utf8String(65_536);
export const SequenceSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const DurationMsSchema = SequenceSchema;
export const ByteCountSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: "^[0-9]+$",
});

export const ThemePreferenceSchema = Type.Enum(["system", "light", "dark"]);
export const RuntimePhaseSchema = Type.Enum([
  "idle",
  "starting",
  "running",
  "stopping",
  "degraded",
]);
export const ThinkingLevelSchema = Type.Enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const DesiredSettingStateSchema = Type.Enum([
  "ready_for_next_run",
  "pending_current_run_terminal",
]);
export const RunStatusSchema = Type.Enum([
  "accepted",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "aborted",
  "interrupted",
  "outcome_unknown",
]);
export const ReceiptStateSchema = Type.Enum([
  "recorded",
  "accepted",
  "succeeded",
  "failed",
  "aborted",
  "committed",
  "delivery_unknown",
  "outcome_unknown",
]);
export const ReceiptScopeSchema = Type.Enum(["host", "workspace", "session", "run"]);
export const RiskAcknowledgementSchema = Type.Enum(["not_required", "required", "acknowledged"]);
export const BlockStatusSchema = Type.Enum(["streaming", "settled", "interrupted"]);
export const ToolKindSchema = Type.Enum(["read", "edit", "write", "bash", "unknown"]);
export const ToolDeclarationStatusSchema = Type.Enum(["preparing", "ready", "invalid"]);
export const ToolExecutionStatusSchema = Type.Enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "aborted",
]);
export const InterruptionReasonSchema = Type.Enum([
  "host_restart",
  "runtime_replaced",
  "runtime_lost",
]);
export const WorkspaceChangeSchema = Type.Enum(["registered", "updated", "selected", "removed"]);
export const SessionChangeSchema = Type.Enum([
  "created",
  "renamed",
  "committed",
  "trashed",
  "restored",
]);
export const RetryDispositionSchema = Type.Enum([
  "never",
  "after_sync",
  "restart_catalog",
  "explicit",
]);
export const ErrorCodeSchema = Type.Enum([
  "invalid_frame",
  "frame_too_large",
  "invalid_command",
  "unsupported_command",
  "unsupported_protocol",
  "protocol_violation",
  "unauthenticated",
  "forbidden_origin",
  "sync_buffer_overflow",
  "workspace_not_found",
  "workspace_path_invalid",
  "workspace_path_not_found",
  "workspace_path_not_directory",
  "workspace_path_unreadable",
  "workspace_path_unwritable",
  "workspace_duplicate",
  "workspace_display_name_invalid",
  "workspace_in_use",
  "session_not_found",
  "session_busy",
  "stale_session_version",
  "invalid_cursor",
  "stale_catalog_revision",
  "trash_not_found",
  "session_restore_conflict",
  "session_restore_workspace_missing",
  "run_not_active",
  "run_mismatch",
  "receipt_not_found",
  "receipt_state_mismatch",
  "unresolved_command_outcome",
  "model_unavailable",
  "thinking_unsupported",
  "provider_auth_required",
  "provider_failed",
  "command_delivery_unknown",
  "command_outcome_unknown",
  "run_interrupted",
  "content_unavailable",
  "content_too_large",
  "storage_failed",
  "sdk_incompatible",
]);

export const ErrorDetailsSchema = closed({
  field: Type.Optional(utf8String(128, 1)),
  expected: Type.Optional(utf8String(512, 1)),
  actual: Type.Optional(utf8String(512, 1)),
  receiptId: Type.Optional(OpaqueIdSchema),
  activeRunId: Type.Optional(OpaqueIdSchema),
});
export const AppErrorSchema = closed({
  code: ErrorCodeSchema,
  message: utf8String(1000, 1),
  retryDisposition: RetryDispositionSchema,
  details: Type.Optional(ErrorDetailsSchema),
});
export const ThemeSettingSchema = closed({
  themePreference: ThemePreferenceSchema,
  updatedAt: IsoInstantSchema,
});
export const WorkspaceSummarySchema = closed({
  workspaceId: OpaqueIdSchema,
  displayName: DisplayNameSchema,
  displayPath: DisplayPathSchema,
  selected: Type.Boolean(),
  available: Type.Boolean(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
});
export const SessionSummarySchema = closed({
  sessionId: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  title: SessionTitleSchema,
  sessionVersion: SessionVersionSchema,
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  active: Type.Boolean(),
  unreadTerminal: Type.Boolean(),
  lastRunStatus: nullable(RunStatusSchema),
});
export const TrashRecordSchema = closed({
  trashId: OpaqueIdSchema,
  originalSessionId: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  title: SessionTitleSchema,
  originalSessionVersion: SessionVersionSchema,
  trashedAt: IsoInstantSchema,
  restorable: Type.Boolean(),
  restoreBlockedReason: nullable(utf8String(500, 1)),
});
export const ModelRefSchema = closed({ providerId: OpaqueIdSchema, modelId: OpaqueIdSchema });
export const ModelCatalogEntrySchema = closed({
  model: ModelRefSchema,
  providerDisplayName: DisplayNameSchema,
  modelDisplayName: DisplayNameSchema,
  available: Type.Boolean(),
  supportedThinkingLevels: Type.Array(ThinkingLevelSchema, {
    minItems: 1,
    maxItems: 7,
    uniqueItems: true,
  }),
});
export const ModelCatalogSchema = closed({
  revision: OpaqueIdSchema,
  models: Type.Array(ModelCatalogEntrySchema, { maxItems: 1000 }),
});
export const DesiredSettingsSchema = closed({
  revision: OpaqueIdSchema,
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
  state: DesiredSettingStateSchema,
  updatedAt: IsoInstantSchema,
});
export const RunSettingSnapshotSchema = closed({
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
});

export const READ_COMMAND_TYPES = [
  "app.bootstrap",
  "app.sync",
  "workspace.list",
  "session.list",
  "session.inspect",
  "session.trash.list",
  "session.sync",
  "session.history",
  "command.status",
] as const;
export const MUTATION_COMMAND_TYPES = [
  "app.setThemePreference",
  "workspace.register",
  "workspace.select",
  "workspace.updateDisplayName",
  "workspace.remove",
  "session.create",
  "session.activate",
  "session.rename",
  "session.trash",
  "session.trash.restore",
  "run.prompt",
  "run.abort",
  "command.acknowledgeUnknown",
  "runtime.setDesiredModel",
  "runtime.setDesiredThinking",
] as const;
export const COMMAND_TYPES = [...READ_COMMAND_TYPES, ...MUTATION_COMMAND_TYPES] as const;
export const ReadCommandTypeSchema = Type.Enum(READ_COMMAND_TYPES);
export const MutationCommandTypeSchema = Type.Enum(MUTATION_COMMAND_TYPES);
export const CommandTypeSchema = Type.Enum(COMMAND_TYPES);
export type MutationCommandType = Static<typeof MutationCommandTypeSchema>;
export type CommandType = Static<typeof CommandTypeSchema>;

export const CommandReceiptSchema = closed({
  receiptId: OpaqueIdSchema,
  clientMutationId: MutationIdSchema,
  commandType: MutationCommandTypeSchema,
  scope: ReceiptScopeSchema,
  authorityId: OpaqueIdSchema,
  state: ReceiptStateSchema,
  workspaceId: nullable(OpaqueIdSchema),
  sessionId: nullable(OpaqueIdSchema),
  runId: nullable(OpaqueIdSchema),
  productTurnId: nullable(OpaqueIdSchema),
  riskAcknowledgement: RiskAcknowledgementSchema,
  recordedAt: IsoInstantSchema,
  acceptedAt: nullable(IsoInstantSchema),
  terminalAt: nullable(IsoInstantSchema),
  acknowledgedAt: nullable(IsoInstantSchema),
  error: nullable(AppErrorSchema),
});
export const RunEnvelopeSchema = closed({
  runId: OpaqueIdSchema,
  productTurnId: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  promptReceiptId: OpaqueIdSchema,
  promptClientMutationId: MutationIdSchema,
  runtimeEpoch: RuntimeEpochSchema,
  baseSessionVersion: SessionVersionSchema,
  baseLeafEntryId: nullable(OpaqueIdSchema),
  settings: RunSettingSnapshotSchema,
  status: RunStatusSchema,
  acceptedAt: IsoInstantSchema,
  terminalAt: nullable(IsoInstantSchema),
  terminalError: nullable(AppErrorSchema),
  interruptionReason: nullable(InterruptionReasonSchema),
});

export const ContentReferenceSchema = closed({
  contentRef: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  kind: Type.Enum(["text", "terminal", "diff", "json", "binary"]),
  mediaType: utf8String(200, 1),
  byteLength: ByteCountSchema,
  digest: Type.String({ minLength: 64, maxLength: 64 }),
  available: Type.Boolean(),
});
export const ContentPreviewSchema = closed({
  text: utf8String(65_536),
  truncated: Type.Boolean(),
  originalByteLength: ByteCountSchema,
  complete: nullable(ContentReferenceSchema),
});
const JsonValueBaseSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      utf8String(65_536),
      Type.Array(Type.Ref("JsonValue"), { maxItems: 1024 }),
      Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Ref("JsonValue"), {
        maxProperties: 1024,
      }),
    ]),
  },
  "JsonValue",
);
function jsonWithinLimits(value: unknown): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (Array.isArray(node))
      return node.length <= 1024 && node.every((item) => visit(item, depth + 1));
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node);
      return (
        entries.length <= 1024 &&
        entries.every(
          ([key, item]) =>
            key.length >= 1 && serializedStringByteLength(key) <= 256 && visit(item, depth + 1),
        )
      );
    }
    return typeof node !== "number" || Number.isFinite(node);
  };
  try {
    return visit(value, 0) && utf8Length(JSON.stringify(value)) <= 262_144;
  } catch {
    return false;
  }
}
export const JsonValueSchema = Type.Refine(JsonValueBaseSchema, jsonWithinLimits);
export const NonNullJsonValueSchema = Type.Refine(JsonValueSchema, (value) => value !== null);
export const PromptViewSchema = closed({
  promptId: OpaqueIdSchema,
  text: utf8String(262_144),
  createdAt: IsoInstantSchema,
});
export const UsageViewSchema = closed({
  inputTokens: ByteCountSchema,
  outputTokens: ByteCountSchema,
  cacheReadTokens: ByteCountSchema,
  cacheWriteTokens: ByteCountSchema,
});
const blockBase = {
  blockId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  sourceIndex: Type.Integer({ minimum: 0, maximum: 255 }),
};
export const ThinkingBlockSchema = closed({
  kind: Type.Literal("thinking"),
  ...blockBase,
  status: BlockStatusSchema,
  content: ContentPreviewSchema,
});
export const TextBlockSchema = closed({
  kind: Type.Literal("text"),
  ...blockBase,
  status: BlockStatusSchema,
  content: ContentPreviewSchema,
});
export const ReadDetailsSchema = closed({
  kind: Type.Literal("read"),
  path: DisplayPathSchema,
  startLine: nullable(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  endLine: nullable(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  content: ContentPreviewSchema,
});
const editDetails = {
  path: DisplayPathSchema,
  diff: ContentPreviewSchema,
  additions: nullable(SequenceSchema),
  deletions: nullable(SequenceSchema),
};
export const EditDetailsSchema = closed({ kind: Type.Literal("edit"), ...editDetails });
export const WriteDetailsSchema = closed({ kind: Type.Literal("write"), ...editDetails });
export const BashDetailsSchema = closed({
  kind: Type.Literal("bash"),
  command: utf8String(262_144, 1),
  output: ContentPreviewSchema,
  exitCode: nullable(Type.Integer({ minimum: -2147483648, maximum: 2147483647 })),
  signal: nullable(utf8String(64, 1)),
  durationMs: nullable(DurationMsSchema),
});
export const UnknownToolDetailsSchema = closed({
  kind: Type.Literal("unknown"),
  input: ContentPreviewSchema,
  output: nullable(ContentPreviewSchema),
});
export const ToolDetailsSchema = Type.Union([
  ReadDetailsSchema,
  EditDetailsSchema,
  WriteDetailsSchema,
  BashDetailsSchema,
  UnknownToolDetailsSchema,
]);
const toolFields = {
  toolCallId: OpaqueIdSchema,
  name: utf8String(256, 1),
  toolKind: ToolKindSchema,
  argumentsPreview: utf8String(65_536),
  argumentsTruncated: Type.Boolean(),
  argumentsContent: nullable(ContentReferenceSchema),
  executionStatus: ToolExecutionStatusSchema,
  summary: utf8String(1000),
  details: nullable(ToolDetailsSchema),
  startedAt: nullable(IsoInstantSchema),
  terminalAt: nullable(IsoInstantSchema),
};
export const ToolCallViewSchema = closed({
  ...toolFields,
  declarationStatus: ToolDeclarationStatusSchema,
  arguments: nullable(JsonValueSchema),
  error: nullable(AppErrorSchema),
});
export const ToolBlockSchema = closed({
  kind: Type.Literal("tool"),
  ...blockBase,
  status: BlockStatusSchema,
  tool: ToolCallViewSchema,
});
export const ErrorBlockSchema = closed({
  kind: Type.Literal("error"),
  ...blockBase,
  status: Type.Enum(["settled", "interrupted"]),
  error: AppErrorSchema,
});
export const ContentBlockSchema = Type.Union([
  ThinkingBlockSchema,
  TextBlockSchema,
  ToolBlockSchema,
  ErrorBlockSchema,
]);
export const AssistantStepViewSchema = closed({
  stepId: OpaqueIdSchema,
  productTurnId: OpaqueIdSchema,
  stepIndex: Type.Integer({ minimum: 0, maximum: 255 }),
  status: Type.Enum(["streaming", "settled", "interrupted"]),
  blocks: Type.Array(ContentBlockSchema, { maxItems: 256 }),
  startedAt: IsoInstantSchema,
  terminalAt: nullable(IsoInstantSchema),
  usage: nullable(UsageViewSchema),
});
export const ProductTurnViewSchema = closed({
  productTurnId: OpaqueIdSchema,
  runId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  prompt: PromptViewSchema,
  settings: RunSettingSnapshotSchema,
  status: RunStatusSchema,
  steps: Type.Array(AssistantStepViewSchema, { maxItems: 256 }),
  startedAt: IsoInstantSchema,
  terminalAt: nullable(IsoInstantSchema),
  error: nullable(AppErrorSchema),
});
export const CommittedSnapshotSchema = closed({
  session: SessionSummarySchema,
  turns: Type.Array(ProductTurnViewSchema, { maxItems: 100 }),
  historyCursor: nullable(CursorSchema),
});
export const ActiveOverlaySchema = closed({
  runtimeEpoch: RuntimeEpochSchema,
  run: RunEnvelopeSchema,
  turn: ProductTurnViewSchema,
  runSeq: SequenceSchema,
});
export const SessionSyncViewSchema = closed({
  committed: CommittedSnapshotSchema,
  runtimePhase: nullable(RuntimePhaseSchema),
  runtimeEpoch: nullable(RuntimeEpochSchema),
  activeOverlay: nullable(ActiveOverlaySchema),
  desiredSettings: nullable(DesiredSettingsSchema),
  receipts: Type.Array(CommandReceiptSchema, { maxItems: 200 }),
  mutationBlockedByReceiptIds: Type.Array(OpaqueIdSchema, {
    maxItems: 200,
    uniqueItems: true,
  }),
});
export const DegradedViewSchema = closed({
  code: ErrorCodeSchema,
  message: utf8String(1000, 1),
  since: IsoInstantSchema,
});
export const SessionCatalogPageSchema = closed({
  workspaceId: OpaqueIdSchema,
  catalogRevision: OpaqueIdSchema,
  appliedLimit: Type.Integer({ minimum: 1, maximum: 200 }),
  sessions: Type.Array(SessionSummarySchema, { maxItems: 200 }),
  nextCursor: nullable(CursorSchema),
});
export const TrashCatalogPageSchema = closed({
  workspaceId: nullable(OpaqueIdSchema),
  catalogRevision: OpaqueIdSchema,
  appliedLimit: Type.Integer({ minimum: 1, maximum: 200 }),
  entries: Type.Array(TrashRecordSchema, { maxItems: 200 }),
  nextCursor: nullable(CursorSchema),
});
export const BootstrapResultSchema = closed({
  snapshotSeq: SequenceSchema,
  workspaceCatalogRevision: OpaqueIdSchema,
  theme: ThemeSettingSchema,
  workspaces: Type.Array(WorkspaceSummarySchema, { maxItems: 1000 }),
  selectedWorkspaceId: nullable(OpaqueIdSchema),
  selectedSessionCatalog: nullable(SessionCatalogPageSchema),
  trashCatalog: TrashCatalogPageSchema,
  activeSessionId: nullable(OpaqueIdSchema),
  activeSync: nullable(SessionSyncViewSchema),
  modelCatalog: ModelCatalogSchema,
  desiredSettings: nullable(DesiredSettingsSchema),
  recentReceipts: Type.Array(CommandReceiptSchema, { maxItems: 200 }),
  degraded: nullable(DegradedViewSchema),
});
export const AppSyncResultSchema = BootstrapResultSchema;
export const SessionSyncResultSchema = closed({ view: SessionSyncViewSchema });

export const EmptyPayloadSchema = closed({});
export const FirstSessionCatalogPageRequestSchema = closed({
  workspaceId: OpaqueIdSchema,
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
});
export const ContinueSessionCatalogPageRequestSchema = closed({
  workspaceId: OpaqueIdSchema,
  appliedLimit: Type.Integer({ minimum: 1, maximum: 200 }),
  catalogRevision: OpaqueIdSchema,
  cursor: CursorSchema,
});
export const SessionCatalogPageRequestSchema = Type.Union([
  FirstSessionCatalogPageRequestSchema,
  ContinueSessionCatalogPageRequestSchema,
]);
export const FirstTrashCatalogPageRequestSchema = closed({
  workspaceId: nullable(OpaqueIdSchema),
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
});
export const ContinueTrashCatalogPageRequestSchema = closed({
  workspaceId: nullable(OpaqueIdSchema),
  appliedLimit: Type.Integer({ minimum: 1, maximum: 200 }),
  catalogRevision: OpaqueIdSchema,
  cursor: CursorSchema,
});
export const TrashCatalogPageRequestSchema = Type.Union([
  FirstTrashCatalogPageRequestSchema,
  ContinueTrashCatalogPageRequestSchema,
]);

const readNoSession = <const T extends string, const P extends TSchema>(type: T, payload: P) =>
  closed({
    v: Type.Literal(1),
    requestId: RequestIdSchema,
    type: Type.Literal(type),
    clientMutationId: Type.Null(),
    sessionId: Type.Null(),
    expectedSessionVersion: Type.Null(),
    payload,
  });
const readSession = <const T extends string, const P extends TSchema>(type: T, payload: P) =>
  closed({
    v: Type.Literal(1),
    requestId: RequestIdSchema,
    type: Type.Literal(type),
    clientMutationId: Type.Null(),
    sessionId: OpaqueIdSchema,
    expectedSessionVersion: Type.Null(),
    payload,
  });
const mutateNoSession = <const T extends string, const P extends TSchema>(type: T, payload: P) =>
  closed({
    v: Type.Literal(1),
    requestId: RequestIdSchema,
    type: Type.Literal(type),
    clientMutationId: MutationIdSchema,
    sessionId: Type.Null(),
    expectedSessionVersion: Type.Null(),
    payload,
  });
const mutateSession = <const T extends string, const P extends TSchema>(type: T, payload: P) =>
  closed({
    v: Type.Literal(1),
    requestId: RequestIdSchema,
    type: Type.Literal(type),
    clientMutationId: MutationIdSchema,
    sessionId: OpaqueIdSchema,
    expectedSessionVersion: SessionVersionSchema,
    payload,
  });

export const AppBootstrapPayloadSchema = EmptyPayloadSchema;
export const AppSyncPayloadSchema = closed({
  knownSnapshotSeq: nullable(SequenceSchema),
  knownRuntimeEpoch: nullable(RuntimeEpochSchema),
});
export const SetThemePreferencePayloadSchema = closed({ themePreference: ThemePreferenceSchema });
export const WorkspaceRegisterPayloadSchema = closed({
  path: LocalPathInputSchema,
  displayName: Type.Optional(DisplayNameSchema),
});
export const WorkspaceIdPayloadSchema = closed({ workspaceId: OpaqueIdSchema });
export const WorkspaceDisplayNamePayloadSchema = closed({
  workspaceId: OpaqueIdSchema,
  displayName: DisplayNameSchema,
});
export const SessionCreatePayloadSchema = closed({
  workspaceId: OpaqueIdSchema,
  title: Type.Optional(SessionTitleSchema),
});
export const SessionInspectPayloadSchema = closed({
  turnLimit: Type.Integer({ minimum: 1, maximum: 100 }),
});
export const SessionRenamePayloadSchema = closed({ title: SessionTitleSchema });
export const SessionSyncPayloadSchema = closed({
  knownRuntimeEpoch: nullable(RuntimeEpochSchema),
  knownSessionVersion: nullable(SessionVersionSchema),
});
export const SessionHistoryPayloadSchema = closed({
  cursor: CursorSchema,
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
});
export const RunPromptPayloadSchema = closed({ text: utf8String(262_144, 1) });
export const RunAbortPayloadSchema = closed({ runId: OpaqueIdSchema });
export const CommandStatusPayloadSchema = closed({ clientMutationId: MutationIdSchema });
export const CommandAcknowledgeUnknownPayloadSchema = closed({
  receiptId: OpaqueIdSchema,
  expectedState: Type.Enum(["delivery_unknown", "outcome_unknown"]),
});
export const RuntimeSetDesiredModelPayloadSchema = closed({ model: ModelRefSchema });
export const RuntimeSetDesiredThinkingPayloadSchema = closed({
  thinkingLevel: ThinkingLevelSchema,
});

export const AppBootstrapCommandSchema = readNoSession("app.bootstrap", EmptyPayloadSchema);
export const AppSyncCommandSchema = readNoSession("app.sync", AppSyncPayloadSchema);
export const SetThemePreferenceCommandSchema = mutateNoSession(
  "app.setThemePreference",
  SetThemePreferencePayloadSchema,
);
export const WorkspaceListCommandSchema = readNoSession("workspace.list", EmptyPayloadSchema);
export const WorkspaceRegisterCommandSchema = mutateNoSession(
  "workspace.register",
  WorkspaceRegisterPayloadSchema,
);
export const WorkspaceSelectCommandSchema = mutateNoSession(
  "workspace.select",
  WorkspaceIdPayloadSchema,
);
export const WorkspaceUpdateDisplayNameCommandSchema = mutateNoSession(
  "workspace.updateDisplayName",
  WorkspaceDisplayNamePayloadSchema,
);
export const WorkspaceRemoveCommandSchema = mutateNoSession(
  "workspace.remove",
  WorkspaceIdPayloadSchema,
);
export const SessionListCommandSchema = readNoSession(
  "session.list",
  SessionCatalogPageRequestSchema,
);
export const SessionCreateCommandSchema = mutateNoSession(
  "session.create",
  SessionCreatePayloadSchema,
);
export const SessionActivateCommandSchema = mutateSession("session.activate", EmptyPayloadSchema);
export const SessionInspectCommandSchema = readSession(
  "session.inspect",
  SessionInspectPayloadSchema,
);
export const SessionRenameCommandSchema = mutateSession(
  "session.rename",
  SessionRenamePayloadSchema,
);
export const SessionTrashCommandSchema = mutateSession("session.trash", EmptyPayloadSchema);
export const SessionTrashListCommandSchema = readNoSession(
  "session.trash.list",
  TrashCatalogPageRequestSchema,
);
export const SessionTrashRestoreCommandSchema = mutateNoSession(
  "session.trash.restore",
  closed({ trashId: OpaqueIdSchema }),
);
export const SessionSyncCommandSchema = readSession("session.sync", SessionSyncPayloadSchema);
export const SessionHistoryCommandSchema = readSession(
  "session.history",
  SessionHistoryPayloadSchema,
);
export const RunPromptCommandSchema = mutateSession("run.prompt", RunPromptPayloadSchema);
export const RunAbortCommandSchema = mutateSession("run.abort", RunAbortPayloadSchema);
export const CommandStatusCommandSchema = readNoSession(
  "command.status",
  CommandStatusPayloadSchema,
);
export const CommandAcknowledgeUnknownCommandSchema = mutateNoSession(
  "command.acknowledgeUnknown",
  CommandAcknowledgeUnknownPayloadSchema,
);
export const RuntimeSetDesiredModelCommandSchema = mutateSession(
  "runtime.setDesiredModel",
  RuntimeSetDesiredModelPayloadSchema,
);
export const RuntimeSetDesiredThinkingCommandSchema = mutateSession(
  "runtime.setDesiredThinking",
  RuntimeSetDesiredThinkingPayloadSchema,
);
export const CommandEnvelopeSchema = Type.Union([
  AppBootstrapCommandSchema,
  AppSyncCommandSchema,
  SetThemePreferenceCommandSchema,
  WorkspaceListCommandSchema,
  WorkspaceRegisterCommandSchema,
  WorkspaceSelectCommandSchema,
  WorkspaceUpdateDisplayNameCommandSchema,
  WorkspaceRemoveCommandSchema,
  SessionListCommandSchema,
  SessionCreateCommandSchema,
  SessionActivateCommandSchema,
  SessionInspectCommandSchema,
  SessionRenameCommandSchema,
  SessionTrashCommandSchema,
  SessionTrashListCommandSchema,
  SessionTrashRestoreCommandSchema,
  SessionSyncCommandSchema,
  SessionHistoryCommandSchema,
  RunPromptCommandSchema,
  RunAbortCommandSchema,
  CommandStatusCommandSchema,
  CommandAcknowledgeUnknownCommandSchema,
  RuntimeSetDesiredModelCommandSchema,
  RuntimeSetDesiredThinkingCommandSchema,
]);
export type CommandEnvelope = Static<typeof CommandEnvelopeSchema>;
export const COMMAND_ENVELOPE_SCHEMAS = {
  "app.bootstrap": AppBootstrapCommandSchema,
  "app.sync": AppSyncCommandSchema,
  "app.setThemePreference": SetThemePreferenceCommandSchema,
  "workspace.list": WorkspaceListCommandSchema,
  "workspace.register": WorkspaceRegisterCommandSchema,
  "workspace.select": WorkspaceSelectCommandSchema,
  "workspace.updateDisplayName": WorkspaceUpdateDisplayNameCommandSchema,
  "workspace.remove": WorkspaceRemoveCommandSchema,
  "session.list": SessionListCommandSchema,
  "session.create": SessionCreateCommandSchema,
  "session.activate": SessionActivateCommandSchema,
  "session.inspect": SessionInspectCommandSchema,
  "session.rename": SessionRenameCommandSchema,
  "session.trash": SessionTrashCommandSchema,
  "session.trash.list": SessionTrashListCommandSchema,
  "session.trash.restore": SessionTrashRestoreCommandSchema,
  "session.sync": SessionSyncCommandSchema,
  "session.history": SessionHistoryCommandSchema,
  "run.prompt": RunPromptCommandSchema,
  "run.abort": RunAbortCommandSchema,
  "command.status": CommandStatusCommandSchema,
  "command.acknowledgeUnknown": CommandAcknowledgeUnknownCommandSchema,
  "runtime.setDesiredModel": RuntimeSetDesiredModelCommandSchema,
  "runtime.setDesiredThinking": RuntimeSetDesiredThinkingCommandSchema,
} as const satisfies Record<CommandType, TSchema>;
export type CommandEnvelopeByType = {
  readonly [K in CommandType]: Static<(typeof COMMAND_ENVELOPE_SCHEMAS)[K]>;
};

export const SetThemePreferenceResultSchema = closed({
  receipt: CommandReceiptSchema,
  theme: ThemeSettingSchema,
});
export const WorkspaceListResultSchema = closed({
  workspaces: Type.Array(WorkspaceSummarySchema, { maxItems: 1000 }),
});
export const WorkspaceResultSchema = closed({
  receipt: CommandReceiptSchema,
  workspace: WorkspaceSummarySchema,
});
export const WorkspaceSelectResultSchema = closed({
  receipt: CommandReceiptSchema,
  workspace: WorkspaceSummarySchema,
  sessionCatalog: SessionCatalogPageSchema,
});
export const WorkspaceRemoveResultSchema = closed({
  receipt: CommandReceiptSchema,
  workspaceId: OpaqueIdSchema,
});
export const SessionCreateResultSchema = closed({
  receipt: CommandReceiptSchema,
  session: SessionSummarySchema,
  activated: Type.Boolean(),
  view: SessionSyncResultSchema,
});
export const SessionActivateResultSchema = closed({
  receipt: CommandReceiptSchema,
  session: SessionSummarySchema,
  view: SessionSyncResultSchema,
});
export const SessionInspectResultSchema = closed({ snapshot: CommittedSnapshotSchema });
export const SessionResultSchema = closed({
  receipt: CommandReceiptSchema,
  session: SessionSummarySchema,
});
export const SessionTrashResultSchema = closed({
  receipt: CommandReceiptSchema,
  trash: TrashRecordSchema,
  activeSessionId: nullable(OpaqueIdSchema),
  runtimeEpoch: RuntimeEpochSchema,
});
export const SessionHistoryResultSchema = closed({
  turns: Type.Array(ProductTurnViewSchema, { maxItems: 100 }),
  nextCursor: nullable(CursorSchema),
  sessionVersion: SessionVersionSchema,
});
export const RunPromptResultSchema = closed({
  receipt: CommandReceiptSchema,
  run: RunEnvelopeSchema,
});
export const RunAbortResultSchema = closed({
  receipt: CommandReceiptSchema,
  runId: OpaqueIdSchema,
});
export const CommandStatusResultSchema = closed({ receipt: CommandReceiptSchema });
export const CommandAcknowledgeUnknownResultSchema = closed({
  receipt: CommandReceiptSchema,
  acknowledgedReceipt: CommandReceiptSchema,
});
export const DesiredSettingsResultSchema = closed({
  receipt: CommandReceiptSchema,
  desiredSettings: DesiredSettingsSchema,
});
export const CommandResultSchema = Type.Union([
  BootstrapResultSchema,
  AppSyncResultSchema,
  SetThemePreferenceResultSchema,
  WorkspaceListResultSchema,
  WorkspaceResultSchema,
  WorkspaceSelectResultSchema,
  WorkspaceRemoveResultSchema,
  SessionCatalogPageSchema,
  SessionCreateResultSchema,
  SessionActivateResultSchema,
  SessionInspectResultSchema,
  SessionResultSchema,
  SessionTrashResultSchema,
  TrashCatalogPageSchema,
  SessionSyncResultSchema,
  SessionHistoryResultSchema,
  RunPromptResultSchema,
  RunAbortResultSchema,
  CommandStatusResultSchema,
  CommandAcknowledgeUnknownResultSchema,
  DesiredSettingsResultSchema,
]);
const successResponse = <const R extends TSchema>(result: R) =>
  closed({ v: Type.Literal(1), requestId: RequestIdSchema, ok: Type.Literal(true), result });
export const COMMAND_RESPONSE_SCHEMAS = {
  "app.bootstrap": successResponse(BootstrapResultSchema),
  "app.sync": successResponse(AppSyncResultSchema),
  "app.setThemePreference": successResponse(SetThemePreferenceResultSchema),
  "workspace.list": successResponse(WorkspaceListResultSchema),
  "workspace.register": successResponse(WorkspaceResultSchema),
  "workspace.select": successResponse(WorkspaceSelectResultSchema),
  "workspace.updateDisplayName": successResponse(WorkspaceResultSchema),
  "workspace.remove": successResponse(WorkspaceRemoveResultSchema),
  "session.list": successResponse(SessionCatalogPageSchema),
  "session.create": successResponse(SessionCreateResultSchema),
  "session.activate": successResponse(SessionActivateResultSchema),
  "session.inspect": successResponse(SessionInspectResultSchema),
  "session.rename": successResponse(SessionResultSchema),
  "session.trash": successResponse(SessionTrashResultSchema),
  "session.trash.list": successResponse(TrashCatalogPageSchema),
  "session.trash.restore": successResponse(SessionResultSchema),
  "session.sync": successResponse(SessionSyncResultSchema),
  "session.history": successResponse(SessionHistoryResultSchema),
  "run.prompt": successResponse(RunPromptResultSchema),
  "run.abort": successResponse(RunAbortResultSchema),
  "command.status": successResponse(CommandStatusResultSchema),
  "command.acknowledgeUnknown": successResponse(CommandAcknowledgeUnknownResultSchema),
  "runtime.setDesiredModel": successResponse(DesiredSettingsResultSchema),
  "runtime.setDesiredThinking": successResponse(DesiredSettingsResultSchema),
} as const satisfies Record<CommandType, TSchema>;
export type CommandResponseByType = {
  readonly [K in CommandType]: Static<(typeof COMMAND_RESPONSE_SCHEMAS)[K]>;
};

export const COMMAND_PAYLOAD_SCHEMAS = {
  "app.bootstrap": AppBootstrapPayloadSchema,
  "app.sync": AppSyncPayloadSchema,
  "app.setThemePreference": SetThemePreferencePayloadSchema,
  "workspace.list": EmptyPayloadSchema,
  "workspace.register": WorkspaceRegisterPayloadSchema,
  "workspace.select": WorkspaceIdPayloadSchema,
  "workspace.updateDisplayName": WorkspaceDisplayNamePayloadSchema,
  "workspace.remove": WorkspaceIdPayloadSchema,
  "session.list": SessionCatalogPageRequestSchema,
  "session.create": SessionCreatePayloadSchema,
  "session.activate": EmptyPayloadSchema,
  "session.inspect": SessionInspectPayloadSchema,
  "session.rename": SessionRenamePayloadSchema,
  "session.trash": EmptyPayloadSchema,
  "session.trash.list": TrashCatalogPageRequestSchema,
  "session.trash.restore": closed({ trashId: OpaqueIdSchema }),
  "session.sync": SessionSyncPayloadSchema,
  "session.history": SessionHistoryPayloadSchema,
  "run.prompt": RunPromptPayloadSchema,
  "run.abort": RunAbortPayloadSchema,
  "command.status": CommandStatusPayloadSchema,
  "command.acknowledgeUnknown": CommandAcknowledgeUnknownPayloadSchema,
  "runtime.setDesiredModel": RuntimeSetDesiredModelPayloadSchema,
  "runtime.setDesiredThinking": RuntimeSetDesiredThinkingPayloadSchema,
} as const satisfies Record<CommandType, TSchema>;
export const COMMAND_RESULT_SCHEMAS = {
  "app.bootstrap": BootstrapResultSchema,
  "app.sync": AppSyncResultSchema,
  "app.setThemePreference": SetThemePreferenceResultSchema,
  "workspace.list": WorkspaceListResultSchema,
  "workspace.register": WorkspaceResultSchema,
  "workspace.select": WorkspaceSelectResultSchema,
  "workspace.updateDisplayName": WorkspaceResultSchema,
  "workspace.remove": WorkspaceRemoveResultSchema,
  "session.list": SessionCatalogPageSchema,
  "session.create": SessionCreateResultSchema,
  "session.activate": SessionActivateResultSchema,
  "session.inspect": SessionInspectResultSchema,
  "session.rename": SessionResultSchema,
  "session.trash": SessionTrashResultSchema,
  "session.trash.list": TrashCatalogPageSchema,
  "session.trash.restore": SessionResultSchema,
  "session.sync": SessionSyncResultSchema,
  "session.history": SessionHistoryResultSchema,
  "run.prompt": RunPromptResultSchema,
  "run.abort": RunAbortResultSchema,
  "command.status": CommandStatusResultSchema,
  "command.acknowledgeUnknown": CommandAcknowledgeUnknownResultSchema,
  "runtime.setDesiredModel": DesiredSettingsResultSchema,
  "runtime.setDesiredThinking": DesiredSettingsResultSchema,
} as const satisfies Record<CommandType, TSchema>;
export type CommandPayloadByType = {
  readonly [K in CommandType]: Static<(typeof COMMAND_PAYLOAD_SCHEMAS)[K]>;
};
export type CommandResultByType = {
  readonly [K in CommandType]: Static<(typeof COMMAND_RESULT_SCHEMAS)[K]>;
};

export const SuccessResponseSchema = Type.Union(Object.values(COMMAND_RESPONSE_SCHEMAS));
export const ErrorResponseSchema = closed({
  v: Type.Literal(1),
  requestId: RequestIdSchema,
  ok: Type.Literal(false),
  error: AppErrorSchema,
});
export const ResponseEnvelopeSchema = Type.Union([SuccessResponseSchema, ErrorResponseSchema]);

export interface MutationAuthorityDescriptor {
  readonly scope: "host" | "workspace" | "session" | "run";
  readonly authority: string;
  readonly lineage: string;
}
export const MUTATION_AUTHORITY = {
  "app.setThemePreference": { scope: "host", authority: "app", lineage: "none" },
  "workspace.register": { scope: "host", authority: "workspace-catalog", lineage: "none" },
  "workspace.select": { scope: "host", authority: "selection", lineage: "none" },
  "workspace.updateDisplayName": {
    scope: "workspace",
    authority: "payload.workspaceId",
    lineage: "workspace",
  },
  "workspace.remove": {
    scope: "workspace",
    authority: "payload.workspaceId",
    lineage: "workspace",
  },
  "session.create": { scope: "workspace", authority: "payload.workspaceId", lineage: "workspace" },
  "session.activate": {
    scope: "session",
    authority: "envelope.sessionId",
    lineage: "workspace/session",
  },
  "session.rename": {
    scope: "session",
    authority: "envelope.sessionId",
    lineage: "workspace/session",
  },
  "session.trash": {
    scope: "session",
    authority: "envelope.sessionId",
    lineage: "workspace/session",
  },
  "session.trash.restore": {
    scope: "workspace",
    authority: "trash.workspaceId",
    lineage: "workspace",
  },
  "run.prompt": {
    scope: "run",
    authority: "allocated.runId",
    lineage: "workspace/session/run/product-turn",
  },
  "run.abort": { scope: "run", authority: "payload.runId", lineage: "workspace/session/run" },
  "command.acknowledgeUnknown": { scope: "host", authority: "app", lineage: "none" },
  "runtime.setDesiredModel": {
    scope: "session",
    authority: "envelope.sessionId",
    lineage: "workspace/session",
  },
  "runtime.setDesiredThinking": {
    scope: "session",
    authority: "envelope.sessionId",
    lineage: "workspace/session",
  },
} as const satisfies Record<MutationCommandType, MutationAuthorityDescriptor>;

export interface CommandAuthorityContext {
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly productTurnId?: string;
}

export interface ResolvedCommandAuthority {
  readonly commandType: MutationCommandType;
  readonly scope: "host" | "workspace" | "session" | "run";
  readonly authorityId: string;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly productTurnId: string | null;
}

export type CommandAuthorityResolution =
  | { readonly ok: true; readonly value: ResolvedCommandAuthority }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "missing_authority_context";
        readonly field: keyof CommandAuthorityContext;
      };
    };

type MutationCommandEnvelope = CommandEnvelopeByType[MutationCommandType];

const missingAuthorityContext = (
  field: keyof CommandAuthorityContext,
): CommandAuthorityResolution => ({
  ok: false,
  error: { code: "missing_authority_context", field },
});

const resolvedAuthority = (
  commandType: MutationCommandType,
  authorityId: string,
  workspaceId: string | null,
  sessionId: string | null,
  runId: string | null,
  productTurnId: string | null,
): CommandAuthorityResolution => ({
  ok: true,
  value: {
    commandType,
    scope: MUTATION_AUTHORITY[commandType].scope,
    authorityId,
    workspaceId,
    sessionId,
    runId,
    productTurnId,
  },
});

export function resolveCommandAuthority(
  command: MutationCommandEnvelope,
  context: CommandAuthorityContext = {},
): CommandAuthorityResolution {
  switch (command.type) {
    case "app.setThemePreference":
    case "command.acknowledgeUnknown":
      return resolvedAuthority(command.type, "app", null, null, null, null);
    case "workspace.register":
      return resolvedAuthority(command.type, "workspace-catalog", null, null, null, null);
    case "workspace.select":
      return resolvedAuthority(command.type, "selection", null, null, null, null);
    case "workspace.updateDisplayName":
    case "workspace.remove":
    case "session.create":
      return resolvedAuthority(
        command.type,
        command.payload.workspaceId,
        command.payload.workspaceId,
        null,
        null,
        null,
      );
    case "session.trash.restore":
      return context.workspaceId === undefined
        ? missingAuthorityContext("workspaceId")
        : resolvedAuthority(
            command.type,
            context.workspaceId,
            context.workspaceId,
            null,
            null,
            null,
          );
    case "session.activate":
    case "session.rename":
    case "session.trash":
    case "runtime.setDesiredModel":
    case "runtime.setDesiredThinking":
      return context.workspaceId === undefined
        ? missingAuthorityContext("workspaceId")
        : resolvedAuthority(
            command.type,
            command.sessionId,
            context.workspaceId,
            command.sessionId,
            null,
            null,
          );
    case "run.abort":
      return context.workspaceId === undefined
        ? missingAuthorityContext("workspaceId")
        : resolvedAuthority(
            command.type,
            command.payload.runId,
            context.workspaceId,
            command.sessionId,
            command.payload.runId,
            null,
          );
    case "run.prompt":
      if (context.workspaceId === undefined) return missingAuthorityContext("workspaceId");
      if (context.runId === undefined) return missingAuthorityContext("runId");
      if (context.productTurnId === undefined) return missingAuthorityContext("productTurnId");
      return resolvedAuthority(
        command.type,
        context.runId,
        context.workspaceId,
        command.sessionId,
        context.runId,
        context.productTurnId,
      );
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export const ThemeChangedPayloadSchema = closed({ theme: ThemeSettingSchema });
export const WorkspaceChangedPayloadSchema = closed({
  change: WorkspaceChangeSchema,
  workspaceCatalogRevision: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  workspace: nullable(WorkspaceSummarySchema),
});
export const SessionDirectoryChangedPayloadSchema = closed({
  change: SessionChangeSchema,
  sessionCatalogRevision: OpaqueIdSchema,
  trashCatalogRevision: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  session: nullable(SessionSummarySchema),
  trash: nullable(TrashRecordSchema),
});
export const ActiveSessionChangedPayloadSchema = closed({
  previousSessionId: nullable(OpaqueIdSchema),
  activeSessionId: nullable(OpaqueIdSchema),
  runtimeEpoch: RuntimeEpochSchema,
  sessionVersion: nullable(SessionVersionSchema),
  sessionCatalogRevision: OpaqueIdSchema,
});
export const DesiredSettingsChangedPayloadSchema = closed({
  desiredSettings: DesiredSettingsSchema,
});
export const RunStartedPayloadSchema = closed({
  run: RunEnvelopeSchema,
  turn: ProductTurnViewSchema,
});
export const AssistantStepStartedPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  step: AssistantStepViewSchema,
});
export const BlockStartedPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  block: ContentBlockSchema,
});
export const BlockDeltaPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  blockId: OpaqueIdSchema,
  append: utf8String(32_768, 1),
});
export const BlockSettledPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  block: ContentBlockSchema,
});
const PreparingToolCallSchema = closed({
  toolCallId: OpaqueIdSchema,
  name: utf8String(256, 1),
  toolKind: Type.Enum(["read", "edit", "write", "bash", "unknown"]),
  declarationStatus: Type.Literal("preparing"),
  argumentsPreview: Type.Literal(""),
  argumentsTruncated: Type.Literal(false),
  arguments: Type.Null(),
  argumentsContent: Type.Null(),
  executionStatus: Type.Literal("pending"),
  summary: utf8String(1000),
  details: Type.Null(),
  startedAt: IsoInstantSchema,
  terminalAt: Type.Null(),
  error: Type.Null(),
});
const ReadyToolCallSchema = closed({
  ...toolFields,
  declarationStatus: Type.Literal("ready"),
  arguments: NonNullJsonValueSchema,
  error: Type.Null(),
});
const InvalidToolCallSchema = closed({
  ...toolFields,
  declarationStatus: Type.Literal("invalid"),
  arguments: Type.Null(),
  error: AppErrorSchema,
});
export const ToolDeclarationStartedBlockSchema = Type.Refine(
  closed({
    kind: Type.Literal("tool"),
    ...blockBase,
    status: Type.Literal("streaming"),
    tool: PreparingToolCallSchema,
  }),
  (block) => {
    const builtInKinds = new Set(["read", "edit", "write", "bash"]);
    const expectedKind = builtInKinds.has(block.tool.name) ? block.tool.name : "unknown";
    return block.tool.summary === block.tool.name && block.tool.toolKind === expectedKind;
  },
);
export const ToolDeclarationSettledBlockSchema = Type.Union([
  closed({
    kind: Type.Literal("tool"),
    ...blockBase,
    status: BlockStatusSchema,
    tool: ReadyToolCallSchema,
  }),
  closed({
    kind: Type.Literal("tool"),
    ...blockBase,
    status: BlockStatusSchema,
    tool: InvalidToolCallSchema,
  }),
]);
export const ToolDeclarationStartedPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  block: ToolDeclarationStartedBlockSchema,
});
export const ToolDeclarationDeltaPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  blockId: OpaqueIdSchema,
  toolCallId: OpaqueIdSchema,
  argumentsFragment: utf8String(32_768, 1),
});
export const ToolDeclarationSettledPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  block: ToolDeclarationSettledBlockSchema,
});
export const ToolExecutionStartedPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  blockId: OpaqueIdSchema,
  toolCallId: OpaqueIdSchema,
  startedAt: IsoInstantSchema,
});
export const ToolExecutionUpdatedPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  blockId: OpaqueIdSchema,
  toolCallId: OpaqueIdSchema,
  outputAppend: utf8String(32_768),
  previewTruncated: Type.Boolean(),
});
export const ToolExecutionSettledPayloadSchema = closed({
  productTurnId: OpaqueIdSchema,
  stepId: OpaqueIdSchema,
  blockId: OpaqueIdSchema,
  tool: ToolCallViewSchema,
});
export const RunStateChangedPayloadSchema = closed({ run: RunEnvelopeSchema });
export const SessionCommittedPayloadSchema = closed({
  sessionVersion: SessionVersionSchema,
  sessionCatalogRevision: OpaqueIdSchema,
  turns: Type.Array(ProductTurnViewSchema, { maxItems: 4 }),
});
export const CommandReceiptChangedPayloadSchema = closed({ receipt: CommandReceiptSchema });
export const HostDegradedPayloadSchema = closed({ degraded: DegradedViewSchema });

export const EVENT_TYPES = [
  "app.theme_changed",
  "workspace.changed",
  "session.directory_changed",
  "active_session.changed",
  "desired_settings.changed",
  "run.started",
  "assistant_step.started",
  "block.started",
  "block.delta",
  "block.settled",
  "tool.declaration_started",
  "tool.declaration_delta",
  "tool.declaration_settled",
  "tool.execution_started",
  "tool.execution_updated",
  "tool.execution_settled",
  "run.state_changed",
  "session.committed",
  "command.receipt_changed",
  "host.degraded",
] as const;
export const EventTypeSchema = Type.Enum(EVENT_TYPES);
export type EventType = Static<typeof EventTypeSchema>;
export const EVENT_PAYLOAD_SCHEMAS = {
  "app.theme_changed": ThemeChangedPayloadSchema,
  "workspace.changed": WorkspaceChangedPayloadSchema,
  "session.directory_changed": SessionDirectoryChangedPayloadSchema,
  "active_session.changed": ActiveSessionChangedPayloadSchema,
  "desired_settings.changed": DesiredSettingsChangedPayloadSchema,
  "run.started": RunStartedPayloadSchema,
  "assistant_step.started": AssistantStepStartedPayloadSchema,
  "block.started": BlockStartedPayloadSchema,
  "block.delta": BlockDeltaPayloadSchema,
  "block.settled": BlockSettledPayloadSchema,
  "tool.declaration_started": ToolDeclarationStartedPayloadSchema,
  "tool.declaration_delta": ToolDeclarationDeltaPayloadSchema,
  "tool.declaration_settled": ToolDeclarationSettledPayloadSchema,
  "tool.execution_started": ToolExecutionStartedPayloadSchema,
  "tool.execution_updated": ToolExecutionUpdatedPayloadSchema,
  "tool.execution_settled": ToolExecutionSettledPayloadSchema,
  "run.state_changed": RunStateChangedPayloadSchema,
  "session.committed": SessionCommittedPayloadSchema,
  "command.receipt_changed": CommandReceiptChangedPayloadSchema,
  "host.degraded": HostDegradedPayloadSchema,
} as const satisfies Record<EventType, TSchema>;
export type EventPayloadByType = {
  readonly [K in EventType]: Static<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;
};

const eventBase = { v: Type.Literal(1), connectionSeq: SequenceSchema };
const allNull = {
  workspaceId: Type.Null(),
  sessionId: Type.Null(),
  sessionVersion: Type.Null(),
  runtimeEpoch: Type.Null(),
  runId: Type.Null(),
  runSeq: Type.Null(),
};
const workspaceScope = {
  workspaceId: OpaqueIdSchema,
  sessionId: Type.Null(),
  sessionVersion: Type.Null(),
  runtimeEpoch: Type.Null(),
  runId: Type.Null(),
  runSeq: Type.Null(),
};
const runtimeScope = {
  workspaceId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  sessionVersion: SessionVersionSchema,
  runtimeEpoch: RuntimeEpochSchema,
  runId: OpaqueIdSchema,
  runSeq: SequenceSchema,
};
const event = <const T extends string, const S extends TProperties, const P extends TSchema>(
  type: T,
  scope: S,
  payload: P,
) => closed({ ...eventBase, type: Type.Literal(type), ...scope, payload });
export const ThemeChangedEventSchema = event(
  "app.theme_changed",
  allNull,
  ThemeChangedPayloadSchema,
);
export const WorkspaceChangedEventSchema = event(
  "workspace.changed",
  workspaceScope,
  WorkspaceChangedPayloadSchema,
);
export const SessionDirectoryChangedEventSchema = event(
  "session.directory_changed",
  {
    workspaceId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    sessionVersion: nullable(SessionVersionSchema),
    runtimeEpoch: Type.Null(),
    runId: Type.Null(),
    runSeq: Type.Null(),
  },
  SessionDirectoryChangedPayloadSchema,
);
export const ActiveSessionChangedEventSchema = event(
  "active_session.changed",
  {
    workspaceId: OpaqueIdSchema,
    sessionId: nullable(OpaqueIdSchema),
    sessionVersion: nullable(SessionVersionSchema),
    runtimeEpoch: RuntimeEpochSchema,
    runId: Type.Null(),
    runSeq: Type.Null(),
  },
  ActiveSessionChangedPayloadSchema,
);
export const DesiredSettingsChangedEventSchema = event(
  "desired_settings.changed",
  {
    workspaceId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    sessionVersion: SessionVersionSchema,
    runtimeEpoch: RuntimeEpochSchema,
    runId: Type.Null(),
    runSeq: Type.Null(),
  },
  DesiredSettingsChangedPayloadSchema,
);
export const RunStartedEventSchema = event("run.started", runtimeScope, RunStartedPayloadSchema);
export const AssistantStepStartedEventSchema = event(
  "assistant_step.started",
  runtimeScope,
  AssistantStepStartedPayloadSchema,
);
export const BlockStartedEventSchema = event(
  "block.started",
  runtimeScope,
  BlockStartedPayloadSchema,
);
export const BlockDeltaEventSchema = event("block.delta", runtimeScope, BlockDeltaPayloadSchema);
export const BlockSettledEventSchema = event(
  "block.settled",
  runtimeScope,
  BlockSettledPayloadSchema,
);
export const ToolDeclarationStartedEventSchema = event(
  "tool.declaration_started",
  runtimeScope,
  ToolDeclarationStartedPayloadSchema,
);
export const ToolDeclarationDeltaEventSchema = event(
  "tool.declaration_delta",
  runtimeScope,
  ToolDeclarationDeltaPayloadSchema,
);
export const ToolDeclarationSettledEventSchema = event(
  "tool.declaration_settled",
  runtimeScope,
  ToolDeclarationSettledPayloadSchema,
);
export const ToolExecutionStartedEventSchema = event(
  "tool.execution_started",
  runtimeScope,
  ToolExecutionStartedPayloadSchema,
);
export const ToolExecutionUpdatedEventSchema = event(
  "tool.execution_updated",
  runtimeScope,
  ToolExecutionUpdatedPayloadSchema,
);
export const ToolExecutionSettledEventSchema = event(
  "tool.execution_settled",
  runtimeScope,
  ToolExecutionSettledPayloadSchema,
);
export const RunStateChangedEventSchema = event(
  "run.state_changed",
  runtimeScope,
  RunStateChangedPayloadSchema,
);
export const SessionCommittedEventSchema = event(
  "session.committed",
  {
    workspaceId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    sessionVersion: SessionVersionSchema,
    runtimeEpoch: nullable(RuntimeEpochSchema),
    runId: nullable(OpaqueIdSchema),
    runSeq: nullable(SequenceSchema),
  },
  SessionCommittedPayloadSchema,
);
export const CommandReceiptChangedEventSchema = event(
  "command.receipt_changed",
  {
    workspaceId: nullable(OpaqueIdSchema),
    sessionId: nullable(OpaqueIdSchema),
    sessionVersion: nullable(SessionVersionSchema),
    runtimeEpoch: nullable(RuntimeEpochSchema),
    runId: nullable(OpaqueIdSchema),
    runSeq: nullable(SequenceSchema),
  },
  CommandReceiptChangedPayloadSchema,
);
export const HostDegradedEventSchema = event(
  "host.degraded",
  {
    workspaceId: nullable(OpaqueIdSchema),
    sessionId: nullable(OpaqueIdSchema),
    sessionVersion: nullable(SessionVersionSchema),
    runtimeEpoch: nullable(RuntimeEpochSchema),
    runId: nullable(OpaqueIdSchema),
    runSeq: nullable(SequenceSchema),
  },
  HostDegradedPayloadSchema,
);
export const EVENT_ENVELOPE_SCHEMAS = {
  "app.theme_changed": ThemeChangedEventSchema,
  "workspace.changed": WorkspaceChangedEventSchema,
  "session.directory_changed": SessionDirectoryChangedEventSchema,
  "active_session.changed": ActiveSessionChangedEventSchema,
  "desired_settings.changed": DesiredSettingsChangedEventSchema,
  "run.started": RunStartedEventSchema,
  "assistant_step.started": AssistantStepStartedEventSchema,
  "block.started": BlockStartedEventSchema,
  "block.delta": BlockDeltaEventSchema,
  "block.settled": BlockSettledEventSchema,
  "tool.declaration_started": ToolDeclarationStartedEventSchema,
  "tool.declaration_delta": ToolDeclarationDeltaEventSchema,
  "tool.declaration_settled": ToolDeclarationSettledEventSchema,
  "tool.execution_started": ToolExecutionStartedEventSchema,
  "tool.execution_updated": ToolExecutionUpdatedEventSchema,
  "tool.execution_settled": ToolExecutionSettledEventSchema,
  "run.state_changed": RunStateChangedEventSchema,
  "session.committed": SessionCommittedEventSchema,
  "command.receipt_changed": CommandReceiptChangedEventSchema,
  "host.degraded": HostDegradedEventSchema,
} as const satisfies Record<EventType, TSchema>;
export type EventEnvelopeByType = {
  readonly [K in EventType]: Static<(typeof EVENT_ENVELOPE_SCHEMAS)[K]>;
};
export const EventEnvelopeSchema = Type.Union([
  ThemeChangedEventSchema,
  WorkspaceChangedEventSchema,
  SessionDirectoryChangedEventSchema,
  ActiveSessionChangedEventSchema,
  DesiredSettingsChangedEventSchema,
  RunStartedEventSchema,
  AssistantStepStartedEventSchema,
  BlockStartedEventSchema,
  BlockDeltaEventSchema,
  BlockSettledEventSchema,
  ToolDeclarationStartedEventSchema,
  ToolDeclarationDeltaEventSchema,
  ToolDeclarationSettledEventSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionUpdatedEventSchema,
  ToolExecutionSettledEventSchema,
  RunStateChangedEventSchema,
  SessionCommittedEventSchema,
  CommandReceiptChangedEventSchema,
  HostDegradedEventSchema,
]);
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

export const HelloSchema = closed({
  type: Type.Literal("hello"),
  protocolMajor: Type.Literal(1),
  protocolMinor: Type.Integer({ minimum: 0, maximum: 65535 }),
  clientId: OpaqueIdSchema,
  capabilities: Type.Array(utf8String(128, 1), {
    maxItems: 128,
    uniqueItems: true,
  }),
});
export const WelcomeSchema = closed({
  type: Type.Literal("welcome"),
  protocolMajor: Type.Literal(1),
  protocolMinor: Type.Integer({ minimum: 0, maximum: 65535 }),
  connectionId: OpaqueIdSchema,
  serverVersion: utf8String(128, 1),
  capabilities: Type.Array(utf8String(128, 1), {
    maxItems: 128,
    uniqueItems: true,
  }),
  connectionSeq: SequenceSchema,
});
export const ClientFrameSchema = Type.Union([HelloSchema, CommandEnvelopeSchema]);
export const ServerFrameSchema = Type.Union([
  WelcomeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
]);
export const ApplicationFrameSchema = Type.Union([
  HelloSchema,
  WelcomeSchema,
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
]);
export type ClientFrame = Static<typeof ClientFrameSchema>;
export type ServerFrame = Static<typeof ServerFrameSchema>;
export type ApplicationFrame = Static<typeof ApplicationFrameSchema>;

export type CodecResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };
const invalidFrame = (): CodecResult<never> => ({
  ok: false,
  error: {
    code: "invalid_frame",
    message: "Frame is not valid yaca protocol data.",
    retryDisposition: "never",
  },
});
const frameTooLarge = (): CodecResult<never> => ({
  ok: false,
  error: {
    code: "frame_too_large",
    message: "Frame exceeds the yaca protocol byte limit.",
    retryDisposition: "never",
  },
});
const unsupportedProtocol = (): CodecResult<never> => ({
  ok: false,
  error: {
    code: "unsupported_protocol",
    message: "Protocol major version is not supported.",
    retryDisposition: "never",
  },
});
const unsupportedCommand = (): CodecResult<never> => ({
  ok: false,
  error: {
    code: "unsupported_command",
    message: "Command type is not supported.",
    retryDisposition: "never",
  },
});
const protocolViolation = (): CodecResult<never> => ({
  ok: false,
  error: {
    code: "protocol_violation",
    message: "Server frame violates the yaca protocol.",
    retryDisposition: "never",
  },
});
const CommandProbeSchema = closed({
  v: Type.Literal(1),
  requestId: RequestIdSchema,
  type: utf8String(128, 1),
  clientMutationId: nullable(MutationIdSchema),
  sessionId: nullable(OpaqueIdSchema),
  expectedSessionVersion: nullable(SessionVersionSchema),
  payload: Type.Unknown(),
});
function parseFrame(
  serialized: string,
  malformed: () => CodecResult<never>,
  oversized: () => CodecResult<never> = frameTooLarge,
): CodecResult<unknown> {
  try {
    if (utf8Length(serialized) > FRAME_BYTE_LIMIT) return oversized();
    const value: unknown = JSON.parse(serialized);
    return { ok: true, value };
  } catch {
    return malformed();
  }
}
function hasShallowMajorMismatch(value: unknown, direction: "client" | "server"): boolean {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, "protocolMajor")) return false;
    const major = record.protocolMajor;
    if (typeof major !== "number" || !Number.isFinite(major) || major === 1) return false;
    if (direction === "server") return record.type === "welcome";
    return (
      record.type === "hello" ||
      (typeof record.type === "string" && Object.hasOwn(record, "requestId"))
    );
  } catch {
    return false;
  }
}
function isUnknownCommand(value: unknown): boolean {
  return (
    Value.Check(CommandProbeSchema, value) &&
    !Value.Check(CommandTypeSchema, (value as { type: unknown }).type)
  );
}
export function decodeApplicationFrame(serialized: string): CodecResult<ApplicationFrame> {
  const parsed = parseFrame(serialized, invalidFrame);
  if (!parsed.ok) return parsed;
  return Value.Check(ApplicationFrameSchema, parsed.value)
    ? { ok: true, value: parsed.value }
    : invalidFrame();
}
export function encodeApplicationFrame(value: unknown): CodecResult<string> {
  try {
    if (!Value.Check(ApplicationFrameSchema, value)) return invalidFrame();
    const serialized = JSON.stringify(value);
    return utf8Length(serialized) > FRAME_BYTE_LIMIT
      ? frameTooLarge()
      : { ok: true, value: serialized };
  } catch {
    return invalidFrame();
  }
}
function serializeFrame(
  schema: TSchema,
  value: unknown,
  malformed: () => CodecResult<never>,
  oversized: () => CodecResult<never> = frameTooLarge,
): CodecResult<string> {
  try {
    if (!Value.Check(schema, value)) return malformed();
    const serialized = JSON.stringify(value);
    return utf8Length(serialized) > FRAME_BYTE_LIMIT
      ? oversized()
      : { ok: true, value: serialized };
  } catch {
    return malformed();
  }
}
export function decodeClientFrame(serialized: string): CodecResult<ClientFrame> {
  const parsed = parseFrame(serialized, invalidFrame);
  if (!parsed.ok) return parsed;
  if (hasShallowMajorMismatch(parsed.value, "client")) return unsupportedProtocol();
  if (isUnknownCommand(parsed.value)) return unsupportedCommand();
  return Value.Check(ClientFrameSchema, parsed.value)
    ? { ok: true, value: parsed.value }
    : invalidFrame();
}
export function decodeServerFrame(serialized: string): CodecResult<ServerFrame> {
  const parsed = parseFrame(serialized, protocolViolation, protocolViolation);
  if (!parsed.ok) return parsed;
  if (hasShallowMajorMismatch(parsed.value, "server")) return unsupportedProtocol();
  return Value.Check(ServerFrameSchema, parsed.value)
    ? { ok: true, value: parsed.value }
    : protocolViolation();
}
export function encodeClientFrame(value: unknown): CodecResult<string> {
  if (hasShallowMajorMismatch(value, "client")) return unsupportedProtocol();
  if (isUnknownCommand(value)) return unsupportedCommand();
  return serializeFrame(ClientFrameSchema, value, invalidFrame);
}
export function encodeServerFrame(value: unknown): CodecResult<string> {
  if (hasShallowMajorMismatch(value, "server")) return unsupportedProtocol();
  return serializeFrame(ServerFrameSchema, value, protocolViolation, protocolViolation);
}

export const HealthResponseSchema = closed({
  status: Type.Literal("ok"),
  service: Type.Literal("yaca-host"),
  version: utf8String(128, 1),
  uptimeSeconds: Type.Number({ minimum: 0 }),
  authorityPorts: Type.Tuple([
    Type.Integer({ minimum: 49_152, maximum: 65_535 }),
    Type.Integer({ minimum: 49_152, maximum: 65_535 }),
  ]),
});

export type AppError = Static<typeof AppErrorSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
export type OpaqueId = Static<typeof OpaqueIdSchema>;
export type RequestId = Static<typeof RequestIdSchema>;
export type MutationId = Static<typeof MutationIdSchema>;
export type SessionVersion = Static<typeof SessionVersionSchema>;
export type RuntimeEpoch = Static<typeof RuntimeEpochSchema>;
export type Cursor = Static<typeof CursorSchema>;
export type IsoInstant = Static<typeof IsoInstantSchema>;
export type DisplayName = Static<typeof DisplayNameSchema>;
export type SessionTitle = Static<typeof SessionTitleSchema>;
export type LocalPathInput = Static<typeof LocalPathInputSchema>;
export type DisplayPath = Static<typeof DisplayPathSchema>;
export type SafeText = Static<typeof SafeTextSchema>;
export type Sequence = Static<typeof SequenceSchema>;
export type DurationMs = Static<typeof DurationMsSchema>;
export type ByteCount = Static<typeof ByteCountSchema>;
export type ErrorDetails = Static<typeof ErrorDetailsSchema>;
export type ThemePreference = Static<typeof ThemePreferenceSchema>;
export type RuntimePhase = Static<typeof RuntimePhaseSchema>;
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type DesiredSettingState = Static<typeof DesiredSettingStateSchema>;
export type RunStatus = Static<typeof RunStatusSchema>;
export type ReceiptState = Static<typeof ReceiptStateSchema>;
export type ReceiptScope = Static<typeof ReceiptScopeSchema>;
export type RiskAcknowledgement = Static<typeof RiskAcknowledgementSchema>;
export type BlockStatus = Static<typeof BlockStatusSchema>;
export type ToolKind = Static<typeof ToolKindSchema>;
export type ToolDeclarationStatus = Static<typeof ToolDeclarationStatusSchema>;
export type ToolExecutionStatus = Static<typeof ToolExecutionStatusSchema>;
export type InterruptionReason = Static<typeof InterruptionReasonSchema>;
export type WorkspaceChange = Static<typeof WorkspaceChangeSchema>;
export type SessionChange = Static<typeof SessionChangeSchema>;
export type RetryDisposition = Static<typeof RetryDispositionSchema>;
export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ThemeSetting = Static<typeof ThemeSettingSchema>;
export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type TrashRecord = Static<typeof TrashRecordSchema>;
export type ModelRef = Static<typeof ModelRefSchema>;
export type ModelCatalogEntry = Static<typeof ModelCatalogEntrySchema>;
export type ModelCatalog = Static<typeof ModelCatalogSchema>;
export type DesiredSettings = Static<typeof DesiredSettingsSchema>;
export type RunSettingSnapshot = Static<typeof RunSettingSnapshotSchema>;
export type CommandReceipt = Static<typeof CommandReceiptSchema>;
export type RunEnvelope = Static<typeof RunEnvelopeSchema>;
export type ContentReference = Static<typeof ContentReferenceSchema>;
export type ContentPreview = Static<typeof ContentPreviewSchema>;
export type JsonValue = Static<typeof JsonValueSchema>;
export type PromptView = Static<typeof PromptViewSchema>;
export type UsageView = Static<typeof UsageViewSchema>;
export type ThinkingBlock = Static<typeof ThinkingBlockSchema>;
export type TextBlock = Static<typeof TextBlockSchema>;
export type ReadDetails = Static<typeof ReadDetailsSchema>;
export type EditDetails = Static<typeof EditDetailsSchema>;
export type WriteDetails = Static<typeof WriteDetailsSchema>;
export type BashDetails = Static<typeof BashDetailsSchema>;
export type UnknownToolDetails = Static<typeof UnknownToolDetailsSchema>;
export type ToolDetails = Static<typeof ToolDetailsSchema>;
export type ToolCallView = Static<typeof ToolCallViewSchema>;
export type ToolBlock = Static<typeof ToolBlockSchema>;
export type ErrorBlock = Static<typeof ErrorBlockSchema>;
export type ContentBlock = Static<typeof ContentBlockSchema>;
export type AssistantStepView = Static<typeof AssistantStepViewSchema>;
export type ProductTurnView = Static<typeof ProductTurnViewSchema>;
export type CommittedSnapshot = Static<typeof CommittedSnapshotSchema>;
export type ActiveOverlay = Static<typeof ActiveOverlaySchema>;
export type SessionSyncView = Static<typeof SessionSyncViewSchema>;
export type DegradedView = Static<typeof DegradedViewSchema>;
export type SessionCatalogPage = Static<typeof SessionCatalogPageSchema>;
export type TrashCatalogPage = Static<typeof TrashCatalogPageSchema>;
export type BootstrapResult = Static<typeof BootstrapResultSchema>;
export type AppSyncResult = Static<typeof AppSyncResultSchema>;
export type SessionSyncResult = Static<typeof SessionSyncResultSchema>;
export type ThemeChangedPayload = Static<typeof ThemeChangedPayloadSchema>;
export type WorkspaceChangedPayload = Static<typeof WorkspaceChangedPayloadSchema>;
export type SessionDirectoryChangedPayload = Static<typeof SessionDirectoryChangedPayloadSchema>;
export type ActiveSessionChangedPayload = Static<typeof ActiveSessionChangedPayloadSchema>;
export type DesiredSettingsChangedPayload = Static<typeof DesiredSettingsChangedPayloadSchema>;
export type RunStartedPayload = Static<typeof RunStartedPayloadSchema>;
export type AssistantStepStartedPayload = Static<typeof AssistantStepStartedPayloadSchema>;
export type BlockStartedPayload = Static<typeof BlockStartedPayloadSchema>;
export type BlockDeltaPayload = Static<typeof BlockDeltaPayloadSchema>;
export type BlockSettledPayload = Static<typeof BlockSettledPayloadSchema>;
export type ToolDeclarationStartedPayload = Static<typeof ToolDeclarationStartedPayloadSchema>;
export type ToolDeclarationDeltaPayload = Static<typeof ToolDeclarationDeltaPayloadSchema>;
export type ToolDeclarationSettledPayload = Static<typeof ToolDeclarationSettledPayloadSchema>;
export type ToolExecutionStartedPayload = Static<typeof ToolExecutionStartedPayloadSchema>;
export type ToolExecutionUpdatedPayload = Static<typeof ToolExecutionUpdatedPayloadSchema>;
export type ToolExecutionSettledPayload = Static<typeof ToolExecutionSettledPayloadSchema>;
export type RunStateChangedPayload = Static<typeof RunStateChangedPayloadSchema>;
export type SessionCommittedPayload = Static<typeof SessionCommittedPayloadSchema>;
export type CommandReceiptChangedPayload = Static<typeof CommandReceiptChangedPayloadSchema>;
export type HostDegradedPayload = Static<typeof HostDegradedPayloadSchema>;
