import { stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { posix } from "node:path";

import fastifyStatic from "@fastify/static";
import type { HealthResponse } from "@yaca/contracts";
import Fastify from "fastify";

import { acquireAuthorityFence } from "./authority-fence.js";
import { YACA_VERSION } from "./version.js";
import type { YacaPaths } from "./paths.js";

export const LOOPBACK_HOST = "127.0.0.1";
const SHUTDOWN_GRACE_MS = 2_000;

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

async function closeApplication(app: ReturnType<typeof Fastify>): Promise<void> {
  const forceTimer = setTimeout(() => {
    app.server.closeIdleConnections();
    app.server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(forceTimer);
  }
}

export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(`yaca only listens on ${LOOPBACK_HOST}`);
  }

  const authorityFence = await acquireAuthorityFence(options.paths);
  let app: ReturnType<typeof Fastify> | undefined;
  try {
    const hostApp = Fastify({ logger: false });
    app = hostApp;
    const startedAt = process.hrtime.bigint();

    hostApp.get(
      "/api/health",
      async (): Promise<HealthResponse> => ({
        authorityPort: authorityFence.port,
        status: "ok",
        service: "yaca-host",
        version: YACA_VERSION,
        uptimeSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      }),
    );

    if (options.webRoot) {
      const webRootStat = await stat(options.webRoot).catch(() => undefined);
      if (!webRootStat?.isDirectory()) {
        throw new Error("yaca Web root must be an existing directory");
      }
      await hostApp.register(fastifyStatic, {
        root: options.webRoot,
        prefix: "/",
      });

      hostApp.setNotFoundHandler(async (request, reply) => {
        if (request.method === "GET" && !isApiRequestTarget(request.url)) {
          return reply.type("text/html; charset=utf-8").sendFile("index.html");
        }

        return reply.code(404).send({ error: "not_found" });
      });
    }

    await hostApp.ready();
    await hostApp.listen({ host, port: options.port ?? 3210 });
    const address = hostApp.server.address() as AddressInfo;
    const url = `http://${host}:${address.port}`;
    let closing: Promise<void> | undefined;

    return {
      host,
      port: address.port,
      url,
      close: () => {
        closing ??= (async () => {
          try {
            await closeApplication(hostApp);
          } finally {
            await authorityFence.release();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (app) await closeApplication(app).catch(() => undefined);
    await authorityFence.release();
    throw error;
  }
}
