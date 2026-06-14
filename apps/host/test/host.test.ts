import { HealthResponseSchema, Value } from "@yaca/contracts";
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { prepareYacaPaths, type RunningHost, startHost, type YacaPaths } from "@yaca/host";

const runningHosts: RunningHost[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createPaths(): Promise<YacaPaths> {
  const temporary = await mkdtemp(join(tmpdir(), "yaca-host-data-"));
  temporaryRoots.push(temporary);
  return prepareYacaPaths({ root: join(temporary, "data") });
}

describe("Host network boundary", () => {
  test("refuses a non-loopback bind address", async () => {
    await expect(
      startHost({ host: "0.0.0.0", paths: await createPaths(), port: 0 }),
    ).rejects.toThrow("yaca only listens on 127.0.0.1");
  });

  test("serves schema-valid health without pre-empting application bootstrap", async () => {
    const host = await startHost({ paths: await createPaths(), port: 0 });
    runningHosts.push(host);

    const health = await fetch(`${host.url}/api/health`).then((response) => response.json());
    const bootstrapResponse = await fetch(`${host.url}/api/bootstrap`);

    expect(Value.Check(HealthResponseSchema, health)).toBe(true);
    expect(health).toMatchObject({ service: "yaca-host", status: "ok", version: "0.1.0" });
    expect(bootstrapResponse.status).toBe(404);
  });

  test("serves static assets and falls back to the Web shell for navigation routes", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "yaca-web-"));
    temporaryRoots.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>yaca shell</title>");
    await writeFile(join(webRoot, "assets", "shell.js"), "globalThis.yacaShell = true;");

    const host = await startHost({ paths: await createPaths(), port: 0, webRoot });
    runningHosts.push(host);

    const navigationResponse = await fetch(`${host.url}/sessions/example`);
    const assetResponse = await fetch(`${host.url}/assets/shell.js`);
    const apiResponses = await Promise.all(
      [
        "/api",
        "/api/",
        "/api/not-found",
        "/%61pi",
        "/%2561pi",
        "/api%2fnot-found",
        "/section/../api",
        "//api",
        "/%5capi",
      ].map(async (path) => ({ path, response: await fetch(`${host.url}${path}`) })),
    );

    expect(navigationResponse.status).toBe(200);
    expect(navigationResponse.headers.get("content-type")).toContain("text/html");
    expect(await navigationResponse.text()).toContain("yaca shell");
    expect(await assetResponse.text()).toBe("globalThis.yacaShell = true;");
    for (const { path, response } of apiResponses) {
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text(), path).not.toContain("yaca shell");
    }
  });

  test("holds one kernel authority fence per yaca root and releases it on close", async () => {
    const paths = await createPaths();
    const first = await startHost({ paths, port: 0 });
    runningHosts.push(first);

    const lockPath = join(paths.run, "host.lock");
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    expect(metadata).toMatchObject({
      pid: process.pid,
      instance: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      authorityPort: expect.any(Number),
      startedAt: expect.any(String),
    });
    const rejectedAt = Date.now();
    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(metadata.authorityPort)} is already in use; refusing to start`,
    );
    expect(Date.now() - rejectedAt).toBeLessThan(1_000);

    await rm(lockPath);
    await expect(startHost({ paths, port: 0 })).rejects.toThrow("authority port");

    await first.close();
    runningHosts.splice(runningHosts.indexOf(first), 1);
    await expect(access(lockPath)).rejects.toThrow();

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  });

  test("allows exactly one of eight same-root authority contenders to start", async () => {
    const paths = await createPaths();
    const startedAt = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => startHost({ paths, port: 0 })),
    );
    const started = results.filter(
      (result): result is PromiseFulfilledResult<RunningHost> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    runningHosts.push(...started.map((result) => result.value));

    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(rejected.every((result) => String(result.reason).includes("authority port"))).toBe(true);
  });

  test("keeps authority while the JavaScript event loop is blocked beyond the former lease", async () => {
    const paths = await createPaths();
    const first = await startHost({ paths, port: 0 });
    runningHosts.push(first);

    const blockedAt = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_100);
    expect(Date.now() - blockedAt).toBeGreaterThanOrEqual(5_000);
    await expect(startHost({ paths, port: 0 })).rejects.toThrow("authority port");
  }, 7_000);

  test("fails closed when an unrelated process owns the derived authority port", async () => {
    const paths = await createPaths();
    const probe = await startHost({ paths, port: 0 });
    const metadata = JSON.parse(await readFile(join(paths.run, "host.lock"), "utf8"));
    await probe.close();

    const unrelated = createServer((socket) => socket.destroy());
    await new Promise<void>((resolveListening, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(
        { exclusive: true, host: "127.0.0.1", port: metadata.authorityPort },
        resolveListening,
      );
    });

    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(metadata.authorityPort)} is already in use; refusing to start`,
    );
    await new Promise<void>((resolveClose, reject) =>
      unrelated.close((error) => (error ? reject(error) : resolveClose())),
    );
  });

  test("bounds shutdown while an HTTP response remains backpressured", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "yaca-large-response-"));
    temporaryRoots.push(webRoot);
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>yaca</title>");
    await writeFile(join(webRoot, "large.bin"), "");
    await truncate(join(webRoot, "large.bin"), 64 * 1024 * 1024);
    const paths = await createPaths();
    const host = await startHost({ paths, port: 0, webRoot });
    runningHosts.push(host);
    const socket = createConnection({ host: "127.0.0.1", port: host.port });
    await new Promise<void>((resolveConnected, reject) => {
      socket.once("connect", resolveConnected);
      socket.once("error", reject);
    });
    socket.write("GET /large.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
    await new Promise<void>((resolveReadable, reject) => {
      socket.once("readable", resolveReadable);
      socket.once("error", reject);
    });

    const closing = host.close();
    await expect(startHost({ paths, port: 0 })).rejects.toThrow("authority port");
    const closedWithinDeadline = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolveDeadline) => setTimeout(() => resolveDeadline(false), 2_750)),
    ]);
    socket.destroy();
    await closing;
    runningHosts.splice(runningHosts.indexOf(host), 1);

    expect(closedWithinDeadline).toBe(true);
    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  }, 5_000);
});
