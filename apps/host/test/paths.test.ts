import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveYacaPaths } from "../src/paths.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("yaca persistence paths", () => {
  test("derive every runtime directory from an injected root", async () => {
    const root = await mkdtemp(join(tmpdir(), "yaca-paths-"));
    temporaryRoots.push(root);

    expect(resolveYacaPaths({ root })).toEqual({
      root,
      agent: join(root, "agent"),
      app: join(root, "app"),
      content: join(root, "content"),
      trash: join(root, "trash"),
      logs: join(root, "logs"),
      run: join(root, "run"),
      temporary: join(root, "tmp"),
    });
  });

  test("defaults to a .yaca directory below an injected home", async () => {
    const home = await mkdtemp(join(tmpdir(), "yaca-home-"));
    temporaryRoots.push(home);

    const paths = resolveYacaPaths({ home });

    expect(paths.root).toBe(join(home, ".yaca"));
    expect(Object.values(paths).every((path) => !path.includes(".pi"))).toBe(true);
  });
});
