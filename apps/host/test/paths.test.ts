import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
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

  test("rejects a parent replacement returned from the root create checkpoint", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-root-parent-swap-"));
    temporaryRoots.push(base);
    const parent = join(base, "parent");
    const originalParent = join(base, "original-parent");
    const external = join(base, "external");
    const requestedRoot = join(parent, "data");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o700);
    await mkdir(external, { mode: 0o700 });
    await chmod(external, 0o700);
    const externalBefore = await lstat(external);

    await expect(
      prepareYacaPaths({
        root: requestedRoot,
        faultInjector: async (operation, context) => {
          if (operation !== "directory-before-create" || context.name !== "root") return;
          await rename(parent, originalParent);
          await symlink(external, parent, "dir");
        },
      }),
    ).rejects.toThrow();

    const externalAfter = await lstat(external);
    expect(externalAfter.ino).toBe(externalBefore.ino);
    expect(externalAfter.mode).toBe(externalBefore.mode);
    expect(await readdir(external)).toEqual([]);
    expect(await readdir(originalParent)).toEqual([]);
  });

  test("rejects a newly created root replaced before descriptor verification", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-root-leaf-swap-"));
    temporaryRoots.push(base);
    const requestedRoot = join(base, "data");
    const createdRoot = join(base, "created-root");
    const userDirectory = join(base, "user-directory");
    const protectedFile = join(userDirectory, "protected.txt");
    const protectedBytes = Buffer.from("protected root bytes\n");
    await mkdir(userDirectory, { mode: 0o755 });
    await chmod(userDirectory, 0o755);
    await writeFile(protectedFile, protectedBytes, { mode: 0o640 });
    const userBefore = await lstat(userDirectory);
    const fileBefore = await lstat(protectedFile);
    let stagingPath: string | undefined;

    await expect(
      prepareYacaPaths({
        root: requestedRoot,
        faultInjector: async (operation, context) => {
          if (operation !== "directory-staging-bound" || context.name !== "root") return;
          const stagingName = (await readdir(base)).find((name) =>
            name.startsWith(".data.staging-"),
          );
          expect(stagingName).toBeDefined();
          stagingPath = join(base, stagingName!);
          expect((await lstat(stagingPath)).mode & 0o777).toBe(0o700);
          await rename(stagingPath, createdRoot);
          await rename(userDirectory, stagingPath);
        },
      }),
    ).rejects.toThrow();

    expect(stagingPath).toBeDefined();
    const userAfter = await lstat(stagingPath!);
    const fileAfter = await lstat(join(stagingPath!, "protected.txt"));
    expect(userAfter.ino).toBe(userBefore.ino);
    expect(userAfter.mode).toBe(userBefore.mode);
    expect(fileAfter.ino).toBe(fileBefore.ino);
    expect(fileAfter.mode).toBe(fileBefore.mode);
    await expect(readFile(join(stagingPath!, "protected.txt"))).resolves.toEqual(protectedBytes);
    expect(await readdir(createdRoot)).toEqual([]);
  });

  test("rejects a newly created child replaced before descriptor verification", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-child-leaf-swap-"));
    temporaryRoots.push(base);
    const requestedRoot = join(base, "data");
    const createdAgent = join(base, "created-agent");
    const userDirectory = join(base, "user-agent");
    const protectedFile = join(userDirectory, "protected.txt");
    const protectedBytes = Buffer.from("protected child bytes\n");
    await mkdir(userDirectory, { mode: 0o755 });
    await chmod(userDirectory, 0o755);
    await writeFile(protectedFile, protectedBytes, { mode: 0o640 });
    const userBefore = await lstat(userDirectory);
    const fileBefore = await lstat(protectedFile);
    let stagingPath: string | undefined;

    await expect(
      prepareYacaPaths({
        root: requestedRoot,
        faultInjector: async (operation, context) => {
          if (operation !== "directory-staging-bound" || context.name !== "agent") return;
          const stagingName = (await readdir(requestedRoot)).find((name) =>
            name.startsWith(".agent.staging-"),
          );
          expect(stagingName).toBeDefined();
          stagingPath = join(requestedRoot, stagingName!);
          expect((await lstat(stagingPath)).mode & 0o777).toBe(0o700);
          await rename(stagingPath, createdAgent);
          await rename(userDirectory, stagingPath);
        },
      }),
    ).rejects.toThrow();

    expect(stagingPath).toBeDefined();
    const userAfter = await lstat(stagingPath!);
    const fileAfter = await lstat(join(stagingPath!, "protected.txt"));
    expect(userAfter.ino).toBe(userBefore.ino);
    expect(userAfter.mode).toBe(userBefore.mode);
    expect(fileAfter.ino).toBe(fileBefore.ino);
    expect(fileAfter.mode).toBe(fileBefore.mode);
    await expect(readFile(join(stagingPath!, "protected.txt"))).resolves.toEqual(protectedBytes);
    expect(await readdir(createdAgent)).toEqual([]);
  });

  test.each([
    { swapAt: "agent" as const, originalChildren: [] },
    { swapAt: "app" as const, originalChildren: ["agent"] },
  ])(
    "keeps one root authority when replacement occurs before $swapAt preparation",
    async ({ swapAt, originalChildren }) => {
      const base = await mkdtemp(join(tmpdir(), "yaca-runtime-root-swap-"));
      temporaryRoots.push(base);
      const requestedRoot = join(base, "data");
      const originalRoot = join(base, "original-root");
      const replacementRoot = join(base, "replacement-root");
      const protectedFile = join(replacementRoot, "protected.txt");
      const protectedBytes = Buffer.from("protected runtime root bytes\n");
      await mkdir(replacementRoot, { mode: 0o700 });
      await chmod(replacementRoot, 0o700);
      await writeFile(protectedFile, protectedBytes, { mode: 0o600 });
      const replacementBefore = await lstat(replacementRoot);
      const protectedBefore = await lstat(protectedFile);
      let swapped = false;

      await expect(
        prepareYacaPaths({
          root: requestedRoot,
          faultInjector: async (operation, context) => {
            if (operation !== "runtime-child-parent" || context.name !== swapAt || swapped) return;
            swapped = true;
            await rename(requestedRoot, originalRoot);
            await rename(replacementRoot, requestedRoot);
          },
        }),
      ).rejects.toThrow();

      const replacementAfter = await lstat(requestedRoot);
      const protectedAfter = await lstat(join(requestedRoot, "protected.txt"));
      expect(replacementAfter.ino).toBe(replacementBefore.ino);
      expect(replacementAfter.mode).toBe(replacementBefore.mode);
      expect(protectedAfter.ino).toBe(protectedBefore.ino);
      expect(protectedAfter.mode).toBe(protectedBefore.mode);
      await expect(readFile(join(requestedRoot, "protected.txt"))).resolves.toEqual(protectedBytes);
      expect(await readdir(requestedRoot)).toEqual(["protected.txt"]);
      expect(await readdir(originalRoot)).toEqual(originalChildren);
    },
  );

  test("revalidates an earlier child at every later runtime checkpoint", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-runtime-child-swap-"));
    temporaryRoots.push(base);
    const requestedRoot = join(base, "data");
    const originalAgent = join(base, "original-agent");
    const replacementAgent = join(base, "replacement-agent");
    const protectedFile = join(replacementAgent, "protected.txt");
    const protectedBytes = Buffer.from("protected earlier child bytes\n");
    await mkdir(replacementAgent, { mode: 0o700 });
    await writeFile(protectedFile, protectedBytes, { mode: 0o600 });
    const replacementBefore = await lstat(replacementAgent);
    const protectedBefore = await lstat(protectedFile);

    await expect(
      prepareYacaPaths({
        root: requestedRoot,
        faultInjector: async (operation, context) => {
          if (operation !== "runtime-child-parent" || context.name !== "app") return;
          await rename(join(requestedRoot, "agent"), originalAgent);
          await rename(replacementAgent, join(requestedRoot, "agent"));
        },
      }),
    ).rejects.toThrow();

    const visibleAgent = join(requestedRoot, "agent");
    const replacementAfter = await lstat(visibleAgent);
    const protectedAfter = await lstat(join(visibleAgent, "protected.txt"));
    expect(replacementAfter.ino).toBe(replacementBefore.ino);
    expect(replacementAfter.mode).toBe(replacementBefore.mode);
    expect(protectedAfter.ino).toBe(protectedBefore.ino);
    expect(protectedAfter.mode).toBe(protectedBefore.mode);
    await expect(readFile(join(visibleAgent, "protected.txt"))).resolves.toEqual(protectedBytes);
    expect(await readdir(originalAgent)).toEqual([]);
  });

  test("rejects a target installed before staging commit without changing it", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-runtime-target-swap-"));
    temporaryRoots.push(base);
    const requestedRoot = join(base, "data");
    const target = join(requestedRoot, "agent");
    const protectedBytes = Buffer.from("protected target bytes\n");
    let targetBefore: Awaited<ReturnType<typeof lstat>> | undefined;

    await expect(
      prepareYacaPaths({
        root: requestedRoot,
        faultInjector: async (operation, context) => {
          if (operation !== "directory-before-commit" || context.name !== "agent") return;
          await mkdir(target, { mode: 0o755 });
          await chmod(target, 0o755);
          await writeFile(join(target, "protected.txt"), protectedBytes, { mode: 0o640 });
          targetBefore = await lstat(target);
        },
      }),
    ).rejects.toThrow();

    expect(targetBefore).toBeDefined();
    const targetAfter = await lstat(target);
    expect(targetAfter.ino).toBe(targetBefore!.ino);
    expect(targetAfter.mode).toBe(targetBefore!.mode);
    await expect(readFile(join(target, "protected.txt"))).resolves.toEqual(protectedBytes);
    expect(await readdir(target)).toEqual(["protected.txt"]);
    const retainedStaging = (await readdir(requestedRoot)).find((name) =>
      name.startsWith(".agent.staging-"),
    );
    expect(retainedStaging).toBeDefined();
    expect((await lstat(join(requestedRoot, retainedStaging!))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(requestedRoot, retainedStaging!))).toEqual([]);
  });

  test("attempts every authority close when one injected close fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-runtime-close-"));
    temporaryRoots.push(base);
    const closed: string[] = [];

    await expect(
      prepareYacaPaths({
        root: join(base, "data"),
        faultInjector: (operation, context) => {
          if (operation !== "directory-close") return;
          closed.push(context.name);
          if (context.name === "root") throw new Error("injected root close failure");
        },
      }),
    ).rejects.toThrow("injected root close failure");

    expect(closed.sort()).toEqual(
      [
        "root-parent",
        "root",
        "agent",
        "app",
        "content",
        "trash",
        "logs",
        "run",
        "temporary",
      ].sort(),
    );
  });

  test("prepares a fresh tree under a restrictive umask", async () => {
    const base = await mkdtemp(join(tmpdir(), "yaca-runtime-umask-"));
    temporaryRoots.push(base);
    const previousUmask = process.umask(0o077);
    try {
      const paths = await prepareYacaPaths({ root: join(base, "data") });
      await expect(
        Promise.all(Object.values(paths).map(async (path) => (await stat(path)).mode & 0o777)),
      ).resolves.toEqual([0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700]);
    } finally {
      process.umask(previousUmask);
    }
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
