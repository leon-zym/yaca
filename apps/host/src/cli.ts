#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { prepareYacaPaths } from "./paths.js";
import { YACA_VERSION } from "./version.js";

const HELP = `Usage: yaca [start] [options]

Start the local yaca Host and Web shell.

Options:
  --host <host>       Bind address; only 127.0.0.1 is accepted (default: 127.0.0.1)
  --port <port>       TCP port, or 0 for an ephemeral port (default: 3210)
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
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      port: { type: "string" },
      version: { type: "boolean", short: "v" },
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

  const paths = await prepareYacaPaths();
  process.env.TMPDIR = paths.temporary;

  const { startHost } = await import("./host.js");
  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const host = await startHost({
    ...(values.host ? { host: values.host } : {}),
    paths,
    port: parsePort(values.port),
    webRoot,
  });

  process.stdout.write(`yaca listening at ${host.url}\n`);
  void host.safetyFailure.then((error) => {
    process.stderr.write(`yaca: ${error.message}\n`);
    process.exitCode = 1;
  });

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
