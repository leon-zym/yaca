import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApplicationFrameSchema,
  BlockDeltaPayloadSchema,
  COMMAND_ENVELOPE_SCHEMAS,
  COMMAND_PAYLOAD_SCHEMAS,
  COMMAND_RESPONSE_SCHEMAS,
  COMMAND_RESULT_SCHEMAS,
  CommandEnvelopeSchema,
  CommandReceiptSchema,
  COMMAND_TYPES,
  CursorSchema,
  decodeClientFrame,
  decodeApplicationFrame,
  decodeServerFrame,
  DisplayNameSchema,
  encodeClientFrame,
  encodeApplicationFrame,
  encodeServerFrame,
  ErrorResponseSchema,
  EventEnvelopeSchema,
  EVENT_ENVELOPE_SCHEMAS,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  HelloSchema,
  MUTATION_AUTHORITY,
  MUTATION_COMMAND_TYPES,
  RunEnvelopeSchema,
  RunPromptPayloadSchema,
  SessionCatalogPageRequestSchema,
  SuccessResponseSchema,
  ThemeSettingSchema,
  ContentPreviewSchema,
  ToolDeclarationSettledPayloadSchema,
  ToolDeclarationStartedPayloadSchema,
  Value,
  WelcomeSchema,
} from "../src/index.js";

const fixtureDirectory = fileURLToPath(new URL("../../../docs/spec/fixtures/", import.meta.url));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}`, "utf8")) as Record<string, unknown>;
}

describe("closed application protocol", () => {
  it("accepts hello, welcome, and a minimal app.sync command", () => {
    expect(
      Value.Check(HelloSchema, {
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientId: "web-1",
        capabilities: [],
      }),
    ).toBe(true);
    expect(
      Value.Check(WelcomeSchema, {
        type: "welcome",
        protocolMajor: 1,
        protocolMinor: 0,
        connectionId: "connection-1",
        serverVersion: "0.1.0",
        capabilities: [],
        connectionSeq: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(CommandEnvelopeSchema, {
        v: 1,
        requestId: "request-1",
        type: "app.sync",
        clientMutationId: null,
        sessionId: null,
        expectedSessionVersion: null,
        payload: { knownSnapshotSeq: null, knownRuntimeEpoch: null },
      }),
    ).toBe(true);
  });

  it("keeps theme objects and mutations closed", () => {
    expect(
      Value.Check(ThemeSettingSchema, {
        themePreference: "dark",
        updatedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Value.Check(CommandEnvelopeSchema, {
        v: 1,
        requestId: "r",
        type: "app.setThemePreference",
        clientMutationId: "m",
        sessionId: null,
        expectedSessionVersion: null,
        payload: { themePreference: "system", unknown: true },
      }),
    ).toBe(false);
  });

  it("enforces pagination XOR and exact applied limits", () => {
    expect(
      Value.Check(SessionCatalogPageRequestSchema, {
        workspaceId: "workspace-1",
        limit: 200,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionCatalogPageRequestSchema, {
        workspaceId: "workspace-1",
        appliedLimit: 50,
        catalogRevision: "revision-1",
        cursor: "cursor-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionCatalogPageRequestSchema, {
        workspaceId: "workspace-1",
        limit: 50,
        cursor: "cursor-1",
      }),
    ).toBe(false);
  });

  it("validates every nested wire object in the five golden scenarios", () => {
    const mutation = fixture("non-run-mutation-receipt.json");
    for (const receipt of mutation.receipts as unknown[]) {
      expect(Value.Check(CommandReceiptSchema, receipt)).toBe(true);
    }

    const gap = fixture("app-sync-gap.json");
    for (const key of ["missedCatalogEvent", "observedGap", "bufferedCatalogEvent"]) {
      expect(Value.Check(EventEnvelopeSchema, gap[key])).toBe(true);
    }
    expect(Value.Check(CommandEnvelopeSchema, gap.syncCommand)).toBe(true);
    expect(Value.Check(SuccessResponseSchema, gap.syncResponse)).toBe(true);

    const tool = fixture("tool-declaration-stream.json");
    for (const event of tool.events as unknown[]) {
      expect(Value.Check(EventEnvelopeSchema, event)).toBe(true);
    }

    const restart = fixture("restart-unknown-outcomes.json");
    expect(Value.Check(CommandReceiptSchema, restart.recordedPromptAfterRestart)).toBe(true);
    const accepted = restart.acceptedPromptAfterRestart as Record<string, unknown>;
    expect(Value.Check(CommandReceiptSchema, accepted.receipt)).toBe(true);
    expect(Value.Check(RunEnvelopeSchema, accepted.run)).toBe(true);

    const trash = fixture("active-session-trash.json");
    expect(Value.Check(ErrorResponseSchema, trash.runningRejection)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, trash.idleCommand)).toBe(true);
    expect(Value.Check(SuccessResponseSchema, trash.idleResponse)).toBe(true);
    for (const event of trash.events as unknown[]) {
      expect(Value.Check(EventEnvelopeSchema, event)).toBe(true);
    }

    // A scenario wrapper is metadata, never a wire frame.
    expect(Value.Check(ApplicationFrameSchema, tool)).toBe(false);
  });

  it("has exhaustive command, event, and mutation authority discriminants", () => {
    expect(COMMAND_TYPES).toHaveLength(24);
    expect(EVENT_TYPES).toHaveLength(20);
    expect(Object.keys(MUTATION_AUTHORITY).sort()).toEqual([...MUTATION_COMMAND_TYPES].sort());
    expect(Object.keys(COMMAND_PAYLOAD_SCHEMAS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(Object.keys(COMMAND_RESULT_SCHEMAS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(COMMAND_ENVELOPE_SCHEMAS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(Object.keys(COMMAND_RESPONSE_SCHEMAS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(Object.keys(EVENT_ENVELOPE_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("keeps every wire object closed except intentional JsonValue records", () => {
    const visited = new Set<object>();
    const visit = (schema: unknown): void => {
      if (schema === null || typeof schema !== "object" || visited.has(schema)) return;
      visited.add(schema);
      const node = schema as Record<string, unknown>;
      if (node.type === "object" && node.patternProperties === undefined) {
        expect(node.additionalProperties).toBe(false);
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(ApplicationFrameSchema);
  });

  it("generates a minimum valid and unknown-field-invalid fixture for every payload/result variant", () => {
    const registries = [COMMAND_PAYLOAD_SCHEMAS, COMMAND_RESULT_SCHEMAS, EVENT_PAYLOAD_SCHEMAS];
    for (const registry of registries) {
      for (const [name, schema] of Object.entries(registry)) {
        const minimum = Value.Create(schema);
        expect(Value.Check(schema, minimum), `${name} minimum`).toBe(true);
        expect(
          Value.Check(schema, { ...(minimum as Record<string, unknown>), unknown: true }),
          `${name} unknown field`,
        ).toBe(false);
      }
    }
  });

  it("enforces declaration settlement XOR", () => {
    const tool = fixture("tool-declaration-stream.json");
    const settled = (tool.events as Array<Record<string, unknown>>)[3]?.payload;
    expect(Value.Check(ToolDeclarationSettledPayloadSchema, settled)).toBe(true);
    const invalid = structuredClone(settled) as {
      block: { tool: { arguments: unknown; error: unknown } };
    };
    invalid.block.tool.arguments = null;
    invalid.block.tool.error = null;
    expect(Value.Check(ToolDeclarationSettledPayloadSchema, invalid)).toBe(false);
  });

  it("enforces every deterministic tool declaration start field", () => {
    const tool = fixture("tool-declaration-stream.json");
    const started = (tool.events as Array<Record<string, unknown>>)[0]?.payload;
    expect(Value.Check(ToolDeclarationStartedPayloadSchema, started)).toBe(true);
    const mutations = [
      ["status", "settled"],
      ["argumentsPreview", "{}"],
      ["declarationStatus", "ready"],
      ["argumentsTruncated", true],
      ["arguments", {}],
      ["argumentsContent", {}],
      ["executionStatus", "running"],
      ["summary", "not-the-tool-name"],
      ["details", {}],
      ["startedAt", null],
      ["terminalAt", "2026-08-19T03:01:11.000Z"],
      ["error", { code: "invalid_frame", message: "bad", retryDisposition: "never" }],
      ["toolKind", "bash"],
    ] as const;
    for (const [field, value] of mutations) {
      const invalid = structuredClone(started) as Record<string, unknown>;
      const block = invalid.block as Record<string, unknown>;
      if (field === "status") block.status = value;
      else (block.tool as Record<string, unknown>)[field] = value;
      expect(Value.Check(ToolDeclarationStartedPayloadSchema, invalid), field).toBe(false);
    }
  });

  it("classifies client and server codec failures without exception leakage", () => {
    const errorCode = (result: ReturnType<typeof decodeClientFrame>) =>
      result.ok ? "ok" : result.error.code;
    expect(errorCode(decodeClientFrame("{bad"))).toBe("invalid_frame");
    expect(
      errorCode(
        decodeClientFrame(
          JSON.stringify({
            type: "hello",
            protocolMajor: 2,
            protocolMinor: 0,
            clientId: "web",
            capabilities: [],
          }),
        ),
      ),
    ).toBe("unsupported_protocol");
    expect(
      errorCode(
        decodeClientFrame(
          JSON.stringify({
            v: 1,
            requestId: "r",
            type: "future.command",
            clientMutationId: null,
            sessionId: null,
            expectedSessionVersion: null,
            payload: {},
          }),
        ),
      ),
    ).toBe("unsupported_command");
    const impossibleServer = decodeServerFrame("{bad");
    expect(impossibleServer.ok ? "ok" : impossibleServer.error.code).toBe("protocol_violation");
    const oversizedServer = decodeServerFrame(`{"value":"${"x".repeat(1_048_576)}"}`);
    expect(oversizedServer.ok ? "ok" : oversizedServer.error.code).toBe("protocol_violation");
    const majorServer = decodeServerFrame(
      JSON.stringify({
        type: "welcome",
        protocolMajor: 2,
        protocolMinor: 0,
        connectionId: "c",
        serverVersion: "1",
        capabilities: [],
        connectionSeq: 0,
      }),
    );
    expect(majorServer.ok ? "ok" : majorServer.error.code).toBe("unsupported_protocol");
    const impossibleEncode = encodeServerFrame({ type: "impossible" });
    expect(impossibleEncode.ok ? "ok" : impossibleEncode.error.code).toBe("protocol_violation");
    const unknownEncode = encodeClientFrame({
      v: 1,
      requestId: "r",
      type: "future.command",
      clientMutationId: null,
      sessionId: null,
      expectedSessionVersion: null,
      payload: {},
    });
    expect(unknownEncode.ok ? "ok" : unknownEncode.error.code).toBe("unsupported_command");
  });

  it("round-trips every command, response, and event envelope by frame direction", () => {
    for (const [name, schema] of Object.entries(COMMAND_ENVELOPE_SCHEMAS)) {
      const value = Value.Create(schema);
      const encoded = encodeClientFrame(value);
      expect(encoded.ok, `${name} client encode`).toBe(true);
      if (encoded.ok)
        expect(decodeClientFrame(encoded.value), `${name} host decode`).toEqual({
          ok: true,
          value,
        });
      const unknown = encodeClientFrame({
        ...(value as Record<string, unknown>),
        unknown: true,
      });
      expect(unknown.ok ? "ok" : unknown.error.code, `${name} closed command`).toBe(
        "invalid_frame",
      );
    }
    for (const registries of [COMMAND_RESPONSE_SCHEMAS, EVENT_ENVELOPE_SCHEMAS]) {
      for (const [name, schema] of Object.entries(registries)) {
        const value = Value.Create(schema);
        const encoded = encodeServerFrame(value);
        expect(encoded.ok, `${name} server encode`).toBe(true);
        if (encoded.ok)
          expect(decodeServerFrame(encoded.value), `${name} client decode`).toEqual({
            ok: true,
            value,
          });
        const unknown = encodeServerFrame({
          ...(value as Record<string, unknown>),
          unknown: true,
        });
        expect(unknown.ok ? "ok" : unknown.error.code, `${name} closed server frame`).toBe(
          "protocol_violation",
        );
      }
    }
  });

  it("returns stable AppError values from codecs instead of leaking throws", () => {
    const decoded = decodeApplicationFrame("{not-json");
    expect(decoded).toEqual({
      ok: false,
      error: {
        code: "invalid_frame",
        message: "Frame is not valid yaca protocol data.",
        retryDisposition: "never",
      },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(encodeApplicationFrame(cyclic)).toEqual(decoded);

    const hello = {
      type: "hello",
      protocolMajor: 1,
      protocolMinor: 0,
      clientId: "web-1",
      capabilities: [],
    } as const;
    const encoded = encodeApplicationFrame(hello);
    expect(encoded.ok).toBe(true);
    if (encoded.ok)
      expect(decodeApplicationFrame(encoded.value)).toEqual({ ok: true, value: hello });
  });

  it("rejects unknown fields, null violations, byte overflow, and oversized frames", () => {
    expect(
      Value.Check(HelloSchema, {
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientId: "x",
        capabilities: [],
        extra: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(HelloSchema, {
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientId: null,
        capabilities: [],
      }),
    ).toBe(false);
    const tooLarge = JSON.stringify({ value: "x".repeat(1_048_576) });
    expect(decodeApplicationFrame(tooLarge)).toMatchObject({
      ok: false,
      error: { code: "frame_too_large" },
    });
  });

  it("accepts exact UTF-8 boundaries and rejects one byte beyond them", () => {
    expect(Value.Check(RunPromptPayloadSchema, { text: "x".repeat(262_144) })).toBe(true);
    expect(Value.Check(RunPromptPayloadSchema, { text: "x".repeat(262_145) })).toBe(false);
    expect(
      Value.Check(BlockDeltaPayloadSchema, {
        productTurnId: "turn",
        stepId: "step",
        blockId: "block",
        append: `${"界".repeat(10_922)}xx`,
      }),
    ).toBe(true);
    expect(
      Value.Check(BlockDeltaPayloadSchema, {
        productTurnId: "turn",
        stepId: "step",
        blockId: "block",
        append: `${"界".repeat(10_922)}xxx`,
      }),
    ).toBe(false);
    const preview = {
      text: "x".repeat(65_536),
      truncated: false,
      originalByteLength: "65536",
      complete: null,
    };
    expect(Value.Check(ContentPreviewSchema, preview)).toBe(true);
    expect(Value.Check(ContentPreviewSchema, { ...preview, text: `${preview.text}x` })).toBe(false);
    const cursorAtLimit = `${"界".repeat(170)}xx`;
    expect(Value.Check(CursorSchema, cursorAtLimit)).toBe(true);
    expect(Value.Check(CursorSchema, `${cursorAtLimit}x`)).toBe(false);
    const nameAtLimit = `${"界".repeat(42)}xx`;
    expect(Value.Check(DisplayNameSchema, nameAtLimit)).toBe(true);
    expect(Value.Check(DisplayNameSchema, `${nameAtLimit}x`)).toBe(false);
    expect(Value.Check(RunPromptPayloadSchema, {})).toBe(false);
  });
});
