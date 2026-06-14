import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";

import type { YacaPaths } from "./paths.js";

const AUTHORITY_PORT_BASE = 49_152;
const AUTHORITY_PORT_COUNT = 1_024;
const LOOPBACK_HOST = "127.0.0.1";

export interface AuthorityFence {
  port: number;
  release(): Promise<void>;
}

function authorityPortForRoot(root: string): number {
  const digest = createHash("sha256").update(root).digest();
  return AUTHORITY_PORT_BASE + (digest.readUInt32BE(0) % AUTHORITY_PORT_COUNT);
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

export async function acquireAuthorityFence(paths: YacaPaths): Promise<AuthorityFence> {
  const port = authorityPortForRoot(paths.root);
  const server = await bindAuthorityPort(port);

  let released = false;
  return {
    port,
    release: async () => {
      if (released) return;
      released = true;
      await closeServer(server);
    },
  };
}
