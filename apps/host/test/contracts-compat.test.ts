import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decodeClientFrame,
  encodeClientFrame,
  type CodecResult,
  type ClientFrame,
} from "@yaca/contracts";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
  new URL("../../../docs/spec/fixtures/app-sync-gap.json", import.meta.url),
);

function errorCode<T>(result: CodecResult<T>): string {
  return result.ok ? "ok" : result.error.code;
}

describe("Host consumption of public contracts", () => {
  it("decodes the client frame produced at the public client boundary", () => {
    const scenario = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      syncCommand: ClientFrame;
    };
    const encoded = encodeClientFrame(scenario.syncCommand);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(decodeClientFrame(encoded.value)).toEqual({ ok: true, value: scenario.syncCommand });
    }
  });

  it("observes serialized-string maximum and unknown-command rejection", () => {
    const maximumHello = {
      type: "hello",
      protocolMajor: 1,
      protocolMinor: 0,
      clientId: "x".repeat(126),
      capabilities: [],
    } as const;
    expect(errorCode(encodeClientFrame(maximumHello))).toBe("ok");
    expect(errorCode(encodeClientFrame({ ...maximumHello, clientId: "x".repeat(127) }))).toBe(
      "invalid_frame",
    );
    expect(
      errorCode(
        encodeClientFrame({
          v: 1,
          requestId: "request",
          type: "future.command",
          clientMutationId: null,
          sessionId: null,
          expectedSessionVersion: null,
          payload: {},
        }),
      ),
    ).toBe("unsupported_command");
  });
});
