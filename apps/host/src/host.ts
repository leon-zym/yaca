import type { AddressInfo } from "node:net";
import { join, posix } from "node:path";

import fastifyStatic from "@fastify/static";
import type { HealthResponse } from "@yaca/contracts";
import Fastify from "fastify";
import { lock } from "proper-lockfile";

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
  safetyFailure: Promise<Error>;
  close(): Promise<void>;
}

async function acquireHostLock(
  paths: YacaPaths,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  const lockPath = join(paths.run, "host.lock");
  let compromised = false;
  let releaseLease: () => Promise<void>;
  try {
    releaseLease = await lock(paths.run, {
      lockfilePath: lockPath,
      onCompromised: (error) => {
        compromised = true;
        onCompromised(error);
      },
      realpath: false,
      retries: { factor: 1, maxTimeout: 500, minTimeout: 500, retries: 12 },
      stale: 5_000,
      update: 1_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error("another yaca Host is running for this data root", { cause: error });
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (compromised) return;
    await releaseLease();
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
  let safetyFailed = false;
  let resolveSafetyFailure!: (error: Error) => void;
  const safetyFailure = new Promise<Error>((resolveFailure) => {
    resolveSafetyFailure = resolveFailure;
  });

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

  const releaseHostLock = await acquireHostLock(options.paths, (cause) => {
    if (safetyFailed) return;
    safetyFailed = true;
    const error = new Error("yaca Host lease was compromised; service stopped", { cause });
    resolveSafetyFailure(error);
    void app.close().catch(() => undefined);
  });
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
    safetyFailure,
    close: () => app.close(),
  };
}
