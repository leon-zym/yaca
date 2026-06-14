import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import type { YacaPaths } from "./paths.js";

const AUTHORITY_PORT_BASE = 49_152;
const AUTHORITY_PORT_COUNT = 1_024;
const LOOPBACK_HOST = "127.0.0.1";

interface AuthorityMetadata {
  pid: number;
  instance: string;
  authorityPort: number;
  startedAt: string;
}

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

async function writeMetadata(paths: YacaPaths, metadata: AuthorityMetadata): Promise<void> {
  const metadataPath = join(paths.run, "host.lock");
  const temporaryPath = join(paths.run, `.host.lock-${metadata.instance}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, metadataPath);
    } catch (error) {
      if (
        !["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw error;
      }
      await rm(metadataPath, { force: true, recursive: true });
      await rename(temporaryPath, metadataPath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeOwnMetadata(paths: YacaPaths, instance: string): Promise<void> {
  const metadataPath = join(paths.run, "host.lock");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as AuthorityMetadata;
    if (metadata.instance === instance) await rm(metadataPath, { force: true });
  } catch {
    // Diagnostic metadata never participates in ownership or shutdown.
  }
}

export async function acquireAuthorityFence(paths: YacaPaths): Promise<AuthorityFence> {
  const port = authorityPortForRoot(paths.root);
  const instance = randomUUID();
  const server = await bindAuthorityPort(port);

  try {
    await writeMetadata(paths, {
      pid: process.pid,
      instance,
      authorityPort: port,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let released = false;
  return {
    port,
    release: async () => {
      if (released) return;
      released = true;
      await removeOwnMetadata(paths, instance);
      await closeServer(server);
    },
  };
}
