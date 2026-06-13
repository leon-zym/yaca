import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, posix } from "node:path";

import fastifyStatic from "@fastify/static";
import type { HealthResponse } from "@yaca/contracts";
import Fastify from "fastify";

import { YACA_VERSION } from "./version.js";
import type { YacaPaths } from "./paths.js";

export const LOOPBACK_HOST = "127.0.0.1";

export interface StartHostOptions {
  host?: string;
  paths: YacaPaths;
  port?: number;
  webRoot?: string;
}

export interface RunningHost {
  host: typeof LOOPBACK_HOST;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface HostLockRecord {
  pid: number;
  instanceId: string;
  startedAt: string;
}

function parseHostLock(contents: string): HostLockRecord | undefined {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.instanceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.instanceId,
      ) ||
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt))
    ) {
      return undefined;
    }
    return value as unknown as HostLockRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function restoreClaimedLock(claimedPath: string, lockPath: string): Promise<void> {
  try {
    await link(claimedPath, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function acquireHostLock(paths: YacaPaths): Promise<() => Promise<void>> {
  const lockPath = join(paths.run, "host.lock");
  const instanceId = randomUUID();
  const candidatePath = join(paths.run, `host.lock.candidate-${instanceId}`);
  const record: HostLockRecord = {
    pid: process.pid,
    instanceId,
    startedAt: new Date().toISOString(),
  };
  const candidate = await open(candidatePath, "wx", 0o600);
  try {
    await candidate.writeFile(`${JSON.stringify(record)}\n`);
    await candidate.sync();
  } finally {
    await candidate.close();
  }

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await link(candidatePath, lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let observedContents: string;
      try {
        observedContents = await readFile(lockPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const observedRecord = parseHostLock(observedContents);
      if (observedRecord && isProcessAlive(observedRecord.pid)) {
        throw new Error("another yaca Host is running for this data root");
      }

      const claimedPath = join(paths.run, `host.lock.stale-${randomUUID()}`);
      try {
        await rename(lockPath, claimedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      const claimedContents = await readFile(claimedPath, "utf8").catch(() => "");
      if (claimedContents !== observedContents) {
        await restoreClaimedLock(claimedPath, lockPath);
      }
      await rm(claimedPath, { force: true });
    }

    const installedRecord = await readFile(lockPath, "utf8").then(parseHostLock);
    if (installedRecord?.instanceId !== instanceId) {
      if (installedRecord && isProcessAlive(installedRecord.pid)) {
        throw new Error("another yaca Host is running for this data root");
      }
      throw new Error("unable to acquire the yaca Host lock safely");
    }
  } finally {
    await rm(candidatePath, { force: true });
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = await readFile(lockPath, "utf8").then(parseHostLock);
      if (current?.instanceId === instanceId) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

function isApiRequestTarget(requestTarget: string): boolean {
  let pathname = requestTarget.split(/[?#]/u, 1)[0] ?? "/";
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
  } catch {
    return true;
  }

  if (/%[0-9a-f]{2}/iu.test(pathname)) return true;
  const normalized = posix.normalize(
    `/${pathname.replaceAll("\\", "/").replaceAll("?", "/").replaceAll("#", "/")}`,
  );
  return normalized === "/api" || normalized.startsWith("/api/");
}

export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(`yaca only listens on ${LOOPBACK_HOST}`);
  }

  const app = Fastify({ logger: false });
  const startedAt = process.hrtime.bigint();

  app.get(
    "/api/health",
    async (): Promise<HealthResponse> => ({
      status: "ok",
      service: "yaca-host",
      version: YACA_VERSION,
      uptimeSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    }),
  );

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: "/",
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !isApiRequestTarget(request.url)) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }

      return reply.code(404).send({ error: "not_found" });
    });
  }

  const releaseHostLock = await acquireHostLock(options.paths);
  app.addHook("onClose", releaseHostLock);
  try {
    await app.listen({ host, port: options.port ?? 3210 });
  } catch (error) {
    await app.close().catch(() => undefined);
    await releaseHostLock();
    throw error;
  }
  const address = app.server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    host,
    port: address.port,
    url,
    close: () => app.close(),
  };
}
