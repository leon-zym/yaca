import { BootstrapResponseSchema, HealthResponseSchema, Value } from "@yaca/contracts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { type RunningHost, startHost } from "../src/host.js";

const runningHosts: RunningHost[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Host network boundary", () => {
  test("refuses a non-loopback bind address", async () => {
    await expect(startHost({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
      "yaca only listens on 127.0.0.1",
    );
  });

  test("serves schema-valid health and foundation bootstrap responses", async () => {
    const host = await startHost({ port: 0 });
    runningHosts.push(host);

    const health = await fetch(`${host.url}/api/health`).then((response) => response.json());
    const bootstrap = await fetch(`${host.url}/api/bootstrap`).then((response) => response.json());

    expect(Value.Check(HealthResponseSchema, health)).toBe(true);
    expect(health).toMatchObject({ service: "yaca-host", status: "ok", version: "0.1.0" });
    expect(Value.Check(BootstrapResponseSchema, bootstrap)).toBe(true);
    expect(bootstrap).toEqual({
      application: "yaca",
      capabilities: [],
      protocol: { major: 1, minor: 0 },
      version: "0.1.0",
    });
  });

  test("serves static assets and falls back to the Web shell for navigation routes", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "yaca-web-"));
    temporaryRoots.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>yaca shell</title>");
    await writeFile(join(webRoot, "assets", "shell.js"), "globalThis.yacaShell = true;");

    const host = await startHost({ port: 0, webRoot });
    runningHosts.push(host);

    const navigationResponse = await fetch(`${host.url}/sessions/example`);
    const assetResponse = await fetch(`${host.url}/assets/shell.js`);
    const missingApiResponse = await fetch(`${host.url}/api/not-found`);

    expect(navigationResponse.status).toBe(200);
    expect(navigationResponse.headers.get("content-type")).toContain("text/html");
    expect(await navigationResponse.text()).toContain("yaca shell");
    expect(await assetResponse.text()).toBe("globalThis.yacaShell = true;");
    expect(missingApiResponse.status).toBe(404);
    expect(await missingApiResponse.text()).not.toContain("yaca shell");
  });
});
