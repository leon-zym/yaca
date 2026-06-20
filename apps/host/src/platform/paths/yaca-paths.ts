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
}

type DirectoryObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "existing"; readonly canonicalPath: string };

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
    return { kind: "existing", canonicalPath };
  } finally {
    await handle?.close();
  }
}

async function createPrivateDirectory(
  requestedPath: string,
  expectedCanonicalPath: string,
  name: string,
  root: boolean,
): Promise<string> {
  try {
    await mkdir(requestedPath, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw unsafeDirectoryError(name, root);
    }
    throw error;
  }

  const pathBefore = await lstat(requestedPath, { bigint: true });
  assertPrivateDirectory(pathBefore, name, root, false);
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
    assertPrivateDirectory(descriptorBefore, name, root, false);
    assertSameDirectory(pathBefore, descriptorBefore, name, root);
    await handle.chmod(DIRECTORY_MODE);
    const descriptorAfter = await handle.stat({ bigint: true });
    assertPrivateDirectory(descriptorAfter, name, root, true);
    assertSameDirectory(descriptorBefore, descriptorAfter, name, root);
    const pathAfter = await lstat(requestedPath, { bigint: true });
    assertPrivateDirectory(pathAfter, name, root, true);
    assertSameDirectory(descriptorAfter, pathAfter, name, root);
    if ((await realpath(requestedPath)) !== expectedCanonicalPath) {
      throw unsafeDirectoryError(name, root);
    }
    return expectedCanonicalPath;
  } finally {
    await handle?.close();
  }
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
  const observedRoot = await observeDirectory(requestedRoot, expectedRoot, "root", true);
  const root =
    observedRoot.kind === "existing"
      ? observedRoot.canonicalPath
      : await createPrivateDirectory(requestedRoot, expectedRoot, "root", true);

  const definitions = [
    ["agent", "agent"],
    ["app", "app"],
    ["content", "content"],
    ["trash", "trash"],
    ["logs", "logs"],
    ["run", "run"],
    ["temporary", "tmp"],
  ] as const;
  const observations = await Promise.all(
    definitions.map(async ([key, leaf]) => {
      const requestedPath = join(root, leaf);
      const observation = await observeDirectory(requestedPath, requestedPath, leaf, false);
      return { key, leaf, requestedPath, observation };
    }),
  );
  const prepared = await Promise.all(
    observations.map(async ({ key, leaf, requestedPath, observation }) => {
      const canonicalPath =
        observation.kind === "existing"
          ? observation.canonicalPath
          : await createPrivateDirectory(requestedPath, requestedPath, leaf, false);
      assertContained(root, canonicalPath, leaf);
      return [key, canonicalPath] as const;
    }),
  );
  const paths = Object.fromEntries(prepared) as Omit<YacaPaths, "root">;
  return { root, ...paths };
}
