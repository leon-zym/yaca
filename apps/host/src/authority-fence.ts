import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";

import type { YacaPaths } from "./paths.js";

const AUTHORITY_PORT_BASE = 49_152;
const AUTHORITY_PORT_COUNT = 16_384;
const LOOPBACK_HOST = "127.0.0.1";

export interface AuthorityFence {
  ports: [number, number];
  release(): Promise<void>;
}

function authorityPortsForRoot(root: string): [number, number] {
  const digest = createHash("sha256").update(root).digest();
  const first = AUTHORITY_PORT_BASE + (digest.readUInt32BE(0) % AUTHORITY_PORT_COUNT);
  let second = AUTHORITY_PORT_BASE + (digest.readUInt32BE(4) % AUTHORITY_PORT_COUNT);
  if (second === first) {
    second = AUTHORITY_PORT_BASE + ((second - AUTHORITY_PORT_BASE + 1) % AUTHORITY_PORT_COUNT);
  }
  return [first, second];
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

async function bindAuthorityPort(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolveListening, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen({ exclusive: true, host: LOOPBACK_HOST, port }, () => {
        server.off("error", onError);
        resolveListening();
      });
    });
    return server;
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`yaca authority port ${port} is already in use; refusing to start`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function closeAuthorityServers(servers: Server[]): Promise<void> {
  const errors: unknown[] = [];
  for (const server of servers.toReversed()) {
    try {
      await closeServer(server);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed to release yaca authority ports");
}

export async function acquireAuthorityFence(paths: YacaPaths): Promise<AuthorityFence> {
  const ports = authorityPortsForRoot(paths.root);
  const servers: Server[] = [];
  try {
    for (const port of ports) servers.push(await bindAuthorityPort(port));
  } catch (error) {
    try {
      await closeAuthorityServers(servers);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "failed to acquire and roll back yaca authority ports",
      );
    }
    throw error;
  }

  let released = false;
  return {
    ports,
    release: async () => {
      if (released) return;
      released = true;
      await closeAuthorityServers(servers);
    },
  };
}
