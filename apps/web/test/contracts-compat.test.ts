import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decodeServerFrame,
  encodeServerFrame,
  type CodecResult,
  type ServerFrame,
} from "@yaca/contracts";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
  new URL("../../../docs/spec/fixtures/tool-declaration-stream.json", import.meta.url),
);

function errorCode<T>(result: CodecResult<T>): string {
  return result.ok ? "ok" : result.error.code;
}

describe("Web consumption of public contracts", () => {
  it("decodes the server event produced at the public server boundary", () => {
    const scenario = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      events: ServerFrame[];
    };
    const event = scenario.events[0];
    const encoded = encodeServerFrame(event);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) expect(decodeServerFrame(encoded.value)).toEqual({ ok: true, value: event });
  });

  it("observes serialized-string maximum and impossible-frame rejection", () => {
    const maximumWelcome = {
      type: "welcome",
      protocolMajor: 1,
      protocolMinor: 0,
      connectionId: "connection",
      serverVersion: "x".repeat(126),
      capabilities: [],
      connectionSeq: 0,
    } as const;
    expect(errorCode(encodeServerFrame(maximumWelcome))).toBe("ok");
    expect(
      errorCode(encodeServerFrame({ ...maximumWelcome, serverVersion: "x".repeat(127) })),
    ).toBe("protocol_violation");
    expect(errorCode(encodeServerFrame({ ...maximumWelcome, unknown: true }))).toBe(
      "protocol_violation",
    );
  });
});
