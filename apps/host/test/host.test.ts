import { HealthResponseSchema, Value } from "@yaca/contracts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { prepareYacaPaths, type RunningHost, startHost, type YacaPaths } from "@yaca/host";

const runningHosts: RunningHost[] = [];
const temporaryRoots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const authorityBlockers = new Set<Server>();

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all([...authorityBlockers].map((server) => closeAuthorityBlocker(server)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createPaths(): Promise<YacaPaths> {
  const temporary = await mkdtemp(join(tmpdir(), "yaca-host-data-"));
  temporaryRoots.push(temporary);
  return prepareYacaPaths({ root: join(temporary, "data") });
}

async function readAuthorityPorts(host: RunningHost): Promise<[number, number]> {
  return fetch(`${host.url}/api/health`).then(
    async (response) =>
      ((await response.json()) as { authorityPorts: [number, number] }).authorityPorts,
  );
}

async function bindAuthorityBlocker(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  authorityBlockers.add(server);
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, resolveListening);
  });
  return server;
}

async function closeAuthorityBlocker(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  authorityBlockers.delete(server);
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
      authorityPorts: [expect.any(Number), expect.any(Number)],
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

    const authorityPorts = await readAuthorityPorts(first);
    expect(new Set(authorityPorts).size).toBe(2);
    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(authorityPorts[0])} is already in use; refusing to start`,
    );

    await first.close();
    runningHosts.splice(runningHosts.indexOf(first), 1);
    expect(await readdir(paths.run)).toEqual([]);

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
    expect(await readAuthorityPorts(restarted)).toEqual(authorityPorts);
  });

  test("starts distinct roots concurrently when their authority port sets do not overlap", async () => {
    const candidateRoot = await mkdtemp(join(tmpdir(), "yaca-authority-candidates-"));
    temporaryRoots.push(candidateRoot);
    const selected: Array<{ paths: YacaPaths; ports: [number, number] }> = [];
    const selectedPorts = new Set<number>();
    const targetCount = 32;
    const candidateLimit = 256;

    for (let index = 0; index < candidateLimit && selected.length < targetCount; index += 1) {
      const paths = await prepareYacaPaths({ root: join(candidateRoot, `candidate-${index}`) });
      let probe: RunningHost;
      try {
        probe = await startHost({ paths, port: 0 });
      } catch (error) {
        if (String(error).includes("authority port")) continue;
        throw error;
      }
      runningHosts.push(probe);
      let ports: [number, number];
      try {
        ports = await readAuthorityPorts(probe);
      } finally {
        await probe.close();
        runningHosts.splice(runningHosts.indexOf(probe), 1);
      }
      if (ports.some((port) => selectedPorts.has(port))) continue;
      selected.push({ paths, ports });
      for (const port of ports) selectedPorts.add(port);
    }

    if (selected.length < targetCount) {
      throw new Error(
        `found only ${String(selected.length)} non-overlapping authority pairs from ${String(candidateLimit)} candidates`,
      );
    }

    const starts = await Promise.all(
      selected.map(async ({ paths, ports }) => {
        try {
          const host = await startHost({ paths, port: 0 });
          runningHosts.push(host);
          return { host, ports, type: "started" as const };
        } catch (error) {
          return { error, ports, type: "rejected" as const };
        }
      }),
    );
    expect(starts.filter((result) => result.type === "rejected")).toEqual([]);
    await Promise.all(
      starts.map(async (result) => {
        if (result.type === "started")
          expect(await readAuthorityPorts(result.host)).toEqual(result.ports);
      }),
    );
  }, 15_000);

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
      | Promise<
          | { type: "started" }
          | { error: unknown; type: "cleanup_failed" }
          | { error: unknown; type: "rejected" }
        >
      | undefined;
    let contenderSettled: typeof contender;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      await waitForMessage("blocking");
      const blockedAt = process.hrtime.bigint();
      const minimumBlockedUntil = blockedAt + 5_500_000_000n;
      while (process.hrtime.bigint() < minimumBlockedUntil) {
        const remainingNanoseconds = minimumBlockedUntil - process.hrtime.bigint();
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, Number((remainingNanoseconds + 999_999n) / 1_000_000n)),
        );
      }
      expect(process.hrtime.bigint() - blockedAt).toBeGreaterThanOrEqual(5_500_000_000n);
      expect(messages.some((message) => message.type === "unblocked")).toBe(false);

      contender = startHost({ paths, port: 0 }).then(
        async (host) => {
          runningHosts.push(host);
          try {
            await host.close();
          } catch (error) {
            return { error, type: "cleanup_failed" as const };
          }
          const contenderIndex = runningHosts.indexOf(host);
          if (contenderIndex !== -1) runningHosts.splice(contenderIndex, 1);
          return { type: "started" as const };
        },
        (error: unknown) => ({ error, type: "rejected" as const }),
      );
      contenderSettled = withDeadline(
        contender,
        5_000,
        "same-root authority contender did not settle within 5 seconds",
      );
      const outcome = await Promise.race([
        contenderSettled,
        unblocked.then(() => ({ type: "unblocked" as const })),
      ]);
      expect(outcome.type).toBe("rejected");
      if (outcome.type === "rejected") expect(String(outcome.error)).toContain("authority port");
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        exit = await withDeadline(
          childExit,
          3_000,
          "blocking Host did not terminate within 3 seconds after SIGKILL",
        );
      } finally {
        if (exit) children.delete(child);
        await contenderSettled;
      }
    }

    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(messages.some((message) => message.type === "unblocked")).toBe(false);
  }, 30_000);

  test("fails closed when an unrelated process owns either derived authority port", async () => {
    const paths = await createPaths();
    const probe = await startHost({ paths, port: 0 });
    runningHosts.push(probe);
    const authorityPorts = await readAuthorityPorts(probe);
    await probe.close();
    runningHosts.splice(runningHosts.indexOf(probe), 1);

    for (const authorityPort of authorityPorts) {
      const unrelated = await bindAuthorityBlocker(authorityPort);
      await expect(startHost({ paths, port: 0 })).rejects.toThrow(
        `yaca authority port ${String(authorityPort)} is already in use; refusing to start`,
      );
      await closeAuthorityBlocker(unrelated);
    }
  });

  test("releases the first authority port when binding the second fails", async () => {
    const paths = await createPaths();
    const probe = await startHost({ paths, port: 0 });
    runningHosts.push(probe);
    const authorityPorts = await readAuthorityPorts(probe);
    await probe.close();
    runningHosts.splice(runningHosts.indexOf(probe), 1);

    const secondPortOwner = await bindAuthorityBlocker(authorityPorts[1]);
    await expect(startHost({ paths, port: 0 })).rejects.toThrow(
      `yaca authority port ${String(authorityPorts[1])} is already in use; refusing to start`,
    );
    const firstPortOwner = await bindAuthorityBlocker(authorityPorts[0]);
    await closeAuthorityBlocker(firstPortOwner);
    await closeAuthorityBlocker(secondPortOwner);
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
