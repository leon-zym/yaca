import { HealthResponseSchema, Value } from "@yaca/contracts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { prepareYacaPaths, type RunningHost, startHost, type YacaPaths } from "@yaca/host";

const runningHosts: RunningHost[] = [];
const temporaryRoots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
  for (const child of children) child.kill("SIGKILL");
  children.clear();
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
    const paths = await createPaths();
    const host = await startHost({ paths, port: 0 });
    runningHosts.push(host);

    const health = await fetch(`${host.url}/api/health`).then((response) => response.json());
    const bootstrapResponse = await fetch(`${host.url}/api/bootstrap`);

    expect(Value.Check(HealthResponseSchema, health)).toBe(true);
    expect(health).toMatchObject({
      authorityPort: expect.any(Number),
      service: "yaca-host",
      status: "ok",
      version: "0.1.0",
    });
    expect(await readdir(paths.run)).toEqual([]);
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

  test("releases authority after Web initialization fails", async () => {
    const paths = await createPaths();
    const missingWebRoot = join(paths.root, "missing-web-root");

    await expect(startHost({ paths, port: 0, webRoot: missingWebRoot })).rejects.toThrow();

    const recovered = await startHost({ paths, port: 0 });
    runningHosts.push(recovered);
  });

  test("holds one kernel authority fence per yaca root and releases it on close", async () => {
    const paths = await createPaths();
    const first = await startHost({ paths, port: 0 });
    runningHosts.push(first);

    const authorityPort = await fetch(`${first.url}/api/health`).then(
      async (response) => ((await response.json()) as { authorityPort: number }).authorityPort,
    );
    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(authorityPort)} is already in use; refusing to start`,
    );

    await first.close();
    runningHosts.splice(runningHosts.indexOf(first), 1);
    expect(await readdir(paths.run)).toEqual([]);

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  });

  test("allows exactly one of eight same-root authority contenders to start", async () => {
    const paths = await createPaths();
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
    expect(rejected.every((result) => String(result.reason).includes("authority port"))).toBe(true);
  });

  test("keeps authority while its child process event loop is blocked beyond five seconds", async () => {
    const paths = await createPaths();
    const fixture = resolve(import.meta.dirname, "fixtures/blocking-host.mjs");
    const child = spawn(process.execPath, [fixture, paths.root], {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const messages: Array<{ type: string }> = [];
    let resolveUnblocked!: () => void;
    const unblocked = new Promise<void>((resolveUnexpected) => {
      resolveUnblocked = resolveUnexpected;
    });
    let wake: (() => void) | undefined;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as { type: string };
        messages.push(message);
        if (message.type === "unblocked") resolveUnblocked();
      }
      wake?.();
      wake = undefined;
    });
    const waitForMessage = async (type: string) => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const message = messages.find((candidate) => candidate.type === type);
        if (message) return message;
        await new Promise<void>((resolveWake) => {
          const timeout = setTimeout(resolveWake, 100);
          wake = () => {
            clearTimeout(timeout);
            resolveWake();
          };
        });
      }
      throw new Error(`blocking Host did not report ${type}: ${stderr}`);
    };

    let contender:
      | Promise<{ host: RunningHost; type: "started" } | { error: unknown; type: "rejected" }>
      | undefined;
    let contenderHost: RunningHost | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      await waitForMessage("blocking");
      contender = startHost({ paths, port: 0 }).then(
        (host) => {
          contenderHost = host;
          runningHosts.push(host);
          return { host, type: "started" as const };
        },
        (error: unknown) => ({ error, type: "rejected" as const }),
      );
      const outcome = await Promise.race([
        contender,
        unblocked.then(() => ({ type: "unblocked" as const })),
      ]);
      expect(outcome.type).toBe("rejected");
      if (outcome.type === "rejected") expect(String(outcome.error)).toContain("authority port");
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        let exitTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          exit = await Promise.race([
            childExit,
            new Promise<never>((_resolve, reject) => {
              exitTimeout = setTimeout(
                () => reject(new Error("blocking Host did not terminate after SIGKILL")),
                2_000,
              );
            }),
          ]);
        } finally {
          if (exitTimeout) clearTimeout(exitTimeout);
        }
      } finally {
        if (exit) children.delete(child);

        try {
          await contender;
        } finally {
          if (contenderHost) {
            try {
              await contenderHost.close();
            } finally {
              const contenderIndex = runningHosts.indexOf(contenderHost);
              if (contenderIndex !== -1) runningHosts.splice(contenderIndex, 1);
            }
          }
        }
      }
    }

    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(messages.some((message) => message.type === "unblocked")).toBe(false);
  }, 12_000);

  test("fails closed when an unrelated process owns the derived authority port", async () => {
    const paths = await createPaths();
    const probe = await startHost({ paths, port: 0 });
    const authorityPort = await fetch(`${probe.url}/api/health`).then(
      async (response) => ((await response.json()) as { authorityPort: number }).authorityPort,
    );
    await probe.close();

    const unrelated = createServer((socket) => socket.destroy());
    await new Promise<void>((resolveListening, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(
        { exclusive: true, host: "127.0.0.1", port: authorityPort },
        resolveListening,
      );
    });

    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(authorityPort)} is already in use; refusing to start`,
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
    await closing;
    socket.destroy();
    runningHosts.splice(runningHosts.indexOf(host), 1);

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  }, 6_000);
});
