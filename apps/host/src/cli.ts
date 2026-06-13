#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveYacaPaths } from "./paths.js";
import { YACA_VERSION } from "./version.js";

const HELP = `Usage: yaca [start] [options]

Start the local yaca Host and Web shell.

Options:
  --host <host>       Bind address; only 127.0.0.1 is accepted (default: 127.0.0.1)
  --port <port>       TCP port, or 0 for an ephemeral port (default: 3210)
  --data-dir <path>   Runtime data root (default: YACA_HOME or ~/.yaca)
  --web-root <path>   Built Web assets (default: apps/web/dist)
  -h, --help          Show help
  -v, --version       Show version
`;

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3210;
  if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 to 65535");
  const port = Number(value);
  if (port > 65_535) throw new Error("--port must be an integer from 0 to 65535");
  return port;
}

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      port: { type: "string" },
      version: { type: "boolean", short: "v" },
      "web-root": { type: "string" },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${YACA_VERSION}\n`);
    return;
  }

  const command = positionals[0] ?? "start";
  if (command !== "start" || positionals.length > 1) {
    throw new Error(`unknown command: ${positionals.join(" ")}`);
  }

  const configuredRoot = values["data-dir"] || process.env.YACA_HOME;
  const paths = resolveYacaPaths(configuredRoot ? { root: configuredRoot } : {});
  await Promise.all(
    [...new Set(Object.values(paths))].map((path) => mkdir(path, { recursive: true })),
  );
  process.env.YACA_HOME = paths.root;
  process.env.TMPDIR = paths.temporary;

  const { startHost } = await import("./host.js");
  const webRoot = values["web-root"] ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const host = await startHost({
    ...(values.host ? { host: values.host } : {}),
    port: parsePort(values.port),
    webRoot,
  });

  process.stdout.write(`yaca listening at ${host.url}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`yaca: ${message}\n`);
  process.exitCode = 1;
});
