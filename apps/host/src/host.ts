import type { AddressInfo } from "node:net";

import fastifyStatic from "@fastify/static";
import type { BootstrapResponse, HealthResponse } from "@yaca/contracts";
import Fastify from "fastify";

import { YACA_VERSION } from "./version.js";

export const LOOPBACK_HOST = "127.0.0.1";

export interface StartHostOptions {
  host?: string;
  port?: number;
  webRoot?: string;
}

export interface RunningHost {
  host: typeof LOOPBACK_HOST;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startHost(options: StartHostOptions = {}): Promise<RunningHost> {
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

  app.get(
    "/api/bootstrap",
    async (): Promise<BootstrapResponse> => ({
      application: "yaca",
      version: YACA_VERSION,
      protocol: { major: 1, minor: 0 },
      capabilities: [],
    }),
  );

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: "/",
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }

      return reply.code(404).send({ error: "not_found" });
    });
  }

  await app.listen({ host, port: options.port ?? 3210 });
  const address = app.server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    host,
    port: address.port,
    url,
    close: () => app.close(),
  };
}
