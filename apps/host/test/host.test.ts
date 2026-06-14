import { HealthResponseSchema, Value } from "@yaca/contracts";
import { access, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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

  test("holds one renewable Host lease per yaca root and releases it on close", async () => {
    const paths = await createPaths();
    const first = await startHost({ paths, port: 0 });
    runningHosts.push(first);

    const lockPath = join(paths.run, "host.lock");
    await expect(access(lockPath)).resolves.toBeUndefined();
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    const initialMtime = (await stat(lockPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(initialMtime);
    await expect(startHost({ paths, port: 0 })).rejects.toThrow("another yaca Host is running");

    await first.close();
    runningHosts.splice(runningHosts.indexOf(first), 1);
    await expect(access(lockPath)).rejects.toThrow();

    const restarted = await startHost({ paths, port: 0 });
    runningHosts.push(restarted);
  }, 12_000);

  test("allows exactly one contender to replace a stale Host lease", async () => {
    const paths = await createPaths();
    const lockPath = join(paths.run, "host.lock");
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

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
  }, 10_000);

  test("stops serving and exposes a safety error when its Host lease is compromised", async () => {
    const paths = await createPaths();
    const host = await startHost({ paths, port: 0 });
    runningHosts.push(host);

    expect(host.safetyFailure).toBeInstanceOf(Promise);
    await rename(join(paths.run, "host.lock"), join(paths.run, "host.lock-displaced"));

    await expect(host.safetyFailure).resolves.toMatchObject({
      message: "yaca Host lease was compromised; service stopped",
    });
    await expect
      .poll(
        () =>
          fetch(`${host.url}/api/health`).then(
            () => true,
            () => false,
          ),
        { timeout: 3_000 },
      )
      .toBe(false);

    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);
  });
});
