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

export type YacaPathErrorCode = "io_failure" | "unsafe_directory";

export class YacaPathError extends Error {
  readonly code: YacaPathErrorCode;

  constructor(code: YacaPathErrorCode, message?: string) {
    super(message ?? "yaca path preparation failed");
    this.name = "YacaPathError";
    this.code = code;
  }
}

export type YacaPathOperation =
  | "directory-before-create"
  | "directory-created-bound"
  | "runtime-child-parent"
  | "directory-close";

export interface YacaPathFaultContext {
  readonly name: keyof YacaPaths | "root-parent";
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

interface AuthorityRecord {
  readonly name: YacaPathFaultContext["name"];
  readonly authority: VerifiedParent;
}

class AuthorityRegistry {
  readonly #injector: YacaPathFaultInjector | undefined;
  readonly #records: AuthorityRecord[] = [];

  constructor(injector?: YacaPathFaultInjector) {
    this.#injector = injector;
  }

  add(record: AuthorityRecord): void {
    this.#records.push(record);
  }

  replace(name: AuthorityRecord["name"], authority: VerifiedParent): void {
    const index = this.#records.findIndex((record) => record.name === name);
    if (index === -1) throw new YacaPathError("io_failure");
    const previous = this.#records[index]!;
    this.#records[index] = { ...previous, authority };
  }

  async verify(): Promise<void> {
    for (const record of this.#records) await verifyParent(record.authority);
  }

  async checkpoint(operation: YacaPathOperation, context: YacaPathFaultContext): Promise<void> {
    await this.verify();
    let callbackFailed = false;
    let callbackFailure: unknown;
    try {
      await this.#injector?.(operation, context);
    } catch (error) {
      callbackFailed = true;
      callbackFailure = error;
    }
    let verificationFailed = false;
    let verificationFailure: unknown;
    try {
      await this.verify();
    } catch (error) {
      verificationFailed = true;
      verificationFailure = error;
    }
    if (callbackFailed) throw callbackFailure;
    if (verificationFailed) throw verificationFailure;
  }

  async finish(primary?: YacaPathError): Promise<YacaPathError | undefined> {
    let failure = primary;
    for (const record of this.#records) {
      try {
        await this.checkpoint("directory-close", { name: record.name });
      } catch (error) {
        failure ??= yacaPathError(error);
      }
    }

    const closeResults = await Promise.allSettled(
      this.#records.map(({ authority }) => authority.handle.close()),
    );
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (closeFailure) failure ??= yacaPathError(closeFailure.reason);

    const auditResults = await Promise.allSettled(
      this.#records.map((record) => auditAuthority(record.authority)),
    );
    const auditFailure = auditResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (auditFailure) failure ??= yacaPathError(auditFailure.reason);
    return failure;
  }
}

function assertContained(root: string, candidate: string, name: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new YacaPathError("unsafe_directory", `${name} path escapes the yaca root`);
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

async function createMissingDirectory(
  requestedPath: string,
  expectedCanonicalPath: string,
  name: string,
  root: boolean,
  contextName: keyof YacaPaths,
  parent: VerifiedParent,
  registry: AuthorityRegistry,
): Promise<CreatedDirectory> {
  await registry.verify();
  await verifyMissingDirectory(requestedPath, name, root, parent);
  await registry.checkpoint("directory-before-create", { name: contextName });
  await verifyMissingDirectory(requestedPath, name, root, parent);
  try {
    await mkdir(requestedPath, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw unsafeDirectoryError(name, root);
    }
    throw error;
  }

  // Node has no descriptor-relative mkdir. No visible checkpoint is exposed
  // between direct creation and this first descriptor/path identity binding.
  const pathBefore = await lstat(requestedPath, { bigint: true });
  assertBindableDirectory(pathBefore, name, root);
  await verifyParent(parent);
  if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
    throw unsafeDirectoryError(name, root);
  }

  let handle: FileHandle | undefined;
  let registered = false;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorBefore = await handle.stat({ bigint: true });
    assertBindableDirectory(descriptorBefore, name, root);
    assertSameDirectory(pathBefore, descriptorBefore, name, root);
    await verifyCreatedDirectory(
      requestedPath,
      expectedCanonicalPath,
      name,
      root,
      parent,
      handle,
      descriptorBefore,
      false,
    );
    registry.add({
      name: contextName,
      authority: {
        identity: parentIdentity(expectedCanonicalPath, descriptorBefore),
        handle,
      },
    });
    registered = true;
    await registry.checkpoint("directory-created-bound", { name: contextName });
    if ((descriptorBefore.mode & 0o777n) !== BigInt(DIRECTORY_MODE)) {
      await handle.chmod(DIRECTORY_MODE);
    }
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
    const descriptorAfter = await handle.stat({ bigint: true });
    assertPrivateDirectory(descriptorAfter, name, root, true);
    assertSameDirectory(descriptorBefore, descriptorAfter, name, root);
    const authority = {
      identity: parentIdentity(expectedCanonicalPath, descriptorAfter),
      handle,
    };
    registry.replace(contextName, authority);
    await registry.verify();
    handle = undefined;
    return { canonicalPath: expectedCanonicalPath, authority };
  } finally {
    if (!registered) await handle?.close();
  }
}

async function verifyMissingDirectory(
  requestedPath: string,
  name: string,
  root: boolean,
  parent: VerifiedParent,
): Promise<void> {
  await verifyParent(parent);
  try {
    await lstat(requestedPath);
    throw unsafeDirectoryError(name, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await verifyParent(parent);
}

async function openVerifiedParent(path: string): Promise<VerifiedParent> {
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) throw new YacaPathError("unsafe_directory");
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
    throw new YacaPathError("unsafe_directory");
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
    throw new YacaPathError("unsafe_directory");
  }
}

function assertOwnedDirectory(stat: BigIntStats): void {
  const owner = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (owner !== undefined && stat.uid !== BigInt(owner))
  ) {
    throw new YacaPathError("unsafe_directory");
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
  if (requireMode) assertPrivateDirectory(descriptor, name, root, true);
  else assertBindableDirectory(descriptor, name, root);
  assertSameDirectory(expected, descriptor, name, root);
  const pathStat = await lstat(requestedPath, { bigint: true });
  if (requireMode) assertPrivateDirectory(pathStat, name, root, true);
  else assertBindableDirectory(pathStat, name, root);
  assertSameDirectory(descriptor, pathStat, name, root);
  if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
    throw unsafeDirectoryError(name, root);
  }
  await verifyParent(parent);
}

function assertBindableDirectory(stat: BigIntStats, name: string, root: boolean): void {
  assertPrivateDirectory(stat, name, root, false);
  if ((stat.mode & 0o077n) !== 0n) throw unsafeDirectoryError(name, root);
}

async function auditAuthority(expected: VerifiedParent): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      expected.identity.canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat({ bigint: true });
    assertParentIdentity(expected.identity, descriptor);
    if ((await realpath(expected.identity.canonicalPath)) !== expected.identity.canonicalPath) {
      throw new YacaPathError("unsafe_directory");
    }
    const pathStat = await lstat(expected.identity.canonicalPath, { bigint: true });
    assertParentIdentity(expected.identity, pathStat);
  } finally {
    await handle?.close();
  }
}

function yacaPathError(error: unknown): YacaPathError {
  return error instanceof YacaPathError ? error : new YacaPathError("io_failure");
}

function assertPrivateDirectory(
  stat: BigIntStats,
  name: string,
  root: boolean,
  requireMode: boolean,
): void {
  if (stat.isSymbolicLink()) {
    if (root) {
      throw new YacaPathError("unsafe_directory", "yaca data root must not be a symbolic link");
    }
    throw new YacaPathError("unsafe_directory", `${name} path escapes the yaca root`);
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
  return new YacaPathError(
    "unsafe_directory",
    root
      ? "yaca data root must be an owner-only directory"
      : `${name} path must be an owner-only directory`,
  );
}

export async function prepareYacaPaths(options: PrepareYacaPathsOptions = {}): Promise<YacaPaths> {
  const registry = new AuthorityRegistry(options.faultInjector);
  let preparedRoot: string | undefined;
  let preparedChildren: Array<readonly [keyof Omit<YacaPaths, "root">, string]> | undefined;
  let primary: YacaPathError | undefined;
  try {
    const requestedRoot = resolve(options.root ?? join(options.home ?? homedir(), ".yaca"));
    const canonicalParent = await realpath(dirname(requestedRoot));
    const expectedRoot = join(canonicalParent, basename(requestedRoot));
    const rootParent = await openVerifiedParent(canonicalParent);
    registry.add({ name: "root-parent", authority: rootParent });
    await registry.verify();
    const observedRoot = await observeDirectory(expectedRoot, expectedRoot, "root", true);
    let root: string;
    let rootAuthority: VerifiedParent;
    if (observedRoot.kind === "existing") {
      root = observedRoot.canonicalPath;
      rootAuthority = observedRoot.authority;
      registry.add({ name: "root", authority: rootAuthority });
      await registry.verify();
    } else {
      const createdRoot = await createMissingDirectory(
        expectedRoot,
        expectedRoot,
        "root",
        true,
        "root",
        rootParent,
        registry,
      );
      root = createdRoot.canonicalPath;
      rootAuthority = createdRoot.authority;
    }

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
    for (const [key, leaf] of definitions) {
      await registry.checkpoint("runtime-child-parent", { name: key });
      const requestedPath = join(root, leaf);
      const observation = await observeDirectory(requestedPath, requestedPath, leaf, false);
      let canonicalPath: string;
      if (observation.kind === "existing") {
        canonicalPath = observation.canonicalPath;
        registry.add({ name: key, authority: observation.authority });
      } else {
        const created = await createMissingDirectory(
          requestedPath,
          requestedPath,
          leaf,
          false,
          key,
          rootAuthority,
          registry,
        );
        canonicalPath = created.canonicalPath;
      }
      await registry.verify();
      assertContained(root, canonicalPath, leaf);
      prepared.push([key, canonicalPath]);
    }
    await registry.verify();
    preparedRoot = root;
    preparedChildren = prepared;
  } catch (error) {
    primary = yacaPathError(error);
  }
  const failure = await registry.finish(primary);
  if (failure) throw failure;
  if (!preparedRoot || !preparedChildren) throw new YacaPathError("io_failure");
  const paths = Object.fromEntries(preparedChildren) as Omit<YacaPaths, "root">;
  return { root: preparedRoot, ...paths };
}
