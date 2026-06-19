import { constants } from "node:fs";
import { chmod, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PersistenceError, persistenceError } from "./errors.js";

export type PersistenceOperation =
  | "read"
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync"
  | "quarantine-write"
  | "quarantine-directory-verified"
  | "quarantine-verified";

export type PersistenceFaultInjector = (operation: PersistenceOperation) => void | Promise<void>;

export interface PersistenceOptions<T> {
  faultInjector?: PersistenceFaultInjector;
  parse?: (value: unknown) => T;
}

export interface ResolvedTarget {
  directory: string;
  path: string;
}

export async function injectFault(
  injector: PersistenceFaultInjector | undefined,
  operation: PersistenceOperation,
): Promise<void> {
  await injector?.(operation);
}

export async function resolveTarget(requestedPath: string): Promise<ResolvedTarget> {
  try {
    const absolutePath = resolve(requestedPath);
    const directory = await realpath(dirname(absolutePath));
    await chmod(directory, 0o700);
    const path = join(directory, basename(absolutePath));
    await rejectSymbolicLink(path);
    return { directory, path };
  } catch (error) {
    throw persistenceError(error);
  }
}

export async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new PersistenceError("unsafe_symbolic_link");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function syncDirectory(
  directory: string,
  injector?: PersistenceFaultInjector,
): Promise<void> {
  await injectFault(injector, "directory-fsync");
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function serializeJson(value: unknown): Buffer {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new PersistenceError("invalid_json");
    return Buffer.from(serialized, "utf8");
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("invalid_json");
  }
}

export function parseJson<T>(bytes: Uint8Array, parse?: (value: unknown) => T): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return parse ? parse(value) : (value as T);
  } catch {
    throw new PersistenceError("invalid_json");
  }
}
