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
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicJsonFile,
  DurableJsonl,
  PersistenceError,
  type PersistenceOperation,
} from "@yaca/host";
import { afterEach, describe, expect, test } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  await chmod(directory, 0o700);
  return realpath(directory);
}

function failAt(target: PersistenceOperation): (operation: PersistenceOperation) => void {
  return (operation) => {
    if (operation === target) {
      throw Object.assign(new Error("injected system operation failure"), { code: "EIO" });
    }
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("AtomicJsonFile", () => {
  test("durably replaces JSON and reconstructs the value", async () => {
    const directory = await temporaryDirectory("yaca-atomic-json-");
    const target = join(directory, "state.json");
    const file = new AtomicJsonFile<{ revision: number; label: string }>(target);

    await expect(file.read()).resolves.toBeUndefined();
    await file.replace({ revision: 1, label: "old" });
    await file.replace({ revision: 2, label: "new" });

    await expect(file.read()).resolves.toEqual({ revision: 2, label: "new" });
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  test.each([
    ["write", "old"],
    ["file-fsync", "old"],
    ["rename", "old"],
    ["directory-fsync", "new"],
  ] satisfies ReadonlyArray<readonly [PersistenceOperation, string]>)(
    "leaves only a complete old or new value after a %s failure",
    async (operation, visibleLabel) => {
      const directory = await temporaryDirectory(`yaca-atomic-${operation}-`);
      const target = join(directory, "state.json");
      await new AtomicJsonFile<{ label: string }>(target).replace({ label: "old" });

      const failing = new AtomicJsonFile<{ label: string }>(target, {
        faultInjector: failAt(operation),
      });
      await expect(failing.replace({ label: "new" })).rejects.toMatchObject({
        code: "io_failure",
      });

      await expect(new AtomicJsonFile<{ label: string }>(target).read()).resolves.toEqual({
        label: visibleLabel,
      });
      expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    },
  );

  test("classifies cross-device rename without exposing the target path", async () => {
    const directory = await temporaryDirectory("yaca-atomic-exdev-");
    const target = join(directory, "private-state.json");
    const file = new AtomicJsonFile(target, {
      faultInjector: (operation) => {
        if (operation === "rename") {
          throw Object.assign(new Error(`rename leaked ${target}`), { code: "EXDEV" });
        }
      },
    });

    const failure = await file.replace({ revision: 1 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PersistenceError);
    expect(failure).toMatchObject({ code: "cross_device_rename" });
    expect((failure as Error).message).not.toContain(target);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("rejects a symbolic-link JSON file without changing its target", async () => {
    const directory = await temporaryDirectory("yaca-atomic-link-");
    const outside = join(directory, "outside.json");
    const linked = join(directory, "state.json");
    await writeFile(outside, '{"protected":true}\n');
    await symlink(outside, linked);

    await expect(new AtomicJsonFile(linked).replace({ protected: false })).rejects.toMatchObject({
      code: "unsafe_symbolic_link",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe('{"protected":true}\n');
  });

  test("does not rename an attacker temp over an external target after a parent swap", async () => {
    const root = await temporaryDirectory("yaca-atomic-parent-swap-");
    const stateDirectory = join(root, "state");
    const externalDirectory = join(root, "external");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(stateDirectory, "state.json");
    const externalTarget = join(externalDirectory, "state.json");
    const protectedBytes = Buffer.from('{"protected":true}\n');
    await writeFile(target, '{"revision":1}\n', { mode: 0o600 });
    await writeFile(externalTarget, protectedBytes, { mode: 0o600 });
    const externalBefore = await lstat(externalTarget);
    let swapped = false;
    const file = new AtomicJsonFile<{ revision: number }>(target, {
      faultInjector: async (operation) => {
        if (operation !== "rename" || swapped) return;
        swapped = true;
        const temporaryName = (await readdir(stateDirectory)).find((name) =>
          name.includes(".tmp-"),
        );
        expect(temporaryName).toBeDefined();
        await writeFile(join(externalDirectory, temporaryName!), '{"attacker":true}\n', {
          mode: 0o600,
        });
        await rename(stateDirectory, join(root, "original-state"));
        await symlink(externalDirectory, stateDirectory);
      },
    });

    await expect(file.replace({ revision: 2 })).rejects.toMatchObject({ code: "io_failure" });

    const externalAfter = await lstat(externalTarget);
    expect(externalAfter.ino).toBe(externalBefore.ino);
    expect(externalAfter.mode).toBe(externalBefore.mode);
    await expect(readFile(externalTarget)).resolves.toEqual(protectedBytes);
  });

  test("does not create a temp through a visibly swapped parent", async () => {
    const root = await temporaryDirectory("yaca-atomic-create-swap-");
    const stateDirectory = join(root, "state");
    const externalDirectory = join(root, "external");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(stateDirectory, "state.json");
    let swapped = false;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation !== "temporary-create" || swapped) return;
        swapped = true;
        await rename(stateDirectory, join(root, "original-state"));
        await symlink(externalDirectory, stateDirectory);
      },
    });

    await expect(file.replace({ revision: 1 })).rejects.toMatchObject({ code: "io_failure" });
    expect(await readdir(externalDirectory)).toEqual([]);
    expect(await readdir(join(root, "original-state"))).toEqual([]);
  });

  test.each(["write", "file-fsync"] as const)(
    "does not mutate a temporary moved at the %s checkpoint",
    async (checkpoint) => {
      const directory = await temporaryDirectory(`yaca-atomic-${checkpoint}-temp-`);
      const externalDirectory = await temporaryDirectory(`yaca-atomic-${checkpoint}-external-`);
      const target = join(directory, "state.json");
      let movedPath: string | undefined;
      let movedBefore: Awaited<ReturnType<typeof lstat>> | undefined;
      let movedBytes: Buffer | undefined;
      const file = new AtomicJsonFile(target, {
        faultInjector: async (operation) => {
          if (operation !== checkpoint || movedPath) return;
          const temporaryName = (await readdir(directory)).find((name) => name.includes(".tmp-"));
          expect(temporaryName).toBeDefined();
          movedPath = join(externalDirectory, temporaryName!);
          await rename(join(directory, temporaryName!), movedPath);
          movedBefore = await lstat(movedPath);
          movedBytes = await readFile(movedPath);
        },
      });

      const failure = await file.replace({ revision: 1 }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "io_failure",
        diagnostic: { kind: "retained_temporary" },
      });
      const movedAfter = await lstat(movedPath!);
      expect(movedAfter.ino).toBe(movedBefore!.ino);
      expect(movedAfter.mode).toBe(movedBefore!.mode);
      await expect(readFile(movedPath!)).resolves.toEqual(movedBytes);
    },
  );

  test("rejects a target replacement returned from the directory-fsync checkpoint", async () => {
    const directory = await temporaryDirectory("yaca-atomic-directory-target-");
    const target = join(directory, "state.json");
    const committedPath = join(directory, "committed-state.json");
    const protectedBytes = Buffer.from('{"protected":true}\n');
    await writeFile(target, '{"revision":0}\n', { mode: 0o600 });
    let replaced = false;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation !== "directory-fsync" || replaced) return;
        replaced = true;
        await rename(target, committedPath);
        await writeFile(target, protectedBytes, { mode: 0o600 });
      },
    });

    await expect(file.replace({ revision: 1 })).rejects.toMatchObject({ code: "io_failure" });

    await expect(readFile(target)).resolves.toEqual(protectedBytes);
    await expect(readFile(committedPath, "utf8")).resolves.toBe('{"revision":1}\n');
  });

  test("returns retained-temporary evidence when the first descriptor stat fails", async () => {
    const directory = await temporaryDirectory("yaca-atomic-first-stat-");
    const target = join(directory, "state.json");
    let temporaryName: string | undefined;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation !== "temporary-opened") return;
        temporaryName = (await readdir(directory)).find((name) => name.includes(".tmp-"));
        throw Object.assign(new Error("injected descriptor stat failure"), { code: "EIO" });
      },
    });

    const failure = await file.replace({ revision: 1 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "io_failure",
      diagnostic: { kind: "retained_temporary", id: expect.any(String) },
    });
    expect(JSON.stringify((failure as { diagnostic: unknown }).diagnostic)).not.toContain(
      directory,
    );
    expect(temporaryName).toBeDefined();
    const retained = join(directory, temporaryName!);
    expect((await lstat(retained)).mode & 0o777).toBe(0o600);
    expect((await lstat(retained)).size).toBe(0);
    await expect(new AtomicJsonFile(target).read()).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([temporaryName]);
  });

  test("rejects unsafe existing permissions without repairing the file or parent", async () => {
    const root = await temporaryDirectory("yaca-atomic-mode-");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o755 });
    const target = join(stateDirectory, "state.json");
    const original = Buffer.from('{"revision":1}\n');
    await writeFile(target, original, { mode: 0o644 });
    await chmod(stateDirectory, 0o755);
    await chmod(target, 0o644);

    await expect(new AtomicJsonFile(target).replace({ revision: 2 })).rejects.toMatchObject({
      code: "io_failure",
    });

    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o755);
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
    await expect(readFile(target)).resolves.toEqual(original);
  });

  test("does not repair an unsafe existing target in a private parent", async () => {
    const directory = await temporaryDirectory("yaca-atomic-file-mode-");
    const target = join(directory, "state.json");
    const original = Buffer.from('{"revision":1}\n');
    await writeFile(target, original, { mode: 0o644 });
    await chmod(target, 0o644);

    await expect(new AtomicJsonFile(target).replace({ revision: 2 })).rejects.toMatchObject({
      code: "io_failure",
    });

    expect((await lstat(target)).mode & 0o777).toBe(0o644);
    await expect(readFile(target)).resolves.toEqual(original);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("does not replace a user file that appears after an initially missing target", async () => {
    const directory = await temporaryDirectory("yaca-atomic-missing-leaf-");
    const target = join(directory, "state.json");
    const protectedBytes = Buffer.from('{"protected":true}\n');
    let installed = false;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation !== "rename" || installed) return;
        installed = true;
        await writeFile(target, protectedBytes, { mode: 0o600 });
      },
    });

    await expect(file.replace({ revision: 1 })).rejects.toMatchObject({ code: "io_failure" });

    await expect(readFile(target)).resolves.toEqual(protectedBytes);
  });

  test("does not replace a new inode substituted for the initial target", async () => {
    const directory = await temporaryDirectory("yaca-atomic-existing-leaf-");
    const target = join(directory, "state.json");
    const originalPath = join(directory, "original-state.json");
    const originalBytes = Buffer.from('{"revision":1}\n');
    const replacementBytes = Buffer.from('{"protected":true}\n');
    await writeFile(target, originalBytes, { mode: 0o600 });
    const originalBefore = await lstat(target);
    let replaced = false;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation !== "rename" || replaced) return;
        replaced = true;
        await rename(target, originalPath);
        await writeFile(target, replacementBytes, { mode: 0o600 });
      },
    });

    await expect(file.replace({ revision: 2 })).rejects.toMatchObject({ code: "io_failure" });

    expect((await lstat(originalPath)).ino).toBe(originalBefore.ino);
    await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
    await expect(readFile(target)).resolves.toEqual(replacementBytes);
  });

  test("does not unlink a replacement installed after temp cleanup validation", async () => {
    const directory = await temporaryDirectory("yaca-atomic-cleanup-leaf-");
    const externalDirectory = await temporaryDirectory("yaca-atomic-cleanup-external-");
    const target = join(directory, "state.json");
    const externalTarget = join(externalDirectory, "user-file.json");
    const protectedBytes = Buffer.from('{"protected":true}\n');
    await writeFile(externalTarget, protectedBytes, { mode: 0o600 });
    let writeFailed = false;
    let retainedPath: string | undefined;
    let replacementPath: string | undefined;
    let externalAfterInstall: Awaited<ReturnType<typeof lstat>> | undefined;
    const file = new AtomicJsonFile(target, {
      faultInjector: async (operation) => {
        if (operation === "write" && !writeFailed) {
          writeFailed = true;
          throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        }
        if (operation !== "temporary-cleanup" || retainedPath) return;
        const temporaryName = (await readdir(directory)).find((name) => name.includes(".tmp-"));
        expect(temporaryName).toBeDefined();
        replacementPath = join(directory, temporaryName!);
        retainedPath = join(directory, `${temporaryName}.retained`);
        await rename(replacementPath, retainedPath);
        await link(externalTarget, replacementPath);
        externalAfterInstall = await lstat(externalTarget);
      },
    });

    const failure = await file.replace({ revision: 1 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "io_failure",
      diagnostic: { kind: "retained_temporary" },
    });
    expect(JSON.stringify((failure as { diagnostic: unknown }).diagnostic)).not.toContain(
      directory,
    );
    await expect(readFile(replacementPath!)).resolves.toEqual(protectedBytes);
    expect((await lstat(replacementPath!)).mode & 0o777).toBe(0o600);
    expect((await lstat(retainedPath!)).mode & 0o777).toBe(0o600);
    const externalAfter = await lstat(externalTarget);
    expect(externalAfter.ino).toBe(externalAfterInstall!.ino);
    expect(externalAfter.mode).toBe(externalAfterInstall!.mode);
    expect(externalAfter.nlink).toBe(externalAfterInstall!.nlink);
    await expect(readFile(externalTarget)).resolves.toEqual(protectedBytes);

    await expect(new AtomicJsonFile(target).read()).resolves.toBeUndefined();
    await expect(readFile(retainedPath!)).resolves.toEqual(Buffer.alloc(0));
  });
});

describe("DurableJsonl", () => {
  test("serializes concurrent appends into an ordered, durable valid prefix", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-order-");
    const target = join(directory, "events.jsonl");
    const ledger = new DurableJsonl<{ sequence: number }>(target);

    await Promise.all(Array.from({ length: 24 }, (_, sequence) => ledger.append({ sequence })));

    await expect(ledger.readValidPrefix()).resolves.toMatchObject({
      records: Array.from({ length: 24 }, (_, sequence) => ({ sequence })),
      corruptTail: null,
    });
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  test("does not begin an append until an earlier read reaches its linearization point", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-read-barrier-");
    const target = join(directory, "events.jsonl");
    await writeFile(target, '{"sequence":0}\n', { mode: 0o600 });
    const readEntered = deferred();
    const releaseRead = deferred();
    let blockedFirstRead = false;
    let writeEntered = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "read" && !blockedFirstRead) {
          blockedFirstRead = true;
          readEntered.resolve();
          await releaseRead.promise;
        }
        if (operation === "write") writeEntered = true;
      },
    });

    const reading = ledger.readValidPrefix();
    await readEntered.promise;
    const appending = ledger.append({ sequence: 1 });
    await nextTurn();

    expect(writeEntered).toBe(false);
    releaseRead.resolve();
    await expect(reading).resolves.toMatchObject({ records: [{ sequence: 0 }] });
    await expect(appending).resolves.toBeUndefined();
    expect(writeEntered).toBe(true);
  });

  test("does not expose a written line before its fsync completes", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-fsync-barrier-");
    const target = join(directory, "events.jsonl");
    const fsyncEntered = deferred();
    const releaseFsync = deferred();
    let blockFirstFsync = true;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "file-fsync" && blockFirstFsync) {
          blockFirstFsync = false;
          fsyncEntered.resolve();
          await releaseFsync.promise;
        }
      },
    });

    const appending = ledger.append({ sequence: 1 });
    await fsyncEntered.promise;
    let readSettled = false;
    const reading = ledger.readValidPrefix().then((result) => {
      readSettled = true;
      return result;
    });
    await nextTurn();

    expect(readSettled).toBe(false);
    releaseFsync.resolve();
    await expect(appending).resolves.toBeUndefined();
    await expect(reading).resolves.toEqual({
      records: [{ sequence: 1 }],
      corruptTail: null,
    });
    expect(await readdir(directory)).toEqual(["events.jsonl"]);
  });

  test("does not open or modify an external ledger after its parent is swapped", async () => {
    const root = await temporaryDirectory("yaca-jsonl-append-parent-swap-");
    const journalDirectory = join(root, "journal");
    const externalDirectory = join(root, "external");
    await mkdir(journalDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(journalDirectory, "events.jsonl");
    const externalTarget = join(externalDirectory, "events.jsonl");
    await writeFile(target, '{"sequence":0}\n', { mode: 0o600 });
    const protectedBytes = Buffer.from('{"protected":true}\n');
    await writeFile(externalTarget, protectedBytes, { mode: 0o644 });
    const externalBefore = await lstat(externalTarget);
    let swapped = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation !== "append-open" || swapped) return;
        swapped = true;
        await rename(journalDirectory, join(root, "original-journal"));
        await symlink(externalDirectory, journalDirectory);
      },
    });
    await ledger.readValidPrefix();

    await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

    const externalAfter = await lstat(externalTarget);
    expect(externalAfter.ino).toBe(externalBefore.ino);
    expect(externalAfter.mode).toBe(externalBefore.mode);
    expect(externalAfter.size).toBe(externalBefore.size);
    await expect(readFile(externalTarget)).resolves.toEqual(protectedBytes);
  });

  test("rejects a parent replacement returned from the write checkpoint", async () => {
    const root = await temporaryDirectory("yaca-jsonl-append-fd-");
    const journalDirectory = join(root, "journal");
    const externalDirectory = join(root, "external");
    await mkdir(journalDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(journalDirectory, "events.jsonl");
    const externalTarget = join(externalDirectory, "events.jsonl");
    await writeFile(target, '{"sequence":0}\n', { mode: 0o600 });
    const protectedBytes = Buffer.from('{"protected":true}\n');
    await writeFile(externalTarget, protectedBytes, { mode: 0o600 });
    let swapped = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation !== "write" || swapped) return;
        swapped = true;
        await rename(journalDirectory, join(root, "original-journal"));
        await symlink(externalDirectory, journalDirectory);
      },
    });
    await ledger.readValidPrefix();

    await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

    await expect(readFile(join(root, "original-journal", "events.jsonl"), "utf8")).resolves.toBe(
      '{"sequence":0}\n',
    );
    await expect(readFile(externalTarget)).resolves.toEqual(protectedBytes);
    expect(ledger.status).toBe("degraded");
    await expect(ledger.append({ sequence: 2 })).rejects.toMatchObject({ code: "degraded" });
  });

  test.each(["file-fsync", "directory-fsync"] as const)(
    "rejects a canonical leaf replacement returned from the %s checkpoint",
    async (checkpoint) => {
      const directory = await temporaryDirectory(`yaca-jsonl-${checkpoint}-replacement-`);
      const target = join(directory, "events.jsonl");
      const originalPath = join(directory, "opened-events.jsonl");
      const replacementBytes = Buffer.from('{"protected":true}\n');
      await writeFile(target, '{"sequence":0}\n', { mode: 0o600 });
      let replaced = false;
      const ledger = new DurableJsonl<{ sequence: number }>(target, {
        faultInjector: async (operation) => {
          if (operation !== checkpoint || replaced) return;
          replaced = true;
          await rename(target, originalPath);
          await writeFile(target, replacementBytes, { mode: 0o600 });
        },
      });
      await ledger.readValidPrefix();

      await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

      const replacement = await lstat(target);
      expect(replacement.mode & 0o777).toBe(0o600);
      await expect(readFile(target)).resolves.toEqual(replacementBytes);
      await expect(readFile(originalPath, "utf8")).resolves.toBe(
        '{"sequence":0}\n{"sequence":1}\n',
      );
      expect(ledger.status).toBe("degraded");
    },
  );

  test("does not create a missing ledger through a visibly swapped parent", async () => {
    const root = await temporaryDirectory("yaca-jsonl-create-swap-");
    const journalDirectory = join(root, "journal");
    const externalDirectory = join(root, "external");
    await mkdir(journalDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(journalDirectory, "events.jsonl");
    let swapped = false;
    const ledger = new DurableJsonl(target, {
      faultInjector: async (operation) => {
        if (operation !== "append-open" || swapped) return;
        swapped = true;
        await rename(journalDirectory, join(root, "original-journal"));
        await symlink(externalDirectory, journalDirectory);
      },
    });

    await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

    expect(await readdir(externalDirectory)).toEqual([]);
    expect(await readdir(join(root, "original-journal"))).toEqual([]);
  });

  test("does not append to a user file that appears after a missing-ledger checkpoint", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-missing-leaf-");
    const target = join(directory, "events.jsonl");
    const protectedBytes = Buffer.from('{"protected":true}\n');
    let installed = false;
    const ledger = new DurableJsonl(target, {
      faultInjector: async (operation) => {
        if (operation !== "append-open" || installed) return;
        installed = true;
        await writeFile(target, protectedBytes, { mode: 0o600 });
      },
    });

    await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

    const after = await lstat(target);
    expect(after.mode & 0o777).toBe(0o600);
    await expect(readFile(target)).resolves.toEqual(protectedBytes);
  });

  test("does not append to a replacement of the initially observed ledger", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-existing-leaf-");
    const target = join(directory, "events.jsonl");
    const originalPath = join(directory, "original-events.jsonl");
    const originalBytes = Buffer.from('{"sequence":0}\n');
    const replacementBytes = Buffer.from('{"protected":true}\n');
    await writeFile(target, originalBytes, { mode: 0o600 });
    const originalBefore = await lstat(target);
    let replaced = false;
    const ledger = new DurableJsonl(target, {
      faultInjector: async (operation) => {
        if (operation !== "append-open" || replaced) return;
        replaced = true;
        await rename(target, originalPath);
        await writeFile(target, replacementBytes, { mode: 0o600 });
      },
    });
    await ledger.readValidPrefix();

    await expect(ledger.append({ sequence: 1 })).rejects.toMatchObject({ code: "io_failure" });

    expect((await lstat(originalPath)).ino).toBe(originalBefore.ino);
    await expect(readFile(originalPath)).resolves.toEqual(originalBytes);
    await expect(readFile(target)).resolves.toEqual(replacementBytes);
  });

  test("does not repair an existing ledger with unsafe permissions", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-append-mode-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":0}\n');
    await writeFile(target, original, { mode: 0o640 });
    await chmod(target, 0o640);

    await expect(new DurableJsonl(target).append({ sequence: 1 })).rejects.toMatchObject({
      code: "io_failure",
    });

    expect((await lstat(target)).mode & 0o777).toBe(0o640);
    await expect(readFile(target)).resolves.toEqual(original);
  });

  test("linearizes 32 interleaved appends and reads in call order", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-linearized-race-");
    const target = join(directory, "events.jsonl");
    const ledger = new DurableJsonl<{ sequence: number }>(target);
    const operations: Array<Promise<unknown>> = [];

    for (let sequence = 0; sequence < 32; sequence += 1) {
      operations.push(ledger.append({ sequence }));
      operations.push(
        ledger.readValidPrefix().then((result) => {
          expect(result.records).toEqual(
            Array.from({ length: sequence + 1 }, (_, current) => ({ sequence: current })),
          );
          expect(result.corruptTail).toBeNull();
        }),
      );
    }

    await Promise.all(operations);
    expect(ledger.status).toBe("healthy");
  });

  test.each([
    ["write", []],
    ["file-fsync", [{ sequence: 1 }]],
    ["directory-fsync", [{ sequence: 1 }]],
  ] satisfies ReadonlyArray<readonly [PersistenceOperation, Array<{ sequence: number }>]>)(
    "locks queued and future appends after an uncertain %s failure",
    async (operation, recordsAfterFailure) => {
      const directory = await temporaryDirectory(`yaca-jsonl-${operation}-`);
      const target = join(directory, "events.jsonl");
      let injected = false;
      const ledger = new DurableJsonl<{ sequence: number }>(target, {
        faultInjector: (currentOperation) => {
          if (!injected && currentOperation === operation) {
            injected = true;
            throw Object.assign(new Error("injected"), { code: "EIO" });
          }
        },
      });

      const uncertain = ledger.append({ sequence: 1 });
      const alreadyQueued = ledger.append({ sequence: 2 });

      await expect(uncertain).rejects.toMatchObject({ code: "io_failure" });
      await expect(alreadyQueued).rejects.toMatchObject({ code: "degraded" });
      expect(ledger.status).toBe("degraded");
      await expect(ledger.readValidPrefix()).resolves.toMatchObject({
        records: recordsAfterFailure,
      });
      await expect(ledger.append({ sequence: 3 })).rejects.toMatchObject({
        code: "degraded",
      });
    },
  );

  test("settles every concurrently queued append after the first uncertain failure", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-concurrent-failure-");
    const target = join(directory, "events.jsonl");
    let injected = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: (operation) => {
        if (!injected && operation === "write") {
          injected = true;
          throw Object.assign(new Error(`injected at ${target}`), { code: "EIO" });
        }
      },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, (_, sequence) => ledger.append({ sequence })),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(16).fill("rejected"));
    expect(
      outcomes.map((outcome) =>
        outcome.status === "rejected" ? (outcome.reason as PersistenceError).code : "fulfilled",
      ),
    ).toEqual(["io_failure", ...Array(15).fill("degraded")]);
    expect(ledger.status).toBe("degraded");
    const laterFailure = await ledger.append({ sequence: 99 }).catch((error: unknown) => error);
    expect(laterFailure).toMatchObject({ code: "degraded" });
    expect((laterFailure as Error).message).not.toContain(target);
    await expect(ledger.readValidPrefix()).resolves.toMatchObject({ records: [] });
  });

  test.each([
    ["torn", Buffer.from('{"sequence":')],
    ["corrupt", Buffer.from('not-json\n{"sequence":3}\n')],
  ])(
    "returns the ordered valid prefix and logical evidence for a %s tail without filesystem mutation",
    async (_, tail) => {
      const directory = await temporaryDirectory("yaca-jsonl-tail-");
      const target = join(directory, "events.jsonl");
      const prefix = Buffer.from('{"sequence":1}\n{"sequence":2}\n');
      const original = Buffer.concat([prefix, tail]);
      await writeFile(target, original, { mode: 0o600 });
      const entriesBefore = await readdir(directory);
      const statBefore = await lstat(target);
      const ledger = new DurableJsonl<{ sequence: number }>(target);

      const first = await ledger.readValidPrefix();

      expect(first.records).toEqual([{ sequence: 1 }, { sequence: 2 }]);
      expect(first.corruptTail?.byteLength).toBe(tail.byteLength);
      await expect(first.corruptTail!.read()).resolves.toEqual(tail);
      expect(ledger.status).toBe("degraded");
      await expect(ledger.append({ sequence: 3 })).rejects.toMatchObject({ code: "degraded" });

      const second = await ledger.readValidPrefix();
      const reopened = await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();

      expect(second.corruptTail?.id).toBe(first.corruptTail?.id);
      expect(reopened.corruptTail?.id).toBe(first.corruptTail?.id);
      expect(await readdir(directory)).toEqual(entriesBefore);
      const statAfter = await lstat(target);
      expect(statAfter.ino).toBe(statBefore.ino);
      expect(statAfter.mode).toBe(statBefore.mode);
      expect(statAfter.size).toBe(statBefore.size);
      expect(statAfter.nlink).toBe(statBefore.nlink);
      await expect(readFile(target)).resolves.toEqual(original);
    },
  );

  test("rejects a corrupt-tail descriptor after the ledger inode is replaced", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-replaced-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .corruptTail!;
    const originalPath = join(directory, "original-events.jsonl");
    await rename(target, originalPath);
    await writeFile(target, original, { mode: 0o600 });

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });
    await expect(readFile(originalPath)).resolves.toEqual(original);
    await expect(readFile(target)).resolves.toEqual(original);
  });

  test("rejects a corrupt-tail descriptor when the ledger gains a hard link", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-hardlink-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .corruptTail!;
    const linkedPath = join(directory, "linked-events.jsonl");
    await link(target, linkedPath);
    const before = await lstat(target);

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });

    const after = await lstat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2);
    expect(after.mode & 0o777).toBe(0o600);
    await expect(readFile(target)).resolves.toEqual(original);
    await expect(readFile(linkedPath)).resolves.toEqual(original);
  });

  test("rejects a corrupt-tail descriptor after the ledger bytes change in place", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-modified-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .corruptTail!;
    const modified = Buffer.concat([original, Buffer.from("changed")]);
    await writeFile(target, modified, { mode: 0o600 });

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });
    await expect(readFile(target)).resolves.toEqual(modified);
    expect(await readdir(directory)).toEqual(["events.jsonl"]);
  });

  test("does not follow a symbolic-link ledger when corrupt-tail evidence is read", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-evidence-link-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .corruptTail!;
    const originalPath = join(directory, "original-events.jsonl");
    await rename(target, originalPath);
    await symlink(originalPath, target);

    await expect(evidence.read()).rejects.toMatchObject({ code: "unsafe_symbolic_link" });
    await expect(readFile(originalPath)).resolves.toEqual(original);
  });

  test("rejects corrupt-tail evidence when a renamed parent is linked back to the same ledger", async () => {
    const root = await temporaryDirectory("yaca-jsonl-evidence-parent-alias-");
    const journalDirectory = join(root, "journal");
    await mkdir(journalDirectory, { mode: 0o700 });
    const target = join(journalDirectory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .corruptTail!;
    const renamedDirectory = join(root, "renamed-journal");
    await rename(journalDirectory, renamedDirectory);
    await symlink(renamedDirectory, journalDirectory);

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });
    await expect(readFile(join(renamedDirectory, "events.jsonl"))).resolves.toEqual(original);
  });

  test("rejects an oversized ledger before allocating its corrupt tail", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-limit-");
    const target = join(directory, "events.jsonl");
    await writeFile(target, "not-json", { mode: 0o600 });
    await truncate(target, 268_435_457);

    await expect(new DurableJsonl(target).readValidPrefix()).rejects.toMatchObject({
      code: "content_too_large",
    });

    expect((await lstat(target)).size).toBe(268_435_457);
    expect(await readdir(directory)).toEqual(["events.jsonl"]);
  });

  test("keeps its actual read buffer bounded when the ledger grows to a sparse GiB", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-ledger-growth-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n');
    await writeFile(target, original, { mode: 0o600 });
    const allocatedByteLengths: number[] = [];
    const ledger = new DurableJsonl(target, {
      faultInjector: async (operation, context) => {
        if (operation !== "read-sized") return;
        allocatedByteLengths.push(context?.byteLength ?? -1);
        await truncate(target, 1_073_741_824);
      },
    });

    await expect(ledger.readValidPrefix()).rejects.toMatchObject({ code: "io_failure" });

    expect(allocatedByteLengths).toEqual([original.byteLength]);
    expect(Math.max(...allocatedByteLengths)).toBeLessThanOrEqual(268_435_456);
    expect((await lstat(target)).size).toBe(1_073_741_824);
  });

  test("rejects changed ledger permissions without repairing them", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-mode-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl(target).readValidPrefix()).corruptTail!;
    await chmod(target, 0o640);

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
    await expect(readFile(target)).resolves.toEqual(original);
  });

  test("rejects changed ledger timestamps without changing its bytes", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-time-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    const evidence = (await new DurableJsonl(target).readValidPrefix()).corruptTail!;
    const changedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(target, changedTime, changedTime);

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });
    await expect(readFile(target)).resolves.toEqual(original);
  });

  test("rejects a parent swap during corrupt-tail verification without writing through it", async () => {
    const root = await temporaryDirectory("yaca-jsonl-ledger-parent-swap-");
    const journalDirectory = join(root, "journal");
    const externalDirectory = join(root, "external");
    await mkdir(journalDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const target = join(journalDirectory, "events.jsonl");
    const externalTarget = join(externalDirectory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    await writeFile(externalTarget, original, { mode: 0o600 });
    const externalBefore = await lstat(externalTarget);
    const verified = deferred();
    const releaseVerification = deferred();
    let blockVerification = true;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "corrupt-tail-verified" && blockVerification) {
          blockVerification = false;
          verified.resolve();
          await releaseVerification.promise;
        }
      },
    });
    const evidence = (await ledger.readValidPrefix()).corruptTail!;

    const reading = evidence.read();
    await verified.promise;
    const originalDirectory = join(root, "original-journal");
    await rename(journalDirectory, originalDirectory);
    await symlink(externalDirectory, journalDirectory);
    releaseVerification.resolve();

    await expect(reading).rejects.toMatchObject({ code: "io_failure" });
    const externalAfter = await lstat(externalTarget);
    expect(externalAfter.ino).toBe(externalBefore.ino);
    expect(externalAfter.mode).toBe(externalBefore.mode);
    expect(externalAfter.size).toBe(externalBefore.size);
    await expect(readFile(externalTarget)).resolves.toEqual(original);
    await expect(readFile(join(originalDirectory, "events.jsonl"))).resolves.toEqual(original);
  });

  test("reopens an existing partial tail as degraded before any append", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-reopen-tail-");
    const target = join(directory, "events.jsonl");
    const prefix = Buffer.from('{"sequence":1}\n');
    const tail = Buffer.from('{"sequence":');
    const original = Buffer.concat([prefix, tail]);
    await writeFile(target, original, { mode: 0o600 });
    const reopened = new DurableJsonl<{ sequence: number }>(target);

    await expect(reopened.append({ sequence: 2 })).rejects.toMatchObject({ code: "degraded" });

    expect(reopened.status).toBe("degraded");
    await expect(readFile(target)).resolves.toEqual(original);
    expect(await readdir(directory)).toEqual(["events.jsonl"]);
  });

  test("rejects a symbolic-link ledger without changing its target", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-link-");
    const outside = join(directory, "outside.jsonl");
    const linked = join(directory, "events.jsonl");
    await writeFile(outside, '{"protected":true}\n');
    await symlink(outside, linked);

    await expect(new DurableJsonl(linked).append({ protected: false })).rejects.toMatchObject({
      code: "unsafe_symbolic_link",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe('{"protected":true}\n');
  });
});
