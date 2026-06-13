import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export interface ResolveYacaPathsOptions {
  root?: string;
  home?: string;
}

export function resolveYacaPaths(options: ResolveYacaPathsOptions = {}): YacaPaths {
  const root = resolve(options.root ?? join(options.home ?? homedir(), ".yaca"));

  return {
    root,
    agent: join(root, "agent"),
    app: join(root, "app"),
    content: join(root, "content"),
    trash: join(root, "trash"),
    logs: join(root, "logs"),
    run: join(root, "run"),
    temporary: join(root, "tmp"),
  };
}
