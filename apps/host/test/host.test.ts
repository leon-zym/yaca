import { HealthResponseSchema, Value } from "@yaca/contracts";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("holds one Host lock per yaca root and releases it on close", async () => {
    const paths = await createPaths();
    const first = await startHost({ paths, port: 0 });
    runningHosts.push(first);

    const lockPath = join(paths.run, "host.lock");
    await expect(access(lockPath)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    await expect(startHost({ paths, port: 0 })).rejects.toThrow("another yaca Host is running");

    await first.close();
    runningHosts.splice(runningHosts.indexOf(first), 1);
    await expect(access(join(paths.run, "host.lock"))).rejects.toThrow();

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  });

  test("reclaims a valid Host lock whose owner process is dead", async () => {
    const paths = await createPaths();
    const lockPath = join(paths.run, "host.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        instanceId: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const host = await startHost({ paths, port: 0 });
    runningHosts.push(host);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      instanceId: expect.not.stringMatching(/^0{8}-/u),
    });
  });

  test("reclaims damaged and malicious Host lock records", async () => {
    const paths = await createPaths();
    const lockPath = join(paths.run, "host.lock");

    for (const contents of [
      "not-json\n",
      `${JSON.stringify({
        pid: process.pid,
        instanceId: "../../not-an-instance",
        startedAt: "not-a-date",
      })}\n`,
    ]) {
      await writeFile(lockPath, contents);
      const host = await startHost({ paths, port: 0 });
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
      await host.close();
    }
  });

  test("allows exactly one contender to replace a stale Host lock", async () => {
    const paths = await createPaths();
    await writeFile(join(paths.run, "host.lock"), "damaged\n");

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
    expect(
      rejected.every((result) => String(result.reason).includes("another yaca Host is running")),
    ).toBe(true);
  });
});
