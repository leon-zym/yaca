import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

function assertContained(root: string, candidate: string, name: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${name} path escapes the yaca root`);
  }
}

async function prepareChild(root: string, name: string): Promise<string> {
  const requestedPath = join(root, name);
  await mkdir(requestedPath, { recursive: true });
  const canonicalPath = await realpath(requestedPath);
  assertContained(root, canonicalPath, name);
  return canonicalPath;
}

async function ensureRootDirectory(requestedRoot: string): Promise<void> {
  try {
    if ((await lstat(requestedRoot)).isSymbolicLink()) {
      throw new Error("yaca data root must not be a symbolic link");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(requestedRoot, { mode: 0o700, recursive: true });
  }

  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new Error("yaca data root must not be a symbolic link");
  }
}

export async function prepareYacaPaths(options: PrepareYacaPathsOptions = {}): Promise<YacaPaths> {
  const requestedRoot = resolve(options.root ?? join(options.home ?? homedir(), ".yaca"));
  await ensureRootDirectory(requestedRoot);
  const root = await realpath(requestedRoot);

  const [agent, app, content, trash, logs, run, temporary] = await Promise.all([
    prepareChild(root, "agent"),
    prepareChild(root, "app"),
    prepareChild(root, "content"),
    prepareChild(root, "trash"),
    prepareChild(root, "logs"),
    prepareChild(root, "run"),
    prepareChild(root, "tmp"),
  ]);

  return { root, agent, app, content, trash, logs, run, temporary };
}
