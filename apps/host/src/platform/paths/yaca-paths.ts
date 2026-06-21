import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;

export interface YacaPaths {
  root: string;
  agent: string;
  app: string;
  content: string;
  trash: string;
  logs: string;
  run: string;
  temporary: string;
}

export interface PrepareYacaPathsOptions {
  root?: string;
  home?: string;
  faultInjector?: YacaPathFaultInjector;
}

export type YacaPathOperation =
  | "directory-before-create"
  | "directory-created"
  | "runtime-child-parent";

export interface YacaPathFaultContext {
  readonly name: keyof YacaPaths;
}

export type YacaPathFaultInjector = (
  operation: YacaPathOperation,
  context: YacaPathFaultContext,
) => void | Promise<void>;

type DirectoryObservation =
  | { readonly kind: "missing" }
  | {
      readonly kind: "existing";
      readonly canonicalPath: string;
      readonly authority: VerifiedParent;
    };

interface CreatedDirectory {
  readonly canonicalPath: string;
  readonly authority: VerifiedParent;
}

interface ParentIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly user: bigint;
  readonly mode: bigint;
}

interface VerifiedParent {
  readonly identity: ParentIdentity;
  readonly handle: FileHandle;
}

function assertContained(root: string, candidate: string, name: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${name} path escapes the yaca root`);
  }
}

async function observeDirectory(
  requestedPath: string,
  expectedCanonicalPath: string,
  name: string,
  root: boolean,
): Promise<DirectoryObservation> {
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(requestedPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  assertPrivateDirectory(pathBefore, name, root, true);
  const canonicalPath = await realpath(requestedPath);
  if (canonicalPath !== expectedCanonicalPath) throw unsafeDirectoryError(name, root);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat({ bigint: true });
    assertPrivateDirectory(descriptor, name, root, true);
    assertSameDirectory(pathBefore, descriptor, name, root);
    const pathAfter = await lstat(requestedPath, { bigint: true });
    assertPrivateDirectory(pathAfter, name, root, true);
    assertSameDirectory(descriptor, pathAfter, name, root);
    if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
      throw unsafeDirectoryError(name, root);
    }
    const authority = {
      identity: parentIdentity(canonicalPath, descriptor),
      handle,
    };
    handle = undefined;
    return { kind: "existing", canonicalPath, authority };
  } finally {
    await handle?.close();
  }
}

async function createPrivateDirectory(
  requestedPath: string,
  expectedCanonicalPath: string,
  name: string,
  root: boolean,
  contextName: keyof YacaPaths,
  parent: VerifiedParent,
  injector?: YacaPathFaultInjector,
): Promise<CreatedDirectory> {
  await verifyParent(parent);
  await injector?.("directory-before-create", { name: contextName });
  // ADR-0005 records Node's missing descriptor-relative mkdir. This final
  // identity check rejects every visible parent replacement before mkdir;
  // only an active same-UID check-to-syscall race remains out of scope.
  await verifyParent(parent);
  try {
    await mkdir(requestedPath, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw unsafeDirectoryError(name, root);
    }
    throw error;
  }

  const pathBefore = await lstat(requestedPath, { bigint: true });
  assertPrivateDirectory(pathBefore, name, root, true);
  await verifyParent(parent);
  if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
    throw unsafeDirectoryError(name, root);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorBefore = await handle.stat({ bigint: true });
    assertPrivateDirectory(descriptorBefore, name, root, true);
    assertSameDirectory(pathBefore, descriptorBefore, name, root);
    await verifyCreatedDirectory(
      requestedPath,
      expectedCanonicalPath,
      name,
      root,
      parent,
      handle,
      descriptorBefore,
      true,
    );
    await injector?.("directory-created", { name: contextName });
    await verifyCreatedDirectory(
      requestedPath,
      expectedCanonicalPath,
      name,
      root,
      parent,
      handle,
      descriptorBefore,
      true,
    );
    const authority = {
      identity: parentIdentity(expectedCanonicalPath, descriptorBefore),
      handle,
    };
    handle = undefined;
    return { canonicalPath: expectedCanonicalPath, authority };
  } finally {
    await handle?.close();
  }
}

async function openVerifiedParent(path: string): Promise<VerifiedParent> {
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) throw new Error("yaca parent directory is unsafe");
  const pathBefore = await lstat(path, { bigint: true });
  assertOwnedDirectory(pathBefore);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat({ bigint: true });
    assertOwnedDirectory(descriptor);
    const identity = parentIdentity(canonicalPath, descriptor);
    assertParentIdentity(identity, pathBefore);
    const parent = { identity, handle };
    await verifyParent(parent);
    return parent;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

function parentIdentity(canonicalPath: string, descriptor: BigIntStats): ParentIdentity {
  return {
    canonicalPath,
    device: descriptor.dev,
    inode: descriptor.ino,
    user: descriptor.uid,
    mode: descriptor.mode & 0o777n,
  };
}

async function verifyParent(parent: VerifiedParent): Promise<void> {
  const descriptor = await parent.handle.stat({ bigint: true });
  assertParentIdentity(parent.identity, descriptor);
  if ((await realpath(parent.identity.canonicalPath)) !== parent.identity.canonicalPath) {
    throw new Error("yaca parent directory is unsafe");
  }
  const pathStat = await lstat(parent.identity.canonicalPath, { bigint: true });
  assertParentIdentity(parent.identity, pathStat);
}

function assertParentIdentity(expected: ParentIdentity, actual: BigIntStats): void {
  assertOwnedDirectory(actual);
  if (
    expected.device !== actual.dev ||
    expected.inode !== actual.ino ||
    expected.user !== actual.uid ||
    expected.mode !== (actual.mode & 0o777n)
  ) {
    throw new Error("yaca parent directory is unsafe");
  }
}

function assertOwnedDirectory(stat: BigIntStats): void {
  const owner = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (owner !== undefined && stat.uid !== BigInt(owner))
  ) {
    throw new Error("yaca parent directory is unsafe");
  }
}

async function verifyCreatedDirectory(
  requestedPath: string,
  expectedCanonicalPath: string,
  name: string,
  root: boolean,
  parent: VerifiedParent,
  handle: FileHandle,
  expected: BigIntStats,
  requireMode: boolean,
): Promise<void> {
  await verifyParent(parent);
  const descriptor = await handle.stat({ bigint: true });
  assertPrivateDirectory(descriptor, name, root, requireMode);
  assertSameDirectory(expected, descriptor, name, root);
  const pathStat = await lstat(requestedPath, { bigint: true });
  assertPrivateDirectory(pathStat, name, root, requireMode);
  assertSameDirectory(descriptor, pathStat, name, root);
  if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
    throw unsafeDirectoryError(name, root);
  }
  await verifyParent(parent);
}

function assertPrivateDirectory(
  stat: BigIntStats,
  name: string,
  root: boolean,
  requireMode: boolean,
): void {
  if (stat.isSymbolicLink()) {
    if (root) throw new Error("yaca data root must not be a symbolic link");
    throw new Error(`${name} path escapes the yaca root`);
  }
  const owner = process.getuid?.();
  if (
    !stat.isDirectory() ||
    (owner !== undefined && stat.uid !== BigInt(owner)) ||
    (requireMode && (stat.mode & 0o777n) !== BigInt(DIRECTORY_MODE))
  ) {
    throw unsafeDirectoryError(name, root);
  }
}

function assertSameDirectory(
  expected: BigIntStats,
  actual: BigIntStats,
  name: string,
  root: boolean,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.uid !== actual.uid) {
    throw unsafeDirectoryError(name, root);
  }
}

function unsafeDirectoryError(name: string, root: boolean): Error {
  return new Error(
    root
      ? "yaca data root must be an owner-only directory"
      : `${name} path must be an owner-only directory`,
  );
}

export async function prepareYacaPaths(options: PrepareYacaPathsOptions = {}): Promise<YacaPaths> {
  const requestedRoot = resolve(options.root ?? join(options.home ?? homedir(), ".yaca"));
  const canonicalParent = await realpath(dirname(requestedRoot));
  const expectedRoot = join(canonicalParent, basename(requestedRoot));
  const rootParent = await openVerifiedParent(canonicalParent);
  let root: string;
  let rootAuthority: VerifiedParent | undefined;
  try {
    await verifyParent(rootParent);
    const observedRoot = await observeDirectory(expectedRoot, expectedRoot, "root", true);
    if (observedRoot.kind === "existing") {
      root = observedRoot.canonicalPath;
      rootAuthority = observedRoot.authority;
      await verifyParent(rootParent);
    } else {
      const createdRoot = await createPrivateDirectory(
        expectedRoot,
        expectedRoot,
        "root",
        true,
        "root",
        rootParent,
        options.faultInjector,
      );
      root = createdRoot.canonicalPath;
      rootAuthority = createdRoot.authority;
    }
  } catch (error) {
    await rootAuthority?.handle.close().catch(() => undefined);
    throw error;
  } finally {
    await rootParent.handle.close();
  }
  if (!rootAuthority) throw new Error("yaca data root authority was not established");

  const definitions = [
    ["agent", "agent"],
    ["app", "app"],
    ["content", "content"],
    ["trash", "trash"],
    ["logs", "logs"],
    ["run", "run"],
    ["temporary", "tmp"],
  ] as const;
  const prepared: Array<readonly [keyof Omit<YacaPaths, "root">, string]> = [];
  try {
    for (const [key, leaf] of definitions) {
      await options.faultInjector?.("runtime-child-parent", { name: key });
      await verifyParent(rootAuthority);
      const requestedPath = join(root, leaf);
      const observation = await observeDirectory(requestedPath, requestedPath, leaf, false);
      let canonicalPath: string;
      if (observation.kind === "existing") {
        try {
          await verifyParent(rootAuthority);
          canonicalPath = observation.canonicalPath;
        } finally {
          await observation.authority.handle.close();
        }
      } else {
        await verifyParent(rootAuthority);
        const created = await createPrivateDirectory(
          requestedPath,
          requestedPath,
          leaf,
          false,
          key,
          rootAuthority,
          options.faultInjector,
        );
        canonicalPath = created.canonicalPath;
        await created.authority.handle.close();
      }
      await verifyParent(rootAuthority);
      assertContained(root, canonicalPath, leaf);
      prepared.push([key, canonicalPath]);
    }
    await verifyParent(rootAuthority);
    const paths = Object.fromEntries(prepared) as Omit<YacaPaths, "root">;
    return { root, ...paths };
  } finally {
    await rootAuthority.handle.close();
  }
}
