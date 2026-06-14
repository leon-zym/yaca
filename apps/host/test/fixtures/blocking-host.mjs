import { prepareYacaPaths, startHost } from "@yaca/host";

const root = process.argv[2];
if (!root) throw new Error("missing yaca data root");

const paths = await prepareYacaPaths({ root });
const host = await startHost({ paths, port: 0 });
process.stdout.write(`${JSON.stringify({ type: "ready", url: host.url })}\n`);

const blockedAt = Date.now();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_100);
process.stdout.write(
  `${JSON.stringify({ type: "unblocked", blockedMs: Date.now() - blockedAt })}\n`,
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await host.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
