import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { TSchema } from "typebox";

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
  HealthResponseSchema,
  MUTATION_AUTHORITY,
  MUTATION_COMMAND_TYPES,
  JsonValueSchema,
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
import { createBoundaryFixtures, createMinimumFixture } from "./fixture-generator.js";

const fixtureDirectory = fileURLToPath(new URL("../../../docs/spec/fixtures/", import.meta.url));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}`, "utf8")) as Record<string, unknown>;
}

function assertMaximumBoundaries(
  registry: Record<string, TSchema>,
  encode: (value: unknown) => { readonly ok: boolean },
): void {
  for (const [name, schema] of Object.entries(registry)) {
    const boundaries = createBoundaryFixtures(schema);
    expect(boundaries.length, `${name} boundaries`).toBeGreaterThan(0);
    for (const boundary of boundaries) {
      expect(Value.Check(schema, boundary.valid), `${name}:${boundary.path} maximum`).toBe(true);
      expect(Value.Check(schema, boundary.invalid), `${name}:${boundary.path} overflow`).toBe(
        false,
      );
      expect(encode(boundary.valid).ok, `${name}:${boundary.path} maximum encode`).toBe(true);
    }
  }
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

  it("publishes no Value.Create defaults in wire schemas", () => {
    const visited = new Set<object>();
    const visit = (schema: unknown): void => {
      if (schema === null || typeof schema !== "object" || visited.has(schema)) return;
      visited.add(schema);
      const node = schema as Record<string, unknown>;
      expect(Object.hasOwn(node, "default")).toBe(false);
      for (const value of Object.values(node)) visit(value);
    };
    visit(ApplicationFrameSchema);
    visit(HealthResponseSchema);
  });

  it("generates a minimum valid and unknown-field-invalid fixture for every payload/result variant", () => {
    const registries = [COMMAND_PAYLOAD_SCHEMAS, COMMAND_RESULT_SCHEMAS, EVENT_PAYLOAD_SCHEMAS];
    for (const registry of registries) {
      for (const [name, schema] of Object.entries(registry)) {
        let minimum: unknown;
        try {
          minimum = createMinimumFixture(schema);
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`);
        }
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

  it("uses only shallow numeric protocol-major probes before v1 validation", () => {
    const clientCases = [
      { type: "hello", protocolMajor: 2, future: { deeply: "unknown" } },
      { requestId: "future-request", type: "future.command", protocolMajor: 2 },
    ];
    for (const value of clientCases) {
      const result = decodeClientFrame(JSON.stringify(value));
      expect(result.ok ? "ok" : result.error.code).toBe("unsupported_protocol");
    }
    const welcome = decodeServerFrame(
      JSON.stringify({ type: "welcome", protocolMajor: 9, future: true }),
    );
    expect(welcome.ok ? "ok" : welcome.error.code).toBe("unsupported_protocol");
    for (const value of [
      { type: "hello", protocolMajor: "2" },
      { type: "hello", future: { protocolMajor: 2 } },
      { protocolMajor: 2 },
      ["hello", 2],
    ]) {
      const result = decodeClientFrame(JSON.stringify(value));
      expect(result.ok ? "ok" : result.error.code).toBe("invalid_frame");
    }
  });

  it("round-trips every command, response, and event envelope by frame direction", () => {
    for (const [name, schema] of Object.entries(COMMAND_ENVELOPE_SCHEMAS)) {
      let value: unknown;
      try {
        value = createMinimumFixture(schema);
      } catch (error) {
        throw new Error(`${name}: ${String(error)}`);
      }
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
        const value = createMinimumFixture(schema);
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

  it("covers maximum boundaries for all 24 command envelopes", () => {
    assertMaximumBoundaries(COMMAND_ENVELOPE_SCHEMAS, encodeClientFrame);
  }, 10_000);

  it("covers maximum boundaries for all 24 success response envelopes", () => {
    assertMaximumBoundaries(COMMAND_RESPONSE_SCHEMAS, encodeServerFrame);
  }, 20_000);

  it("covers maximum boundaries for all 20 event envelopes", () => {
    assertMaximumBoundaries(EVENT_ENVELOPE_SCHEMAS, encodeServerFrame);
  }, 15_000);

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
    expect(Value.Check(RunPromptPayloadSchema, { text: "x".repeat(262_142) })).toBe(true);
    expect(Value.Check(RunPromptPayloadSchema, { text: "x".repeat(262_143) })).toBe(false);
    expect(Value.Check(RunPromptPayloadSchema, { text: "\n".repeat(131_071) })).toBe(true);
    expect(Value.Check(RunPromptPayloadSchema, { text: "\n".repeat(131_072) })).toBe(false);
    for (const escaped of ['"', "\\"]) {
      expect(Value.Check(RunPromptPayloadSchema, { text: escaped.repeat(131_071) })).toBe(true);
      expect(Value.Check(RunPromptPayloadSchema, { text: escaped.repeat(131_072) })).toBe(false);
    }
    expect(
      Value.Check(BlockDeltaPayloadSchema, {
        productTurnId: "turn",
        stepId: "step",
        blockId: "block",
        append: `${"界".repeat(10_922)}`,
      }),
    ).toBe(true);
    expect(
      Value.Check(BlockDeltaPayloadSchema, {
        productTurnId: "turn",
        stepId: "step",
        blockId: "block",
        append: `${"界".repeat(10_922)}x`,
      }),
    ).toBe(false);
    const preview = {
      text: "x".repeat(65_534),
      truncated: false,
      originalByteLength: "65536",
      complete: null,
    };
    expect(Value.Check(ContentPreviewSchema, preview)).toBe(true);
    expect(Value.Check(ContentPreviewSchema, { ...preview, text: `${preview.text}x` })).toBe(false);
    const cursorAtLimit = `${"界".repeat(170)}`;
    expect(Value.Check(CursorSchema, cursorAtLimit)).toBe(true);
    expect(Value.Check(CursorSchema, `${cursorAtLimit}x`)).toBe(false);
    const nameAtLimit = `${"界".repeat(42)}`;
    expect(Value.Check(DisplayNameSchema, nameAtLimit)).toBe(true);
    expect(Value.Check(DisplayNameSchema, `${nameAtLimit}x`)).toBe(false);
    expect(Value.Check(DisplayNameSchema, "允许 Unicode")).toBe(true);
    expect(Value.Check(DisplayNameSchema, "reject\u0085control")).toBe(false);
    expect(Value.Check(RunPromptPayloadSchema, {})).toBe(false);
  });

  it("enforces aggregate JsonValue serialization and nesting boundaries", () => {
    const encoder = new TextEncoder();
    const values = Array.from({ length: 5 }, (_, index) => (index < 4 ? "x".repeat(52_000) : ""));
    const remaining = 262_144 - encoder.encode(JSON.stringify(values)).byteLength;
    values[4] = "x".repeat(remaining);
    expect(encoder.encode(JSON.stringify(values)).byteLength).toBe(262_144);
    expect(Value.Check(JsonValueSchema, values)).toBe(true);
    values[4] += "x";
    expect(Value.Check(JsonValueSchema, values)).toBe(false);

    let depth32: unknown = null;
    for (let depth = 0; depth < 32; depth += 1) depth32 = [depth32];
    expect(Value.Check(JsonValueSchema, depth32)).toBe(true);
    expect(Value.Check(JsonValueSchema, [depth32])).toBe(false);
  });
});
