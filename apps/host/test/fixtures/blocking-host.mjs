import { prepareYacaPaths, startHost } from "@yaca/host";

const root = process.argv[2];
if (!root) throw new Error("missing yaca data root");

const paths = await prepareYacaPaths({ root });
const host = await startHost({ paths, port: 0 });
process.stdout.write(`${JSON.stringify({ type: "blocking", url: host.url })}\n`);

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
process.stdout.write(`${JSON.stringify({ type: "unblocked" })}\n`);
