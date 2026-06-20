import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  test("rejects an existing root with unsafe permissions without repairing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-root-existing-mode-"));
    temporaryRoots.push(parent);
    const requestedRoot = join(parent, "data");
    await mkdir(requestedRoot, { mode: 0o755 });
    await chmod(requestedRoot, 0o755);

    await expect(prepareYacaPaths({ root: requestedRoot })).rejects.toThrow();

    expect((await lstat(requestedRoot)).mode & 0o777).toBe(0o755);
    expect(await readdir(requestedRoot)).toEqual([]);
  });

  test("accepts an existing owner-only root and children", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-root-safe-mode-"));
    temporaryRoots.push(parent);
    const requestedRoot = join(parent, "data");
    await mkdir(requestedRoot, { mode: 0o700 });
    await chmod(requestedRoot, 0o700);

    const first = await prepareYacaPaths({ root: requestedRoot });
    const second = await prepareYacaPaths({ root: requestedRoot });

    expect(second).toEqual(first);
    await expect(
      Promise.all(Object.values(second).map(async (path) => (await stat(path)).mode & 0o777)),
    ).resolves.toEqual([0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700]);
  });

  test("rejects a hard-linked user file as the data root without changing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-root-hardlink-"));
    temporaryRoots.push(parent);
    const source = join(parent, "user-file");
    const requestedRoot = join(parent, "data");
    const original = Buffer.from("protected user bytes\n");
    await writeFile(source, original, { mode: 0o640 });
    await chmod(source, 0o640);
    await link(source, requestedRoot);
    const before = await lstat(source);

    await expect(prepareYacaPaths({ root: requestedRoot })).rejects.toThrow();

    const after = await lstat(source);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    await expect(readFile(source)).resolves.toEqual(original);
    await expect(readFile(requestedRoot)).resolves.toEqual(original);
  });

  test("rejects an unsafe existing child without repairing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-child-mode-"));
    temporaryRoots.push(parent);
    const requestedRoot = join(parent, "data");
    const app = join(requestedRoot, "app");
    await mkdir(requestedRoot, { mode: 0o700 });
    await mkdir(app, { mode: 0o755 });
    await chmod(requestedRoot, 0o700);
    await chmod(app, 0o755);

    await expect(prepareYacaPaths({ root: requestedRoot })).rejects.toThrow();

    expect((await lstat(app)).mode & 0o777).toBe(0o755);
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

  test("rejects the default .yaca leaf when it is a symbolic link", async () => {
    const home = await mkdtemp(join(tmpdir(), "yaca-home-link-"));
    temporaryRoots.push(home);
    const target = join(home, "redirected-data");
    await mkdir(target);
    await symlink(target, join(home, ".yaca"), "dir");

    await expect(prepareYacaPaths({ home })).rejects.toThrow(
      "yaca data root must not be a symbolic link",
    );
  });

  test("rejects a derived directory symlink that escapes the canonical root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yaca-path-escape-"));
    temporaryRoots.push(parent);
    const root = join(parent, "data");
    const escape = join(parent, "escape");
    await mkdir(root, { mode: 0o700 });
    await mkdir(escape);
    await chmod(root, 0o700);
    await symlink(escape, join(root, "run"), "dir");

    await expect(prepareYacaPaths({ root })).rejects.toThrow("escapes the yaca root");
    expect(await readdir(escape)).toEqual([]);
  });
});
