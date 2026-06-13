import { mkdtemp, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareYacaPaths } from "@yaca/host";
import { afterEach, describe, expect, test } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("yaca persistence paths", () => {
  test("creates and canonicalizes every runtime directory below an injected root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-paths-"));
    temporaryRoots.push(parent);
    const requestedRoot = join(parent, "data");
    const root = await realpath(parent).then((canonicalParent) => join(canonicalParent, "data"));

    expect(await prepareYacaPaths({ root: requestedRoot })).toEqual({
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

    const paths = await prepareYacaPaths({ home });

    expect(paths.root).toBe(await realpath(join(home, ".yaca")));
    expect(Object.values(paths).every((path) => !path.includes(".pi"))).toBe(true);
  });

  test("creates a missing yaca data root with owner-only permissions", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-root-mode-"));
    temporaryRoots.push(parent);
    const requestedRoot = join(parent, "data");

    const paths = await prepareYacaPaths({ root: requestedRoot });

    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
  });

  test("rejects a yaca data root whose leaf is a symbolic link", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-root-link-"));
    temporaryRoots.push(parent);
    const target = join(parent, "canonical");
    const linkedRoot = join(parent, "linked");
    await mkdir(target);
    await symlink(target, linkedRoot, "dir");

    await expect(prepareYacaPaths({ root: linkedRoot })).rejects.toThrow(
      "yaca data root must not be a symbolic link",
    );
    expect(await readdir(target)).toEqual([]);
  });

  test("rejects a derived directory symlink that escapes the canonical root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-path-escape-"));
    temporaryRoots.push(parent);
    const root = join(parent, "data");
    const escape = join(parent, "escape");
    await mkdir(root);
    await mkdir(escape);
    await symlink(escape, join(root, "run"), "dir");

    await expect(prepareYacaPaths({ root })).rejects.toThrow("escapes the yaca root");
    expect(await readdir(escape)).toEqual([]);
  });
});
