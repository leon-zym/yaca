import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PersistenceError, persistenceError } from "./errors.js";

export type PersistenceOperation =
  | "read"
  | "read-sized"
  | "append-open"
  | "write"
  | "file-fsync"
  | "temporary-create"
  | "temporary-cleanup"
  | "rename"
  | "directory-fsync"
  | "corrupt-tail-verified";

export interface PersistenceFaultContext {
  readonly byteLength?: number;
}

export type PersistenceFaultInjector = (
  operation: PersistenceOperation,
  context?: PersistenceFaultContext,
) => void | Promise<void>;

export interface PersistenceOptions<T> {
  faultInjector?: PersistenceFaultInjector;
  parse?: (value: unknown) => T;
}

export interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly user: bigint;
  readonly mode: bigint;
}

export interface ResolvedTarget {
  readonly directory: string;
  readonly path: string;
  readonly parent: DirectoryIdentity;
}

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly user: bigint;
  readonly links: bigint;
  readonly mode: bigint;
}

export type LeafState =
  | { readonly kind: "missing" }
  | { readonly kind: "existing"; readonly identity: FileIdentity };

export async function injectFault(
  injector: PersistenceFaultInjector | undefined,
  operation: PersistenceOperation,
  context?: PersistenceFaultContext,
): Promise<void> {
  await injector?.(operation, context);
}

export async function resolveReadOnlyTarget(requestedPath: string): Promise<ResolvedTarget> {
  try {
    const absolutePath = resolve(requestedPath);
    const requestedDirectory = dirname(absolutePath);
    const directory = await realpath(requestedDirectory);
    if (directory !== requestedDirectory) throw new PersistenceError("unsafe_symbolic_link");
    const path = join(directory, basename(absolutePath));
    await rejectSymbolicLink(path);
    const parent = await inspectDirectory(directory);
    return { directory, path, parent };
  } catch (error) {
    throw persistenceError(error);
  }
}

export async function openVerifiedDirectory(target: ResolvedTarget): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      target.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat({ bigint: true });
    assertDirectoryIdentity(target.parent, descriptor);
    await verifyDirectoryIdentity(target);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw persistenceError(error);
  }
}

export async function verifyDirectoryIdentity(target: ResolvedTarget): Promise<void> {
  const canonical = await realpath(target.directory);
  if (canonical !== target.parent.canonicalPath) throw new PersistenceError("io_failure");
  const pathStat = await lstat(target.directory, { bigint: true });
  assertDirectoryIdentity(target.parent, pathStat);
}

export async function verifyFilePath(
  target: ResolvedTarget,
  descriptor: BigIntStats,
): Promise<BigIntStats> {
  await verifyDirectoryIdentity(target);
  const canonical = await realpath(target.path);
  if (canonical !== target.path) throw new PersistenceError("unsafe_symbolic_link");
  const pathStat = await lstat(target.path, { bigint: true });
  assertSafeFile(pathStat, target.parent.device);
  if (pathStat.dev !== descriptor.dev || pathStat.ino !== descriptor.ino) {
    throw new PersistenceError("io_failure");
  }
  return pathStat;
}

export async function captureLeafState(target: ResolvedTarget): Promise<LeafState> {
  await verifyDirectoryIdentity(target);
  try {
    const pathStat = await lstat(target.path, { bigint: true });
    assertSafeFile(pathStat, target.parent.device);
    await verifyFilePath(target, pathStat);
    return { kind: "existing", identity: fileIdentity(pathStat) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await verifyDirectoryIdentity(target);
    return { kind: "missing" };
  }
}

export async function verifyLeafState(target: ResolvedTarget, expected: LeafState): Promise<void> {
  await verifyDirectoryIdentity(target);
  let pathStat: BigIntStats;
  try {
    pathStat = await lstat(target.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && expected.kind === "missing") {
      await verifyDirectoryIdentity(target);
      return;
    }
    throw error;
  }
  if (expected.kind === "missing") throw new PersistenceError("io_failure");
  assertSafeFile(pathStat, target.parent.device);
  assertFileIdentity(expected.identity, pathStat);
  await verifyFilePath(target, pathStat);
}

export function assertFileIdentity(expected: FileIdentity, actual: BigIntStats): void {
  if (
    expected.device !== actual.dev ||
    expected.inode !== actual.ino ||
    expected.user !== actual.uid ||
    expected.links !== actual.nlink ||
    expected.mode !== (actual.mode & 0o777n)
  ) {
    throw new PersistenceError("io_failure");
  }
}

export function assertSafeFile(stat: BigIntStats, expectedDevice: bigint): void {
  const owner = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev !== expectedDevice ||
    stat.nlink !== 1n ||
    (stat.mode & 0o777n) !== 0o600n ||
    (owner !== undefined && stat.uid !== BigInt(owner))
  ) {
    throw new PersistenceError("io_failure");
  }
}

function fileIdentity(stat: BigIntStats): FileIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    user: stat.uid,
    links: stat.nlink,
    mode: stat.mode & 0o777n,
  };
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

export async function syncDirectoryHandle(
  handle: FileHandle,
  injector?: PersistenceFaultInjector,
): Promise<void> {
  await injectFault(injector, "directory-fsync");
  await handle.sync();
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

async function inspectDirectory(directory: string): Promise<DirectoryIdentity> {
  let handle: FileHandle | undefined;
  try {
    const pathBefore = await lstat(directory, { bigint: true });
    assertSafeDirectory(pathBefore);
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat({ bigint: true });
    assertSameDirectory(pathBefore, descriptor);
    const pathAfter = await lstat(directory, { bigint: true });
    assertSameDirectory(descriptor, pathAfter);
    return {
      canonicalPath: directory,
      device: descriptor.dev,
      inode: descriptor.ino,
      user: descriptor.uid,
      mode: descriptor.mode & 0o777n,
    };
  } finally {
    await handle?.close();
  }
}

function assertSafeDirectory(stat: BigIntStats): void {
  const owner = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777n) !== 0o700n ||
    (owner !== undefined && stat.uid !== BigInt(owner))
  ) {
    throw new PersistenceError("io_failure");
  }
}

function assertSameDirectory(expected: BigIntStats, actual: BigIntStats): void {
  assertSafeDirectory(actual);
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.uid !== actual.uid ||
    (expected.mode & 0o777n) !== (actual.mode & 0o777n)
  ) {
    throw new PersistenceError("io_failure");
  }
}

function assertDirectoryIdentity(expected: DirectoryIdentity, actual: BigIntStats): void {
  assertSafeDirectory(actual);
  if (
    expected.device !== actual.dev ||
    expected.inode !== actual.ino ||
    expected.user !== actual.uid ||
    expected.mode !== (actual.mode & 0o777n)
  ) {
    throw new PersistenceError("io_failure");
  }
}
